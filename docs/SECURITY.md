# 安全说明

## 1. 资产与信任边界

- **公网入口**：`app.example.com`、`ai.example.com` 经 Cloudflare Tunnel（名称 `pi`，出站）；Cloudflare 终止 TLS，可见明文。
- **Pi 本机**：应用只监听 `127.0.0.1:3000`；cloudflared 出站连接；opencode `127.0.0.1:4096`；nginx/certbot 旧入口已移除。
- **现有服务**：Minecraft（Paper 26.1.2，在线模式关闭、白名单开启）、SakuraFRP、RDP/桌面、opencode。
- **秘密**：`/etc/antifieldcloud/env`（RCON/opencode 密码、APP_VERSION）、SQLite（TOTP secret、会话哈希、恢复码哈希）、
  备份归档（普通归档含 TOTP/会话，密钥包 age 加密）、离线 age 私钥。
- **数据与状态**：`/var/lib/antifieldcloud`（DB/files/backups/world-backups/secrets）、只读状态文件
  `{world-backup,world-pull,drill}-status.json`（0644，由 root/PC 脚本写入，应用只读）。

## 2. 威胁模型

| 威胁 | 影响 | 控制 |
|---|---|---|
| 互联网暴力破解登录 | 账号接管 | scrypt、TOTP、每 IP 5 次/15 分钟限流、全局 60 次/小时（loopback 免占）、统一错误、300 ms 失败延迟 |
| 会话劫持/CSRF | 未授权文件/白名单操作 | HttpOnly+Secure+SameSite=Lax Cookie、CSRF 双提交、Origin 校验、改密失效其它会话 |
| 跨站借用 opencode 会话 | 以用户身份操作 AI 工作区 | ai 主机 HTTP/WS 均校验 `Origin`（仅 app/ai 正式 origin），拒绝 403 + 审计 |
| 路径穿越/任意文件读取 | 读取/覆盖 Pi 文件 | 只接受 DB id；物理路径由 id 派生；文件名清洗；无路径参数 |
| 恶意预览内容 XSS | 窃取会话 | 仅栅格图片/PDF/白名单音视频内联；文本走 JSON 由 React 转义；SVG/HTML/XML 强制下载；CSP `media-src 'self'` |
| 上传耗尽磁盘 | 服务不可用 | 10 GiB 配额（含回收站与笔记附件）、单请求 100 MiB/20 文件、分片单文件 5 GiB/8 MiB 块；写前/流中/事务内检查、507；分片会话 24h 过期、3 并发/用户 |
| 笔记附件越权展示 | 隐私附件出现在云盘/搜索/分享 | `files.origin='note'` 隔离：用户列表/搜索/回收站/分享只接受 `origin='user'`；附件仅经笔记接口管理 |
| 多文件分享越权枚举 | 拿到不属于该分享的文件 | 公开 `items/:itemId/content` 校验条目归属（否则 404 `share_item_not_found`）；未解锁不返回文件清单 |
| opencode 端口被直接访问 | AI 工作区被滥用 | 端口仅 loopback；ai 主机会话校验；服务端注入 Basic；不向浏览器下发密钥 |
| RCON 被滥用 | 白名单/服务器被改 | 应用 API 不提供任意命令；仅白名单增删与只读状态；世界备份 root 脚本只发固定 save 命令；nftables 阻断非 loopback |
| 备份泄露 | 文件与 TOTP 泄露 | 两阶段 pending/ack、归档 0640、PC 目录 ACL（当前用户+Administrators+SYSTEM）、`.sha256` 旁文件；密钥包 age 加密；普通归档仍含 TOTP |
| 备份归档被恶意替换/注入 | 文件覆盖/路径穿越/压缩炸弹 | Web 导入需 TOTP；文件名白名单、SHA-256、tar 路径/链接/设备/条目大小校验；快照行数与数据库快照大小上限；恢复只到新目录、不覆盖；整库恢复仅离线 root CLI |
| 备份解包耗尽磁盘/内存 | 服务不可用 | staging 上限 2 GiB 且 ≤可用空间 20%；恢复按选择字节 ×2 预检；快照最多 10 万行、DB 快照 ≤256 MiB；归档浏览 30 次/分钟 |
| 世界备份期间丢数据 | 世界存档损坏 | `save-on` 放 finally 并重试；gzip 完整性 + SHA 校验后才原子改名；保留 4 份；失败状态 JSON 可见 |
| 物理 SD 丢失 | 数据泄露/丢失 | 无全盘加密（当前限制）；建议后续 LUKS/加密备份；应用归档 + 世界备份到 PC |
| 校园网扫描 | RCON/Minecraft 暴露 | nftables 默认拒绝入站；25575 仅 loopback；25565 仅直连/校园网段 |
| 供应链/依赖 | 代码执行 | 运行时依赖少；`npm ci --ignore-scripts`；不做服务端构建；CI `npm audit --omit=dev`、gitleaks、Dependabot |

