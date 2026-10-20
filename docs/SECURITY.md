# 安全说明

## 1. 资产与信任边界

- **公网入口**：`app.example.com`、`ai.example.com` 经 Cloudflare Tunnel；Cloudflare 终止 TLS，可见明文。
- **Pi 本机**：应用只监听 `127.0.0.1:3000`；cloudflared 出站连接；opencode `127.0.0.1:4096`；nginx/certbot 旧入口已移除。
- **现有服务**：Minecraft（Paper 26.1.2，在线模式关闭、白名单开启）、SakuraFRP、RDP/桌面、opencode。
- **秘密**：`/etc/antifieldcloud/env`（RCON/opencode 密码）、SQLite（TOTP secret、会话哈希、恢复码哈希）、备份归档。

## 2. 威胁模型

| 威胁 | 影响 | 控制 |
|---|---|---|
| 互联网暴力破解登录 | 账号接管 | scrypt、TOTP、每 IP 5 次/15 分钟限流、全局 20 次/小时、统一错误、300 ms 失败延迟 |
| 会话劫持/CSRF | 未授权文件/白名单操作 | HttpOnly+Secure+SameSite=Lax Cookie、CSRF 双提交、Origin 校验、改密失效其它会话 |
| 路径穿越/任意文件读取 | 读取/覆盖 Pi 文件 | 只接受 DB id；物理路径由 id 派生；文件名清洗；无路径参数 |
| 恶意预览内容 XSS | 窃取会话 | 仅栅格图片/PDF/白名单音视频内联；文本走 JSON 由 React 转义；SVG/HTML/XML 强制下载；CSP `media-src 'self'` |
| 上传耗尽磁盘 | 服务不可用 | 10 GiB 配额（含回收站）、单请求 100 MiB/20 文件、分片单文件 5 GiB/8 MiB 块；写前/流中/事务内检查、507；分片会话 24h 过期、3 并发/用户、配额预留 |
| opencode 端口被直接访问 | AI 工作区被滥用 | 端口仅 loopback；ai 主机会话校验；服务端注入 Basic；不向浏览器下发密钥 |
| RCON 被滥用 | 白名单/服务器被改 | 不提供任意命令；仅白名单增删；名字白名单校验；命令后复核；nftables 阻断非 loopback |
| 备份泄露 | 文件与 TOTP 泄露 | 两阶段 pending/ack、归档 0640、PC 目录 ACL（当前用户+Administrators+SYSTEM）、`.sha256` 旁文件；密钥包 age 加密；普通归档仍含 TOTP |
| 备份归档被恶意替换/注入 | 文件覆盖/路径穿越 | Web 导入需 TOTP；文件名白名单、SHA-256、tar 路径/链接/设备/大小校验；恢复只到新目录、不覆盖；整库恢复仅离线 root CLI |
| 物理 SD 丢失 | 数据泄露/丢失 | 无全盘加密（当前限制）；建议后续 LUKS/加密备份；每日备份 |
| 校园网扫描 | RCON/Minecraft 暴露 | nftables 默认拒绝入站；25575 仅 loopback；25565 限网段 |
| 供应链/依赖 | 代码执行 | 运行时依赖少；`npm ci --ignore-scripts`；不做服务端构建 |

## 3. 已实现控制

### 网络
- 应用绑定 127.0.0.1；公网唯一入口为 Cloudflare Tunnel（出站）。
- nftables：默认 drop 入站；loopback/established/ICMP 放行；22 放行；80/25565 仅 `169.254.0.0/16` 与 `198.51.100.0/24`；25575 仅 loopback。
- 不在 Pi 上开 3000/4096 的任何外部监听。

### 认证
- scrypt（N=2^15, r=8, p=1，64 B key，16 B 随机盐），恒定时间比较；用户不存在时执行等价哈希。
- TOTP：RFC 6238 SHA-1/6 位/30 秒，±1 步，记录 `totp_last_step` 防重放。
- 恢复码 10 个，一次性，SHA-256 存储。
- 挑战 5 分钟一次性；会话 7 天；Cookie 属性按协议严格设置。
- 密码最少 12 字符；改密会注销其它会话。

