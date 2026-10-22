# Bot 集成（v0.5.7）

AntifieldCloud 的 Bot 模块把运维告警、只读状态查询、AI 问答（命令与普通消息 Chat）和手动/定时内容发布接到社交平台。
v0.5.7 支持 **Telegram、Discord、Slack、QQ 官方 Bot**；QQ 仅文本（无媒体/图片）；Telegram/Discord 提供只读按钮；Discord 支持 Gateway 长连接与普通消息 Chat。
本版新增：目标级群聊触发方式（仅 @/回复、全部消息）、回复引用/线程、长回复分段与 Markdown 平台化、图片理解（默认关闭）、
`/reset` 与 `/forget confirm` 自助命令、平台连接自检、入站事件诊断、角色/记忆元数据管理，以及 `/bots` 的 6 个分区。
企业微信/钉钉/飞书与多管理员审批仍未实现。生产已部署 v0.5.7/schema v12（release `20261022T131121Z`，commit `8dcd10f`，部署内只读 smoke 16/16、完整 smoke 24/24；迁移前快照 `db-predeploy-20261022T131150335Z.sqlite`）；真实平台消息级联调待用户实发。
Discord Gateway 已连接；Discord DM、Discord #general @Bot、QQ C2C 与 QQ 群普通消息 Chat 已实发确认；出站连通性断开/恢复已实测。

> 安全边界：Bot Token/Secret/AppSecret 只写不读，数据库只存 AES-256-GCM 密文；Webhook 只按平台签名鉴权；
> 除自助命令（`/role` 仅私聊；`/reset`、`/forget confirm` 全用户）外，斜杠命令需要目标 + 用户双重白名单；Chat 只授予目标内普通消息 AI 对话，不授予命令权限；
> 发布必须 TOTP + `PUBLISH` 二次确认；通知/命令/Chat 输出不包含内部路径或 URL；记忆/角色正文不通过 API/UI 暴露；
> 诊断只存事件元数据、不存消息正文；图片只按固定域名下载、mime 白名单与大小上限处理且不落盘；Bot 默认关闭（`BOT_ENABLED=false`），Webhook 关闭时返回 404。

## 1. 架构

```text
平台 ──签名 Webhook──▶ POST /api/bot/webhook/:botId
                         │ 验签/时间戳/去重 + IP 限流 → bot_events(received/ignored 诊断)
                         ├─ 斜杠命令 → 自助命令(/role 私聊、/reset、/forget confirm) 或 目标 allow_commands + 用户白名单
                         │              → 只读 provider / OpenCode AI → 平台回复（可带只读按钮）
                         ├─ 普通消息 → 目标 allow_chat + 触发策略(mention/all) → AI Chat → 格式化/分段/引用 → 平台回复
                         ├─ 按钮回调 → 目标 allow_commands + 用户白名单 → 只读刷新/帮助
                         └─ 入站错误 → 401/404/429（不执行业务）

Chat/命令回复管线：AI 文本 → sanitize（路径/URL/控制字符）→ format.ts 平台化（Telegram HTML / Discord / Slack mrkdwn / QQ 纯文本）
                  → text.ts 分段（平台上限、最多 4 段、续段前缀、HTML 安全分段）→ 适配器发送（群/频道带引用，私聊不带）

图片管线（默认关闭）：入站图片引用 → 适配器 loadImage（固定平台域名、image mime、≤BOT_AI_IMAGE_MAX_BYTES、不落盘）
                  → AI prompt files(data URL) → 失败/关闭降级提示；QQ 不支持

Discord Gateway（可选）──WSS──▶ DiscordGatewayManager
                         │ HELLO/IDENTIFY/RESUME、心跳、重连、MESSAGE_CREATE
                         └─ 私聊/@Bot/回复 Bot/目标 all → BotService.handleGatewayMessage → Chat 授权/限流 → AI

平台连接自检 ──▶ POST /api/bots/:id/check → 适配器 check（Telegram getMe/getWebhookInfo、Discord /users/@me、Slack auth.test、QQ access_token）
诊断查询 ──▶ GET /api/bots/:id/events（bot_events 元数据，无正文）
角色/记忆管理 ──▶ GET/PATCH/DELETE roles、GET/DELETE memories（仅元数据）

告警/管理 API ──▶ BotService ──▶ bot_deliveries / bot_publish_jobs
                                  │ 每 30s 队列 tick、静默延后、指数退避、死信；partial 不自动重试
                                  └─ 适配器（Telegram / Discord / Slack / QQ 官方 Bot）
```

服务端模块：

- `server/src/bot/crypto.ts`：`BOT_SECRET_KEY`（32 字节 base64）加密/解密平台凭据，按 `key_version` 保存。
- `server/src/bot/text.ts`：各平台单条文本上限（telegram 4096 / discord 2000 / slack 4000 / qq 2000）、分段（最多 4 段、续段前缀、截断标记、代理对安全切分）；`formatAiReply` 前的纯函数。
- `server/src/bot/format.ts`：AI Markdown 的平台化转换（Telegram HTML 标签/转义、Discord 原生 markdown、Slack mrkdwn、QQ 纯文本），链接只放行 http(s)。
- `server/src/bot/errors.ts`：平台/队列错误 → 中文提示（管理页 `lastErrorHint`），不含凭据/URL/响应正文。
- `server/src/bot/adapters/{telegram,discord,slack,qq}.ts`：平台签名、命令/Chat/按钮解析、文本分段/多附件/引用发送、图片下载（`loadImage`）与连接自检（`check`，QQ 仅 access_token）；QQ 仅文本、群/频道仅 @。
- `server/src/bot/ai.ts`：OpenCode 本地 API 客户端，提供 `/ask` 与 Chat 的会话复用、deny-all 工具、超时/截断、图片 prompt files 与记忆摘要；回答上限 `BOT_AI_MAX_REPLY_CHARS`，平台层再分段。
- `server/src/bot/memory.ts`：每 Bot×用户长期记忆；DB 摘要为权威，`DATA_DIR/bot-memory/memory-<uuid>.md` 为镜像；提供元数据列表/删除。
- `server/src/bot/roles.ts`：每 Bot×用户私聊角色卡；提供元数据列表、启停、删除（正文只供 `/role show` 与 Chat 提示词）。
- `server/src/bot/discord-gateway.ts`：Discord Gateway 长连接、intents、心跳、RESUME/重连与致命关闭码；`chatTriggerFor` 注入目标触发策略。
- `server/src/bot/service.ts`：CRUD、Webhook、Chat/命令/按钮分发、回复管线（sanitize→format→split）、引用、图片降级、事件诊断、连接自检、角色/记忆管理、指标、静默时段、通知/发布队列、重试、清理、限流。
- `server/src/http/routes/bots.ts`：管理 API（含 check/events/roles/memories/chatTrigger/lastErrorHint）；`bot-webhook.ts`：公开回调入口。
- web `/bots`：概览、配置、目标、投递与发布、角色与记忆、诊断六个分区；配置页“检查连接”，目标页触发方式，角色/记忆与诊断面板只展示元数据/脱敏错误。

