# 部署手册（Raspberry Pi 5 / Debian 13，v0.4.2）

> 所有 Agent 会话与人工操作都按本文件执行；涉及系统状态的操作要逐条确认。
> 目标运行位置：`/opt/antifieldcloud/current`，服务用户 `antifieldcloud`，监听 `127.0.0.1:3000`。
> 公开仓库中的域名/IP/路径均为示例值；**实际部署值只记录在 `.local/DEPLOYMENT.md`（gitignored）**。

## 0. 拓扑与前置

- Pi：`antifield@192.0.2.10`（直连网线，实际网段 `169.254.77.0/24`），WiFi 示例 `198.51.100.10`（校园网实际 `172.23.88.0/21`）。
- 域名：`app.example.com`（应用）、`ai.example.com`（opencode 反代），Cloudflare Tunnel 名称为 `pi`（UUID 见 `.local`）。
- 现有服务不改：Minecraft、SakuraFRP、opencode、RDP/桌面；nginx/certbot 旧入口已移除。
- 本仓库从 Windows PC 通过 SSH 部署；PC 需有 `C:\Users\<user>\.ssh\id_ed25519`。
- 非敏感部署值（域名/路径/公网 MC 地址）写入 Pi 的 `/etc/antifieldcloud/deploy.conf`（root 只读，不提交仓库），
  由 `bootstrap-env.sh` 读取；密钥只来自现有服务配置或离线保管。
- 当前 schema v6（迁移 5 结构 + 迁移 6 孤儿 shares 数据修复，不改表结构）；迁移前会执行 `PRAGMA foreign_key_check`，
  其它外键损坏会拒绝启动；数据库 schema 高于程序支持版本时拒绝启动。部署脚本切换前会自动做迁移前 DB 快照，回滚必须使用该快照。

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
# ！先确认当前 SSH 来源在允许网段内，否则加载后会锁死 SSH。
sudo cp -a /etc/nftables.conf /etc/nftables.conf.bak 2>/dev/null || true
sudo nft -c -f deploy/nftables.conf
sudo install -m 0644 deploy/nftables.conf /etc/nftables.conf
sudo nft -f /etc/nftables.conf
sudo systemctl enable --now nftables

