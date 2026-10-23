# 安全说明

## 1. 资产与信任边界

- **公网入口**：`app.example.com`、`ai.example.com` 经 Cloudflare Tunnel（名称 `pi`，出站）；Cloudflare 终止 TLS，可见明文。
- **Pi 本机**：应用只监听 `127.0.0.1:3000`；cloudflared 出站连接；opencode `127.0.0.1:4096`；nginx/certbot 旧入口已移除。
- **现有服务**：Minecraft（Paper 26.1.2，在线模式关闭、白名单开启）、SakuraFRP、RDP/桌面、opencode。
- **秘密**：`/etc/antifieldcloud/env`（RCON/opencode 密码、`BOT_SECRET_KEY`、APP_VERSION）、SQLite（TOTP secret、会话哈希、恢复码哈希、
  Bot 凭据密文）、备份归档（普通归档含 TOTP/会话，密钥包 age 加密）、离线 age 私钥。
- **Bot 凭据**：QQ 官方 Bot AppSecret 由 `BOT_SECRET_KEY`（AES-256-GCM）加密后落库；
  `BOT_SECRET_KEY` 只存在于 env 与加密备份中，丢失后已存 AppSecret 不可解密（只能重新录入）。
- **数据与状态**：`/var/lib/antifieldcloud`（DB/files/backups/world-backups/secrets/bot-memory）、只读状态文件
  `{world-backup,world-pull,drill}-status.json`（0644，由 root/PC 脚本写入，应用只读）。`bot-memory/` 为 Bot 长期记忆镜像（0700/0600，不对外）。

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
| 备份归档被恶意替换/注入 | 文件覆盖/路径穿越/压缩炸弹 | Web 导入需 TOTP；文件名白名单、SHA-256、tar 路径/链接/设备/条目大小校验；快照行数与数据库快照大小上限；恢复只到新目录、不覆盖；整库恢复仅离线 root 手工流程 |
| 备份解包耗尽磁盘/内存 | 服务不可用 | staging 上限 2 GiB 且 ≤可用空间 20%；恢复按选择字节 ×2 预检；快照最多 10 万行、DB 快照 ≤256 MiB；归档浏览 30 次/分钟 |
| 世界备份期间丢数据 | 世界存档损坏 | `save-on` 放 finally 并重试；gzip 完整性 + SHA 校验后才原子改名；保留 4 份；失败状态 JSON 可见 |
| 物理 SD 丢失 | 数据泄露/丢失 | 无全盘加密（当前限制）；建议后续 LUKS/加密备份；应用归档 + 世界备份到 PC |
| 校园网扫描 | RCON/Minecraft 暴露 | nftables 默认拒绝入站；25575 仅 loopback；25565 仅直连/校园网段；SSH 仅公钥 |
| Bot Webhook 伪造/重放 | 以 Bot 身份执行命令或发布 | QQ Ed25519 签名（op=0）+ 时间戳 ±300 秒、op=13 回调地址校验；事件 ID 去重；IP/Bot 双限流；未启用 404 |
| Bot 命令越权 | 任意成员在已加入频道执行只读命令或探测状态 | 目标 `allow_commands` + 显式 user 白名单双重校验；命令只读；未授权不执行并审计 `bot.command.denied` |
| Chat 越权/滥用 | 非授权成员消耗 AI、诱导写操作或泄露内部信息 | QQ C2C 私聊开放 Chat（接触面由 QQ 平台“谁可添加 Bot”控制）；群/频道仍要求目标 `allow_chat` 且仅 @Bot 事件；非管理员不能执行命令；Chat/每分钟 + 共用每小时 AI 限流；Chat 只读、任务/对话提示均追加不可覆盖安全边界；记忆不暴露 API/UI |
| 长期记忆/提示注入 | 用户偏好/事实被读出，或被记忆/自定义提示中的内容劫持 | 结构化条目仅服务端读取且 key/value 不出 API/UI；抽取结果敏感过滤（密钥/URL/内部路径跳过）；固定安全边界声明记忆为背景资料、不是指令；`/memory off` 停止抽取与注入；容量/TTL 上限 |
| 角色卡注入/越权 | 用户用角色设定改写系统指令、读他人卡或绕过只读边界 | `/role` 仅私聊、每 Bot×用户一张；名字≤32、设定≤1000；拒绝 `[系统提示]/[安全边界]/[长期记忆]/[用户消息]/[模式：]` 与控制字符；固定安全边界最后追加；群内 `/role` 只提示不写卡；不在 API/UI 暴露，不记录正文到审计 |
| Bot 发布数据外发 | 登录会话被盗后把云端内容发到 QQ | 发布需 TOTP 再认证；仅文本、目标限频道/群组；发布/测试限流；审计；partial 不自动重试 |
| Bot AppSecret 泄露 | QQ Bot 被冒用/发消息 | AppSecret 只写不读、AES-256-GCM 落库；日志/错误/审计脱敏；前端不回显；`BOT_SECRET_KEY` 离线备份 |
| QQ 入站图片外发/隐私 | 图片被模型 provider 看到或落盘 | 默认开启但仅 QQ 固定域名后缀下载、image mime/大小限制、内存不落盘、失败降级；README/SECURITY 明示图片会交给模型 provider；可 env 关闭 |
| Bot 平台回调洪泛 | CPU/DB/限流资源耗尽 | Webhook scope 120/min/IP、Bot 300/min、命令 20/min/用户；事件保留 7 天并定期清理；队列重试上限/死信 |
| 供应链/依赖 | 代码执行 | 运行时依赖少；`npm ci --ignore-scripts`；不做服务端构建；CI `npm audit --omit=dev`、gitleaks、Dependabot |