### 文件
- 物理路径 `files/<id 前两位>/<id>`，id 由服务端生成；无用户路径拼接。
- 名称 NFC、去控制字符/路径分隔符、长度限制、冲突自动后缀；同目录唯一索引。
- 内容不可变（无在线编辑）；上传先写临时文件再原子移动。
- 配额包含回收站；删除为软删除；30 天自动清理。
- 分片上传（v0.3.1）：会话只按服务端 id 访问，块序号/大小由会话约束；临时目录 `tmp/chunks` 0700、文件 0600；块哈希记录、complete 重新拼接并校验 SHA；24h 过期/取消释放配额与临时文件；每用户 3 个活跃会话；不缓存文件内容到 localStorage（只存 uploadId/块号）。
- MIME/预览白名单；音视频仅允许 mp4/webm/mp3/m4a/ogg/flac/wav，不转码；`X-Content-Type-Options: nosniff`；下载 `Content-Disposition` 文件名编码。

### HTTP
- CSP：`default-src 'self'; script-src 'self'; media-src 'self'; frame-ancestors 'self'; object-src 'none'` 等。
- `X-Frame-Options: SAMEORIGIN`（同源 PDF 预览）、`Referrer-Policy: no-referrer`、`Permissions-Policy` 最小化。
- API 全部 `no-store`；错误响应不含堆栈。
- 日志脱敏：Cookie/Authorization/密码/TOTP 字段。

### 运维
- 服务用户 `antifieldcloud` 无 shell/无 sudo；systemd 只读系统、仅数据目录可写、`NoNewPrivileges`、`MemoryMax=512M`。
  `MemoryMax` 依赖内核 memory cgroup：`/sys/fs/cgroup/cgroup.controllers` 必须包含 `memory`，若内核命令行带
  `cgroup_disable=memory` 则限制不生效（检查方法见 docs/DEPLOY.md §8，smoke 会失败）。
- 环境文件 0640 root:antifieldcloud；非敏感部署值放 `/etc/antifieldcloud/deploy.conf`（root 只读）；
  仓库/CI 不含秘密，实际部署值只记录在 gitignored 的 `.local/DEPLOYMENT.md`。
- 部署脚本：切换前 `backup.mjs --snapshot-db` 做一致性 DB 快照；健康检查失败自动切回上一 release 并复检；
  release 保留 3 个且清理保护 current/previous；tar 包包含 LICENSE。
- 备份两阶段：`--prepare` 只生成 pending，`--ack` 校验 SHA-256 后才推进游标；pending 未确认不删除；
  已确认归档最多 2 个；归档 0640；PC 原子改名并写 `.sha256` 旁文件。
- Windows 备份目录由 `install-backup-task.ps1` 用 `icacls` 收紧为当前用户 + Administrators + SYSTEM；
  任务在电池供电时不跳过、安装前做 Pi 可达性预检、日志 >1 MiB 轮转。
- 密钥包：`backup-secrets.sh` 用 age 公钥加密 `/etc/antifieldcloud/env`、cloudflared 配置/凭证、
  `server.properties`、opencode env 及 opencode DB/config（一致性快照）；私钥只离线保存，PC 拉取 `.age` + `.sha256`。
- 备份状态分开记录 `secretsOk/secretsLastError/lastSecretsAt`；密钥包失败不冒充文件备份成功，告警可读。
- 主机健康探针：root 每 60s 写 `/run/antifieldcloud/pi-health.json`（0644，含欠压/降频/温度/风扇），
  告警模块只读该文件；探针失败不影响主服务。

## 4. 残留风险（按用户选择保留）

1. **RCON 已轮换为 32 位随机密码，但仍监听 0.0.0.0（Paper 无 bind 配置）**：nftables 仅放行 loopback；
   本机被攻破仍可控制 RCON。后续可评估 systemd 网络命名空间/firewalld 细化。
2. **SSH 密码登录开启、无 fail2ban**：当前公网未转发 22，只在直连/校园网可达；仍建议改为仅公钥 + fail2ban。
3. **无 Cloudflare Access**：Cloudflare 边缘只有 TLS，账号安全完全依赖应用 TOTP；建议给 Cloudflare 账号开启 2FA。
4. **Cloudflare 可见明文**：文件内容与登录流量对 Cloudflare 可见；敏感数据可考虑后续应用层加密。
5. **单管理员、无多用户/权限分离**：审计日志可被管理员删除；适合个人使用。
6. **普通备份归档仍含 TOTP secret 与文件内容**：PC 端 ACL 与物理安全是最后防线；密钥包已用 age 加密，
   后续可评估整包加密（restic/age）与异地副本。age 私钥丢失将无法恢复密钥包。