# systemd 单元（应用 + 健康探针；世界备份 unit 见 §9.2）
sudo install -m 0644 deploy/antifieldcloud.service /etc/systemd/system/
sudo systemctl daemon-reload
```

nftables 默认策略与网段（详见 §9）：默认 drop 入站；22 仅 `169.254.77.0/24` + `172.23.88.0/21` 且新建连接限速 20/min；
25565 仅同网段；25575 仅 loopback；DHCP 仅 `eth0`/`wlan0`；80 不再放行。

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
- `APP_VERSION` 由 `bootstrap-env.sh` 从当前 release 的 `package.json` 读取（读不到直接失败，不再回退历史版本号）；
  `deploy.ps1` 切换前也会注入并校验 `/healthz.version`。
- v0.3 可选 env（写入 `/etc/antifieldcloud/env`，按需）：
  - `BACKUP_RESTORE_ENABLED=true`：启用 Web 备份列表/导入/文件级恢复；默认 false 时恢复计划/执行返回 403。
  - `BACKUP_IMPORT_MAX_BYTES=104857600`：Web 归档导入上限，实际还受 `MAX_UPLOAD_BYTES` 限制。
  - `OPENCODE_HTML_MODE=shim|attributes|passthrough`：默认 `shim`；Cloudflare 关闭注入并验证后可切 `passthrough`。
  - `CHUNKED_UPLOAD_ENABLED=true`：启用 5 GiB 分片上传（默认 true）。
  - `CHUNK_SIZE_BYTES=8388608`：块大小，1–100 MiB；Cloudflare 代理下建议 8 MiB。
  - `CHUNK_MAX_FILE_BYTES=5368709120`：单文件上限，默认 5 GiB，不得超过配额。
  - `CHUNK_SESSION_TTL_HOURS=24`、`CHUNK_MAX_CONCURRENT_SESSIONS=3`：会话过期与每用户并发上限。
- v0.4.0 新增 env（默认值见 `deploy/env.example`；升级后可用 `sudo bash scripts/bootstrap-env.sh --dry-run` 预览，
  再运行 `--force` 追加缺失键，非敏感值会沿用现有 env/deploy.conf，不会重置真实域名）：
  - `BACKUP_PREPARE_TIMEOUT_SEC=3300`：Web/CLI 生成归档超时，与 PC 侧 55 分钟对齐。
  - `WORLD_BACKUP_STATUS_FILE`、`WORLD_PULL_STATUS_FILE`、`DRILL_STATUS_FILE`：默认
    `/var/lib/antifieldcloud/{world-backup,world-pull,drill}-status.json`，应用只读。
  - `ALERT_WORLD_BACKUP_MAX_AGE_HOURS=192`、`ALERT_DRILL_MAX_AGE_DAYS=35`：世界备份/拉取与演练超期阈值。
  - `NOTE_ATTACHMENT_MAX_BYTES=26214400`、`NOTE_MAX_ATTACHMENTS=100`、`NOTE_VERSIONS_KEEP=20`：笔记附件与版本限制。
  - `SHARE_MAX_ITEMS=50`：单个分享最多文件数。
  - `METRICS_ENABLED=true`、`METRICS_SAMPLE_SECONDS=60`、`METRICS_RETENTION_DAYS=30`：指标采样与保留。

## 3. 从 PC 部署（带迁移前 DB 快照与自动回滚）

```powershell
cd "$env:USERPROFILE\projects\AntifieldCloud"
npm run check
.\scripts\deploy.ps1 -PiHost 192.0.2.10   # 替换为 Pi 实际直连地址
```

`deploy.ps1` 流程：运行检查 → Vite 构建 → 打包（含 LICENSE/CHANGELOG/docs）→ 远程预检（Node≥26、npm、磁盘 ≥2 GiB + 包体、
systemd 已启用）→ 上传并校验 tar SHA-256 → 解包到 `/opt/antifieldcloud/releases/<UTC>` → 校验远端 `package.json` 版本
→ `npm ci --omit=dev --ignore-scripts` → **迁移前 `backup.mjs --snapshot-db`**（失败则中止，不切换）
→ 注入 `APP_VERSION` 到 `/etc/antifieldcloud/env` → 切换 `current` → `systemctl restart` → 健康检查断言 `/healthz.version`。

- 健康检查失败时脚本先 `systemctl stop`、还原迁移前 DB 快照、`ln -sfn` 回上一 release、`systemctl start` 并复检；
  **没有迁移前快照时拒绝自动回滚**并打印手工步骤（schema 只向上、无 down）。回滚成功才清理坏 release，失败则保留现场并输出
  journalctl 日志与 DB 快照路径。首次部署无回滚目标时保留新 release 便于排查。
- 部署成功后脚本自动运行只读 smoke 子集：`smoke.ps1 -SkipPublic -SkipLocalBackup -ExpectedVersion <版本>`；
  smoke 失败只告警，不回滚已完成的部署。
- **首次部署**（`/etc/antifieldcloud/env` 尚不存在）：脚本只上传/安装并切换 current，跳过 DB 快照、重启与健康检查；
  按第 2 节生成 env 后再 `sudo systemctl enable --now antifieldcloud`。
- 失败清理：切换前失败会删除不完整 release 与 `/tmp` 临时包；本地 tar 总在 finally 清理。
- release 保留 3 个，且清理时永不删除 `current` 与本次 `previous`。
- 手工等价步骤（仅在脚本不可用时）：解包 → `npm ci --omit=dev --ignore-scripts` → 先跑
  `node scripts/backup.mjs --snapshot-db` → 写入/校验 `APP_VERSION` → `ln -sfn` → `systemctl restart antifieldcloud` → `curl /healthz`。

### 3.1 v0.4.2 应用部署步骤（版本升级时执行）

1. 本地：`npm run check`、`npm run build`，确认 `package.json` 版本 0.4.2（schema 仍为 v6，无新迁移）。
2. 执行 `.\scripts\deploy.ps1 -PiHost <直连 IP>`；脚本会完成迁移前快照、APP_VERSION 注入、切换与版本健康检查。
3. 如新 env 键缺失，运行 `sudo bash /opt/antifieldcloud/current/scripts/bootstrap-env.sh --dry-run`
   预览，再 `--force` 写入（保留现有非敏感值），然后 `sudo systemctl restart antifieldcloud`。
4. 运行 `.\scripts\smoke.ps1 -PiHost <直连 IP> -ExpectedVersion 0.4.2`；确认 `antifieldcloud-world.timer` 下次触发时间。
5. OpenCode 升级/兼容检查见 §3.2（应用部署与 OpenCode 升级相互独立，建议先应用后升级并分别验收）。

### 3.2 OpenCode v2.1.1 升级与兼容性复核（本机执行）

当前生产 OpenCode 为 v2.1.1（2026-10-20 由 v2.0.32 升级）。升级/回滚步骤：

```bash
# 1) 备份（root）：二进制、数据、env、unit
TS=$(date -u +%Y%m%dT%H%M%SZ); BK=/var/backups/opencode
sudo install -d -o root -g root -m 0700 "$BK"
sudo tar -C /var/lib/opencode -czf "$BK/opencode-bin-$TS.tar.gz" .opencode/bin/opencode
sudo tar -C /var/lib/opencode --exclude='.opencode/bin' -czf "$BK/opencode-data-$TS.tar.gz" .
sudo cp -a /etc/opencode/opencode.env "$BK/opencode.env.$TS"
sudo cp -a /etc/systemd/system/opencode.service "$BK/opencode.service.$TS"