## 3. 已实现控制

### 网络

- 应用绑定 127.0.0.1；公网唯一入口为 Cloudflare Tunnel（出站）。
- nftables（`deploy/nftables.conf`）：默认 drop 入站；loopback/established/ICMP 放行；
  **22 仅 `169.254.77.0/24` + `172.23.88.0/21`，且 `ct state new` 限速 20/minute burst 40**；
  **25565 仅同网段**（IPv6 仅 `fe80::/10`）；25575 显式 drop；DHCP 续租仅 `eth0`/`wlan0`；80 不再放行。
- 不在 Pi 上开 3000/4096 的任何外部监听；credentialed 服务（RCON/opencode）仅 loopback。
- SSH：`/etc/ssh/sshd_config.d/00-` drop-in 仅公钥（密码/键盘交互关闭，`PermitRootLogin no`），旧配置保留 24h 回滚窗口；
  `fail2ban` 启用 `sshd` jail（nftables 后端、24h ban），`nft -f`/重启 nftables 后需重启 fail2ban 恢复封禁 set。

### 认证

- scrypt（N=2^15, r=8, p=1，64 B key，16 B 随机盐），恒定时间比较；用户不存在时执行等价哈希。
- TOTP：RFC 6238 SHA-1/6 位/30 秒，±1 步，记录 `totp_last_step` 防重放；恢复码 10 个，一次性，SHA-256 存储。
- 挑战 5 分钟一次性；会话 7 天；Cookie 属性按协议严格设置；密码最少 12 字符；改密注销其它会话。
- Cookie 作用域：app 主机 host-only `af_session`/`af_csrf`（不设 `Domain`，HttpOnly/Secure/SameSite=Lax）；ai 主机通过 app 签发的 60 秒一次性 ticket（`/api/auth/ai-ticket` → `/__af/sso/<ticket>`）获得自己的 host-only `af_session`，不再使用父域共享 Cookie；app 写请求与公开 unlock 的受信 Origin 只保留 appOrigin（+ loopback 开发例外）。登录/退出响应及每次 `/api/auth/me` 都会清理 v0.6.0 前的旧父域 Cookie。
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

### Bot（v0.5.8，QQ 官方 Bot 单平台）

- 平台收敛：v0.5.8 起仅保留 QQ 官方 Bot；Telegram/Discord/Slack 适配器、Discord Gateway、按钮、媒体/多附件发布、群聊触发方式（`chatTrigger`）、
  Telegram HTML/引用/线程全部移除。schema v13（迁移 13）`DELETE FROM bots WHERE platform <> 'qq'`，级联删除非 QQ Bot 的目标/队列/事件/会话/记忆/角色卡；
  **生产 Discord Bot 数据在迁移前已备份**，迁移后从应用数据库移除。历史验收记录保留但自 v0.5.8 起不再是当前能力。
- 凭据：`crypto.ts` 使用 AES-256-GCM（随机 12 字节 IV、认证 tag、`key_version=1`）；`BOT_SECRET_KEY` 必须是 32 字节 base64，启动时校验，格式错误拒绝启动/服务初始化。
  管理 API 只返回 `BotSummary`（公开 `config.appId`，无 AppSecret）；`PATCH` 的 `token` 空值保持；Bot 删除级联清理目标/投递/发布/事件/AI 会话/记忆/角色卡。
- 入站：`POST /api/bot/webhook/:botId` 无会话/CSRF，仅 QQ 平台签名鉴权；`op=13` 回调地址校验用 AppSecret 派生 Ed25519 私钥签名（返回 `plain_token`/`signature`），
  `op=0` 校验 `X-Signature-Ed25519` + 时间戳（±300 秒）后回 `{opcode:12}`；`bot_events` 以 `(bot_id, platform_event_id)` 主键去重；Body 上限 256 KiB。
  `bot_inbound_targets` 只记录目标/用户/类型/是否私聊/时间，不记录消息正文；每 Bot 最多 500 条，按事件保留期清理。