## 2. 平台接入

### Telegram

1. BotFather 创建 Bot，取得 Token；`setWebhook` 指向
   `https://app.example.com/api/bot/webhook/<botId>`，并设置随机 `secret_token`（≥16 字符）；
   `allowed_updates` 至少包含 `message` 与 `callback_query`（按钮回调）。
2. 在 `/bots` 填写 Token 与 `Webhook Secret`；平台消息需在允许的私聊/群组/频道中。
3. 命令：`/help`、`/status`、`/backup`、`/world`、`/mc`、`/files [关键词]`、`/ask <问题>`；自助命令 `/role`（仅私聊）、`/reset`、`/forget confirm` 直接发送即可（无需平台注册）。
4. Chat：私聊普通消息直接进入；群/频道默认需 @Bot 或回复 Bot（`privacy mode` 开启时未 @ 的消息不会推送给 Bot）；
   如需“全部消息”触发，在 BotFather `/setprivacy` → Disable，并把目标触发方式设为“全部消息”。
5. 引用：群/频道回复使用入站 `message_id` 作为 `reply_to_message_id`；私聊不引用；被引用消息失效时降级为无引用重发一次。
6. 图片（默认关闭）：开启 `BOT_AI_VISION_ENABLED=true` 后，photo 取最大尺寸、document 仅 `image/*`；从 `api.telegram.org` 固定域名下载，mime 白名单 + 大小上限。
7. 按钮：`/status`、`/help` 回复带“刷新状态/帮助”inline keyboard；回调走 `callback_query`，仍需命令目标 + 用户白名单。

### Discord

1. Developer Portal 创建 Application/Bot，取得 Bot Token、Application ID、Public Key。
2. Interactions Endpoint URL 填 `https://app.example.com/api/bot/webhook/<botId>`；Discord 会以 Ed25519 签名验证。
3. `/bots` 填写 Application ID、Public Key、Token；斜杠命令通过平台注册（`/status` 等；另注册 `/role`、`/reset`、`/forget`——Discord 未注册的命令不会投递）。
4. 首次命令使用 deferred response（type 5），按钮使用 deferred update（type 6），随后通过 interaction follow-up webhook 回复。
5. **普通消息 Chat**：在 Developer Portal 开启 **Message Content Intent**，并设 `BOT_DISCORD_GATEWAY_ENABLED=true`；
   Gateway 使用 Node 内置 WebSocket 连接 `wss://gateway.discord.gg/?v=10&encoding=json`，`intents=37377`
   （GUILDS + GUILD_MESSAGES + DIRECT_MESSAGES + MESSAGE_CONTENT）。私聊、@Bot、回复 Bot 的消息进入 Chat；
   普通频道消息默认不消费，目标触发方式设为“全部消息”后才消费；忽略 bot/webhook 消息。未开启 intent 时 Discord 会以 close 4014 拒绝。
6. 引用：Gateway 消息回复使用 `message_reference`（`fail_if_not_exists:false`）引用入站消息；私聊不引用；引用被拒时降级为无引用重发一次。
7. 图片（默认关闭）：下载消息附件中 `image/*` 的图片（`cdn.discordapp.com`/`media.discordapp.net` 固定域名），mime 白名单 + 大小上限；关闭/失败时降级为文字回答。
8. Gateway 状态显示在 `/bots` 概览与配置分区：`未启用/连接中/已连接/重连中/错误`；错误含脱敏关闭原因（如 Token 无效、intent 未开启）。

### Slack

1. Slack App 启用 Event Subscriptions / Slash Commands，Request URL 指向同一 Webhook；填写 Signing Secret。
2. 订阅 `message.channels`、`message.im`、`app_mention` 等事件（按需）；Slash Command 响应 URL 必须为 `hooks.slack.com`。
   `/role`、`/reset`、`/forget` 需在 Slack 后台创建同名 Slash Command（与 `/status` 等一样）。
3. `/bots` 填写 Bot Token 与 Signing Secret；`chat.postMessage` 发文本，媒体走 `files.getUploadURLExternal` 流程。
4. Chat：DM 普通消息直接进入；频道默认通过 `app_mention` 或消息内显式 `<@BOTID>` 进入；目标触发方式设为“全部消息”且已订阅
   `message.channels` 时，普通频道消息也进入 Chat；其它频道消息忽略。
5. 引用/线程：频道回复使用入站 `ts` 作为 `thread_ts` 留在原线程；私聊不引用；线程失效时降级为不带 `thread_ts` 重发一次。
6. 图片（默认关闭）：下载频道消息中的 `image/*` 文件（仅 `files.slack.com`，用 Bot Token 鉴权），mime 白名单 + 大小上限；QQ 不支持。
7. Slack 本轮不返回按钮；发布媒体逐文件上传后一次完成。