# 2) 升级（opencode 用户；curl 安装器）
sudo -u opencode env HOME=/var/lib/opencode \
  /var/lib/opencode/.opencode/bin/opencode upgrade --method curl

# 3) 重启并验证
sudo systemctl restart opencode
sudo -u opencode /var/lib/opencode/.opencode/bin/opencode --version
# Basic API / 代理兼容（密码从 env 读取，不打印）
PASS=$(sudo grep '^OPENCODE_PASSWORD=' /etc/opencode/opencode.env | cut -d= -f2-)
curl -sS -o /dev/null -w '%{http_code}\n' -u "opencode:$PASS" http://127.0.0.1:4096/api/session
curl -sS -o /dev/null -w '%{http_code}\n' -u "opencode:$PASS" -H 'content-type: application/json' \
  -d '{}' http://127.0.0.1:4096/api/session      # 垫片新建会话路径；会创建测试 session，可 DELETE /api/session/<id> 清理
curl -sS -o /dev/null -w '%{http_code}\n' https://app.<域名>/healthz
```

兼容性判据：`/api/session` 200 且 `data` 为数组；`POST /api/session` 返回 `data.id`；upstream HTML 可被
`injectOpenCodeShim` 注入（`__af/oc-help.js` + `data-cfasync`）；前端 bundle 仍含“新建会话/New session”标记；
公开 `ai.<域名>` 未登录 401/302；应用 healthz 200。任一不满足先保持 `OPENCODE_HTML_MODE=shim` 并回滚 OpenCode。

回滚：`sudo systemctl stop opencode` → 用备份的 `.opencode/bin/opencode` 覆盖 → 恢复 data tar（如需）→
`sudo systemctl start opencode` → 按上面判据复验；应用侧无需回滚。OpenCode 原生按钮/WS 实时事件仍建议用户浏览器复测。

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
- cloudflared 以 root 运行；当前已通过 `20-hardening.conf` drop-in 加固（见 §9.6），定期用
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
指标/告警/分享等 API 401、Pi 服务与 `/healthz` 版本（`-ExpectedVersion`）、内存 cgroup、nftables 规则/25575 阻断/25565 可达、
备份 pending 与 48h 状态、密钥包状态、世界备份/世界拉取/演练状态文件、已安装脚本 SHA-256 与仓库一致、
本地世界/应用归档 `.sha256` 旁文件；所有 SSH 检查带重试与硬超时。`-SkipPublic`/`-SkipLocalBackup`/`-SkipScriptHash`
用于部署后只读子集。

Windows 备份计划任务（**管理员 PowerShell**；安装脚本会收紧 ACL 并做 Pi 可达性预检）：

```powershell
.\scripts\install-backup-task.ps1 -PiHost 192.0.2.10 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups"
# 只预览不注册：
.\scripts\install-backup-task.ps1 -PiHost 192.0.2.10 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups" -DryRun
```

手工检查：`https://app.example.com` 登录、上传/预览、Dashboard MC 状态、白名单增删、文件分享与告警卡片；
`https://ai.example.com` 登录后进入 opencode。若 opencode 仍要求输入自身密码，属于其 UI 行为，
从 Pi `sudo grep OPENCODE_PASSWORD /etc/opencode/opencode.env` 获取后输入一次（不写入前端）。

