# 部署手册（Raspberry Pi 5 / Debian 13，v0.3.1）

> 所有 Agent 会话与人工操作都按本文件执行；涉及系统状态的操作要逐条确认。
> 目标运行位置：`/opt/antifieldcloud/current`，服务用户 `antifieldcloud`，监听 `127.0.0.1:3000`。
> 公开仓库中的域名/IP/路径均为示例值；**实际部署值只记录在 `.local/DEPLOYMENT.md`（gitignored）**。

## 0. 拓扑与前置

- Pi：`antifield@192.0.2.10`（直连网线），WiFi 示例 `198.51.100.10`。
- 域名：`app.example.com`（应用）、`ai.example.com`（opencode 反代），Cloudflare Tunnel `antifieldcloud`。
- 现有服务不改：Minecraft、SakuraFRP、opencode、nginx、RDP/桌面。
- 本仓库从 Windows PC 通过 SSH 部署；PC 需有 `C:\Users\<user>\.ssh\id_ed25519`。
- 非敏感部署值（域名/路径/公网 MC 地址）写入 Pi 的 `/etc/antifieldcloud/deploy.conf`（root 只读，不提交仓库），
  由 `bootstrap-env.sh` 读取；密钥只来自现有服务配置或离线保管。

## 1. 首次系统初始化（重装时执行）

```bash
sudo apt-get update
sudo apt-get install -y nftables age

# 服务账号（无登录 shell、无 sudo）
sudo addgroup --system antifieldcloud
sudo adduser --system --ingroup antifieldcloud --home /var/lib/antifieldcloud \
  --shell /usr/sbin/nologin --no-create-home antifieldcloud

# 数据目录
sudo install -d -o antifieldcloud -g antifield -m 0750 /var/lib/antifieldcloud
sudo install -d -o antifieldcloud -g antifieldcloud -m 0700 /var/lib/antifieldcloud/files /var/lib/antifieldcloud/tmp
sudo install -d -o antifieldcloud -g antifield -m 2770 /var/lib/antifieldcloud/backups
sudo install -d -o root -g root -m 0755 /opt/antifieldcloud/releases /etc/antifieldcloud

# 防火墙（仓库 deploy/nftables.conf；实际网段按 .local 修改后再安装）
sudo nft -c -f deploy/nftables.conf
sudo install -m 0644 deploy/nftables.conf /etc/nftables.conf
sudo nft -f /etc/nftables.conf
sudo systemctl enable --now nftables

# systemd 单元
sudo install -m 0644 deploy/antifieldcloud.service /etc/systemd/system/
sudo systemctl daemon-reload
```

## 2. 非敏感部署值与环境文件

```bash
# 只写非敏感值，不写任何密钥；实际域名/路径按 .local/DEPLOYMENT.md 填写
sudo install -o root -g root -m 0640 /dev/stdin /etc/antifieldcloud/deploy.conf <<'EOF'
APP_ORIGIN=https://app.example.com
AI_ORIGIN=https://ai.example.com
COOKIE_DOMAIN=.example.com
MC_PUBLIC_ADDRESS=mc.example.com:11798
DATA_DIR=/var/lib/antifieldcloud
WEB_DIST_DIR=/opt/antifieldcloud/current/web/dist
ADMIN_USERNAME=antifield
EOF
```

先部署一次代码（第 3 节，服务可先不启动），再生成环境文件：

```bash
cd /opt/antifieldcloud/current
sudo bash scripts/bootstrap-env.sh                  # 首次
sudo bash scripts/bootstrap-env.sh --dry-run        # 查看解析结果（不写文件、不显示密码）
sudo bash scripts/bootstrap-env.sh --force          # 轮换/重建（非敏感配置优先沿用旧 env/deploy.conf）
sudo ls -l /etc/antifieldcloud/env                  # 应为 -rw-r----- root antifieldcloud
```

- `bootstrap-env.sh` 从 `~/minecraft-server/server.properties` 读 RCON 密码、从 `/etc/opencode/opencode.env`
  读 `OPENCODE_PASSWORD`，写入 `/etc/antifieldcloud/env`，不回显密钥。
- 解析顺序：命令行参数 > 现有 env > `/etc/antifieldcloud/deploy.conf` > 示例默认值；`--force` **不会**把真实域名重置为
  `example.com`。若仍使用占位域名，脚本会打印警告。