### QQ 官方 Bot

1. 在 QQ 开放平台（q.qq.com）创建机器人，取得 **AppID** 与 **AppSecret**；AppID 填公开配置，AppSecret 填“Token/AppSecret”字段（只存密文）。
2. “开发设置 → 回调地址”填 `https://app.example.com/api/bot/webhook/<botId>`；平台会发送 `op=13` 校验，服务端用 AppSecret 派生 Ed25519 私钥返回 `{plain_token, signature}`。
3. 事件订阅按场景勾选 `C2C_MESSAGE_CREATE`（私聊）、`GROUP_AT_MESSAGE_CREATE`（群@）、`AT_MESSAGE_CREATE`（频道）。
4. 目标登记：C2C 填 `user_openid`，群聊填 `group_openid`，频道填 `channel_id`；命令用户另建 `kind=user` 且允许命令的目标。
5. 仅文本：单条 ≤2000 字符；被动回复带入站 `msg_id`，主动通知/发布不带 `msg_id`；**不支持媒体/图片**（发布带媒体返回 400，入站图片忽略）。
6. Chat：C2C 普通文本直接进入；群/频道仅 @Bot 触发（平台事件本身即 @ 消息），**不支持“全部消息”触发**（`chatTrigger=all` 返回 `chat_trigger_unsupported`）。
   可先 @Bot 发一条消息，再从 `/bots` 目标的“最近入站目标”登记。
7. 自助命令 `/role`（仅私聊）、`/reset`、`/forget confirm` 直接发送即可（无需平台注册）。
8. QQ 真实回调需用户后台配置；未配置前只能做进程内契约测试。

## 3. 权限模型

- **命令目标**：`bot_targets` 中 `allow_commands=1` 的频道/群组/私聊。
- **用户白名单**：发送者必须是 `kind='user'` 且 `allow_commands=1` 的目标；频道里的普通成员即使目标开启命令也无法执行。
- **自助命令（所有用户）**：`/role`（仅私聊，管理个人角色卡）、`/reset`（重置当前目标 Chat/任务会话，保留长期记忆）、
  `/forget confirm`（清除长期记忆 DB+镜像与该 Bot×用户的全部会话）。这三条不需要目标 `allow_commands` 或 user 白名单；
  审计只记动作、Bot 与用户 ID（截断），不记录角色设定/记忆正文；群内 `/role` 只回复“可私聊设置个人角色”的提示。
- **Chat 目标**：`allow_chat=1` 的目标内普通消息可进入 AI Chat；与 `allow_commands` 独立，不授予斜杠命令权限。
  非管理员只能 Chat；私聊直接进入；群/频道按目标触发方式（`chatTrigger=mention` 仅 @Bot/回复 Bot，`all` 消费全部消息）；
  Chat 不执行写操作。`message` 触发在目标未开放 Chat/触发方式不是 `all` 时静默忽略（只写诊断事件、不回复）。
- **触发方式**：`mention`（默认）与 `all`；QQ 群/频道只支持 `mention`（`all` 返回 `chat_trigger_unsupported`）；
  `all` 需平台前置：Telegram 关闭 privacy mode、Discord 开启 Message Content Intent、Slack 订阅 `message.channels` 且目标为 `all`。
- 只有管理员能在 `/bots` 添加目标/开启权限；Bot 命令本身不提供 RCON、启停、封禁、OP 或任意 shell。
- **按钮**：Telegram inline keyboard / Discord message components 的“刷新状态/帮助”动作沿用命令授权
  （目标 `allow_commands=1` + user 白名单），只调用只读 provider，无写操作；Slack/QQ 不做按钮。
- **发布**：仅管理员手动/定时创建；必须提供 6 位 TOTP（`totpCode`）与 `confirmText: "PUBLISH"`，不能仅靠会话 + CSRF 外发文件。
- 发布媒体仅限活动、`origin='user'` 的普通文件：最多 5 个、单文件 ≤10 MiB、总计 ≤50 MiB；不含外部 URL 抓取；QQ 平台无媒体。
- **AI `/ask` / Chat**：需 `BOT_AI_ENABLED=true`；`/ask` 仅命令白名单用户；Chat 仅 `allow_chat` 目标；私聊 Chat 可用 `/role` 个人角色卡，群聊与无个人卡的私聊使用默认 lofii；提示词 ≤`BOT_AI_MAX_PROMPT_CHARS`；
  Chat 每 Bot×用户每分钟 `BOT_CHAT_RATE_PER_MINUTE`（默认 6），Chat/`/ask` 共用每小时 `BOT_AI_RATE_PER_HOUR`（默认 10）；
  新建 OpenCode 会话使用 deny-all 工具权限；若 OpenCode 明确 400 拒绝 `permissions`，降级为默认权限并在日志标注“未隔离”。
- **长期记忆**：每 Bot×用户一份摘要；DB 为权威，镜像到 `DATA_DIR/bot-memory`；不通过 API/UI 暴露正文；系统提示内置，
  两种 AI 模式共享记忆；摘要失败保留旧摘要；摘要不额外占对话轮次或每小时 AI 配额；用户可 `/forget confirm` 自助清除。
- **管理面**：`GET /api/bots/:id/inbound-targets?limit=50`（需登录）返回最近命令/Chat/按钮的目标与用户（不含正文），
  `/bots` 目标分区可一键填入表单；`BotSummary.gateway` 返回 Discord Gateway 状态；`POST /api/bots/:id/check` 连接自检；
  `GET /api/bots/:id/events` 事件诊断；`roles`/`memories` 管理接口只返回元数据（用户/名字/长度/启停/时间），
  可启停/删除角色卡与删除记忆；角色设定与记忆摘要正文不进入 Web/API。

## 4. 队列、回复管线与失败处理（v0.5.7）