### 6.1 v0.4.0 备份/灾备/迁移

- 迁移：v0.4.0 为 schema v6（迁移 5 结构：`files.origin`、唯一索引、笔记附件/版本、`share_items`、`metrics_samples`；
  迁移 6：孤儿 shares 清理与 `share_items` 回填）。部署脚本切换前自动 `--snapshot-db`；回滚必须先恢复该快照。
- 启用：`BACKUP_RESTORE_ENABLED=true`（默认 true）；重启应用后 `/api/version` 应返回 `backupRestoreEnabled:true`
  及 `noteAttachmentMaxBytes/noteMaxAttachments/noteVersionsKeep/shareMaxItems/metricsEnabled/metricsSampleSeconds/metricsRetentionDays`。
- Windows 应用备份脚本：更新仓库后重新运行 `install-backup-task.ps1`（管理员），确认任务 Args 仍指向实际 `PiHost/BackupRoot`；
  手动跑一次核对 `backup.log` 出现 `secrets=ok`，Pi `backup-pull.json` 含 `secretsOk=true`。
- Pi 密钥包：首次部署后执行一次 `sudo bash /opt/antifieldcloud/current/scripts/backup-secrets.sh`，核对
  `includesOpencode=true` 且 Pi 仅保留最新 2 份；用离线 age 私钥解密抽查 `opencode/opencode.db`（不要在生产回显密码）。
- 世界备份：按 §9.2 安装 unit/timer；首次手动跑一次，确认 `/var/lib/antifieldcloud/world-backup-status.json` 的 `ok=true`
  且 `world-backups/` 出现 `world-<UTC>.tar.gz` + `.sha256`。
- 世界拉取/演练：Windows 周度 `world-pull.ps1` 与季度 `drill.ps1` 由用户手动安装任务（§9.2）；未安装时状态 unknown。
- Web 恢复：只允许导入/校验/文件级恢复到新目录（`skippedMissing` 会剔除并在结果报告）；整库恢复仍按 `docs/BACKUP.md` §8 离线执行。
- 媒体：mp4/webm/mp3/m4a/ogg/flac/wav 可内联播放；mkv/avi 等回退下载。
- 验收：`npm run check`（234/129）、`npm run build`、`npm run test:coverage`、`npm run test:web:coverage`、`smoke.ps1 -ExpectedVersion 0.4.2`、
  Android/桌面原生新建按钮矩阵、备份导入/校验/恢复（临时 DATA_DIR）、世界备份首次执行与 PC 拉取、`drill.ps1` 演练通过；
  OpenCode 升级后按 §3.2 复验 Basic/session/垫片注入/公开入口。

## 7. 主机健康探针（vcgencmd → /run JSON）

`deploy/antifieldcloud-health.service` + `.timer` 每 60s 以 root 采集欠压/降频/温度/风扇并写
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
- 该项是发布验收的硬性检查（`smoke.ps1` 会失败），不能用“应用内存占用低”代替。

## 9. 防火墙、系统加固与世界/演练任务

### 9.1 nftables 新规则（v0.4.0）

