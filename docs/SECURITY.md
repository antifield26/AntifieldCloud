# 安全说明

## 1. 资产与信任边界

- **公网入口**：`app.example.com`、`ai.example.com` 经 Cloudflare Tunnel；Cloudflare 终止 TLS，可见明文。
- **Pi 本机**：应用只监听 `127.0.0.1:3000`；cloudflared 出站连接；nginx 仅 LAN；opencode `127.0.0.1:4096`。
- **现有服务**：Minecraft（Paper 26.1.2，在线模式关闭、白名单开启）、SakuraFRP、RDP/桌面、opencode。
- **秘密**：`/etc/antifieldcloud/env`（RCON/opencode 密码）、SQLite（TOTP secret、会话哈希、恢复码哈希）、备份归档。

## 2. 威胁模型

| 威胁 | 影响 | 控制 |
|---|---|---|
| 互联网暴力破解登录 | 账号接管 | scrypt、TOTP、每 IP 5 次/15 分钟限流、全局 20 次/小时、统一错误、300 ms 失败延迟 |
| 会话劫持/CSRF | 未授权文件/白名单操作 | HttpOnly+Secure+SameSite=Lax Cookie、CSRF 双提交、Origin 校验、改密失效其它会话 |
| 路径穿越/任意文件读取 | 读取/覆盖 Pi 文件 | 只接受 DB id；物理路径由 id 派生；文件名清洗；无路径参数 |
| 恶意预览内容 XSS | 窃取会话 | 仅栅格图片/PDF 内联；文本走 JSON 由 React 转义；SVG/HTML/XML 强制下载；CSP |
| 上传耗尽磁盘 | 服务不可用 | 10 GiB 配额（含回收站）、单文件 2 GiB、单请求 20 文件、写前/流中/事务内三次检查、507 |
| opencode 端口被直接访问 | AI 工作区被滥用 | 端口仅 loopback；ai 主机会话校验；服务端注入 Basic；不向浏览器下发密钥 |
| RCON 被滥用 | 白名单/服务器被改 | 不提供任意命令；仅白名单增删；名字白名单校验；命令后复核；nftables 阻断非 loopback |
| 备份泄露 | 文件与 TOTP 泄露 | 备份目录 0640、PC 目标目录 ACL、文档标注敏感性；不备份 env |
| 物理 SD 丢失 | 数据泄露/丢失 | 无全盘加密（当前限制）；建议后续 LUKS/加密备份；每日备份 |
| 校园网扫描 | RCON/nginx 暴露 | nftables 默认拒绝入站；25575 仅 loopback；80/25565 限网段 |
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
- MIME/预览白名单；`X-Content-Type-Options: nosniff`；下载 `Content-Disposition` 文件名编码。

### HTTP
- CSP：`default-src 'self'; script-src 'self'; frame-ancestors 'self'; object-src 'none'` 等。
- `X-Frame-Options: SAMEORIGIN`（同源 PDF 预览）、`Referrer-Policy: no-referrer`、`Permissions-Policy` 最小化。
- API 全部 `no-store`；错误响应不含堆栈。
- 日志脱敏：Cookie/Authorization/密码/TOTP 字段。

### 运维
- 服务用户 `antifieldcloud` 无 shell/无 sudo；systemd 只读系统、仅数据目录可写、`NoNewPrivileges`、`MemoryMax=512M`。
- 环境文件 0640 root:antifieldcloud；仓库/CI 不含秘密。
- 部署脚本幂等、带健康检查与 release 回滚；备份带 SHA-256 校验。

## 4. 残留风险（按用户选择保留）

1. **RCON 密码仍为弱口令且监听所有接口**：nftables 后仅 loopback 可达，但本机被攻破即可控制 RCON。建议后续轮换强密码（需一次 MC 重启）。
2. **SSH 密码登录开启、无 fail2ban**：当前公网未转发 22，只在直连/校园网可达；仍建议改为仅公钥 + fail2ban。
3. **无 Cloudflare Access**：Cloudflare 边缘只有 TLS，账号安全完全依赖应用 TOTP；建议给 Cloudflare 账号开启 2FA。
4. **Cloudflare 可见明文**：文件内容与登录流量对 Cloudflare 可见；敏感数据可考虑后续应用层加密。
5. **单管理员、无多用户/权限分离**：审计日志可被管理员删除；适合个人使用。
6. **备份含 TOTP secret 与文件内容**：PC 端目录 ACL 与物理安全是最后防线；建议加密备份。
7. **opencode 自身认证行为随版本变化**：当前通过注入 Basic 实现 SSO；升级 opencode 后需复测（见 docs/DEPLOY.md 兜底）。
8. **无 WAF/DDoS 防护**：Cloudflare 默认防护有限；大文件上传/登录仍可能消耗资源（有配额/限流）。
9. **SD 卡无加密**：设备丢失即数据泄露；可后续迁移 SSD + LUKS。
10. **限流在内存中**：应用重启清零；对分布式攻击效果有限。

## 5. 运维安全清单

- 每月 `sudo apt-get update && sudo apt-get upgrade`（Minecraft 重启需选择窗口）。
- 每季度检查 `journalctl -u antifieldcloud`、`nft list ruleset`、备份演练。
- 怀疑泄露时：
  1. 登录设置页“退出全部会话”；
  2. CLI 重置密码/TOTP；
  3. 轮换 RCON/opencode 密码（`bootstrap-env.sh --force` 后重启应用）；
  4. 检查审计日志与 `journalctl`；
  5. 从备份恢复可疑文件。
- 不要在聊天、截图、issue 中粘贴密码、TOTP 密钥、恢复码、隧道 token。

## 6. 安全验收（已覆盖）

- 未登录 `/api/*` 401；ai 未登录 HTML 302、API 401。
- 缺少 CSRF 的写请求 403。
- 非法 Host 404。
- 路径穿越名被清洗；SVG/HTML 无内联预览。
- 超配额上传拒绝；回收站占配额。
- 外部 25575 阻断（见 `scripts/smoke.ps1`）。
- 仓库 `git grep` 不出现真实密钥。