- 可选参数：`--app-origin= --ai-origin= --cookie-domain= --mc-public-address= --data-dir= --web-dist-dir= --admin-username=`。
- v0.3 可选 env（写入 `/etc/antifieldcloud/env`，按需）：
  - `BACKUP_RESTORE_ENABLED=true`：启用 Web 备份列表/导入/文件级恢复；默认 false 时恢复计划/执行返回 403。
  - `BACKUP_IMPORT_MAX_BYTES=104857600`：Web 归档导入上限，实际还受 `MAX_UPLOAD_BYTES` 限制。
  - `OPENCODE_HTML_MODE=shim|attributes|passthrough`：默认 `shim`；Cloudflare 关闭注入并验证后可切 `passthrough`。
  - `CHUNKED_UPLOAD_ENABLED=true`：启用 5 GiB 分片上传（默认 true）。
  - `CHUNK_SIZE_BYTES=8388608`：块大小，1–100 MiB；Cloudflare 代理下建议 8 MiB。
  - `CHUNK_MAX_FILE_BYTES=5368709120`：单文件上限，默认 5 GiB，不得超过配额。
  - `CHUNK_SESSION_TTL_HOURS=24`、`CHUNK_MAX_CONCURRENT_SESSIONS=3`：会话过期与每用户并发上限。

## 3. 从 PC 部署（带迁移前 DB 快照与自动回滚）

```powershell
cd "$env:USERPROFILE\projects\AntifieldCloud"
npm run check
.\scripts\deploy.ps1 -PiHost 192.0.2.10   # 替换为 Pi 实际直连地址
```

`deploy.ps1` 流程：运行检查 → Vite 构建 → 打包（含 LICENSE/CHANGELOG）→ 上传到 `/opt/antifieldcloud/releases/<UTC>`
→ `npm ci --omit=dev --ignore-scripts` → **迁移前 `backup.mjs --snapshot-db`**（失败则中止，不切换）
→ 记录上一 release → 切换 `current` → `systemctl restart` → 健康检查。

- 健康检查失败时脚本自动 `ln -sfn` 回上一 release 并重启、复检；回滚成功才清理坏 release，失败则保留现场并输出
  journalctl 日志与 DB 快照路径。首次部署无回滚目标时保留新 release 便于排查。
- **首次部署**（`/etc/antifieldcloud/env` 尚不存在）：脚本只上传/安装并切换 current，跳过 DB 快照、重启与健康检查；
  按第 2 节生成 env 后再 `sudo systemctl enable --now antifieldcloud`。
- 失败清理：切换前失败会删除不完整 release 与 `/tmp` 临时包；本地 tar 总在 finally 清理。
- release 保留 3 个，且清理时永不删除 `current` 与本次 `previous`。
- 手工等价步骤（仅在脚本不可用时）：解包 → `npm ci --omit=dev --ignore-scripts` → 先跑
  `node scripts/backup.mjs --snapshot-db` → `ln -sfn` → `systemctl restart antifieldcloud` → `curl /healthz`。

## 4. 初始化管理员与 TOTP（必须由本人交互执行）

在**交互式 SSH** 中运行（不要把密码/二维码发到聊天）：

```bash
sudo -u antifieldcloud -H /usr/local/bin/node /opt/antifieldcloud/current/scripts/provision.mjs
```

流程：设置用户名 → 输入两次密码（≥12 位）→ 扫描终端二维码/手动保存密钥 →
输入 6 位验证码 → 保存 10 个恢复码（只显示一次）。

重置：

```bash
sudo -u antifieldcloud -H /usr/local/bin/node /opt/antifieldcloud/current/scripts/provision.mjs --reset-password
sudo -u antifieldcloud -H /usr/local/bin/node /opt/antifieldcloud/current/scripts/provision.mjs --reset-totp
```

## 5. Cloudflare Tunnel 与 DNS

备份并编辑 Pi 上的 `/etc/cloudflared/config.yml`，保留原有 `tunnel`/`credentials-file`/`protocol`，只替换
`ingress` 为仓库 `deploy/cloudflared-ingress.yml` 的内容（示例）：

```yaml
ingress:
  - hostname: app.example.com
    service: http://127.0.0.1:3000
  - hostname: ai.example.com
    service: http://127.0.0.1:3000
  - hostname: mc.example.com
    service: tcp://localhost:25565
  - service: http_status:404
```