7. **opencode 自身认证/UI 行为随版本变化**：当前通过注入 Basic 实现 SSO；升级后需复测。原生新建按钮在上游部分版本有缺陷；v0.3 先关闭 Cloudflare Rocket Loader/升级验证，失败才保留最小隐藏点击接管（无可见 UI）。
8. **无 WAF/DDoS 防护**：Cloudflare 默认防护有限；大文件上传/登录仍可能消耗资源（有配额/限流）。
9. **SD 卡无加密**：设备丢失即数据泄露；可后续迁移 SSD + LUKS。
10. **限流在内存中**：应用重启清零；对分布式攻击效果有限。
11. **Cloudflare 自动注入与严格 CSP 冲突**：Web Analytics/Challenge 脚本被 CSP 拦截；需在 Cloudflare 后台关闭
    自动注入，或接受控制台报错；不建议放开 `script-src` 内联。
12. **scrypt 仍为 N=2^15**：升级到 2^16/2^17 需要密码哈希版本迁移，列入后续。
13. **`http-proxy` 在 Node 26 有 `util._extend` 弃用警告**：Node 27 前需评估替换。
14. **Cloudflare 约 100 MiB/100s 限制**：普通上传仍受单请求限制；v0.3.1 用 8 MiB 分片承载 5 GiB 文件，但总时长仍受 Cloudflare/网络影响。

## 5. 运维安全清单

- 每月 `sudo apt-get update && sudo apt-get upgrade`（Minecraft 重启需选择窗口）；关注
  `apt-get -s upgrade` 的安全更新与 cloudflared 版本提示。
- 每周检查：备份 pending 是否堆积、`backup-pull.json` 是否超过 48h、PC 归档是否有 `.sha256` 旁文件、
  计划任务 `LastTaskResult`；日志 `%LOCALAPPDATA%\AntifieldCloud\backup.log`。
- 每月检查：`systemctl --failed`、`journalctl -u antifieldcloud -p warning`、`nft list ruleset`、
  `/sys/fs/cgroup/cgroup.controllers` 含 `memory`、`vcgencmd get_throttled`、`vcgencmd measure_temp`、
  磁盘/内存余量。
- 每季度检查：恢复演练（按 docs/BACKUP.md §6 解包并记录到 §7）、`cloudflared tunnel info` 连接与版本、
  Windows 备份目录 ACL 是否仍无 Authenticated Users/Users、age 公钥/私钥保管情况。
- 怀疑泄露时：
  1. 登录设置页“退出全部会话”；
  2. CLI 重置密码/TOTP；
  3. 轮换 RCON/opencode 密码（`bootstrap-env.sh --force` 后重启应用；非敏感配置会沿用现有值）；
  4. 重新生成 age 密钥包并离线保管私钥；
  5. 检查审计日志、`journalctl` 与备份 pending 状态；
  6. 从备份恢复可疑文件。
- 不要在聊天、截图、issue 中粘贴密码、TOTP 密钥、恢复码、隧道 token、age 私钥。

## 6. 安全验收（已覆盖）

- 未登录 `/api/*` 401；ai 未登录 HTML 302、API 401。
- 缺少 CSRF 的写请求 403。
- 非法 Host 404。
- 路径穿越名被清洗；SVG/HTML 无内联预览；音视频只允许白名单容器。
- 分享密码新建最少 8 位；公开信息不含备注；回收站文件旧分享返回 410；token 日志脱敏。
- 备份管理：导入需 TOTP、tar 安全校验、恢复仅新目录、计划过期/单并发；整库恢复不暴露 Web。
- 超配额上传拒绝；回收站占配额；普通单请求受 `MAX_UPLOAD_BYTES`（默认 100 MiB）限制；分片上传受 5 GiB 上限、8 MiB 块、会话过期/并发限制与配额预留约束。
- 外部 25575 阻断；内存 cgroup 含 `memory`；备份 pending/48h 状态与 PC `.sha256` 旁文件（见 `scripts/smoke.ps1`）。
- 仓库 `git grep` 不出现真实密钥。