- 授权：命令目标必须 `allow_commands=1`，发送者必须是该 Bot 下 `kind='user'` 且 `allow_commands=1` 的目标；命令白名单固定为
  `/help`（动态自助）、`/status` `/backup` `/world` `/mc` `/files`；v0.5.9 起 `/ask` 已移除（斜杠命令不调用 AI）；非管理员 `/help` 仅公开命令、管理员全量；未知命令对管理员回全量帮助、对非管理员被拒；`/files` 只返回名称/大小，不含内容/路径。
  自助命令例外：`/help`、`/memory`、`/role`（仅私聊）、`/reset`、`/forget confirm` 对所有用户开放，不要求目标/用户白名单（v0.5.9 起 `/help` 动态：非管理员仅公开命令）；它们只影响本人当前 Bot 的会话/记忆/角色，
  审计只记录动作与截断用户 ID、数量/长度，不记录角色设定或记忆正文。
  Chat 使用独立的 `allow_chat=1`：非管理员只能 Chat，不能执行斜杠命令；C2C 私聊直接进入 Chat，QQ 群/频道只有 @Bot 事件进入（平台限制，无“全部消息”触发）；
  未开启 `allow_chat`/未授权事件不调用 AI，只记诊断事件。
- AI：v0.5.9 起仅普通消息 Chat（`/ask` 移除），Chat 仅 `allow_chat` 目标/C2C；Chat 每 Bot×用户每分钟 `BOT_CHAT_RATE_PER_MINUTE`（默认 **30**）、每小时 `BOT_AI_RATE_PER_HOUR`（默认 **120**）；
  提示词截断到 `BOT_AI_MAX_PROMPT_CHARS`（默认 2000）；新建 OpenCode 会话传入 deny-all Permission.Ruleset 关闭工具；
  仅当 OpenCode 明确 400 拒绝 `permissions` 时降级为默认权限，并在日志标注“未隔离”，不宣称已隔离；
  AI 只返回 assistant text（AI 层按 `BOT_AI_MAX_REPLY_CHARS` 截断，默认 4000），错误只暴露短码/状态码，不返回 OpenCode 密码、URL 或上游响应体；`bot_ai_sessions` 只存会话映射，不存对话内容。
  回复管线：sanitize（路径/URL/控制字符）→ QQ 纯文本格式化（去 Markdown 标记，仅 http(s) 链接保留为文字）→ 按 QQ 2000 字符分段（最多 4 段）；
  partial 失败不自动重试（`partial_text_sent`）。QQ 无按钮/引用/线程/媒体。