- 通知/命令回复/发布统一入队，`dedupe_key` 保证同一事件/目标只投递一次。
- 静默时段：目标设置 `quiet_start_minute`/`quiet_end_minute`（Asia/Shanghai 本地分钟 0–1439，成对设置、不能相同）后，窗口内新通知的 `next_attempt_at` 延后到窗口结束；跨午夜按 start > end 处理；通知不丢弃。
- 30 秒 tick，指数退避（30s 起，≤1h），达到 `BOT_DELIVERY_MAX_ATTEMPTS`（默认 5）进入 `failed/dead`。
- 多附件部分成功后失败不自动重试：任务标记 `failed`，`last_error` 含 `partial_media_sent` 与已发送数量，需人工确认后重建，避免重复外发。
- 长回复分段（v0.5.7）：AI 回答经清洗后按平台单条上限分段（Telegram 4096 / Discord 2000 / Slack 4000 / QQ 2000），最多 4 段，
  第 2 段起加“（续 n/m）”前缀，超出部分截断并标记“内容过长已截断”；Telegram HTML 只在标签边界切分并在跨段时补闭合/重开标签，避免平台 400。
  第 2 段起发送失败时把已发送消息 ID 挂到错误上，队列/命令记录 `partial_text_sent` 且**不自动重试**，由管理员核对平台消息后处理。
- Markdown 格式化（v0.5.7）：AI 回答按平台转换（Telegram HTML `parse_mode=HTML`、Discord markdown、Slack mrkdwn、QQ 纯文本），
  仅 http(s) 链接保留，输出保持平台可读且不注入 HTML。
- 引用/线程（v0.5.7）：群/频道回复引用触发消息（Telegram `reply_to_message_id`、Discord Gateway `message_reference`、Slack `thread_ts`），
  私聊不引用；引用/线程失效时降级为无引用重发一次，不丢内容。
- 图片（v0.5.7，默认关闭）：入站图片在 `BOT_AI_VISION_ENABLED=true` 时由适配器从固定平台域名下载（image mime 白名单、≤`BOT_AI_IMAGE_MAX_BYTES`、
  不落盘），以 OpenCode prompt files data URL 交给模型；关闭/下载失败/mime 非法时降级为纯文字回答并附“（图片未能处理，已按文字回答）”；
  只有图片无文字且无法处理时直接提示用户改用文字。QQ 不支持图片。
- 进程重启后，`sending` 超过 10 分钟的记录自动回队；`assembling` 等异常由各模块维护清理。
- 事件保留 `BOT_EVENT_RETENTION_DAYS`（默认 7 天）；AI 会话映射按 `BOT_AI_SESSION_RETENTION_DAYS`（默认 7 天）清理；
  记忆摘要按同一保留期清理（DB 行 + 镜像文件）；入站目标记录按事件保留期清理、每 Bot 最多 500 条；
  已发送投递/发布 30 天后清理；`failed/dead` 保留供人工重投，不自动删除。
- 诊断事件（v0.5.7）：入站 Webhook/Gateway 事件按 `(bot_id, platform_event_id)` 去重写入 `bot_events`，先记 `received`，
  处理完成后更新为 `ok`/`denied`/`rate_limited`/`ignored`/`error`，`detail` 只放短码（如 `command_denied`/`chat_rate_limited`/`partial_reply`），
  不写消息正文；`GET /api/bots/:id/events?hours&limit&offset&outcome` 查询元数据。
- 指标：`GET /api/bots/:id/metrics?hours=24`（1–720 小时）返回投递/发布/事件统计、成功率、最近错误（含 `lastErrorHint` 中文提示）与最近发送；
  `/bots` 页面展示近 24 小时卡与诊断分区。

## 5. 配置