```bash
sudo cp -a /etc/cloudflared/config.yml /var/backups/antifieldcloud/cloudflared-config.yml.$(date +%s)
sudo systemctl restart cloudflared
sudo journalctl -u cloudflared -n 30 --no-pager
sudo cloudflared tunnel info <TUNNEL_UUID>    # 检查 connector 与版本升级提示
```

**DNS 由用户在 Cloudflare 后台手动添加**（现有 `cert.pem` 是隧道 token，不是账号证书，CLI 无 DNS 权限）：

| 类型 | 名称 | 内容 | 代理 |
|---|---|---|---|
| CNAME | `app` | `<TUNNEL_UUID>.cfargotunnel.com` | Proxied（橙色云） |
| CNAME | `ai` | `<TUNNEL_UUID>.cfargotunnel.com` | Proxied（橙色云） |

- 不要修改 `mc.example.com`（指向 SakuraFRP，与工作台无关）。
- Cloudflare 代理有 **100MB（Free/Pro）/200MB（Business）请求体上限** 与默认 100s 代理读超时；应用
  `MAX_UPLOAD_BYTES` 默认按 100 MiB 配置，超过上限的上传由边缘直接 413（见 FAQ）。
- cloudflared 以 root 运行且当前 unit 无沙箱；建议按第 10 节做 drop-in 加固，并定期用
  `cloudflared tunnel info` 的版本提示升级（`--no-autoupdate` 不会自动升级）。

### 5.1 Rocket Loader / 自动注入（OpenCode 无垫片前置）

目标：只为 `ai` 主机关闭 Cloudflare 对模块脚本的改写/自动注入，不影响 `app`。

1. Cloudflare Dashboard → Rules → **Configuration Rules** → Create rule：
   - 表达式：`http.host eq "ai.example.com"`；
   - 设置：**Rocket Loader: Off**；
   - 保存并部署。官方已将 Rocket Loader 从 Page Rules 迁移到 Configuration Rules。
2. Speed → Optimization：如仍启用 Rocket Loader，保持全局设置不动，以 host 规则为准。
3. Web Analytics → Manage Site：自动注入设为 **Disable**（严格 CSP 下 beacon 被拦截）。
4. 如启用 Bot Fight Mode，其 JavaScript Detections 不能单独关闭；可整体关闭或接受控制台 CSP 报错。
5. 验收：
   - `curl -fsS https://ai.example.com/` 的 HTML 中 `type="module"` 未被改写；无 `data-cfasync` 依赖；
   - 认证浏览器桌面/Android/390/915 宽屏测试原生“新建会话”、模型/智能体选择器、SSE/WS；
   - 代理设置 `OPENCODE_HTML_MODE=passthrough`（或 `attributes` 过渡）后再观察 24h；失败切回 `shim`。
6. 回滚：删除该 Configuration Rule → 恢复 `OPENCODE_HTML_MODE=shim` → 重启应用。

注意：opencode 上游原生新建按钮在部分版本/空项目状态有缺陷；若关闭注入后仍无响应，按验收记录保留最小隐藏 click/pointerup 接管（无可见按钮），不重新引入 v0.2.1 的浮动按钮。

## 6. 验证

本机（Pi 上）：

```bash
curl -fsS http://127.0.0.1:3000/healthz
curl -H 'Host: app.example.com' -fsS http://127.0.0.1:3000/healthz
```

公网（DNS 生效后）：

```powershell
.\scripts\smoke.ps1 -PiHost 192.0.2.10 -AppUrl https://app.example.com -AiUrl https://ai.example.com `
  -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups"
```

`smoke.ps1` 覆盖：公网健康/302/401、CSP/nosniff/referrer/HSTS、PWA（manifest/sw/offline）、公开分享页 404/410、
告警 API 401、Pi 服务与 healthz、内存 cgroup、nftables/25575 阻断/25565 可达、备份 pending 与 48h 状态、
本地 `.sha256` 旁文件；所有 SSH 检查带重试。

Windows 备份计划任务（**管理员 PowerShell**；安装脚本会收紧 ACL 并做 Pi 可达性预检）：

```powershell
.\scripts\install-backup-task.ps1 -PiHost 192.0.2.10 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups"
# 只预览不注册：
.\scripts\install-backup-task.ps1 -PiHost 192.0.2.10 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups" -DryRun
```

手工检查：`https://app.example.com` 登录、上传/预览、Dashboard MC 状态、白名单增删、文件分享与告警卡片；
`https://ai.example.com` 登录后进入 opencode。若 opencode 仍要求输入自身密码，属于其 UI 行为，
从 Pi `sudo grep OPENCODE_PASSWORD /etc/opencode/opencode.env` 获取后输入一次（不写入前端）。

