# AntifieldCloud · 个人工作台

面向 Raspberry Pi 5（8 GB，Debian 13）的自托管个人工作台：统一登录、云盘、知识库（笔记附件/版本历史）、多文件分享、Minecraft 状态与白名单、opencode AI 工作区入口、Telegram/Discord/Slack/QQ 官方机器人、PWA、副机指标历史与告警，以及应用归档 + 世界一致性备份 + 恢复演练的灾备链路。

> 状态：v0.5.6（已部署，release `20261022T114546Z`/commit `38dfe70`/schema v11；Node.js 运行时 **v26.12.1**；Bot 默认角色 lofii（私聊/群聊）、私聊个人角色卡、任务/对话双模式提示词、独立 OpenCode 会话、共享长期记忆、QQ C2C 开放 Chat；OpenCode **v2.1.2**；带 Cloudflare Access token 的完整 smoke 24/24）。部署与运维见 `docs/DEPLOY.md`，备份/恢复见 `docs/BACKUP.md`，路线见 [docs/ROADMAP.md](docs/ROADMAP.md)，当前与历史验收见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)，审计修复记录见 [docs/AUDIT.md](docs/AUDIT.md)。

## 技术栈

- 服务端：Node.js >= 26（生产安全更新至 v26.12.1；原生 TypeScript，无编译步骤）+ Fastify + `node:sqlite`（WAL）
- 前端：React 19 + TypeScript + Vite，中文暗色界面，PWA（离线壳，不缓存 API）
- 类型工具链：TypeScript 7.0.2（`@typescript/native` 别名提供 `tsc`）；`typescript` 包别名到 `@typescript/typescript6@6.0.2`，仅供 typescript-eslint 8.x 使用（其尚不支持 TS7 API）；v0.5.1 评估结论（v0.5.2 未变）为**暂不升级、保留双 alias**
- Bot：Telegram Bot API、Discord Interactions（Ed25519）+ Gateway 长连接、Slack Events API/Slash Command（HMAC）、QQ 官方 Bot（op=13 Ed25519 回调校验 + op=0 事件回调）；普通消息 Chat 与 `/ask` 共用本地 OpenCode AI，长期记忆落 DB + `DATA_DIR/bot-memory` 镜像；凭据 AES-256-GCM（`BOT_SECRET_KEY`），只出站调用平台 API
- 部署：Cloudflare Tunnel（`app.example.com` / `ai.example.com`）+ systemd + nftables；不使用 Docker
- 测试：`node --test`（服务端 + 运维脚本 324）+ Vitest/jsdom（前端 141），ESLint，`tsc --noEmit`，覆盖率门禁
- CI：`npm run check` + `npm run build`、服务端/前端覆盖率、运行时依赖边界、`npm audit`（生产依赖）、gitleaks 密钥扫描、shellcheck、nftables 语法、PowerShell 5.1 解析/BOM 检查、版本一致性、Dependabot 月度依赖更新

## 功能

### 认证与账号

- 密码（scrypt）+ TOTP 两步验证，10 个一次性恢复码；会话 7 天，HttpOnly + Secure + SameSite=Lax Cookie。
- 所有非 GET `/api` 校验 CSRF 与 Origin；改密/重生成恢复码需“当前密码 + TOTP”，并受限流与审计。
- 登录限流：每 IP 5 次失败/15 分钟、全局 60 次/小时（loopback 不占全局桶）、TOTP 全局 120 次/小时；再认证另有独立限流与恒定延迟。

### 云盘

- 目录树、多文件上传（可取消/重试/放弃并清理）、搜索、预览、Range 下载、回收站（30 天自动清理）；配额 10 GiB（含回收站）。
- 普通 multipart 单文件上限 100 MiB（匹配 Cloudflare 代理）；更大的文件自动走 8 MiB 分片上传，单文件上限 5 GiB，支持断点续传、配额预留、24h 会话过期与每用户 3 并发。
- `/api/storage` 轻量返回配额用量；文件列表/搜索/回收站只展示 `origin='user'` 的普通文件。

### 知识库