当前 `deploy/nftables.conf`：默认 `policy drop`；loopback/established/ICMP 放行；DHCP 仅 `eth0`/`wlan0`；
**22 仅 `169.254.77.0/24` + `172.23.88.0/21`，且 `ct state new` 限速 `20/minute burst 40 packets`**；
**25565 仅同网段**（IPv6 仅 `fe80::/10`）；**25575 显式 drop**；80 不再放行；出站不限制。

```bash
# 备份 → 语法校验 → 加载 → 验证（root）
sudo cp -a /etc/nftables.conf /etc/nftables.conf.bak.$(date +%s)
sudo nft -c -f deploy/nftables.conf
sudo install -m 0644 deploy/nftables.conf /etc/nftables.conf
sudo nft -f /etc/nftables.conf
sudo systemctl enable --now nftables
sudo nft list ruleset
ss -tlnp | grep -E ':25565|:25575'
```

- **前置确认（否则会锁死 SSH）**：先确认自己当前的 SSH 来源地址在 `169.254.77.0/24` 或 `172.23.88.0/21` 内；
  不确定时先在 Pi 本机/物理键鼠旁操作，并保持一个已建立的 SSH 会话不要断开。
  实际网段按 `.local/DEPLOYMENT.md` 修改；网段宁窄勿宽。
- 期望：外部 `<Pi IP>:25575` 失败、`127.0.0.1:25575` 正常；22/25565 在允许网段内正常、其它来源不可达；
  22 频繁新建连接会被限速（暴力破解防护）。
- 回滚：`sudo cp /etc/nftables.conf.bak.<ts> /etc/nftables.conf && sudo systemctl restart nftables`；
  紧急解绑（需物理键鼠/已建立 SSH）：`sudo systemctl disable --now nftables && sudo nft flush ruleset`。
  **不要**在只有一条 SSH 连接且来源网段未确认时清空规则。

### 9.2 systemd 加固（v0.4.0）

`deploy/antifieldcloud.service` 已启用：`CapabilityBoundingSet=`（空）、`AmbientCapabilities=`、`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`、
`PrivateDevices`、`PrivateTmp`、`ProtectSystem=strict`、`ProtectHome=true`、`ReadWritePaths=/var/lib/antifieldcloud`、
`ProtectKernelTunables/Logs`、`ProtectControlGroups`、`ProtectClock/Hostname`、`RestrictNamespaces/SUIDSGID/Realtime`、
`LockPersonality`、`SystemCallArchitectures=native`、`StartLimitIntervalSec=60/StartLimitBurst=5`、`MemoryMax=512M`。

```bash
sudo cp -a /etc/systemd/system/antifieldcloud.service /var/backups/antifieldcloud/antifieldcloud.service.$(date +%s)
sudo install -m 0644 deploy/antifieldcloud.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart antifieldcloud
curl -fsS http://127.0.0.1:3000/healthz
journalctl -u antifieldcloud -n 50 --no-pager
```

- 回滚：恢复备份的 unit → `daemon-reload` → `restart`。若出现 `status=226/NAMESPACE` 或权限错误，先确认
  `ReadWritePaths` 覆盖所有实际写入目录（当前仅 `/var/lib/antifieldcloud`），再检查 `/run` 目录归属。
- 健康探针 `deploy/antifieldcloud-health.service/.timer` 与 `PI_HEALTH_FILE` 不变（§7）。
- 世界备份 unit `antifieldcloud-world.service` 也使用同类加固（整机只读、仅数据目录可写、Minecraft 目录只读、空 cap 之外仅保留必要 chown/chmod）。

### 9.3 世界备份 timer 安装与回滚

```bash
# 安装/更新（root）
sudo install -m 0644 deploy/antifieldcloud-world.service deploy/antifieldcloud-world.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now antifieldcloud-world.timer
systemctl list-timers antifieldcloud-world.timer
# 手动触发一次并检查
sudo systemctl start antifieldcloud-world.service
journalctl -u antifieldcloud-world -n 80 --no-pager
cat /var/lib/antifieldcloud/world-backup-status.json
ls -lh /var/lib/antifieldcloud/world-backups/
```