### 6.1 v0.3 备份管理/媒体/迁移

- 迁移：v0.3 新增 schema migration 3（`backup_archives` 列 + `restore_plans`），部署脚本会在切换前自动 `--snapshot-db`。
- 启用：`BACKUP_RESTORE_ENABLED=true`；重启应用后 `/api/version` 应返回 `backupRestoreEnabled:true`。
- Windows 备份脚本：更新仓库后重新运行 `install-backup-task.ps1`（管理员），确认任务 Args 仍指向实际 `PiHost/BackupRoot`；
  手动跑一次核对 `backup.log` 出现 `secrets=ok`，Pi `backup-pull.json` 含 `secretsOk=true`。
- Pi 密钥包：首次部署后执行一次 `sudo bash /opt/antifieldcloud/current/scripts/backup-secrets.sh`，核对输出
  `includesOpencode=true`；用离线 age 私钥解密抽查 `opencode/opencode.db`（不要在生产回显密码）。
- Web 恢复：只允许导入/校验/文件级恢复到新目录；整库恢复仍按 `docs/BACKUP.md` §6 离线执行。
- 媒体：mp4/webm/mp3/m4a/ogg/flac/wav 可内联播放；mkv/avi 等回退下载。
- 验收：`npm run check`、`npm run build`、`smoke.ps1`、Android/桌面原生新建按钮矩阵、备份导入/校验/恢复（临时 DATA_DIR）。

## 7. 主机健康探针（vcgencmd → /run JSON）

新增 `deploy/antifieldcloud-health.service` + `.timer`，每 60s 以 root 采集欠压/降频/温度/风扇并写
`/run/antifieldcloud/pi-health.json`（0644），供应用告警模块读取。

```bash
sudo install -d -m 0755 /usr/local/libexec
sudo install -m 0755 deploy/health-probe.sh /usr/local/libexec/antifieldcloud-health.sh
sudo install -m 0644 deploy/antifieldcloud-health.service deploy/antifieldcloud-health.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now antifieldcloud-health.timer
sudo systemctl start antifieldcloud-health.service
cat /run/antifieldcloud/pi-health.json
```

- `deploy/antifieldcloud.service` 已设置 `Environment=PI_HEALTH_FILE=/run/antifieldcloud/pi-health.json`；
  更新 unit 后执行 `sudo systemctl daemon-reload && sudo systemctl restart antifieldcloud` 使其生效。
- 告警阈值（磁盘/温度/备份超期/欠压等）由 env 的 `ALERT_*` 控制；webhook 配置只读展示，不在前端存储明文密钥。

## 8. 内存限制检查（重要）

应用 unit 的 `MemoryMax=512M` 依赖内核 memory cgroup；若 Pi 内核命令行包含 `cgroup_disable=memory`，限制不会生效：

```bash
cat /proc/cmdline | tr ' ' '\n' | grep -i cgroup
cat /sys/fs/cgroup/cgroup.controllers        # 必须包含 memory
sudo systemctl show antifieldcloud -p MemoryCurrent -p MemoryMax
```

- 若 controllers 缺少 `memory`：从内核命令行移除 `cgroup_disable=memory`（检查 `/boot/firmware/cmdline.txt` 与固件/镜像
  默认 cmdline 的实际来源），重启，再确认 `memory` 出现在 controllers 且 `MemoryCurrent` 有数值。
- 该项是 v0.2.x 发布验收的硬性检查（`smoke.ps1` 会失败），不能用“应用内存占用低”代替。

## 9. 防火墙验证与回滚

```bash
sudo /usr/sbin/nft list ruleset
ss -tlnp | grep -E ':25565|:25575'
```

- 期望：外部访问 `<Pi 直连 IP>:25575` 失败；`22`、`25565` 正常；`127.0.0.1:25575` 正常。
- 仓库 `deploy/nftables.conf` 的 `198.51.100.0/24` 是示例网段；按 `.local/DEPLOYMENT.md` 的实际直连/校园网段修改后
  重新 `nft -c -f` 校验并加载；网段宁窄勿宽（例如实际为 `/21` 就不要写 `/16`）。