- Markdown 笔记 + 书签、标签、置顶、FTS5 搜索（中文回退 LIKE）、分页。
- 笔记附件：每请求 1–5 个、单文件 ≤25 MiB、每笔记 ≤100 个，计入总配额，但不出现在普通文件列表/搜索/回收站；只能经笔记接口管理，内容仍走鉴权的文件内容路由。
- 版本历史：标题/正文/标签变化时自动快照，每笔记保留最近 20 个版本；可查看/恢复（恢复前自动保存当前版本），跨笔记版本一律 404。

### 文件分享

- 单文件兼容入口 + 多文件分享：`POST /api/shares` 一次 1–50 个活动普通文件；逐文件下载，不生成 zip。
- 可选密码（新建至少 8 位）、有效期（默认 7 天，最长 30 天）、最大下载次数、备注；token 只存 SHA-256，密码 scrypt。
- 下载次数按“分享会话”计一次；任一文件被删除/移入回收站会吊销整个分享；公开页 `/s/<token>` 带 `noindex`，多文件分享解锁后展示文件清单。
- 公开内容支持 Range/HEAD/ETag/304/416；多文件分享的旧单文件 `/content` 返回 409 `share_bundle`。

### Minecraft

- SLP + RCON 只读状态（版本/MOTD/在线玩家/TPS/白名单数/服务状态）；白名单增删并执行后复核。
- 应用 API 不提供任意 RCON 命令、启停、封禁、OP；仅白名单增删 + 只读状态。
- 世界一致性备份由 root 脚本 `scripts/backup-world.mjs` 通过固定 `save-off` → `save-all flush` → `save-on`（finally）完成，应用 API 不可触达。

### opencode AI 工作区

- `ai.example.com` 只经会话校验后反代到固定上游 `127.0.0.1:4096`；客户端 `Authorization`/Cookie 被覆盖/移除。
- HTTP 与 WebSocket 均校验 `Origin`（仅 app/ai 正式 origin；WS 必须带合法 Origin），拒绝时 403 + 审计。
- `OPENCODE_HTML_MODE=shim|attributes|passthrough` 兼容 Rocket Loader/自动注入差异，不添加可见 UI。

### 机器人（v0.5.6）