## 3. 已实现控制

### 网络

- 应用绑定 127.0.0.1；公网唯一入口为 Cloudflare Tunnel（出站）。
- nftables（`deploy/nftables.conf`）：默认 drop 入站；loopback/established/ICMP 放行；
  **22 仅 `169.254.77.0/24` + `172.23.88.0/21`，且 `ct state new` 限速 5/minute burst 10**；
  **25565 仅同网段**（IPv6 仅 `fe80::/10`）；25575 显式 drop；DHCP 续租仅 `eth0`/`wlan0`；80 不再放行。
- 不在 Pi 上开 3000/4096 的任何外部监听；credentialed 服务（RCON/opencode）仅 loopback。

### 认证

- scrypt（N=2^15, r=8, p=1，64 B key，16 B 随机盐），恒定时间比较；用户不存在时执行等价哈希。
- TOTP：RFC 6238 SHA-1/6 位/30 秒，±1 步，记录 `totp_last_step` 防重放；恢复码 10 个，一次性，SHA-256 存储。
- 挑战 5 分钟一次性；会话 7 天；Cookie 属性按协议严格设置；密码最少 12 字符；改密注销其它会话。
- 限流：登录每 IP 5 次/15 分钟、全局 60 次/小时（loopback 不占全局桶）；TOTP 全局 120 次/小时；
  再认证每 IP 5 次/15 分钟 + 全局 30 次/小时 + TOTP 共享桶；失败审计与恒定延迟。
- 未认证用户名 ≤64 字符（超长直接 400）；审计写入 actor≤64、target≤256、detail≤4 KiB，读取时再次截断。

### 文件与分享

- 物理路径 `files/<id 前两位>/<id>`，id 由服务端生成；无用户路径拼接。
- 名称 NFC、去控制字符/路径分隔符、长度限制、冲突自动后缀；同目录同 origin 唯一索引。
- 内容不可变（无在线编辑）；上传先写临时文件再原子移动；配额包含回收站与笔记附件；删除为软删除；30 天自动清理。
- `files.origin` 隔离：`user`（云盘）/`note`（附件）/`system`；用户可见查询与目录操作只作用于 `origin='user'`。
- 笔记附件：只经 `GET/POST/DELETE /api/notes/:id/attachments` 管理；单文件 ≤25 MiB、每请求 1–5、每笔记 ≤100；计入配额；删除笔记硬删附件；维护任务清理孤儿附件。
- 分片上传：会话只按服务端 id 访问，块序号/大小由会话约束；临时目录 0700/文件 0600；complete 重新拼接并校验 SHA；24h 过期/取消释放配额与临时文件；不缓存文件内容到 localStorage。
- MIME/预览白名单；音视频仅允许 mp4/webm/mp3/m4a/ogg/flac/wav，不转码；`X-Content-Type-Options: nosniff`；下载 `Content-Disposition` 文件名编码。
- 分享：token 只存 SHA-256；新建密码 ≥8 位（旧短密码分享仍可解锁）；公开 POST 校验 Origin；
  限流（创建 30/min、metadata 120/min、unlock 8/15min、content 240/min）；`af_share` 5 分钟 HttpOnly Cookie，Path 限定单 token；
  下载次数按会话计且仅在内容流完整读完后 +1；文件删除/回收站吊销整个分享（含作为条目之一的分享）。

