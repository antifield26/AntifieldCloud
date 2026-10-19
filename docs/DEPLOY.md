# 部署手册（Raspberry Pi 5 / Debian 13）

> 所有 Agent 会话与人工操作都按本文件执行；涉及系统状态的操作要逐条确认。
> 目标运行位置：`/opt/antifieldcloud/current`，服务用户 `antifieldcloud`，监听 `127.0.0.1:3000`。

## 0. 拓扑与前置

- Pi：`antifield@192.0.2.10`（直连网线），WiFi 198.51.100.10（校园网）。
- 域名：`app.example.com`（应用）、`ai.example.com`（opencode 反代），Cloudflare Tunnel `antifieldcloud`。
- 现有服务不改：Minecraft、SakuraFRP、opencode、nginx、RDP/桌面。
- 本仓库从 Windows PC 通过 SSH 部署；PC 需有 `C:\Users\<user>\.ssh\id_ed25519`。

## 1. 首次系统初始化（已在本次部署执行，保留供重装）

```bash
sudo apt-get update
sudo apt-get install -y nftables

# 服务账号（无登录 shell、无 sudo）
sudo addgroup --system antifieldcloud
sudo adduser --system --ingroup antifieldcloud --home /var/lib/antifieldcloud \
  --shell /usr/sbin/nologin --no-create-home antifieldcloud

# 数据目录
sudo install -d -o antifieldcloud -g antifield -m 0750 /var/lib/antifieldcloud
sudo install -d -o antifieldcloud -g antifieldcloud -m 0700 /var/lib/antifieldcloud/files /var/lib/antifieldcloud/tmp
sudo install -d -o antifieldcloud -g antifield -m 2770 /var/lib/antifieldcloud/backups
sudo install -d -o root -g root -m 0755 /opt/antifieldcloud/releases /etc/antifieldcloud

# 防火墙（仓库 deploy/nftables.conf）
sudo nft -c -f deploy/nftables.conf
sudo install -m 0644 deploy/nftables.conf /etc/nftables.conf
sudo nft -f /etc/nftables.conf
sudo systemctl enable --now nftables

# systemd 单元
sudo install -m 0644 deploy/antifieldcloud.service /etc/systemd/system/
sudo systemctl daemon-reload
```

## 2. 生成环境文件

先部署一次代码（第 3 节，服务可先不启动），再执行：

```bash
cd /opt/antifieldcloud/current
sudo bash scripts/bootstrap-env.sh
sudo ls -l /etc/antifieldcloud/env   # 应为 -rw-r----- root antifieldcloud
```

`bootstrap-env.sh` 从 `~/minecraft-server/server.properties` 读取 RCON 密码、从
`/etc/opencode/opencode.env` 读取 `OPENCODE_PASSWORD`，写入 `/etc/antifieldcloud/env`，不回显密钥。
如文件已存在，使用 `sudo bash scripts/bootstrap-env.sh --force`。
脚本中的 `example.com` 域名是占位值；部署到真实域名前，请修改 `APP_ORIGIN`、`AI_ORIGIN`、
`COOKIE_DOMAIN`、`MC_PUBLIC_ADDRESS`。

## 3. 从 PC 部署

```powershell
cd "$env:USERPROFILE\projects\AntifieldCloud"
npm run check
.\scripts\deploy.ps1 -PiHost 192.0.2.10   # 替换为 Pi 实际直连地址
```

`deploy.ps1` 会：运行检查 → Vite 构建 → 打包 → 上传到 `/opt/antifieldcloud/releases/<UTC>` →
`npm ci --omit=dev --ignore-scripts` → 切换 `current` → `systemctl restart antifieldcloud` → 健康检查 → 保留 3 个 release。

手工等价步骤：