见 `deploy/env.example` 的 `BOT_*` 段与 `docs/DEPLOY.md` §2/§3.1：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BOT_ENABLED` | `false` | 总开关；完成平台联调后再显式开启 |
| `BOT_SECRET_KEY` | 由 `bootstrap-env.sh` 生成 | 32 字节 base64；必须与 DB 一起备份 |
| `BOT_WEBHOOK_MAX_BODY_BYTES` | `262144` | Webhook body 上限 |
| `BOT_DELIVERY_INTERVAL_SECONDS` | `30` | 队列轮询间隔 |
| `BOT_DELIVERY_MAX_ATTEMPTS` | `5` | 最大尝试次数 |
| `BOT_EVENT_RETENTION_DAYS` | `7` | 入站事件/入站目标保留 |
| `BOT_COMMAND_RATE_PER_MINUTE` | `20` | 每用户命令限流 |
| `BOT_PUBLISH_MAX_MEDIA_BYTES` | `10485760` | 单个发布媒体上限 |
| `BOT_PUBLISH_MAX_MEDIA_FILES` | `5` | 单次发布媒体数量上限（默认 5；UI 与 Telegram/Discord 适配器按 5 控制） |
| `BOT_PUBLISH_MAX_MEDIA_TOTAL_BYTES` | `52428800` | 单次发布媒体总大小上限 |
| `BOT_PUBLISH_MAX_SCHEDULED_DAYS` | `30` | 定时发布最远天数 |
| `BOT_MAX_BOTS` | `10` | Bot 数量上限 |
| `BOT_AI_ENABLED` | `false` | `/ask` 与 Chat 的 AI 总开关；默认关闭 |
| `BOT_AI_PROVIDER` | 空 | 可选 OpenCode provider；与 `BOT_AI_MODEL` 同时设置才指定模型 |
| `BOT_AI_MODEL` | 空 | 可选模型 ID；为空使用 OpenCode 默认模型 |
| `BOT_AI_TIMEOUT_SECONDS` | `60` | AI 超时（10–180 秒） |
| `BOT_AI_MAX_PROMPT_CHARS` | `2000` | 提示词截断（100–8000） |
| `BOT_AI_RATE_PER_HOUR` | `10` | 每 Bot×用户每小时 AI 调用上限（1–120；Chat 与 `/ask` 共用） |
| `BOT_AI_SESSION_RETENTION_DAYS` | `7` | AI 会话/记忆映射保留天数（1–90） |
| `BOT_CHAT_RATE_PER_MINUTE` | `6` | Chat 每 Bot×用户每分钟上限（1–60） |
| `BOT_AI_MEMORY_MAX_CHARS` | `4096` | 长期记忆摘要上限（512–16384） |
| `BOT_AI_TASK_PROMPT` | 空 | `/ask` 任务提示覆盖；空则内置，最长 2000 |
| `BOT_AI_CHAT_PROMPT` | 空 | 普通 Chat 提示覆盖；空则内置，最长 2000 |
| `BOT_AI_MAX_REPLY_CHARS` | `4000` | AI 单次回答字符上限（1000–12000）；平台层再按各自上限分段 |
| `BOT_AI_VISION_ENABLED` | `false` | 图片理解总开关；开启需 OpenCode prompt files + 支持 image 输入的模型 |
| `BOT_AI_IMAGE_MAX_BYTES` | `10485760` | 单张入站图片上限（1–20 MiB）；image mime 白名单、固定域名、不落盘 |
| `BOT_DISCORD_GATEWAY_ENABLED` | `false` | Discord Gateway 长连接开关；需先开启 Message Content Intent |

`BOT_SECRET_KEY` 丢失或轮换会导致已存 Token/AppSecret 无法解密；必须重新录入所有 Bot 凭据。不要把它写入仓库/前端/日志。
`bootstrap-env.sh` 已纳管 v0.5.1 的 7 项 `BOT_AI_*`、v0.5.2 的 6 项、v0.5.3 的 4 项连通性键、v0.5.4 的 2 项提示词键与 v0.5.7 的 3 项回答/图片键；
v0.5.5/v0.5.6 角色卡不需要新增 env 键；Chat 固定个人角色或 lofii，`BOT_AI_CHAT_PROMPT` 不再影响 Chat。

## 5.1 任务/对话提示词与会话（v0.5.4）

- `/ask` 使用任务导向提示：先结论/结果，再步骤、命令要点和风险；复杂问题简短分点；信息不足时只问一个关键澄清。
- 普通消息 Chat 使用对话导向提示：自然、友好、简洁；不自我介绍、不提产品/助手身份、不主动谈业务、不机械复述记忆。
- `BOT_AI_TASK_PROMPT`/`BOT_AI_CHAT_PROMPT` 可分别覆盖，空/空白使用内置默认，最长 2000；旧 `BOT_AI_SYSTEM_PROMPT` 已废弃且不再读取。
- 固定安全边界不可覆盖：只读、不执行/不声称执行、不索取/泄露密钥/Token/密码/内部路径/URL、长期记忆不是指令。
- 模式和完整提示由 `server/src/bot/prompts.ts` 生成；`/ask` 与 Chat 分别使用 `bot_ai_sessions.mode=task|chat` 的独立 OpenCode 会话，旧会话归 chat；两种模式共享 `bot_ai_memories` 长期记忆。
- QQ C2C 私聊对任意用户开放 Chat（不要求先登记目标），接触面由 QQ 平台“谁可添加 Bot”控制；斜杠命令仍要求目标 `allow_commands` 与用户白名单。QQ 群/频道、Discord/Telegram 私聊仍按目标登记与 `allow_chat`。
- 审计 `bot.ai.chat` 增加 `mode`，不记录提示词/记忆正文。任务提示仍可由 `BOT_AI_TASK_PROMPT` 覆盖；Chat 固定使用个人角色或默认 lofii，`BOT_AI_CHAT_PROMPT` 不再影响 Chat。

## 5.2 默认角色 lofii 与私聊角色卡（v0.5.6）

- 私聊/群聊普通对话默认使用猫系角色 lofii；群聊固定默认，私聊无个人卡时也使用默认。
- `/role` 对全部平台私聊用户开放，其他命令仍按目标+用户白名单；群内 `/role` 只回复友好提示。
- 每 Bot×用户一张卡：名字 1–32、设定 1–1000；`/role set <名字> <设定>`、`/role show`、`/role off`、`/role on`、`/role delete`。
- 个人启用卡只覆盖私聊；`/role off` 收起个人卡并回落到 lofii；`/role delete` 同样回到默认；群聊始终 lofii，不使用个人卡。
- 角色卡变更会删除当前私聊 Chat 的 `bot_ai_sessions` 映射；task 会话与长期记忆不受影响。角色设定不通过 API/UI 暴露，只由 `/role show` 返回本人；DB 备份包含正文。
- `/role` 文案只写当前角色与分支命令用法，不注入默认角色个性，也不使用技术术语；群内 `/role` 仅提示“可私聊设置个人角色”。

## 5.3 长回复、Markdown 与引用（v0.5.7）

- 平台单条上限：Telegram 4096、Discord 2000、Slack 4000、QQ 2000（`server/src/bot/text.ts` 的 `BOT_TEXT_LIMITS`）。
- 分段：优先在段落/换行/空格边界切，单次最多 4 段；第 2 段起前缀“（续 n/m）”；超过 4 段只保留前 3 段 + 截断末段（标记“内容过长已截断”）；
  代理对（emoji/生僻字）不会被切成半个字符。Telegram HTML 模式使用标签感知分段：只在标签边界切分，跨段补关闭/重开标签，保证每段标签平衡。
- 格式化：`server/src/bot/format.ts` 把 AI Markdown 转为平台格式；Telegram 先整体转义再放入 `<b>/<i>/<code>/<pre>/<a>` 等受支持标签，
  Discord 保留原生 markdown（标题转粗体），Slack 转 mrkdwn，QQ 去掉标记保留纯文本；链接只允许 http(s)。
- 引用：群/频道回复携带触发消息 ID/时间戳（平台实现见 §2）；私聊不引用；引用/线程失败时降级为无引用重发一次。
- 失败语义：分段/附件部分成功后失败时错误对象带已发送 ID，投递/发布记录 `partial_text_sent`/`partial_media_sent` 并**不自动重试**，
  避免重复外发；需管理员核对平台消息后人工处理或重建任务。

## 5.4 图片理解（v0.5.7，默认关闭）

- 开关：`BOT_AI_VISION_ENABLED=false`（默认）；开启还需 OpenCode 支持 prompt files 与模型支持 image 输入。
  生产只读验证（2026-10-22）：OpenCode prompt files 接受 `data:` URL，`opencode-go/deepseek-v4.1-flash` 支持 image；默认保持关闭。
- 入站：Telegram photo（取最大尺寸）/document（仅 `image/*`）、Discord/Slack 消息中的图片附件；QQ 不支持。
- 下载：适配器 `loadImage` 只允许固定平台域名（`api.telegram.org`、`cdn.discordapp.com`/`media.discordapp.net`、`files.slack.com`），
  校验 image mime 白名单（jpeg/png/webp/gif）与 `BOT_AI_IMAGE_MAX_BYTES`，平台声明超限提前拒绝；图片不写磁盘，只在内存转 base64。
- 交给 AI：以 OpenCode prompt files 的 data URL 附加到本轮 prompt；只有图片无文字也可进入 Chat。
- 降级：vision 关闭/适配器不支持/下载失败/mime 非法时，有文字则继续文字回答并附“（图片未能处理，已按文字回答）”；
  无文字则提示“当前暂不支持处理这张图片，可以用文字描述”。审计 `bot.ai.image` 只记录 mime/大小/跳过原因，不记录内容。
- 与回复管线一致：图片回答同样经过 sanitize → 平台格式化 → 分段发送。

## 5.5 平台连接自检（v0.5.7）

- `POST /api/bots/:id/check`（登录 + CSRF，30 次/分钟）：Bot 必须启用、凭据可解密；调用适配器只读自检：
  - Telegram：`getMe` 校验 Token（返回 `@username`）+ `getWebhookInfo` 对比 `APP_ORIGIN/api/bot/webhook/<id>`，返回待处理更新数；
  - Discord：`GET /users/@me` 校验 Token；
  - Slack：`auth.test` 返回 team/user；
  - QQ：`access_token` 换取成功即视为可用（detail 固定，不返回 token）。
- 返回 `{health:{ok,items:[{name,ok,detail}],checkedAt}}`；`detail` 只含脱敏信息/短错误码（如 `telegram_unauthorized`、`network_error`），
  不包含 Token/Signing Secret/AppSecret/内部 URL。无论成功失败都刷新 `last_checked_at` 并写审计 `bot.check`；不覆盖投递 `last_error`。
- 不支持的平台/适配器返回 `400 bot_health_unsupported`；`/bots` 配置页“检查连接”展示通过/异常项。

## 5.6 诊断与管理（v0.5.7）

- 事件诊断：见 §4；`outcome` 缺省返回全部，非法值 400；`hours` 1–720（默认 24）、`limit` 1–200（默认 50）、`offset` ≥0。
- 错误提示：`server/src/bot/errors.ts` 把队列 `last_error`/事件短码映射为中文提示；未知错误返回 null，前端展示原文。
  `BotDelivery`/`BotPublishJob`/`BotMetrics` 增加 `lastErrorHint`，用于投递/发布/诊断分区与指标卡。
- 角色管理：`GET /api/bots/:id/roles?limit&offset` 返回 `{items:[{userId,userName,name,enabled,promptLength,createdAt,updatedAt}],total}`；
  `PATCH /api/bots/:id/roles/:userId` body `{enabled:boolean}` 启停；`DELETE` 删除并清理该用户 chat 会话。不返回角色设定正文。
- 记忆管理：`GET /api/bots/:id/memories?limit&offset` 返回 `{items:[{userId,userName,summaryLength,createdAt,updatedAt}],total}`；
  `DELETE /api/bots/:id/memories/:userId` 删除 DB 摘要与镜像文件（不动角色卡/会话）。不返回摘要正文。
- 审计：`bot.check`、`bot.reset`、`bot.memory.forget`、`bot.role.admin`、`bot.memory.admin` 只记录动作、数量/长度与截断 ID，不含正文。

## 6. 网络出站（Discord/Telegram/QQ/OpenCode）

Pi 所在网络可能无法直连 `discord.com` / `api.telegram.org` / `bots.qq.com` / `api.sgroup.qq.com`（Slack 通常可达）。
应用使用 Node 全局 `fetch`，支持 Node 26 的环境代理；Discord Gateway 是到 `gateway.discord.gg` 的出站 WSS 长连接，
同样需要网络/代理可达。Telegram/Discord/QQ 的回复、通知和发布同样走固定平台 API。

```bash
# /etc/antifieldcloud/env（可选；代理必须从 Pi 可达）
HTTPS_PROXY=http://127.0.0.1:18090
HTTP_PROXY=http://127.0.0.1:18090
NO_PROXY=127.0.0.1,localhost,::1
NODE_USE_ENV_PROXY=1
```

`127.0.0.1:18090` 可由 SSH 反向隧道或本机代理提供。修改后重启 `antifieldcloud` 并验证：

```bash
curl -sS -m 10 -x "$HTTPS_PROXY" -o /dev/null -w '%{http_code}\n' https://discord.com/api/v10/gateway
curl -sS -m 10 -x "$HTTPS_PROXY" -o /dev/null -w '%{http_code}\n' https://bots.qq.com/app/getAppAccessToken
sudo journalctl -u antifieldcloud -n 50 --no-pager | grep -i bot
```

没有可用出站代理时，Discord/Telegram/QQ 的回复、通知和发布都会失败（Webhook 入站仍可到达）；Slack 不受影响。
Discord Gateway 启用后若无法连接，`BotSummary.gateway.state` 会显示 `error` 并在配置页展示脱敏原因（Token/intent/网络）。
`/ask` 与 Chat 只访问 `OPENCODE_URL`（默认 `http://127.0.0.1:4096`），不走外部代理；不要修改固定上游。不要把代理凭据写入仓库；本机部署信息放在 gitignored 的 `.local/DEPLOYMENT.md`。

### 6.1 连通性探测与自动恢复（v0.5.3）

- `BOT_CONNECTIVITY_ENABLED=true` 时，服务端每 `BOT_CONNECTIVITY_INTERVAL_SECONDS`（默认 60）探测：
  1. 代理 URL（`BOT_PROXY_URL`，空则用 `HTTPS_PROXY`/`HTTP_PROXY`）的 TCP 端口；
  2. 经代理的 `https://discord.com/api/v10/gateway` 外网探测；
  3. 每个启用平台的只读 API URL（Discord/Telegram/Slack/QQ），4xx 也算网络可达。
- `GET /api/bots/connectivity` 返回 `deviceOnline`、代理 host/port、外网与各平台延迟；`POST /api/bots/connectivity/check` 手动复检（30 次/分钟）；`/bots` 概览卡片展示这些状态。
- 外网从不可达恢复时调用 `DiscordGatewayManager.wake()` 跳过退避立即重连，并触发投递/发布队列扫描；探测不携带 Bot 凭据、不记录响应正文。
- PC 端隧道：先运行 `.\scripts\install-tunnel-task.ps1`（登录启动、异常重启；wscript/VBS 无窗口启动，不占前台 shell），后台脚本会先探测 PC 代理 10090，不可用时持续重试；任务日志 `%LOCALAPPDATA%\AntifieldCloud\discord-tunnel.log`。调试用 `.\scripts\discord-tunnel.ps1 -Foreground`。
  判据：计划任务 `Running`，Pi `ss -ltn | grep 18090` 有监听，`/bots` 显示设备在线/代理端口存活。

### 6.2 QQ 群/频道无响应排查（v0.5.3）

按顺序确认，避免把平台配置问题误判为代码问题：

1. QQ 开放平台已订阅群事件 `GROUP_AT_MESSAGE_CREATE`（频道为 `AT_MESSAGE_CREATE`），回调地址为 `https://app.<域名>/api/bot/webhook/<botId>`，且回调校验 `op=13` 已通过。
2. Bot 已被拉入该群/频道；QQ 群消息必须 **@Bot** 才会推送给机器人，普通群聊不会产生事件（QQ 群/频道也不支持“全部消息”触发）。
3. 发送后查看服务端：`bot_events` 是否有新事件（`GET /api/bots/:id/events` 可查元数据）；若事件到达但正文为空/未知，会记录 `audit_log.action='bot.event.ignored'`（只含事件类型，不含正文）。
   若 `bot_inbound_targets` 出现 `target_kind='group'`，到 `/bots` 目标分区从“最近入站目标”登记该 group_openid，再开启 `allow_chat`（命令另开 `allow_commands`）。
4. 若没有新事件，优先检查开放平台事件订阅、Bot 入群状态与 @ 方式；入站 Webhook 不依赖出站代理。
5. 有事件但无回复：查看 `/bots` 出站网络卡片（设备在线/代理端口/QQ 平台延迟）和投递 `lastError`/`lastErrorHint`；QQ 回复需经代理访问 `bots.qq.com`/`api.sgroup.qq.com`。

v0.5.2 当前生产只有 QQ C2C 目标与事件，未出现群入站事件；因此“群无响应”的首个待查项是平台事件订阅/Bot 入群/@，而不是 Chat 授权。
v0.5.3 生产已出现群事件 `68611590B477339A04302BB23B426244`，审计 `bot.chat.denied` 证实根因是群目标未登记；登记 `kind=group`（`allow_chat=1`/`allow_commands=1`）后用户确认群 @Bot 已收到 AI 回复。
v0.5.7 起群/频道诊断可直接用 `/bots` → 诊断分区按 outcome 过滤查看；QQ 群/频道仍只支持 @Bot 触发。

## 7. 记忆存储与运维

- DB `bot_ai_memories`：`(bot_id, user_id)` 主键、`memory_id` 唯一、`summary`、`summary_session_id`、时间戳；DB 是权威来源。
- 镜像：`DATA_DIR/bot-memory/memory-<uuid>.md`；目录 0700、文件 0600；临时文件 + 原子 rename；读取上限 32 KiB。
- 每轮 Chat/`/ask` 后滚动摘要；摘要失败只记日志、保留旧摘要，不影响本轮 AI 回复。
- 删除路径：用户 `/forget confirm` 删除该 Bot×用户 DB 摘要+镜像文件并清空该 Bot×用户全部 AI 会话；管理员 `DELETE /api/bots/:id/memories/:userId`
  只删除摘要与镜像（不清会话，清全部会话由用户自助 `/forget confirm`）；删除角色卡只清该用户 chat 会话，不动记忆；删除 Bot 时 `bot_ai_memories`/`bot_inbound_targets`/`bot_chat_roles` 随 DB 级联删除。
- 角色卡正文：`bot_chat_roles` 只保存每 Bot×用户私聊角色卡（名字/设定/启停/时间）；不通过 Web/API 返回，只由 `/role show` 返回本人；
  管理员在 `/bots` → 角色与记忆只能查看元数据（用户、名字、长度、启停、时间）并启停/删除。
- 记忆/角色正文不经过任何 HTTP 列表 API/前端；`/bots` 不展示摘要或角色设定；Web 静态目录不包含 `bot-memory` 目录。
- 备份：DB 快照包含权威摘要与角色卡正文；镜像目录不是恢复必需项，缺失时可在下次读取时重建。

## 8. 测试与验收边界

- 适配器/验签/队列/命令白名单/发布 TOTP+`PUBLISH`/AI/Chat/记忆/多附件/按钮/Gateway/分段/格式化/引用/触发/图片/自检/诊断/角色与记忆管理
  均有进程内测试（不访问真实平台/模型）。
- v0.5.2 新增：`bot-chat-adapters.test.ts`（12）、`bot-discord-gateway.test.ts`（10）、`bot-v052.test.ts`（5）；
  `bot-migration.test.ts` 覆盖 v6→v9（`allow_chat`、`bot_ai_memories`、`bot_inbound_targets`）。
- Telegram/Slack 以 mock/fixture 覆盖；Discord Ed25519 使用本地密钥对；QQ 使用固定 AppSecret 派生密钥对；AI 使用假 OpenCode HTTP 服务；
  Discord Gateway 使用假 WebSocket（HELLO/IDENTIFY/RESUME/心跳/重连/致命关闭码）。
- v0.5.3 新增：`bot-connectivity.test.ts`（5）覆盖代理端口/外网/平台探测与恢复回调；Gateway `wake` 测试；QQ 未知事件 detail。
- v0.5.4 新增：`bot-prompts.test.ts`（4）、`bot-v054.test.ts`（3）、`bot-v054-c2c.test.ts`（3）、task/chat 会话隔离测试；
  v0.5.5 新增 `bot-roles.test.ts`、`bot-v055.test.ts`，迁移测试覆盖 v6→v11、v9→v11、v10→v11。
- v0.5.7 新增：`bot-v057-foundation.test.ts`（分段/格式化/错误映射/配置迁移）、`bot-v057-adapters.test.ts`（四平台分段、引用、触发、自检、图片提取）、
  `bot-v057-reply.test.ts`（引用降级/线程/partial）、`bot-v057-health.test.ts`（连接自检）、`bot-v057-vision-adapters.test.ts`（图片下载域名/mime/大小）、
  `bot-v057-trigger.test.ts`（chat_trigger 创建/更新/QQ 拒绝/message 触发）、`bot-v057-commands.test.ts`（/reset、/forget confirm）、
  `bot-v057-admin.test.ts`（角色/记忆管理元数据）、`bot-v057-diagnostics.test.ts`（事件 outcome/lastErrorHint）、迁移测试覆盖 v11→v12；
  Telegram HTML 安全分段另有专门用例（标签边界、跨段闭合/重开、长度 ≤4096）。
- 本地基线（2026-10-22）：`npm test` **387**、`npm run test:web` **157**（30 文件）、`npm run check` 通过；`process.env` 与平台 API 均走 mock/夹具。
- **真实平台前置条件**（部署/联调前确认）：
  - Telegram：Webhook 已设置 `secret_token`；群/频道默认只能 @/回复触发；“全部消息”需 BotFather 关闭 privacy mode。
  - Discord：Interactions Endpoint 已保存；普通消息需 Developer Portal 开启 **Message Content Intent** 且 `BOT_DISCORD_GATEWAY_ENABLED=true`；
    “全部消息”需目标 `chatTrigger=all`；`/role` `/reset` `/forget` 需在平台注册。
  - Slack：Event Subscriptions 订阅 `message.channels`/`message.im`/`app_mention`；“全部消息”需目标 `chatTrigger=all` 且已订阅 `message.channels`；
    `/role` `/reset` `/forget` 需创建同名 Slash Command。
  - QQ：回调 `op=13` 已通过、事件订阅含 C2C/群@/频道；群/频道仅 @Bot、不支持全部消息/媒体/图片；C2C 无需登记即可 Chat，命令仍按白名单。
  - 图片：需 `BOT_AI_VISION_ENABLED=true`、OpenCode prompt files 与支持 image 的模型；QQ 不支持；生产默认保持关闭。
- 真实平台：v0.5.1 生产已验证 Discord Interactions + QQ C2C `/help` + AI 真实模型；v0.5.2 已部署/迁移 v9，Discord Gateway 已连接；
  v0.5.3 生产已部署/smoke 24/24，Discord DM、Discord #general @Bot、QQ C2C 与 QQ 群 @Bot 普通消息 Chat 已实发确认，出站连通性断开/恢复实测通过；
  v0.5.4 已部署 release `20261022T085120Z`/schema v10；双模式提示词/会话隔离与 QQ C2C 管理员/非管理员真实回复已验收；v0.5.5 私聊 `/role`/Chat 已实发确认；
  v0.5.6 默认角色 lofii 与简洁 `/role` 文案已验收；OpenCode v2.1.2 Basic/session 已通过。v0.5.7 已部署（release `20261022T131121Z`/schema v12，smoke 24/24；Gateway 已连接、连接自检通过），
  真实平台消息级联调待用户实发后按 `docs/ACCEPTANCE.md` 回填：分段/Markdown/引用、触发方式、`/reset`/`/forget confirm`、连接自检、诊断、角色/记忆管理、图片（默认关闭，按需临时开启）。
- 手工验收：创建/启用 Bot → 添加目标并勾选 `allow_chat`（命令另勾 `allow_commands` 并登记 user 白名单）→ 选择触发方式 →
  私聊/群 @Bot 发普通消息确认 Chat → 发 `/status` 确认命令与按钮 → 发 `/reset`、`/forget confirm` 确认自助命令 →
  发布 1/5 个媒体（含 partial 失败场景）→ 多轮对话后检查 `bot_ai_memories.summary` 与 `DATA_DIR/bot-memory`（不打印内容）→
  Discord 开启 intent 后确认 Gateway `connected` → 配置页“检查连接” → 诊断分区按 outcome 查看事件与中文错误提示 →
  角色与记忆分区启停/删除（只显示元数据）。图片能力在用户同意下临时开启验证后恢复关闭。
- 发布前请确认 Cloudflare Access 对 `/api/bot/webhook/*` 做 bypass，见 `docs/DEPLOY.md` §5.2。