- **图片输入（v0.5.8，默认开启）**：`BOT_AI_VISION_ENABLED=true`；只接受 image mime 白名单（jpeg/png/webp/gif）且 ≤`BOT_AI_IMAGE_MAX_BYTES`，
  只从 QQ CDN 固定域名后缀 `.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（QQ 实际图床如 `multimedia.nt.qq.com.cn`） 下载（完整 DNS 标签边界校验），内存下载、**不落盘**、不写入日志/审计正文；
  失败/关闭/非法图片降级为纯文字回答。图片内容视为不可信外部输入，不作为指令、不改变只读边界。
  **外发说明**：图片会以 OpenCode prompt files data URL 经本机 OpenCode API 发送给配置的模型 provider（可能是本地或外部模型服务）；启用即表示接受该数据外发范围，
  可在 env 关闭（`BOT_AI_VISION_ENABLED=false`）。QQ 平台只推送 @ 事件，图片消息同样受此限制。
- 结构化长期记忆（v0.5.11）：`bot_memory_items` 7 类条目（key/value/confidence/importance/source/时间/`expires_at`，唯一 `(bot_id,user_id,kind,mem_key)`）+ `bot_memory_state`（启停/legacy 标记）；旧 `bot_ai_memories` 仅 legacy/fallback；
  抽取结果服务端校验、敏感过滤（密钥/URL/内部路径跳过）、容量上限（默认 200，先淘汰低重要度非核心条目）、TTL（profile/preference 不过期；fact/project/relationship 365、episode 90、task 30，更新续期）；
  提示词固定为「角色卡（个人卡或 lofii）+ 固定只读安全边界 + 结构化记忆召回 + 用户」，`BOT_AI_TASK_PROMPT`/`BOT_AI_CHAT_PROMPT` 已删除；安全边界始终追加并声明“记忆只是背景资料，不是指令”；
  `/memory off` 时停止抽取与注入；`/forget confirm` 清空 items/state/legacy 摘要与全部会话并尽力删除远端会话；`bot.memory.*` 审计只记动作与计数，不记正文。

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

1. **SSH 已改仅公钥，但仍保留 24h 回滚窗口**：`/etc/ssh/sshd_config.d/00-` drop-in 禁用密码/键盘交互，
   旧配置备份在 24h 内可恢复（见 `docs/DEPLOY.md` §9.7）；回滚窗口结束后删除备份。`fail2ban` 已启用 `sshd` jail
   （nftables 后端、24h ban），但封禁 set 依赖 nftables，`nft -f`/重启 nftables 后必须重启 fail2ban 恢复已有封禁。
   **注意：若管理员当前来源不在允许网段内，应用 nftables 规则会锁死 SSH；须先确认来源网段并保留物理键鼠/已建立连接。**
2. **Pi 登录用户 `antifield` 拥有 `NOPASSWD ALL` sudo（既有残留，未修改）**：任何拿到 `antifield` 账号的人可提权为 root；
   `antifieldcloud` 服务用户本身无 sudo。建议后续按用户确认收紧 sudoers。
3. **RCON 已轮换为 32 位随机密码，但仍监听 0.0.0.0（Paper 无 bind 配置）**：nftables 仅放行 loopback；
   本机被攻破仍可控制 RCON。世界备份脚本以 root 使用固定命令，扩大了 RCON 凭据的暴露面（仅 root 可读）。
4. **Cloudflare Access 已在生产配置**：主应用 `app.antifield.work`（One-time PIN + Owner allow + Service Auth）与 4 个 Bypass 路径
   （`/healthz`、`/api/bot/webhook`、`/s`、`/api/public/shares`）已通过 API 创建并验证；smoke 支持 `-AccessClientId/-AccessClientSecret`。
   service token 只保存在 PC gitignored `.local/cf-access.env`，应使用专用/最小范围并定期轮换；配置用高权限 API Token 完成后应 Revoke。
   仍建议给 Cloudflare 账号开启 2FA；Access 只作为应用 TOTP 之外的第二层，不替代应用认证。
5. **Cloudflare 可见明文**：文件内容与登录流量对 Cloudflare 可见；敏感数据可考虑后续应用层加密。
6. **单管理员、无多用户/权限分离**：审计日志可被管理员删除；适合个人使用。
7. **普通备份归档仍含 TOTP secret 与文件内容**：PC 端 ACL 与物理安全是最后防线；密钥包已用 age 加密，
   后续可评估整包加密（restic/age）与异地副本。age 私钥丢失将无法恢复密钥包。
8. **世界备份依赖 RCON 与 Minecraft 运行**：服务器未运行时备份失败（状态 JSON 可见）；`save-off` 期间若进程崩溃，
   `save-on` 会重试/需人工恢复保存。旧 `minecraft-backups` legacy 归档已于 v0.4.1 清理，旧 cron 保持停用。
9. **opencode 自身认证/UI 行为随版本变化**：当前生产 **v2.1.3**（2026-10-23 由 v2.1.2 升级；v2.1.3 为 Bun 1.4.4 安全修复等补丁版），通过注入 Basic 实现 SSO；
   升级后按 `docs/DEPLOY.md` §3.2 复验 Basic/session/垫片注入/公开入口。原生新建按钮在部分版本仍有缺陷，
   失败时保留最小隐藏点击接管（无可见 UI）；UI/WS 实时事件需浏览器复测。
10. **无 WAF/DDoS 防护**：Cloudflare 默认防护有限；大文件上传/登录仍可能消耗资源（有配额/限流）。
11. **SD 卡无加密**：设备丢失即数据泄露；可后续迁移 SSD + LUKS。
12. **限流在内存中**：应用重启清零；对分布式攻击效果有限。
13. **Cloudflare 自动注入与严格 CSP 冲突**：Web Analytics/Challenge 脚本被 CSP 拦截；需在 Cloudflare 后台关闭自动注入或接受报错；
    不建议放开 `script-src` 内联。
14. **scrypt 仍为 N=2^15**：升级到 2^16/2^17 需要密码哈希版本迁移，列入后续。
15. **`http-proxy` 在 Node 26 有 `util._extend` 弃用警告**：Node 27 前需评估替换。
16. **Cloudflare 约 100 MiB/100s 限制**：普通上传仍受单请求限制；分片承载 5 GiB 文件，但总时长仍受 Cloudflare/网络影响。
17. **Windows 世界拉取/演练任务需用户手动安装**：未安装时面板为 unknown、告警可能触发；任务本身以当前用户运行，依赖直连网线与 SSH 公钥。
18. **Bot 测试为 mock-only**：QQ 适配器/队列/发布/Chat/记忆/文本分段/图片下载/自检/诊断/角色与记忆管理仅用进程内假平台、夹具与假 HTTP，未对真实 QQ 平台做限流、签名漂移、平台故障的负路径验收；
    上线前必须在 QQ 开放平台完成回调地址/事件订阅并联调（`docs/DEPLOY.md` §9.8）。v0.5.1 的 QQ 真实回调与真实模型已验证；v0.5.9 起 AI 仅 Chat（`/ask` 移除）；v0.5.7 已部署并完成生产只读验证；v0.5.8 已部署（release `20261022T134852Z`/schema v13，迁移 13 后仅剩 QQ Bot），图片/自助命令等真实消息已由用户实发验收通过（2026-10-22 21:59–22:08 CST，图片 148563 B jpeg 端到端成功）；诊断/角色记忆面板按用户确认整体通过。
19. **Bot 仅文本、单平台**：QQ 官方 Bot 只支持文本（单条 ≤2000），无媒体/附件/按钮/引用；平台收敛后不再有 Telegram/Discord/Slack 备选通道，QQ 平台故障时 Bot 不可用；无多管理员审批流；发布仅有单管理员 TOTP + `PUBLISH` 双确认。
    长文本分段发送，partial 失败不自动重试，需人工核对后处理。
20. **`BOT_SECRET_KEY` 丢失/轮换**：DB 中已有 QQ AppSecret 将不可解密，必须重新录入；轮换需先备份 DB + 旧密钥并接受一次性重录，
    不做在线密钥版本迁移。`bootstrap-env.sh --force` 会复用旧 key，不会自动轮换。
21. **AI 工具隔离依赖 OpenCode 版本**：Chat 新建会话传 deny-all 的 `permissions`；若 OpenCode 以 400 拒绝该字段，会降级为默认工具权限并在日志标注“未隔离”。
    当前生产 OpenCode v2.1.3 的 OpenAPI 声明支持该字段（2026-10-23 已实测创建会话返回 200、生产模型 assistant text 正常）；2026-10-23 已完成生产只读负路径：deny-all 会话中要求执行 shell 写 `/tmp`，模型返回 `TOOLS_UNAVAILABLE`、无 `tool` 内容段、目标文件未创建；仍不把 Chat 当作强隔离沙箱，模型行为非强保证。
22. **fail2ban 持久化依赖 drop-in**：dbfile 已持久化，`nftables.service` drop-in 会在启动后异步重启 fail2ban 恢复 set；手工 `systemctl reload nftables` 不触发，仍需手动 restart。
    生产已安装并实测封禁恢复；Cloudflare Access 也已配置并纳入带 token 的 smoke，剩余为 service token/API Token 轮换与季度演练。
23. **Bot 记忆镜像文件**：DB 摘要为权威且随 DB 备份；`DATA_DIR/bot-memory/memory-<uuid>.md` 不通过 API/UI 暴露，用户 `/forget confirm` 与管理员删除记忆会同时删除对应镜像；
    删除 Bot 时只级联删除 DB 行，镜像文件无自动清理路径，需按保留期/人工清理；不要把该目录挂到 Web 静态目录。
24. **QQ 群/频道触发限制**：QQ 平台只推送 @Bot 事件，普通群消息不会进入 Bot；没有“全部消息”开关可补救。C2C 私聊开放 Chat 但接触面由 QQ 平台“谁可添加 Bot”控制；
    管理员应确认目标 `allow_chat` 与入站目标登记，避免误以为群内所有消息都会触发。
25. **Node.js 运行时安全更新**：生产 `/usr/local/bin/node` 已从 v26.11.1 更新到 **v26.12.1**（2026-10-22，官方 linux-arm64 + SHA-256 校验）；
    旧二进制保留 `/usr/local/bin/node.v26.11.1` 以便回滚；npm/npx 仍指向 nvm（12.2.0），仅作构建/部署工具。后续安全更新应重复
    `docs/DEPLOY.md` §3.3 并跑带 Access token 的 smoke；Node 更新不影响 DB/schema。
26. **Bot 出站连通性（v0.5.10 起 Pi 直连）**：服务端探测只发无凭据只读 GET（外网 + QQ 平台 API），不记录平台响应正文或 AppSecret；`/api/bots/connectivity` 仅返回 `checkedAt/checking/internet/platforms`，无 `deviceOnline/proxy`。
    v0.5.10 删除 PC 代理隧道脚本/计划任务与 `BOT_PROXY_URL`，生产 env 删除 `HTTPS_PROXY`/`HTTP_PROXY`/`NODE_USE_ENV_PROXY`/`NO_PROXY`；Pi 出站不可达时检查路由/DNS/防火墙，不要恢复旧代理变量（新版本不再读取）。
27. **QQ 群/频道无全量消息权限**：v0.5.8 删除了 `chatTrigger`；QQ 群/频道只有 @Bot 事件进入 Chat，普通群消息不消费。若用户需要群内全量对话，只能依赖 QQ 平台能力（当前不提供），文档应明确此平台限制。
28. **诊断事件含平台目标/用户 ID**：`GET /api/bots/:id/events` 只对登录管理员开放，不存消息正文/用户名，保留 `BOT_EVENT_RETENTION_DAYS`（7 天）；
    仍应按内部数据处理，不截图/外传；`detail` 为固定短码，避免把平台响应正文写入。
29. **角色/记忆删除不可撤销**：`DELETE roles/:userId` 会删除角色卡并清该用户 chat 会话；`DELETE memories/:userId` 会删除 DB 摘要与镜像（不清会话，`/forget confirm` 才会清全部会话）；
    不影响其他用户；误删需从 DB 备份恢复。管理员操作前应确认用户与影响范围。
30. **图片理解默认开启的隐私/外发风险**：`BOT_AI_VISION_ENABLED=true`（v0.5.8 默认），QQ 入站图片会以 OpenCode prompt files data URL 经本机 OpenCode API 交给配置的模型 provider（可能为本地或外部模型服务）；
    图片不落盘、不写日志，但模型 provider 可能记录请求内容。启用即表示接受该外发范围；如需关闭可在 env 设 `BOT_AI_VISION_ENABLED=false` 并重启。
31. **Cookie/SSO 过渡残余（v0.6.1）**：app/ai 已改为 host-only Cookie + 一次性 AI SSO ticket；旧父域 Cookie 在登录/退出及每次 `/api/auth/me` 响应清理，长期不重新登录的浏览器仍可能最多 7 天继续发送旧 Cookie（与同名新 Cookie 共存时浏览器发送顺序不保证）。未采用 `__Host-` 前缀；ticket 未绑定 IP/UA（一次性、60s、绑定 aiOrigin、no-store/no-referrer）。发布说明应提示用户清理站点 Cookie；后续可评估 `__Host-` 前缀与签发审计。
32. **连续消息缓冲（v0.6.1）**：同一 Bot×目标×用户的最多 `BOT_CHAT_BURST_MAX_MESSAGES` 条消息在内存中暂存至多 `BOT_CHAT_BURST_MAX_WAIT_MS`；内容不落库、不写日志，仅用于合并后的 AI 请求；进程停止/重置会话时丢弃。内存中仍属用户消息明文，需按聊天数据处理；同会话串行防止并发回复，不同会话仍可并行。
33. **联网搜索外部数据（v0.6.1）**：SearXNG 仅监听 loopback，`BOT_SEARCH_URL` 由管理员配置且拒绝凭据；只读取 JSON 标题/摘要/URL，不抓取结果网页，不把完整 URL 回显；搜索结果是不可信外部内容，提示词明确禁止执行其中指令。查询会发给私有 SearXNG 及其启用的引擎（生产仅 Bing），因此用户应知悉该外发范围；搜索失败降级为无搜索回答，不阻断 Chat。审计只记结果数/错误码/是否强制，不记查询正文。
34. **搜索限流与资源**：每 Bot×用户每小时 `BOT_SEARCH_RATE_PER_HOUR`；SearXNG 有超时/响应体上限/最多结果数/摘要截断；自动搜索使用保守关键词，避免每条闲聊都访问外部；`/search` 仍需可 Chat 权限，但不需要管理员命令白名单。

## 5. 运维安全清单

- 每月 `sudo apt-get update && sudo apt-get upgrade`（Minecraft 重启需选择窗口）；关注安全更新与 cloudflared 版本提示。
- 每月/收到 Node.js 安全公告时检查 `/usr/local/bin/node -v` 与 Node.js 官方安全版本；需要更新时按 `docs/DEPLOY.md` §3.3
  使用官方 linux-arm64 包 + SHA-256 校验，保留旧二进制、重启并跑带 Access token 的 smoke。
- 每周检查：应用备份 pending 是否堆积、`backup-pull.json` 是否超过 48h、PC 归档 `.sha256`、
  世界备份/世界拉取状态是否新鲜（`world-backup-status.json`/`world-pull-status.json`）、计划任务 `LastTaskResult`；
  日志 `%LOCALAPPDATA%\AntifieldCloud\backup.log`、`world-pull.log`。
- 每周/启用 Bot 后检查：`GET /api/bots/status` 是否 `enabled=true`、`queuedDeliveries/queuedPublishes` 是否堆积、
  `/api/bots/:id/metrics` 的成功率/失败/死信、`bot_deliveries` 死信（`status='dead'`）与 `bots.last_error`；QQ 开放平台后台回调地址/事件订阅是否仍正确；
  确认 AppSecret 未出现在 `journalctl -u antifieldcloud`。启用 Chat 后检查 `BOT_AI_ENABLED`、`bot_ai_sessions` 保留与限流（30/min、120/h）是否合理；`/ask` 已移除。
  启用 Chat 后检查 `/api/bots/connectivity` 的 `internet`/`platforms.qq` 状态（v0.5.10 起无设备/代理字段）；PC 侧不应再有 `AntifieldCloudDiscordTunnel` 计划任务。
  v0.5.8 起另查：`POST /api/bots/:id/check` 自检结果、`GET /api/bots/:id/events` 是否有异常 `error`/`denied` 激增；
  用户自助 `/forget confirm` 后确认 `bot_memory_items`/`bot_memory_state`/legacy `bot_ai_memories` 与 `DATA_DIR/bot-memory` 对应数据已删除；`BOT_AI_VISION_ENABLED` 是否为期望值（v0.5.8 默认 true，关闭需显式 false）；
  审计 `bot.ai.image` 只应含 mime/大小/跳过原因，不应出现图片内容或媒体 URL。
- 每月检查：`systemctl --failed`、`journalctl -u antifieldcloud -p warning`、`nft list ruleset`（确认 22 来源网段）、
  `/sys/fs/cgroup/cgroup.controllers` 含 `memory`、`vcgencmd get_throttled`、`vcgencmd measure_temp`、磁盘/内存余量、
  `crontab -l` 不含旧 `minecraft-backups` 行。
- 每月检查 SSH/fail2ban：`sshd -T` 仍为仅公钥、`fail2ban-client status sshd` 有 jail 统计、`fail2ban-client get sshd bantime=86400`、
  `ls -l /var/lib/fail2ban/fail2ban.sqlite3`（dbfile 持久化）、`systemctl cat nftables.service | grep -A2 fail2ban`（drop-in 生效）；
  封禁 set 与 nftables 规则共存；任何 nftables 变更后执行 `systemctl restart fail2ban` 并复核封禁列表。
- 每月检查 Cloudflare Access：`app` 策略主体、bypass 路径（`/api/bot/webhook/*`、`/healthz`、`/s/*`、`/api/public/shares/*`）
  是否被后续规则覆盖；service token 是否仍有效且未过期；用未登录浏览器验证公开分享仍可用、平台回调仍 200。
- 每季度检查：恢复演练（`scripts/drill.ps1 -ExpectedSchemaVersion 14` 或按 docs/BACKUP.md §7 手动执行并记录）、
  `cloudflared tunnel info` 连接与版本、Windows 备份目录 ACL 是否仍仅白名单主体、age 公钥/私钥保管情况、
  世界备份保留 4 份/PC 保留 4 份是否正常、SSH 仅公钥配置是否仍生效（`sshd -T | grep -E 'passwordauthentication|pubkeyauthentication'`）。
- 怀疑泄露时：
  1. 登录设置页“退出全部会话”；
  2. CLI 重置密码/TOTP；
  3. 轮换 RCON/opencode 密码（opencode 需同步 `/etc/opencode/opencode.env`、`/etc/antifieldcloud/env` 与两个 `service.json`，
     然后重启 opencode 与 antifieldcloud；`bootstrap-env.sh --force` 后也需重启应用，非敏感配置会沿用现有值）；
  4. 重新生成 age 密钥包并离线保管私钥；
  5. 若 Bot 凭据可能泄露：在 QQ 开放平台后台吊销/重建 AppSecret，重新录入 `/bots`（DB 旧密文随更新覆盖）；必要时轮换 `BOT_SECRET_KEY`
     并接受所有 QQ AppSecret 重录；
  6. 检查审计日志、`journalctl`、备份 pending 与世界/演练状态文件；Bot 额外检查 `bot_webhook_rejected`/`bot_command`/`bot.ai.image` 审计；
  7. 从备份恢复可疑文件。
- 不要在聊天、截图、issue 中粘贴密码、TOTP 密钥、恢复码、age 私钥、QQ AppSecret。

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
- Bot：`BOT_ENABLED=false` 时 Webhook 404、写接口 503；无签名/错误签名 401、时间戳过期 401、重复事件 200 opcode=12；
  未授权目标/用户不执行命令并审计；发布缺 `totpCode` 400、错误 TOTP 401；AppSecret/access_token 不出现在 API/日志。
- v0.5.1 Bot（历史；`/ask` 自 v0.5.9 移除）：QQ op=13 校验签名可验、op=0 篡改签名/过期时间戳 401；`/ask` 未启用/越权/超限不调用 AI；deny-all 会话创建与 400 降级日志；
  静默起止成对/相同/越界校验；发布缺 `confirmText` 400 `publish_confirm_required`；metrics 未登录 401。
- v0.5.1 安全：fail2ban dbfile 存在、`nftables.service.d/10-fail2ban-restore.conf` 已安装、nftables restart 后封禁恢复；手工 reload 后手动 restart fail2ban；
  smoke Access service token 仅在同时提供时附加请求头且不打印。
- v0.5.2 Bot（历史；按钮/Gateway 自 v0.5.8 起移除）：`allow_chat` 与 `allow_commands` 独立；Chat 未开启/群未 @/AI 关闭时不调用 AI；管理命令仍双白名单；Chat 6/min 与共用 10/h 限流；
  结构化记忆仅落 DB（legacy 镜像 0700/0600 且不在 Web 静态目录）；抽取失败保留旧记忆；`bot_inbound_targets` 不存正文。
- v0.5.2 发布/多附件（历史；v0.5.8 起发布仅文本、媒体能力移除）：媒体最多 5 个/单 10 MiB/总 50 MiB；QQ 媒体 400；多附件部分成功标记 `failed`/`partial_media_sent` 且不自动重试。
- v0.5.2 Gateway（历史；v0.5.8 起移除）：`intents=37377`、HELLO/IDENTIFY/RESUME/心跳/重连/致命关闭码由假 WebSocket 测试覆盖；关闭开关不建连；Token 不出现在状态/日志。
  上述为本地测试，真实 Discord/各平台未验收；v0.5.8 起不再属于当前能力。
- v0.5.7 Bot（历史；已部署并保留部分能力）：`/reset`、`/forget confirm` 对所有用户开放但不越权影响其他用户；`/forget` 只清本人记忆+会话；
  角色/记忆管理接口只返回元数据、删除需 CSRF、审计不含正文；诊断接口不返回正文/用户名且 outcome 白名单；连接自检结果不含 AppSecret/access_token；
  分段/引用/HTML/chatTrigger 等平台相关能力自 v0.5.8 起收敛为 QQ 单平台（见下条）。
- **v0.5.9 变更**：移除 `/ask`（AI 仅 Chat）、限速放宽（30/120/120）、`/help` 动态开放（非管理员不暴露管理命令）；schema 无迁移。`/ask` 对非管理员按未知命令被拒、管理员回帮助不调用 AI。
- **v0.5.11 变更**：结构化长期记忆（`bot_memory_items` 7 类 + `bot_memory_state`，schema v14）；抽取一次性会话/串行/严格 JSON ops/敏感过滤/容量 200/TTL 分层；分层召回 3000 字/12 条 + legacy fallback；`/memory` 与 off/on；`/forget confirm` 清空 items/state/legacy/会话；管理 API 只返回元数据；旧摘要迁移与清理 CLI；迁移 14 不可逆，v0.5.10 不支持 v14。
- **v0.5.10 变更**：记忆摘要一次性并删除远端会话、更新串行、合并=3 条或空闲 120s、记忆保留 365 天与会话 7 天分离、`/reset`/`/forget`/角色变更尽力删除远端会话；移除代理隧道依赖与 `BOT_PROXY_URL`，连通性改 Pi 直连（快照无 `deviceOnline/proxy`）；schema 无迁移。
- v0.5.8 Bot（历史；本地测试 + 2026-10-22 21:59–22:08 CST 真实 QQ 消息实发验收通过）：平台仅 `qq`；schema v13 删除非 QQ Bot 及级联数据（生产 Discord 数据迁移前已备份）；`BOT_AI_VISION_ENABLED` 默认 true；
  QQ 入站图片只从 `.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（QQ 实际图床如 `multimedia.nt.qq.com.cn`） 下载、image mime 白名单、≤`BOT_AI_IMAGE_MAX_BYTES`、不落盘、失败降级；图片会交给模型 provider（SECURITY §3/§4 明示）；
  文本发布禁止媒体；长文本分段每段 ≤2000、partial 不自动重试；`lastErrorHint` 能识别适配器包装消息中的平台错误码（如 `qq_access_token_failed`）。
- 外部 25575 阻断；22/25565 仅允许网段；`sshd -T` 显示 `passwordauthentication no`、`pubkeyauthentication yes`；`fail2ban-client status sshd`
  显示 jail 与封禁统计（nftables 后端、24h ban）；内存 cgroup 含 `memory`；备份 pending/48h 状态与 PC `.sha256` 旁文件（见 `scripts/smoke.ps1`）。
- Cloudflare Access：bypass 生效时公网 Webhook 可达（200/401 而非 Access 302）、`/healthz` 200、公开分享页正常；主应用仍要求 Access 登录。
- 世界备份/拉取/演练状态文件存在且新鲜（smoke 对缺失 WARN、失败/超期 FAIL）；世界备份归档 SHA/旁文件可校验。
- 仓库 `git grep` 不出现真实密钥；gitleaks CI 通过。