- `OnCalendar=Sun 12:00 Asia/Shanghai`（显式时区）、`Persistent=true`、`AccuracySec=1min`；`flock -w 600` 串行、
  `TimeoutStartSec=4h`；unit 只读整机、仅 `/var/lib/antifieldcloud` 可写、`/home/antifield/minecraft-server` 只读。
- 归档保留最新 4 份（含本次），旧 legacy 文件不动；状态文件 0644，`error/message` 为 ASCII 错误码 + 英文说明，
  便于 PowerShell/前端解析。
- 回滚/停用：`sudo systemctl disable --now antifieldcloud-world.timer`；需要时删除 `/etc/systemd/system/antifieldcloud-world.{service,timer}` 后
  `daemon-reload`。不要删除既有归档；确需清理按 `docs/BACKUP.md` §6.4。
- 旧世界 cron 已在验收后停用；不要同时保留 cron 与 timer，避免重复打包（见 §14）。

### 9.4 世界拉取（Windows 周任务，用户手动安装）

```powershell
# 先手动跑一次（直连网线可达；脚本在仓库 scripts/ 下，也可自行复制到固定路径）
cd "$env:USERPROFILE\projects\AntifieldCloud"
.\scripts\world-pull.ps1 -PiHost 192.0.2.10 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups"
# 创建周任务：每周日 12:00（路径/参数按实际替换）
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\Users\<user>\projects\AntifieldCloud\scripts\world-pull.ps1" -PiHost 192.0.2.10 -BackupRoot "%USERPROFILE%\AntifieldCloudBackups"'
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 12:00
Register-ScheduledTask -TaskName "AntifieldCloud-World-Pull" -Action $action -Trigger $trigger -Description "AntifieldCloud 世界备份周度拉取"
```

- 两阶段：scp `.part` → 远端 `.sha256` 比对 → 原子改名 → 删除远端归档/旁文件（ack）；**失败不 ack、不动远端**，退出码 1。
- 本地保留最新 4 份；日志 `%LOCALAPPDATA%\AntifieldCloud\world-pull.log`；远端状态写 `world-pull-status.json`。
- 回滚/停用：`Unregister-ScheduledTask -TaskName "AntifieldCloud-World-Pull" -Confirm:$false`；已拉取归档保留。
- `install-backup-task.ps1` **只安装每日应用归档任务**，不会创建世界拉取/演练任务。

### 9.5 恢复演练（drill.ps1，季度/升级前）

```powershell
cd "$env:USERPROFILE\projects\AntifieldCloud"
.\scripts\drill.ps1 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups" -ExpectedSchemaVersion 6
# 需要验证世界解包时（先确认临时盘 ≥3× 世界归档体积）
.\scripts\drill.ps1 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups" -ExpectedSchemaVersion 6 -IncludeWorld
# 回写 Pi 状态（可选）
.\scripts\drill.ps1 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups" -PiHost 192.0.2.10
```

- 只读校验 PC 上最新 full + 其后全部 inc：sidecar SHA、tar 条目安全、manifest、最新 DB `integrity_check/foreign_key_check/schema_version`；
  输出 `%BackupRoot%\drills\<UTC>\report.json|report.md`（保留 180 天，`-KeepDays` 可调）。
- 可选回写 `/var/lib/antifieldcloud/drill-status.json`（0644），Dashboard 与 `drill_stale` 告警读取；未运行状态 unknown。
- 回滚：不安装计划任务即无需回滚；删除旧报告目录即可释放空间；不要删除归档本身。
- 演练记录仍按 `docs/BACKUP.md` §7 表格补充（报告路径 + 结果 + 世界是否解包）。

### 9.6 主机加固现状（环境事实）

- **journald persistent**：`/etc/systemd/journald.conf.d/60-workbench-persistent.conf` 设
  `Storage=persistent`、`SystemMaxUse=64M`、`RuntimeMaxUse=32M`；Pi 的 `/var/log` 由 log2ram 承载，关机前同步。