- Telegram、Discord、Slack、QQ 官方 Bot 四个适配器：Telegram 用 `X-Telegram-Bot-Api-Secret-Token`，Discord 用 Ed25519 + 时间戳，Slack 用 HMAC-SHA256 + 时间戳，QQ 用 AppSecret 派生 Ed25519（op=13 回调地址校验、op=0 事件验签，回复 `{opcode:12}`）；公开入口为 `POST /api/bot/webhook/:botId`，原始 body 验签后按事件 ID 去重。QQ 仅支持文本（C2C/群@/频道，单条 ≤2000 字符），不支持媒体。
- **普通消息 Chat**：非斜杠消息在目标 `allow_chat=1` 时进入 AI 对话（Telegram/Slack/QQ Webhook 与 Discord Gateway）；群/频道仅 @Bot 或回复 Bot（Slack 为 `app_mention`/显式 `<@BOTID>`），私聊直接进入；非管理员只能 Chat，管理员斜杠命令仍由目标 `allow_commands` + user 白名单双校验；Chat 只读，不执行写操作。每 Bot×用户每分钟默认 6 次，并与 `/ask` 共用每小时 10 次 AI 配额。
- **长期记忆**：每 Bot×用户一份，DB `bot_ai_memories` 为权威摘要，`DATA_DIR/bot-memory/memory-<uuid>.md` 为镜像（0700/0600）；每轮对话后滚动摘要，失败保留旧摘要；记忆不通过 API/UI 暴露。两种 AI 模式共享记忆；摘要不额外占用对话轮次或 AI 每小时配额。
- **双模式提示词（v0.5.4）**：`/ask` 使用任务导向提示（结论/步骤/风险/必要澄清），普通 Chat 使用无产品身份限定的自然对话提示（不自我介绍、不主动谈业务）；`BOT_AI_TASK_PROMPT`/`BOT_AI_CHAT_PROMPT` 可覆盖，固定只读安全边界始终追加；`/ask` 与 Chat 分别使用独立 OpenCode 会话，共享长期记忆；QQ C2C 私聊对任意用户开放 Chat（平台侧限制 Bot 可添加性），群/频道仍按目标登记；旧 `BOT_AI_SYSTEM_PROMPT` 废弃。
- **默认角色与私聊角色卡（v0.5.6）**：内置默认角色 `lofii`，私聊和群聊普通对话都用它；`/role` 对全部平台私聊用户开放（其他命令仍按白名单），每 Bot×用户一张“名字+角色设定”卡，`set/show/off/on/delete` 管理；个人卡只覆盖私聊，`off` 后回到默认 lofii；群聊固定默认角色。`/ask` 不受影响；角色变更会重置当前私聊对话。`/role` 文案只写当前角色与命令用法，不注入默认角色个性，也不出现技术术语。
- **多附件**：单次最多 5 个、单文件 ≤10 MiB、总 ≤50 MiB；Telegram 全图片走 media group、混合类型逐文件，Discord 单次 multipart，Slack 逐文件上传后一次完成；QQ 仅文本。部分成功不自动重试（标记 `failed`/`partial_media_sent`，需人工重建）。
- **只读按钮**：Telegram inline keyboard 与 Discord message components 支持 `/status`、`/help` 的“刷新状态/帮助”按钮；按钮动作需目标 `allow_commands` + user 白名单，只调用只读 provider，无写操作；Slack/QQ 本轮不做按钮。
- **Discord Gateway**：`server/src/bot/discord-gateway.ts` 使用 Node 内置 WebSocket 建立长连接，`intents=37377`（含 `MESSAGE_CONTENT`）；需在 Developer Portal 开启 Message Content Intent；支持 HELLO/IDENTIFY/RESUME、心跳、RECONNECT/INVALID_SESSION、指数退避重连与致命关闭码；`BOT_DISCORD_GATEWAY_ENABLED=false` 默认关闭（生产已设为 true），`BotSummary.gateway` 展示连接状态。
- **出站连通性（v0.5.3）**：`server/src/bot/connectivity.ts` 每 60 秒按“代理端口 → 外网 → 平台 API”探测；`GET /api/bots/connectivity` 返回设备在线/代理端口/外网/平台状态，`POST /api/bots/connectivity/check` 手动复检；网络恢复后自动 `wake` Discord Gateway 并触发队列扫描；`/bots` 概览展示“出站网络”卡片。
- **Windows 代理隧道**：`scripts/discord-tunnel.ps1` 先探测 PC 代理 10090，再建 SSH 反向隧道；默认通过 `discord-tunnel.vbs` 以 wscript 无窗口启动，直接运行也不占前台 shell；`scripts/install-tunnel-task.ps1` 注册登录启动/异常重启的静默计划任务，并清理旧实例防止重复占用 18090。调试用 `-Foreground`。
- 管理 API `/api/bots*` 与页面 `/bots`：概览、配置、目标、投递与发布四个分区；目标支持 `allowChat` 与“最近入站目标”登记；发布表单多选媒体；Token/Webhook Secret/Signing Secret/AppSecret 只写不读，数据库只存 AES-256-GCM 密文（`BOT_SECRET_KEY`，32 字节 base64）。
- 只读命令 `/help`、`/status`、`/backup`、`/world`、`/mc`、`/files <关键词>`，AI 命令 `/ask <问题>`，以及私聊角色卡命令 `/role`：除 `/role` 仅要求私聊外，其余命令必须同时命中目标的 `allow_commands` 与显式 user 白名单（`kind='user'` 且 `allow_commands=1`）；`/ask` 仅在 `BOT_AI_ENABLED=true` 时可用，按用户每小时限流（默认 10 次），复用 OpenCode 会话，新建会话使用 deny-all 工具权限；不返回文件内容或密钥。
- 告警通知：告警事件写入后按目标 `allow_notifications` 入队，按告警事件去重；目标可配置 `quietStartMinute`/`quietEndMinute`（Asia/Shanghai 本地分钟，0–1439），静默窗口内的通知延后到结束时刻；通知文本清洗内部路径/URL 后外发。
- 发布：文本 + 最多 5 个云端普通文件媒体（单文件 ≤10 MiB、总 ≤50 MiB），目标必须是频道/群组；每次发布要求管理员 TOTP 再认证（`totpCode`）且请求体必须带 `confirmText: 'PUBLISH'`，缺失返回 `publish_confirm_required`；可定时（≤30 天）、取消 queued/draft、失败指数退避重试与手动重投；QQ 仅文本、拒绝媒体。
- 运维：`GET /api/bots/status`、`GET /api/bots/connectivity`、`GET /api/bots/:id/metrics?hours=24`、`GET /api/bots/:id/inbound-targets` 返回运行/连通性/投递/发布/事件统计与最近入站目标；`/bots` 展示近 24 小时指标卡、Discord Gateway 与出站网络状态。
- 默认 `BOT_ENABLED=false`：关闭时 Webhook 与写接口返回 404/503；`BOT_SECRET_KEY` 丢失后已存 Token 无法解密，只能重新录入。Bot 不可用时不影响应用主功能。