- 解绑/回滚：`sudo systemctl disable --now nftables && sudo nft flush ruleset`（需物理键鼠或已建立的 SSH）。

## 9.1 v0.3.1 主机加固记录

- **journald persistent**：`/etc/systemd/journald.conf.d/60-workbench-persistent.conf` 设
  `Storage=persistent`、`SystemMaxUse=64M`、`RuntimeMaxUse=32M`；Pi 的 `/var/log` 由 log2ram 承载（zygote 128M），
  64M + log2ram 的 `JOURNALD_AWARE=true` 会在关机前同步；回滚为删除该 drop-in 并重启 journald。
- **cloudflared**：升级到 `2026.10.1`；`/etc/systemd/system/cloudflared.service.d/20-hardening.conf`
  启用 `NoNewPrivileges/PrivateTmp/ProtectSystem=full/ProtectHome` 等；回滚二进制使用
  `/var/backups/antifieldcloud/cloudflared-2026.8.1`，删 drop-in + `daemon-reload`。
- **nftables**：WiFi 源从示例 `/16` 收窄为实际 `/21`（如 `172.23.88.0/21`）；修改前备份 `/etc/nftables.conf`，
  `nft -c -f` 校验后 reload；回滚备份文件。
- **rpcbind**：`systemctl disable --now rpcbind.socket rpcbind.service`；无 NFS 依赖，111 已关闭。
- **时钟**：`fake-hwclock-load.service` 与 `fake-hwclock-save.timer` 已启用（RTC 无电池时提供关机时间近似值），
  NTP/systemd-timesyncd 仍负责最终校时；如需硬件 RTC，安装 CR2032 电池。
- **RCON**：Paper 无 bind 配置，25575 仍监听所有接口；仅由 nftables 的 `tcp dport 25575 drop` 阻断非 loopback。

## 10. cloudflared 加固与升级（建议）

默认 unit 以 root 运行且没有沙箱参数。建议用 drop-in 限制（按实际 cloudflared 版本验证可写路径）：

```bash
sudo systemctl edit cloudflared
# [Service]
# NoNewPrivileges=yes
# ProtectSystem=strict
# ProtectHome=yes
# PrivateTmp=yes
# ProtectKernelTunables=yes
# ProtectControlGroups=yes
# CapabilityBoundingSet=CAP_NET_BIND_SERVICE
# RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
# ReadWritePaths=/etc/cloudflared
sudo systemctl daemon-reload && sudo systemctl restart cloudflared
```

升级：`cloudflared --version` 与 `sudo cloudflared tunnel info <UUID>` 的提示会显示目标版本；apt 源可能滞后，按 Cloudflare
官方 .deb/仓库升级后 `systemctl restart cloudflared`，并在 smoke 中确认隧道 4 连接已注册。

## 11. 应用回滚与数据库

```bash
ls -1dt /opt/antifieldcloud/releases/*
sudo ln -sfn /opt/antifieldcloud/releases/<上一个> /opt/antifieldcloud/current
sudo systemctl restart antifieldcloud
curl -fsS http://127.0.0.1:3000/healthz
```

- 每次部署在切换前生成 `/var/lib/antifieldcloud/backups/db-predeploy-*.sqlite`（0600，保留最新 10 个）。
- schema 迁移只向上、无 down：回滚旧 release 前应恢复对应迁移前快照（`sudo systemctl stop antifieldcloud` →
  复制快照为 `db.sqlite` → 删除 `-wal/-shm` → 启动），否则旧代码可能不兼容新 schema。
- 数据恢复与全量/增量链解析见 `docs/BACKUP.md` §6。
- cloudflared 回滚：`sudo cp /var/backups/antifieldcloud/cloudflared-config.yml.<ts> /etc/cloudflared/config.yml && sudo systemctl restart cloudflared`。

## 12. CI 检查