- **cloudflared**：`2026.10.1`；`/etc/systemd/system/cloudflared.service.d/20-hardening.conf` 启用
  `NoNewPrivileges/PrivateTmp/ProtectSystem=full/ProtectHome` 等；回滚二进制在 `/var/backups/antifieldcloud/cloudflared-2026.8.1`。
- **rpcbind** 已禁用（111 关闭）；**fake-hwclock** load/save 已启用（无 RTC 电池时近似关机时间），NTP 仍负责校时。
- **RCON**：Paper 无 bind 配置，25575 仍监听所有接口；仅由 nftables 丢弃非 loopback 入站。
- **SSH/sudo 未改**：保留密码登录；`antifield` 用户的 `NOPASSWD ALL` sudo 属既有残留，风险见 `docs/SECURITY.md` §4。

## 10. cloudflared 加固与升级（建议）

当前 cloudflared 已通过 drop-in 加固；如需重建/复核，可按实际版本使用以下限制（验证可写路径）：

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
# 优先使用 deploy.ps1 的自动回滚；手工回滚按以下顺序（schema v6 只向上）
sudo systemctl stop antifieldcloud
sudo cp -a /var/lib/antifieldcloud/backups/db-predeploy-<最新>.sqlite /var/lib/antifieldcloud/db.sqlite
sudo rm -f /var/lib/antifieldcloud/db.sqlite-wal /var/lib/antifieldcloud/db.sqlite-shm
sudo ln -sfn /opt/antifieldcloud/releases/<上一个> /opt/antifieldcloud/current
sudo systemctl start antifieldcloud
curl -fsS http://127.0.0.1:3000/healthz
```

- 每次部署在切换前生成 `/var/lib/antifieldcloud/backups/db-predeploy-*.sqlite`（0600，保留最新 10 个）。
- **schema v6**（迁移 5 结构 + 迁移 6 孤儿分享数据修复）：迁移前会清理不可达孤儿 shares 并做 `PRAGMA foreign_key_check`，
  其它外键不一致会拒绝启动；旧代码遇到更高 schema 会拒绝启动。回滚旧 release 前必须恢复对应迁移前快照
  （`stop → 复制快照为 db.sqlite → 删除 -wal/-shm → 切 release → start`）。
- 数据恢复与全量/增量链解析、世界/密钥包恢复见 `docs/BACKUP.md` §8。
- cloudflared 回滚：`sudo cp /var/backups/antifieldcloud/cloudflared-config.yml.<ts> /etc/cloudflared/config.yml && sudo systemctl restart cloudflared`。

## 12. CI 检查

`.github/workflows/ci.yml` 在 push/PR 运行（`concurrency` 取消旧任务、各 job 有超时）：
Node 26 `npm run check` + `npm run build`；服务端覆盖率（`npm run test:coverage`）与前端覆盖率（`npm run test:web:coverage`）；
生产依赖边界（`npm ci --omit=dev` + `scripts/check-prod-deps.mjs`）；`npm audit --omit=dev --audit-level=high`；
gitleaks secret-scan；`shellcheck`（scripts/*.sh、deploy/*.sh）；`nft -c -f deploy/nftables.conf`；
Windows PowerShell job 覆盖**全部** `scripts/*.ps1` 的 PS 5.1 解析 + UTF-8 BOM 检查；Dependabot 月度更新 npm 与 GitHub Actions 依赖。
部署/备份脚本改动必须让 CI 全绿。

版本一致性（手动/后续流水线）：`node scripts/check-version.mjs` 比对 `package.json` 与 README/CHANGELOG/ACCEPTANCE/AGENTS。

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
| 指标趋势卡空白 | 新部署尚无样本（等待 60s×N）或 `METRICS_ENABLED=false`；看 `/api/metrics?range=1h` 的 `sampleCount` 与 `journalctl` 采样告警 |
| 笔记附件 413/409 | 单文件 ≤`NOTE_ATTACHMENT_MAX_BYTES`（25 MiB）、每请求 1–5、每笔记 ≤100；配额不足 409、磁盘不足 507 |
| 多文件分享 409 share_bundle | 旧单文件 `/content` 不支持多文件；公开页/客户端改用 `items/:itemId/content` |
| 世界备份 unit 失败 | `journalctl -u antifieldcloud-world`；看 `world-backup-status.json` 的 `error/message`；常见 RCON 不可达、磁盘余量不足、save-all 超时；修复后 `systemctl start antifieldcloud-world.service` |
| 世界备份未按时运行 | `systemctl list-timers antifieldcloud-world.timer`；确认 `Persistent=true` 后关机错过的运行会在下次启动补做；检查 unit 是否被 `StartLimit` 限制 |
| 世界拉取失败/不 ack | 看 PC `%LOCALAPPDATA%\AntifieldCloud\world-pull.log` 与 Pi `world-pull-status.json`；失败保留远端归档，重跑即可 |
| 世界/演练状态 unknown | 任务未安装或从未运行；面板按 unknown 展示、告警可能触发；按 §9.4/§9.5 安装并跑一次 |
| 应用了新 nftables 后 SSH 断开 | 来源网段不在 `169.254.77.0/24`/`172.23.88.0/21`；用物理键鼠或已建立连接恢复 `.bak` 并 `systemctl restart nftables` |
| 旧世界 cron 与新 timer 重复备份 | `crontab -u antifield -l` 确认无 `minecraft-backups` 行；旧归档按 §14/`docs/BACKUP.md` §6.4 手动清理 |

## 14. 磁盘清理与保留策略

- 先只读确认：`df -hT /`、`df -i /`、`du -xhd1 /`、`journalctl --disk-usage`；不要直接对 `/home` 或 `/var/lib` 做递归删除。
- 可安全清理：`apt-get clean` 的包缓存、两代以前 `/opt/antifieldcloud/releases/<old>`（保留 current/previous）、旧 `cloudflared` 备份二进制、journald vacuum（保留 7 天且 ≤ 文档上限）。
- 开发缓存需确认：`~/.local/share/pnpm/store`、`~/.nvm` 旧 Node、`~/.rustup` 非 active toolchain、`~/.cargo/registry`、`~/.npm/_cacache`；清理前确认无其他项目依赖，联网可重建。
- **不要清理**：`/var/lib/antifieldcloud`（DB/files/backups/world-backups/secrets 与状态文件）、`/var/lib/opencode`、当前与 previous release、`/var/swap`、`minecraft-server/world`、新的 `world-backups` 归档。
- **世界备份保留**：Pi `world-backups` 保留最新 4 份（脚本自动滚动）；PC `world\` 保留最新 4 份；不要手动删除 `world-<UTC>.tar.gz` 或 `.sha256`，需要释放空间时先确认更旧的 PC 副本可解包。
- **旧世界归档**：`/home/antifield/minecraft-backups` 的 3 个 legacy 归档（约 9 GiB）已于 v0.4.1 清理，旧 cron 停用；如未来再次手工生成 legacy 归档，按 `docs/BACKUP.md` §6.4 在确认 PC 副本后手动清理。
- **应用备份保留**：Pi pending 不自动删、已确认 2 份；PC `daily` 30 天、`weekly` 56 天、`secrets` 90 天；孤儿归档只报告不删除，人工核对后再清理。
- 旧内核 `/opt/jdk` 等系统组件先在 `/boot`/Java 依赖确认后再处理；保留至少一个可回退内核。
- 清理后运行 `smoke.ps1`，并记录释放量；不要清理 `preflight/age-key`。
- 旧入口/TLS：`nginx`、`certbot` 及其 `/etc/nginx`、`/etc/letsencrypt`、`/var/www/html`、80 端口已作为旧入口清理；服务监控只保留 minecraft/cloudflared/opencode。
- 频道/指标：`metrics_samples` 由应用按 30 天保留自动清理；`audit_log`/`alert_events` 90 天；`db-predeploy-*.sqlite` 保留最新 10 个；不要手工删表。