### 可观测性与告警

- 每 60s 采样 CPU/内存/温度/磁盘/负载，保留 30 天；`GET /api/metrics?range=1h|6h|24h|7d|30d` 按桶聚合（最多 240 点）。
- Dashboard 四张 SVG 趋势卡（CPU/内存/温度/磁盘），1h/6h/24h/7d/30d 切换，无第三方图表库。
- Activity 支持动作精确筛选 + 关键词 + 时间范围；Alerts 卡片支持状态/事件筛选与分页。
- 告警条件：磁盘、温度、内存、服务、备份超期、pending 备份、备份密钥包、Minecraft、欠压，以及世界备份/世界拉取/恢复演练超期；通用 JSON webhook（10s×3 重试、可选 HMAC）、Bot 通知、去重/冷却/恢复通知、90 天事件保留。

### 备份与灾备

- 应用归档两阶段：Pi `--prepare` 生成 pending → PC 拉取并校验 SHA-256 → `--ack` 才推进游标；pending 未确认不删除，已确认在 Pi 保留 2 个、PC 每天/每周保留 30 天/56 天。
- Web 备份管理：归档列表、手动 prepare、导入/校验、文件级恢复到新目录（TOTP + typed confirmation）；整库恢复只走离线 root 手工流程（`docs/BACKUP.md` §8.1）。
- 世界备份：`antifieldcloud-world.timer` 每周日 12:00（Asia/Shanghai，Persistent）以 root 生成 gzip 归档（`/var/lib/antifieldcloud/world-backups`），SHA-256 旁文件，保留 4 份；PC 周度 `world-pull.ps1` 校验后 ack 并保留 4 份。
- 恢复演练：`drill.ps1` 自动校验 full+inc 链、旁文件 SHA、tar 安全、最新 DB integrity/FK/schema、manifest，报告保留 180 天；可选 `-IncludeWorld` 解包验证 `level.dat`。
- 密钥包：age 加密 env/cloudflared/Minecraft/opencode 配置与 opencode DB 快照；明文临时目录优先用 `/run/antifieldcloud/secrets-tmp`（tmpfs），Pi 保留 2 份、PC 90 天。
- 备份/世界/拉取/演练状态由脚本写入只读 JSON（`/var/lib/antifieldcloud/*-status.json`，0644），Dashboard/Settings 与告警读取。

### PWA / 手机

- manifest + Service Worker：只缓存静态壳/资源，绝不缓存 `/api`、`/s` 或文件内容；支持安装提示与手机拍照上传。
- 390 px 无横向滚动；多文件分享、笔记附件、备份状态卡在移动端纵向堆叠。

## 常用命令

```powershell
npm ci
npm run dev              # 服务端（Node 原生 TS，默认 127.0.0.1:3000）
npm run dev:web          # Vite 开发服务器 :5173
npm run build            # 构建前端到 web/dist（含 PWA 静态资源）
npm run test             # node --test：服务端 + 运维脚本
npm run test:coverage    # 服务端/脚本测试 + 覆盖率门禁
npm run test:web         # 前端 Vitest
npm run test:web:coverage # 前端 + 覆盖率门禁
npm run check            # typecheck + lint + 服务端测试 + 前端测试
node scripts/check-version.mjs # 版本一致性（package.json / README / CHANGELOG / ACCEPTANCE / AGENTS / env.example / DEPLOY 标题 / lock）
npm run provision        # 初始化管理员/TOTP（在 Pi 上以 antifieldcloud 运行）
npm run backup           # 生成应用备份归档（在 Pi 上以 antifieldcloud 运行）
```