### HTTP

- CSP：`default-src 'self'; script-src 'self'; media-src 'self'; frame-ancestors 'self'; object-src 'none'` 等。
- `X-Frame-Options: SAMEORIGIN`（同源 PDF 预览）、`Referrer-Policy: no-referrer`、`Permissions-Policy` 最小化。
- API 全部 `no-store`；错误响应不含堆栈；日志脱敏 Cookie/Authorization/密码/TOTP。
- 公开分享页 `X-Robots-Tag: noindex, nofollow`；指标/存储/审计/备份接口均需会话。

### 运维

- 服务用户 `antifieldcloud` 无 shell/无 sudo；systemd 只读系统、仅数据目录可写、`NoNewPrivileges`、`MemoryMax=512M`、
  `CapabilityBoundingSet=`（空）、`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`、`PrivateDevices`、
  `ProtectClock/Hostname/KernelLogs`、`RestrictNamespaces/SUIDSGID/Realtime`、`LockPersonality`、`StartLimit`。
  `MemoryMax` 依赖内核 memory cgroup：`/sys/fs/cgroup/cgroup.controllers` 必须包含 `memory`（检查见 docs/DEPLOY.md §8）。
- 世界备份 unit：`User=root`、`ProtectSystem=strict`、`ProtectHome=read-only`、`ReadOnlyPaths=/home/antifield/minecraft-server`、
  `ReadWritePaths=/var/lib/antifieldcloud`、`flock -w 600`、`TimeoutStartSec=4h`、`Nice`/IO 降优先级。
- 环境文件 0640 root:antifieldcloud；非敏感部署值放 `/etc/antifieldcloud/deploy.conf`（root 只读）；
  仓库/CI 不含秘密，实际部署值只记录在 gitignored 的 `.local/DEPLOYMENT.md`。
- 部署脚本：上传后校验 tar SHA-256、远端 package.json 与本地版本一致、磁盘 ≥2 GiB + 包体预检；切换前
  `backup.mjs --snapshot-db`；注入 `APP_VERSION` 并断言 `/healthz.version`；失败先停服、还原迁移前 DB 快照、切回 previous、重启复检；
  release 保留 3 个且清理保护 current/previous；部署后跑只读 smoke 子集。
- CI：`npm run check` + `npm run build`、服务端/前端覆盖率门禁、生产依赖边界、`npm audit --omit=dev --audit-level=high`、
  gitleaks secret-scan、shellcheck、nftables 语法、全部 `scripts/*.ps1` 的 PS 5.1 解析/BOM 检查；concurrency 取消旧任务、作业超时。
- 备份两阶段：`--prepare` 只生成 pending，`--ack` 校验 SHA-256 后才推进游标；pending 未确认不删除；
  已确认归档最多 2 个；归档 0640；PC 原子改名并写 `.sha256` 旁文件；`.part` 成功后才原子改名。
- 备份 CLI：pending 只统计 `origin='pi'`（Web 导入不参与 ack）；物理文件缺失记录为 `skippedMissing` 不中断；
  归档快照行数 ≤10 万、DB 快照 ≤256 MiB、staging ≤2 GiB/20%；归档浏览 30 次/分钟。
- 密钥包：`backup-secrets.sh` 用 age 公钥加密 env/cloudflared/Minecraft/opencode 配置与 opencode DB 快照；
  明文临时目录优先 `/run/antifieldcloud/secrets-tmp`（tmpfs，0700），退出清理；opencode 快照失败只降级警告；
  Pi `KEEP=2` 滚动保留；私钥只离线保存。