```bash
sudo mkdir -p /opt/antifieldcloud/releases/<ts>
sudo tar -xzf /tmp/antifieldcloud-<ts>.tar.gz -C /opt/antifieldcloud/releases/<ts>
cd /opt/antifieldcloud/releases/<ts>
sudo /usr/local/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund
sudo ln -sfn /opt/antifieldcloud/releases/<ts> /opt/antifieldcloud/current
sudo systemctl restart antifieldcloud
curl -fsS http://127.0.0.1:3000/healthz
```

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
`ingress` 为仓库 `deploy/cloudflared-ingress.yml` 的内容：

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
```

**DNS 由用户在 Cloudflare 后台手动添加**（现有 `cert.pem` 是隧道 token，不是账号证书，CLI 无 DNS 权限）：

| 类型 | 名称 | 内容 | 代理 |
|---|---|---|---|
| CNAME | `app` | `<TUNNEL_UUID>.cfargotunnel.com` | Proxied（橙色云） |
| CNAME | `ai` | `<TUNNEL_UUID>.cfargotunnel.com` | Proxied（橙色云） |

> 不要修改 `mc.example.com`：它当前 CNAME 到 SakuraFRP（`frp-rib.com`），与工作台无关。

## 6. 验证

本机（Pi 上）：

```bash
curl -fsS http://127.0.0.1:3000/healthz
curl -H 'Host: app.example.com' -fsS http://127.0.0.1:3000/healthz
```

公网（DNS 生效后）：

```powershell
.\scripts\smoke.ps1 -PiHost 192.0.2.10 -AppUrl https://app.example.com -AiUrl https://ai.example.com
```

Windows 备份计划任务需要**管理员 PowerShell**：

```powershell
.\scripts\install-backup-task.ps1 -PiHost 192.0.2.10 -BackupRoot "$env:USERPROFILE\AntifieldCloudBackups"
```

手工检查：`https://app.example.com` 登录、上传/预览、Dashboard MC 状态、白名单增删；
`https://ai.example.com` 登录后进入 opencode。若 opencode 仍要求输入自身密码，属于其 UI 行为，
从 Pi `sudo grep OPENCODE_PASSWORD /etc/opencode/opencode.env` 获取后输入一次即可（不写入前端）。

## 7. 防火墙验证与回滚

```bash
sudo /usr/sbin/nft list ruleset
ss -tlnp | grep -E ':25565|:25575'
```

- 期望：外部访问 `192.0.2.10:25575` 失败；`22`、`25565` 正常；`127.0.0.1:25575` 正常。
- 解绑/回滚：`sudo systemctl disable --now nftables && sudo nft flush ruleset`（需物理键鼠或已建立的 SSH）。

## 8. 应用回滚

```bash
ls -1dt /opt/antifieldcloud/releases/*
sudo ln -sfn /opt/antifieldcloud/releases/<上一个> /opt/antifieldcloud/current
sudo systemctl restart antifieldcloud
curl -fsS http://127.0.0.1:3000/healthz
```

数据库迁移前由部署脚本产生的备份位于 `/var/lib/antifieldcloud/backups`；恢复见 `docs/BACKUP.md`。
cloudflared 回滚：`sudo cp /var/backups/antifieldcloud/cloudflared-config.yml.<ts> /etc/cloudflared/config.yml && sudo systemctl restart cloudflared`。

## 9. 常见问题

| 现象 | 处理 |
|---|---|
| `deploy.ps1` SSH 超时 | 直连网线偶发丢包；脚本自带重试；检查 PC 网卡节能、网线、Pi `eth0` |
| `npm ci` 失败 | 确认 Pi 可访问 npm registry；使用 `/usr/local/bin/npm`；查看 `journalctl -u antifieldcloud` |
| 公网 502 | `systemctl status cloudflared`；确认 app 在 3000 监听；DNS 是否 Proxied |
| 登录 429 | 15 分钟内失败次数过多；等待或重启应用清空内存限流 |
| 白名单 502 | RCON 不可用：`ss -tlnp | grep 25575`，`sudo journalctl -u minecraft` |
| `ai` 二次密码 | opencode 自身 Basic UI；按第 6 节输入一次，后续浏览器记住 |
| 磁盘占用 | `df -h /`、`du -sh /var/lib/antifieldcloud/*`；配额 10 GiB；备份保留 2 份 |
| 公网页面空白 / 入口脚本未执行 | Cloudflare Rocket Loader 可能改写 `type="module"`；本仓库构建已为入口脚本加 `data-cfasync="false"`。若仍异常，在 Cloudflare Speed → Optimization 关闭 Rocket Loader |
| 校园网暂时无法解析 app/ai | 公网记录已生效时，通常是递归 DNS 的 NXDOMAIN 负缓存（约 30 分钟）；等待或用手机流量验证。不要修改 `mc.example.com` |