部署（PC）：`.\scripts\deploy.ps1 -PiHost <直连 IP>`；冒烟：`.\scripts\smoke.ps1 -PiHost <直连 IP> -ExpectedVersion 0.5.6 -ExpectedSchemaVersion 11`（配置 Cloudflare Access 后可加 `-AccessClientId/-AccessClientSecret`）。

## 目录

```text
server/    Fastify 服务端（src + test：认证/文件/分片/笔记/分享/告警/备份/指标/Bot）
web/       React 前端（Vite 根目录，含 PWA public/ 与 /bots 管理页）
scripts/   provisioning、备份 CLI、世界备份（backup-world.mjs）、恢复演练（drill.ps1/drill-verify.mjs）、
           Windows 拉取与部署/冒烟脚本、bootstrap-env.sh、check-version.mjs；scripts/test 为运维脚本单元测试
deploy/    systemd（应用/健康探针/世界备份 timer）、nftables、cloudflared、env 模板
docs/      架构、安全、部署、备份、Bot 集成、API、UI、审计与验收
```

## 安全与边界

- 单管理员，密码（scrypt）+ TOTP；所有写操作校验 CSRF；会话 Cookie HttpOnly/Secure/SameSite=Lax。
- 文件内容不可变，逻辑目录存 SQLite；配额 10 GiB（含回收站与笔记附件）；单文件 100 MiB，分片上限 5 GiB。
- `files.origin` 隔离可见性：笔记附件只能经笔记接口管理，不出现在文件列表/搜索/回收站；分享只允许活动普通文件。
- Minecraft 应用 API 仅状态查询与白名单增删；RCON 强密码仍由 nftables 限制为 loopback；世界备份脚本以 root 仅执行固定保存命令。
- opencode 仅通过 `ai.example.com` 反代访问，端口 4096 不对外；代理覆写客户端 Authorization/Cookie，并校验 HTTP/WS Origin。
- 分享 token 只存 SHA-256，密码 scrypt；过期/吊销/次数用尽返回 410；公开页 `noindex`；公开写请求校验 Origin 并限流。
- Bot 平台 Token/签名密钥/QQ AppSecret 只写不读，数据库仅存 AES-256-GCM 密文；Webhook 以平台签名/时间戳鉴权并按事件 ID 去重；QQ 额外校验 op=13 Ed25519 回调地址；命令要求目标授权 + 显式用户白名单；发布要求 TOTP + `PUBLISH` 双确认；通知/命令输出清洗路径与 URL。
- Chat 目标级 `allow_chat` 与命令 `allow_commands` 分离：非管理员只能 Chat，群/频道需 @Bot 或回复 Bot；记忆只存摘要（DB 权威 + `DATA_DIR/bot-memory` 镜像，0700/0600），不通过 API/UI 暴露；Discord Gateway 只建立出站 WSS，Token 只出现在 IDENTIFY/RESUME，MESSAGE_CONTENT 仅消费私聊/@/回复消息。
- `/ask` 与 Chat 仅对已授权用户/目标开放，默认关闭且按用户每小时限流；AI 会话新建时使用 deny-all 工具权限，若 OpenCode 明确拒绝该字段才降级并在日志标注“未隔离”；AI 仅把文本回复交给 Bot，不上传文件、不返回 OpenCode 凭据。
- 备份归档校验 SHA-256 与 tar 安全（拒绝路径穿越/链接/设备/超大条目）；Web 恢复只到新目录、不覆盖，整库恢复仅离线 root 流程。
- 指标与审计只记录元数据/主机数值，不含文件内容；审计字段截断（actor≤64、target≤256、detail≤4 KiB）。
- systemd 沙箱（空 capability、只读系统、仅数据目录可写、MemoryMax 512M）+ 世界备份 unit 加固；nftables 默认拒绝入站；SSH 仅公钥（`00-` drop-in，保留 24h 回滚窗口）；`fail2ban` 以 nftables 后端启用 `sshd` jail（24h ban），dbfile 持久化封禁，`nftables.service` 的 drop-in 在启动后异步重启 fail2ban 恢复封禁 set。
- 任何密钥只存放在 `/etc/antifieldcloud/env`（0640 root:antifieldcloud）、Pi 本机或离线 age 私钥；不进仓库/日志/前端 bundle。
- 备份包含 TOTP secret、Bot 凭据密文（`BOT_SECRET_KEY` 在 env 内）与文件内容；密钥包用 age 加密，Windows 备份目录 ACL 仅当前用户/Administrators/SYSTEM。