- 备份状态分开记录 `secretsOk/secretsLastError/lastSecretsAt`；密钥包失败不冒充文件备份成功。
- 主机健康探针：root 每 60s 写 `/run/antifieldcloud/pi-health.json`（0644，含欠压/降频/温度/风扇），告警模块只读。
- 世界/拉取/演练状态：脚本写 0644 JSON，应用只读；文件缺失时面板/告警降级 unknown；状态不含密钥或绝对路径。

## 4. 残留风险（按用户选择保留）

1. **SSH 密码登录保留、无 fail2ban**：公网未转发 22，只在直连/校园网段可达；新 nftables 已把 22 限制到
   `169.254.77.0/24` + `172.23.88.0/21` 并限制新建连接速率，但仍建议改仅公钥 + fail2ban。
   **注意：若管理员当前来源不在允许网段内，应用新规则会锁死 SSH；须先确认来源网段并保留物理键鼠/已建立连接。**
2. **Pi 登录用户 `antifield` 拥有 `NOPASSWD ALL` sudo（既有残留，未修改）**：任何拿到 `antifield` 账号的人可提权为 root；
   `antifieldcloud` 服务用户本身无 sudo。建议后续按用户确认收紧 sudoers。
3. **RCON 已轮换为 32 位随机密码，但仍监听 0.0.0.0（Paper 无 bind 配置）**：nftables 仅放行 loopback；
   本机被攻破仍可控制 RCON。世界备份脚本以 root 使用固定命令，扩大了 RCON 凭据的暴露面（仅 root 可读）。
4. **无 Cloudflare Access**：Cloudflare 边缘只有 TLS，账号安全完全依赖应用 TOTP；建议给 Cloudflare 账号开启 2FA。
5. **Cloudflare 可见明文**：文件内容与登录流量对 Cloudflare 可见；敏感数据可考虑后续应用层加密。
6. **单管理员、无多用户/权限分离**：审计日志可被管理员删除；适合个人使用。
7. **普通备份归档仍含 TOTP secret 与文件内容**：PC 端 ACL 与物理安全是最后防线；密钥包已用 age 加密，
   后续可评估整包加密（restic/age）与异地副本。age 私钥丢失将无法恢复密钥包。
8. **世界备份依赖 RCON 与 Minecraft 运行**：服务器未运行时备份失败（状态 JSON 可见）；`save-off` 期间若进程崩溃，
   `save-on` 会重试/需人工恢复保存。旧 `minecraft-backups` 9 GiB 归档不自动删除，需手动清理。
9. **opencode 自身认证/UI 行为随版本变化**：当前通过注入 Basic 实现 SSO；升级后需复测。原生新建按钮在上游部分版本有缺陷，
   失败时保留最小隐藏点击接管（无可见 UI）。
10. **无 WAF/DDoS 防护**：Cloudflare 默认防护有限；大文件上传/登录仍可能消耗资源（有配额/限流）。
11. **SD 卡无加密**：设备丢失即数据泄露；可后续迁移 SSD + LUKS。
12. **限流在内存中**：应用重启清零；对分布式攻击效果有限。
13. **Cloudflare 自动注入与严格 CSP 冲突**：Web Analytics/Challenge 脚本被 CSP 拦截；需在 Cloudflare 后台关闭自动注入或接受报错；
    不建议放开 `script-src` 内联。
14. **scrypt 仍为 N=2^15**：升级到 2^16/2^17 需要密码哈希版本迁移，列入后续。
15. **`http-proxy` 在 Node 26 有 `util._extend` 弃用警告**：Node 27 前需评估替换。
16. **Cloudflare 约 100 MiB/100s 限制**：普通上传仍受单请求限制；分片承载 5 GiB 文件，但总时长仍受 Cloudflare/网络影响。
17. **Windows 世界拉取/演练任务需用户手动安装**：未安装时面板为 unknown、告警可能触发；任务本身以当前用户运行，依赖直连网线与 SSH 公钥。