`.github/workflows/ci.yml` 在 push/PR 运行：Node 26 `npm run check` + `npm run build`；生产依赖边界
（`npm ci --omit=dev` + `scripts/check-prod-deps.mjs`）；`shellcheck`（scripts/*.sh、deploy/*.sh）；
`nft -c -f deploy/nftables.conf`；Windows PowerShell 5.1 解析 + UTF-8 BOM 检查。部署/备份脚本改动必须让 CI 全绿。

## 13. 常见问题

| 现象 | 处理 |
|---|---|
| `deploy.ps1` SSH 超时 | 直连网线偶发丢包；脚本自带重试；检查 PC 网卡节能、网线、Pi `eth0` |
| `npm ci` 失败 | 确认 Pi 可访问 npm registry；使用 `/usr/local/bin/npm`；查看 `journalctl -u antifieldcloud` |
| 部署健康检查失败 | 脚本已自动回滚；看输出的 journalctl 与迁移前 DB 快照路径；修复后重新部署 |
| 公网 502 | `systemctl status cloudflared`；确认 app 在 3000 监听；DNS 是否 Proxied |
| 上传 >100MB 返回 413 | Cloudflare 套餐请求体上限；调小 `MAX_UPLOAD_BYTES` 或升级套餐，前端会提示大小限制 |
| 登录 429 | 15 分钟内失败次数过多；等待或重启应用清空内存限流 |
| 白名单 502 | RCON 不可用：`ss -tlnp | grep 25575`，`sudo journalctl -u minecraft` |
| `ai` 二次密码 | opencode 自身 Basic UI；按第 6 节输入一次，后续浏览器记住 |
| 内存 cgroup 缺失 | 按第 8 节移除 `cgroup_disable=memory` 后重启；`smoke.ps1` 会检查 |
| 备份 pending 堆积 | 先修直连/计划任务；pending 不会因空间清理被删；查 `backup.log` 与 `--pending` |
| 备份面板红色 | 计划任务失败/超过 48h：查任务 LastTaskResult、`%LOCALAPPDATA%\AntifieldCloud\backup.log` |
| 密钥包未生成 | 按 `docs/BACKUP.md` §5 安装 age 并写入公钥；不影响普通归档 |
| 磁盘占用 | `df -h /`、`du -sh /var/lib/antifieldcloud/*`；配额 10 GiB；release/备份保留策略见文档 |
| 公网页面空白 / 入口脚本未执行 | app 入口脚本已加 `data-cfasync="false"`；ai 代理按 `OPENCODE_HTML_MODE` 处理；若仍异常，在 Cloudflare Speed → Optimization/Configuration Rules 关闭 `ai` 的 Rocket Loader |
| 备份密钥包状态红/unknown | 看 `backup-pull.json` 的 `secretsOk/secretsLastError`；检查 age 公钥权限与 `backup-secrets.sh`；文件归档成功不等于密钥包成功 |
| 备份恢复 403 restore_disabled | env 未设 `BACKUP_RESTORE_ENABLED=true` 或未重启应用 |
| 大文件上传 413 | 普通单请求上限 100 MiB；>100 MiB 应自动走分片（`CHUNKED_UPLOAD_ENABLED=true`、5 GiB 上限）。检查 `/api/version` 的 `chunkedUploadEnabled/chunkSizeBytes/chunkMaxFileBytes`，以及块请求是否被 Cloudflare 单请求限制拦截 |
| 校园网暂时无法解析 | 递归 DNS 负缓存（约 30 分钟）；等待或用手机流量验证。不要修改 `mc.example.com` |

## 14. 磁盘清理与保留策略

- 先只读确认：`df -hT /`、`df -i /`、`du -xhd1 /`、`journalctl --disk-usage`；不要直接对 `/home` 或 `/var/lib` 做递归删除。
- 可安全清理：`apt-get clean` 的包缓存、两代以前 `/opt/antifieldcloud/releases/<old>`（保留 current/previous）、旧 `cloudflared` 备份二进制、journald vacuum（保留 7 天且 ≤ 文档上限）。
- 开发缓存需确认：`~/.local/share/pnpm/store`、`~/.nvm` 旧 Node、`~/.rustup` 非 active toolchain、`~/.cargo/registry`、`~/.npm/_cacache`；清理前确认无其他项目依赖，联网可重建。
- **不要清理**：`/var/lib/antifieldcloud`（DB/files/backups/secrets）、`/var/lib/opencode`、当前与 previous release、`/var/swap`、`minecraft-server/world`、`minecraft-backups`。
- Minecraft 世界不在应用备份覆盖内；`minecraft-backups` 是本地唯一世界副本（cron 约保留 2 天），只能先复制到 PC/离线介质，再按保留策略处理。
- 旧内核 `/opt/jdk` 等系统组件先在 `/boot`/Java 依赖确认后再处理；保留至少一个可回退内核。
- 清理后运行 `smoke.ps1`，并记录释放量；不要清理 `preflight/age-key`。