## 已知限制

- SSH 密码登录已在 v0.5.0 关闭（仅公钥，`00-` drop-in，24h 回滚窗口）；`antifield` 的 `NOPASSWD ALL` sudo 属既有残留（用户选择保留）；`fail2ban` 已启用 `sshd` jail（nftables 后端，24h ban），dbfile 持久化与 nftables 启动后恢复 drop-in 已安装。
- RCON 仍监听所有接口（Paper 无 bind 配置），仅由 nftables 限制为 loopback；Cloudflare Access 主应用 + 4 个 bypass + service token 已配置并验证，service token 只保存在 PC gitignored `.local/cf-access.env`，应定期轮换。
- Cloudflare 终止 TLS，可见明文；单 SD 卡、无全盘加密；普通归档仍含 TOTP/会话明文，age 私钥丢失则密钥包不可恢复。
- 限流状态在内存中，应用重启清零；`http-proxy` 在 Node 26 有弃用警告，Node 27 前需评估替换；scrypt 仍为 N=2^15。
- 分享不支持目录打包，多文件分享不提供服务端 zip；下载次数为会话级近似限制；无公开笔记分享。
- 不支持 WebDAV、Minecraft 启停/控制台、多用户/权限分离；Cloudflare 约 100 MiB/100s 请求限制仍约束单请求上传。
- 世界备份依赖 Minecraft 运行与 RCON 可达；Windows 世界拉取/演练计划任务需用户手动安装，未装时状态为“未运行/unknown”。
- 备份无异地副本与整包加密；旧世界 cron 已停用，历史 `minecraft-backups` 归档不自动删除，需按 `docs/DEPLOY.md` 手动清理。
- Bot 已知限制：QQ 官方 Bot 仅文本、不支持媒体；单次发布最多 5 个媒体文件（单 10 MiB、总 50 MiB，QQ 无媒体）；命令严格只读；Slack/QQ 按钮未实现；企业微信/钉钉/飞书留 v0.5.4，多管理员审批未实现；QQ 群/频道目标仍待真实场景补充。
- v0.5.6：Bot 默认角色 lofii（私聊/群聊）、`/role` 个人角色只覆盖私聊、`off` 回落到 lofii；v0.5.5 的私聊角色卡与 schema v11 保留；v0.5.3 的出站连通性/隧道自恢复/QQ 群 Chat 已完成。
- Bot 已知限制：QQ 官方 Bot 仅文本、不支持媒体；单次发布最多 5 个媒体文件（单 10 MiB、总 50 MiB，QQ 无媒体）；命令严格只读；Slack/QQ 按钮未实现；企业微信/钉钉/飞书留 v0.5.7，多管理员审批未实现；QQ 频道目标仍待补充。
- `/ask` 生产已验证 `opencode-go/deepseek-v4.1-flash` 真实回复；v0.5.3 已实发确认 Discord DM、Discord #general @Bot、QQ C2C 与 QQ 群 @Bot Chat；多附件真实平台外发、按钮与 Telegram/Slack 仍待验收。
- Cloudflare Access 与 QQ 回调已配置并验收；后续仅需轮换 service token/高权限 API Token，并持续复跑带 token 的 smoke。
- 备份已知残留：增量水位受系统时钟回拨/同毫秒写入影响（DR-1）；Web 导入归档无自动保留策略（DR-7）；
  告警跨周期不重复投递（DR-22）；`.backup.lock` 无心跳续租（DR-23，>1h 可按陈旧锁接管）。

详细设计与验收标准见 `docs/ARCHITECTURE.md`、`docs/SECURITY.md`、`docs/DEPLOY.md`、`docs/BACKUP.md`、`docs/BOT.md`、`docs/API.md`、`docs/UI-SPEC.md`。

## License

MIT © 2026 Antifield。详见 [LICENSE](LICENSE)。

> 仓库中的域名、IP 与备份路径均为示例值（`example.com`、`192.0.2.x`、`%USERPROFILE%`）；
> 实际部署通过 `/etc/antifieldcloud/env`、`-PiHost`、`-BackupRoot` 等参数覆盖。