## 5. 运维安全清单

- 每月 `sudo apt-get update && sudo apt-get upgrade`（Minecraft 重启需选择窗口）；关注安全更新与 cloudflared 版本提示。
- 每周检查：应用备份 pending 是否堆积、`backup-pull.json` 是否超过 48h、PC 归档 `.sha256`、
  世界备份/世界拉取状态是否新鲜（`world-backup-status.json`/`world-pull-status.json`）、计划任务 `LastTaskResult`；
  日志 `%LOCALAPPDATA%\AntifieldCloud\backup.log`、`world-pull.log`。
- 每月检查：`systemctl --failed`、`journalctl -u antifieldcloud -p warning`、`nft list ruleset`（确认 22 来源网段）、
  `/sys/fs/cgroup/cgroup.controllers` 含 `memory`、`vcgencmd get_throttled`、`vcgencmd measure_temp`、磁盘/内存余量、
  `crontab -l` 不含旧 `minecraft-backups` 行。
- 每季度检查：恢复演练（`scripts/drill.ps1` 或按 docs/BACKUP.md §7 手动执行并记录）、
  `cloudflared tunnel info` 连接与版本、Windows 备份目录 ACL 是否仍仅白名单主体、age 公钥/私钥保管情况、
  世界备份保留 4 份/PC 保留 4 份是否正常。
- 怀疑泄露时：
  1. 登录设置页“退出全部会话”；
  2. CLI 重置密码/TOTP；
  3. 轮换 RCON/opencode 密码（`bootstrap-env.sh --force` 后重启应用；非敏感配置会沿用现有值）；
  4. 重新生成 age 密钥包并离线保管私钥；
  5. 检查审计日志、`journalctl`、备份 pending 与世界/演练状态文件；
  6. 从备份恢复可疑文件。
- 不要在聊天、截图、issue 中粘贴密码、TOTP 密钥、恢复码、隧道 token、age 私钥。

## 6. 安全验收（已覆盖）

- 未登录 `/api/*` 401；`/api/metrics`、`/api/storage`、`/api/backups`、`/api/shares` 均需会话；ai 未登录 HTML 302、API 401。
- 缺少 CSRF 的写请求 403；公开分享 POST 缺少/非法 Origin 403。
- 非法 Host 404；opencode 非法 Origin（HTTP/WS）403 且审计 `opencode_origin_rejected`。
- 路径穿越名被清洗；SVG/HTML 无内联预览；音视频只允许白名单容器。
- 笔记附件不出现在 `/api/files`、搜索、回收站；跨分享 `itemId` 404；多文件旧 `/content` 409。
- 分享密码新建最少 8 位；公开信息不含备注；回收站文件旧分享返回 410；token 日志脱敏。
- 备份管理：导入需 TOTP、tar 安全校验、恢复仅新目录、计划过期/单并发；整库恢复不暴露 Web；
  归档浏览限流；`skippedMissing` 不整体失败。
- 超配额上传拒绝；回收站/附件占配额；普通单请求受 `MAX_UPLOAD_BYTES`（默认 100 MiB）限制；分片上传受 5 GiB 上限、8 MiB 块、会话过期/并发限制与配额预留约束。
- 外部 25575 阻断；22/25565 仅允许网段；内存 cgroup 含 `memory`；备份 pending/48h 状态与 PC `.sha256` 旁文件（见 `scripts/smoke.ps1`）。
- 世界备份/拉取/演练状态文件存在且新鲜（smoke 对缺失 WARN、失败/超期 FAIL）；世界备份归档 SHA/旁文件可校验。
- 仓库 `git grep` 不出现真实密钥；gitleaks CI 通过。
