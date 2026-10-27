# Bot 集成

兼容性基于 OpenCode v2.1.4。

AntifieldCloud 的 Bot 模块把运维告警、只读状态查询、AI 问答（普通消息 Chat）、QQ 入站图片理解和手动/定时文本发布接到 **QQ 官方 Bot**。
平台仅 QQ：Telegram / Discord / Slack、Discord Gateway、只读按钮、媒体/多附件发布、群聊触发方式（`chatTrigger`）均不属于当前能力。
QQ 入站图片理解默认开启（`BOT_AI_VISION_ENABLED=true`），图片经 OpenCode 交给模型 provider 处理。
企业微信/钉钉/飞书与多管理员审批未实现。

> 当前生产：v0.7.3/schema v17（release `20261027T060134Z`/commit `aedc3c7`；文档模式已显式启用 `mcp:send:read:aad221f1`，真实 QQ 私聊/群聊首轮与私聊后续提示词验收通过），OpenCode v2.1.4；Bot 默认关闭（`BOT_ENABLED=false`），Webhook 关闭时返回 404。
> 安全边界：QQ AppSecret 只写不读，数据库只存 AES-256-GCM 密文；Webhook 只按平台 Ed25519 签名/时间戳鉴权；
> 除自助命令（`/help`、`/memory`、`/role` 仅私聊；`/reset`、`/forget confirm` 全用户）外，斜杠命令需要目标 + 用户双重白名单；Chat 只授予目标内普通消息 AI 对话，不授予命令权限；
> 发布必须 TOTP + `PUBLISH` 二次确认，且仅文本；通知/命令/Chat 输出不包含内部路径或 URL；私聊角色/记忆正文不通过 API/UI 暴露，群聊角色正文仅管理员在 Web 编辑；
> 诊断只存事件元数据、不存消息正文；入站图片只从 QQ 固定域名后缀下载、mime 白名单与大小上限处理且不落盘。
> v0.7.3 文档模式（`BOT_AI_CONTEXT_READ_ENABLED=true`）下，角色卡只在会话创建时进入 prompt；后续轮只给角色名/记忆条数/只读文档路径，
> 模型仅能 `read` 当前作用域 `role.md`/`memory.md`，不得读取其它文件；文档目录 0640/0750、不跟随符号链接、不进入备份。

## 1. 架构

```text
QQ 开放平台 ──签名 Webhook──▶ POST /api/bot/webhook/:botId
                               │ op=13 回调地址校验 / op=0 Ed25519 验签 + 时间戳 + IP/Bot 限流
                               ├─ 事件去重 → bot_events(received/ignored 诊断) + bot_inbound_targets（目标/用户，不存正文）
                               ├─ 斜杠命令（仅 C2C） → 自助命令(/help、/memory、/role 私聊、/reset、/forget confirm) 或 目标 allow_commands + 用户白名单；群聊/频道审计 command.disabled
                               │              → 只读 provider / OpenCode AI → 平台回复
                               ├─ 普通消息 → 目标 allow_chat（C2C 私聊直接进入；群/频道默认仅 @Bot 事件；全量模式按目标/工具调用过滤）
                               │              → 文本或入站图片 → OpenCode AI → 工具 send_message/清洗/格式化/分段 → 平台回复
                               └─ 入站错误 → 401/404/429（不执行业务）

入站图片管线（默认开启）：d.attachments → image/* 元数据(content_type/filename/size/url)
  → 固定域名后缀白名单(.qpic.cn/.qq.com/.qq.com.cn/.gtimg.cn，实际图床如 multimedia.nt.qq.com.cn) + image mime 白名单 + ≤BOT_AI_IMAGE_MAX_BYTES
  → 内存下载（不落盘）→ OpenCode prompt files(data URL) → 模型 provider；失败降级为文字回答

命令/Chat 回复管线：AI 文本 → sanitize（路径/URL/控制字符）→ QQ 纯文本格式化（去 Markdown 标记）
  → 按 QQ 单条 2000 字符分段（最多 4 段、续段前缀“（续 n/m）”、超限截断标记）

平台连接自检 ──▶ POST /api/bots/:id/check → 适配器换取 access_token（detail 不含 token）
诊断查询 ──▶ GET /api/bots/:id/events（bot_events 元数据，无正文）
角色/记忆管理 ──▶ GET/PATCH/DELETE roles；GET/PUT/PATCH/DELETE group-roles（群聊角色卡，管理员可编辑正文）；GET memories（用户级）、GET memories/:userId/items、DELETE 单条/整用户（仅元数据）

告警/管理 API ──▶ BotService ──▶ bot_deliveries / bot_publish_jobs
                                  │ 每 30s 队列 tick、静默延后、指数退避、死信；长文本 partial 不自动重试
                                  └─ QQ 适配器（仅文本）
```

服务端模块：

- `server/src/bot/crypto.ts`：`BOT_SECRET_KEY`（32 字节 base64）加密/解密 QQ AppSecret，按 `key_version` 保存；旧的 `token/webhookSecret/publicKey/signingSecret` 字段仅保留到删除迁移。
- `server/src/bot/adapters/qq.ts`：QQ 官方 Bot 适配器：op=13 回调校验、op=0 Ed25519 验签（±300 秒）、C2C/群@/频道事件解析、命令与 Chat、被动回复 `msg_id`、
  长文本分段发送、入站图片元数据与白名单下载（`loadImage`）、`access_token` 自检（含进程内缓存）。
- `server/src/bot/adapters/http.ts`：平台请求封装（超时/禁止重定向/响应上限/错误码化/图片下载白名单）。
- `server/src/bot/text.ts`：QQ 单条文本上限 2000、分段（最多 4 段、续段前缀、截断标记、代理对安全切分）。
- `server/src/bot/format.ts`：AI Markdown → QQ 纯文本（去代码块/标题/粗体/列表/链接标记，仅 http(s) 链接保留为文字）。
- `server/src/bot/errors.ts`：平台/队列错误 → 中文提示（管理页 `lastErrorHint`），不含凭据/URL/响应正文。
- `server/src/bot/ai.ts`：OpenCode 本地 API 客户端，提供 Chat 会话复用、工具白名单、超时/截断、图片 prompt files 与记忆抽取。回答上限 `BOT_AI_MAX_REPLY_CHARS`，QQ 层再分段。
- `server/src/bot/session.ts`：群聊共享 AI 会话的合成键 `__group__` 与判定函数；同一群聊目标唯一会话，私聊仍用真实用户键。
- `server/src/bot/group-roles.ts`：群聊目标共享角色卡存储；`server/src/http/routes/bot-ai-tool.ts`：消息发送 MCP 的内部回调路由（turn token HMAC、无 session/CSRF）。
- `server/src/bot/memory.ts`：结构化长期记忆：`bot_memory_items` 7 类条目 + `bot_memory_state` 启停/legacy 标记；抽取校验/敏感过滤/容量与 TTL/分层召回；key/value/legacy 均过滤敏感内容，读取侧也排除已落库的敏感条目；旧摘要仅作 legacy 来源与 fallback，抽取 ops=0 不置迁移标记。
- `server/src/bot/roles.ts`：每 Bot×用户私聊角色卡；提供元数据列表、启停、删除（正文只供 `/role show` 与 Chat 提示词）。内置默认角色 `lofii` 只保留名字与简短对话风格，不注入详细人设/背景；`/role show` 对用户自定义卡返回完整详情，默认角色卡只显示名称、不展示内置设定。
- `server/src/bot/group-roles.ts`：每 Bot×群聊目标一张共享角色卡；仅管理员可编辑正文，用于该群所有成员的 Chat 提示词，停用/删除后回退 `lofii`。
- `server/src/bot/prompts.ts`：任务/对话提示与固定安全边界；Chat 使用私聊个人卡或群聊共享卡，缺失时回退内置 lofii；启用发送工具时追加 `[消息发送工具]`（携带一次性 turn 凭据），全量群聊未启用工具时保留 `NO_REPLY` 兼容段。
- `server/src/bot/service.ts`：CRUD、Webhook、Chat/命令分发、群消息模式过滤、回复管线（sanitize→format→split）、图片降级、事件诊断、连接自检、角色/记忆管理、指标、静默时段、通知/发布队列、重试、清理、限流。
- `server/src/http/routes/bots.ts`：管理 API；`bot-webhook.ts`：公开回调入口。
- web `/bots`：概览、配置、目标、投递与发布、角色与记忆、诊断六个分区；配置页“检查连接”，目标页 `allowChat`/群消息模式，角色/记忆与诊断面板只展示元数据/脱敏错误（群聊角色卡正文仅管理员编辑 Modal 可见）。

## 2. QQ 平台接入

1. 在 QQ 开放平台（q.qq.com）创建机器人，取得 **AppID** 与 **AppSecret**；AppID 填公开配置（`config.appId`，5–32 位数字），AppSecret 只提交保存为密文。
2. “开发设置 → 回调地址”填 `https://app.example.com/api/bot/webhook/<botId>`；平台会发送 `op=13` 校验，服务端用 AppSecret 派生 Ed25519 私钥返回 `{plain_token, signature}`；`plain_token` 只接受字母数字/下划线/连字符 1–128、`event_ts` 只接受 1–12 位数字，否则 `400 invalid_payload`（防止签名预言机）；成功 challenge 写审计 `bot.webhook.challenge`。
3. 事件订阅按场景勾选 `C2C_MESSAGE_CREATE`（私聊）、`GROUP_AT_MESSAGE_CREATE`（群@）、`AT_MESSAGE_CREATE`（频道）；如需“接受全部消息”，再勾选 `GROUP_MESSAGE_CREATE`（需在 QQ 后台开启接收所有消息）；群主还需在 QQ 群设置 → 机器人 → 可获取的群聊消息范围选择“获取群内全部消息”，否则平台不会推送非 @ 消息。
4. 目标登记：C2C 填 `user_openid`、群聊填 `group_openid`、频道填 `channel_id`；命令用户另建 `kind=user` 且允许命令的目标。QQ 官方回调不提供真实 QQ 号/群号；可在目标行点“测试”发送测试消息，在 QQ 收到消息的会话即对应目标，再用“编辑名称”改为易识别的名称。每个群聊目标可在“角色与记忆”配置独立共享角色卡；“目标”页可设置仅 @/名字提及（默认）或全部消息（实验性）。
5. 命令（无需平台注册，仅 C2C 私聊可用）：`/help`（动态）、`/memory`（查看/`off|on`）、`/status`、`/backup`、`/world`、`/mc`、`/files <关键词>`、`/role`（仅私聊）、`/reset`、`/forget confirm`；群聊/频道不再接受任何斜杠命令。
6. 触发：C2C 私聊普通文本直接进入 Chat；群/频道默认仅 @Bot 事件；群目标设为“接受全部消息”且平台开启全量消息后，`GROUP_MESSAGE_CREATE` 事件按 externalId 查配置：仅@/名字模式未命中则静默忽略；全量模式交由模型判断，模型调用 `send_message` 才发言，未调用即静默（旧 `NO_REPLY` 仅作为未启用工具时的兼容回退）。
7. **入站图片（默认开启）**：QQ 事件 `d.attachments` 提供 `content_type`/`filename`/`size`/`url`；只取首个 `image/*` 附件，仅图片无文字也可进入 Chat。
   适配器只从固定域名后缀 `.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（QQ 实际图床如 `multimedia.nt.qq.com.cn`） 下载，校验 image mime 白名单（jpeg/png/webp/gif）与 `BOT_AI_IMAGE_MAX_BYTES`；
   图片在内存中转 base64，以 OpenCode prompt files data URL 随本轮 prompt 发送给模型 provider（本地 AI 服务），**不落盘、不写日志/审计正文**。
   `BOT_AI_VISION_ENABLED=false`、无图片权限、下载失败或 mime/大小不合规时降级为文字回答（有文字时附“图片未能处理”说明；无文字时提示改用文字）。
8. 文本输出：单条 ≤2000 字符；被动回复带入站 `msg_id`，主动通知/发布不带 `msg_id`；长回复按 2000 字符分段（最多 4 段、续段前缀、超限截断）；
   QQ 仅支持文本，**不支持媒体/附件/按钮/引用回复**。
9. QQ 真实回调需用户后台配置；未配置前只能做进程内契约测试。平台限制：群/频道默认需 @Bot；开启“接收所有消息”后才推 `GROUP_MESSAGE_CREATE`；仅文本、无按钮/媒体/编辑消息。

## 3. 权限模型

- **命令目标（仅 C2C 私聊）**：`bot_targets` 中 `kind='user'` 且 `allow_commands=1` 的私聊目标；群聊/频道目标不再接受任何斜杠命令（服务端审计 `bot.command.disabled` 并静默忽略）。
- **用户白名单**：私聊发送者必须登记为 `kind='user'` 且 `allow_commands=1` 的目标；群/频道里的成员即使目标开启命令也无法执行（且命令本身已在群聊禁用）。
- **自助命令（仅 C2C 私聊）**：`/help`（按身份动态帮助）、`/memory`（查看记忆计数/类型/启停/最近更新，不含 key/value；`/memory off|on` 暂停/恢复）、`/role`（仅私聊，管理个人角色卡；`/role show` 对自定义卡展示完整详情，默认卡不展示内置详情）、
`/reset`（重置当前目标全部对话，保留长期记忆）、`/forget confirm`（清除结构化条目/状态/legacy 旧摘要与该 Bot×用户的全部会话，含远端）。五条不需要目标 `allow_commands` 或 user 白名单；
- **群聊角色卡**：每个群聊目标一张共享卡（管理员在 Web 编辑）；群聊 Chat 使用该卡，不再使用成员私聊个人卡；群聊不接受 `/role`。`groupReplyMode=mention` 仅处理 @Bot/文本包含 Bot 名称的全量消息；`all` 为实验性，由模型是否调用 `send_message` 决定发送，未调用即静默。
- **AI 会话复用**：按 Bot×目标×用户复用 OpenCode 会话；若远端会话已被清理（404），自动删除 `bot_ai_sessions` 旧映射并重建一次，避免群聊未登记用户持续收到 `bot_ai_http_error`。
- **工具隔离与 fail-closed**：Chat 新建 OpenCode 会话使用 deny-all `permissions`（启用搜索/发送工具时仅 allow `searxng_*`/`botmsg_*`；文档模式再放行当前作用域 `external_directory` 与精确 `read role.md/memory.md`）；若 OpenCode 明确 400 拒绝该字段，
  进入 10 分钟重试窗口，并且**启用发送工具或文档模式时拒绝新 Chat**（固定提示、诊断事件、不调用 AI；`503 bot_ai_tool_isolation_unavailable`），不以默认权限继续；
  窗口到点放行一次重试，上游恢复后自动恢复隔离。启动/批次执行前双重检查，避免降级瞬间的排队批次继续运行。
- **文档模式会话**：`bot_ai_tool_mode` 在 read 开启时追加 `:read:<目录标签>`；目录/工具开关变化会清空会话映射并重建。记忆抽取会话始终 deny-all 且要求 permissions 生效，
  不放 `read`；私聊/群聊作用域独立，群会话不能读取私聊文档。

## 4. 队列、回复管线与失败处理

- 通知/命令回复/发布统一入队，`dedupe_key` 保证同一事件/目标只投递一次。
- 静默时段：目标设置 `quiet_start_minute`/`quiet_end_minute`（Asia/Shanghai 本地分钟 0–1439，成对设置、不能相同）后，窗口内新通知的 `next_attempt_at` 延后到窗口结束；跨午夜按 start > end 处理；通知不丢弃。
- 30 秒 tick，指数退避（30s 起，≤1h），达到 `BOT_DELIVERY_MAX_ATTEMPTS`（默认 5）进入 `failed/dead`。
- 长文本分段（QQ 2000/段，最多 4 段，续段前缀“（续 n/m）”，超出截断并标记“内容过长已截断”）；第 2 段起发送失败时把已发送消息 ID 挂到错误对象，
  队列/命令记录 `partial_text_sent` 且**不自动重试**，由管理员核对平台消息后处理。发布任务不参与分段：路由层拒绝 >2000 字符（`400 publish_text_too_long`）。
- **连续发送间隔（D-20）**：同一 Bot（按 AppID 标识）的外发文本按 1000ms 最小间隔串行，覆盖长文本分段、发送工具多条、兜底文本、命令/通知与队列；`access_token` 换取在间隔闸门外，不占用 1s。实现位于 `QqAdapter.sendMessage` 的 `withSendGate`；`BotService` 生产注入 1000ms，测试可注入 0 以保持快速。多个 Bot 之间互不阻塞。
- **原始工具调用文本防回显**：部分模型在工具解析失败时会把 DSML 工具调用协议作为普通 assistant 文本返回（`<｜…｜ calls>` / `parameter name="text"`）。Chat 兜底只提取 `parameter name="text"` 的可读正文发送；无法提取时使用固定提示，绝不回显协议标记、`turn_id`/`turn_token` 或工具名；发送工具消息与长期记忆同样经 `cleanAiReply` 清洗，并写审计 `bot.ai.tool_call_text`。实现见 `server/src/bot/dsml.ts`。
- 格式：AI 回答经 sanitize（路径/URL/控制字符/原始工具调用协议）→ `format.ts` 去 Markdown 标记保留可读正文 → 按 QQ 上限分段发送；仅 http(s) 链接保留为文字。
- 图片（默认开启）：`d.attachments` → image/* 元数据 → 固定域名后缀白名单 + mime 白名单 + 大小上限 → 内存下载 → OpenCode prompt files；
  关闭/失败/mime 非法时降级为纯文字回答；不落盘、不写日志/审计正文。
- 进程重启后，`sending` 超过 10 分钟的记录自动回队；`assembling` 等异常由各模块维护清理。
- 关闭排空：应用关闭时先有限等待在途 Chat/工具缓冲/投递（最多 15s，超时记录 warn），再停队列；减少部署/重启丢回复与重复投递。
- 事件保留 `BOT_EVENT_RETENTION_DAYS`（默认 7 天）；AI 会话映射按 `BOT_AI_SESSION_RETENTION_DAYS`（默认 7 天）清理；
  结构化记忆按条目 `expires_at` 清理（资料/偏好不过期；事实/项目/关系 365 天、事件 90 天、任务 30 天，更新续期）并受 `BOT_MEMORY_MAX_ITEMS` 容量约束；旧摘要仅 legacy/fallback，验收后 CLI 清理；
  已发送投递/发布 30 天后清理；`failed/dead` 保留供人工重投，不自动删除。
- 诊断事件：入站 Webhook 事件按 `(bot_id, platform_event_id)` 去重写入 `bot_events`，先记 `received`，处理完成后更新为
  `ok`/`denied`/`rate_limited`/`ignored`/`error`，`detail` 只放短码（如 `command_denied`/`chat_rate_limited`/`partial_reply`），不写消息正文。
- 指标：`GET /api/bots/:id/metrics?hours=24`（1–720 小时）返回投递/发布/事件统计、成功率、最近错误（含 `lastErrorHint` 中文提示）与最近发送；
  `/bots` 页面展示近 24 小时卡与诊断分区。

## 5. 配置

见 `deploy/env.example` 的 `BOT_*` 段与 `docs/DEPLOY.md` §2/§3.0（以下为最终保留项；`BOT_DISCORD_GATEWAY_ENABLED` 与 `BOT_PUBLISH_MAX_MEDIA_*` 不属于当前配置）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BOT_ENABLED` | `false` | 总开关；完成 QQ 平台联调后再显式开启 |
| `BOT_SECRET_KEY` | 由 `bootstrap-env.sh` 生成 | 32 字节 base64；必须与 DB 一起备份 |
| `BOT_WEBHOOK_MAX_BODY_BYTES` | `262144` | Webhook body 上限 |
| `BOT_DELIVERY_INTERVAL_SECONDS` | `30` | 队列轮询间隔 |
| `BOT_DELIVERY_MAX_ATTEMPTS` | `5` | 最大尝试次数 |
| `BOT_EVENT_RETENTION_DAYS` | `7` | 入站事件/入站目标保留 |
| `BOT_COMMAND_RATE_PER_MINUTE` | `120` | 每用户命令限流（1–600，当前范围） |
| `BOT_PUBLISH_MAX_SCHEDULED_DAYS` | `30` | 定时发布最远天数 |
| `BOT_MAX_BOTS` | `10` | Bot 数量上限 |
| `BOT_AI_ENABLED` | `false` | 普通消息 Chat 的 AI 总开关；默认关闭 |
| `BOT_AI_PROVIDER` | 空 | 可选 OpenCode provider；与 `BOT_AI_MODEL` 同时设置才指定模型 |
| `BOT_AI_MODEL` | 空 | 可选模型 ID；为空使用 OpenCode 默认模型 |
| `BOT_AI_TIMEOUT_SECONDS` | `60` | AI 超时（10–180 秒） |
| `BOT_AI_MAX_PROMPT_CHARS` | `2000` | 提示词截断（100–8000） |
| `BOT_AI_RATE_PER_HOUR` | `120` | 每 Bot×用户每小时 AI 调用上限（1–600，当前范围；仅 Chat） |
| `BOT_AI_SESSION_RETENTION_DAYS` | `7` | AI 会话映射保留天数（1–90；与会话记忆分离） |
| `BOT_CHAT_RATE_PER_MINUTE` | `30` | Chat 每 Bot×用户每分钟上限（1–120，当前范围） |
| `BOT_AI_MEMORY_MAX_CHARS` | `4096` | legacy 旧摘要/fallback 上限（512–16384；仅 legacy） |
| `BOT_AI_MEMORY_RETENTION_DAYS` | `365` | fact/project/relationship 条目 TTL 天数（30–3650，用于结构化条目） |
| `BOT_AI_MEMORY_BATCH_MESSAGES` | `3` | 累计多少轮对话触发一次记忆抽取（1–20） |
| `BOT_AI_MEMORY_IDLE_FLUSH_SECONDS` | `120` | 用户空闲多少秒触发记忆抽取（0 或 10–3600，0 关闭空闲触发） |
| `BOT_MEMORY_MAX_ITEMS` | `200` | 每 Bot×用户结构化记忆容量上限（20–1000；超限先淘汰低重要度非核心条目；） |
| `BOT_MEMORY_PROMPT_MAX_CHARS` | `3000` | 记忆召回注入上限字符数（500–8000；） |
| `BOT_MEMORY_PROMPT_MAX_ITEMS` | `12` | 记忆召回注入上限条数（1–50；） |
| `BOT_MEMORY_TTL_EPISODE_DAYS` | `90` | episode 条目 TTL（1–365；） |
| `BOT_MEMORY_TTL_TASK_DAYS` | `30` | task 条目 TTL（1–180；） |
| `BOT_AI_MAX_REPLY_CHARS` | `4000` | AI 单次回答字符上限（1000–12000）；QQ 层再按 2000 分段 |
| `BOT_AI_VISION_ENABLED` | `true` | QQ 入站图片理解总开关，默认开启；开启需 OpenCode prompt files + 支持 image 输入的模型 |
| `BOT_AI_IMAGE_MAX_BYTES` | `10485760` | 单张入站图片上限（1–20 MiB）；image mime 白名单、固定域名、不落盘 |
| `BOT_CONNECTIVITY_ENABLED` | `true` | 出站连通性探测开关 |
| `BOT_CONNECTIVITY_INTERVAL_SECONDS` | `60` | 探测间隔（15–600） |
| `BOT_CONNECTIVITY_TIMEOUT_SECONDS` | `8` | 单次探测超时（2–30） |
| `BOT_CHAT_BURST_WINDOW_MS` | `3000` | 同一 Bot×目标×用户连续消息合并窗口（0 关闭合并但仍串行；0–8000） |
| `BOT_CHAT_BURST_MAX_WAIT_MS` | `10000` | 从首条消息起最长等待，避免持续输入不回复（1000–20000） |
| `BOT_CHAT_BURST_MAX_MESSAGES` | `10` | 单批最多合并消息数（1–20） |
| `BOT_CHAT_BURST_GROUP_ALL_WINDOW_MS` | `8000` | 全量群聊非 @ 消息合并窗口（0–30000；） |
| `BOT_CHAT_BURST_GROUP_ALL_MAX_WAIT_MS` | `20000` | 全量群聊合并从首条起最长等待（1000–60000；） |
| `BOT_AI_SEND_TOOL_ENABLED` | `false` | 是否允许模型调用 `botmsg_send_message`；需先安装 botmsg MCP |
| `BOT_AI_CONTEXT_READ_ENABLED` | `false` | v0.7.3 文档模式：角色卡只在会话创建时发送、记忆文档按需 `read`；需先完成 OpenCode 读范围验证 |
| `BOT_CONTEXT_DIR` | `/var/lib/antifieldcloud-context` | 上下文文档目录；生产必须显式设置、OpenCode 组可读、不得位于 DATA_DIR 内；不进入备份 |
| `BOT_SEARCH_ENABLED` | `false` | SearXNG 联网搜索总开关；开启时必须配置 `BOT_SEARCH_URL` |
| `BOT_SEARCH_URL` | 空 | SearXNG 基址；生产建议 `http://127.0.0.1:8888`，仅 http/https、不得含凭据 |
| `BOT_SEARCH_AUTO` | `true` | 自动判断问句/时效内容并搜索；显式 `/search` 不受影响 |
| `BOT_SEARCH_MODE` | `mcp` | `mcp`=模型通过 SearXNG MCP 工具自行决定；`prefetch`=服务端关键词预取（兼容/回退） |
| `BOT_SEARCH_MAX_RESULTS` | `5` | 单次搜索最多结果数（1–10） |
| `BOT_SEARCH_TIMEOUT_SECONDS` | `8` | SearXNG 超时（1–30 秒） |
| `BOT_SEARCH_MAX_SNIPPET_CHARS` | `500` | 单条摘要截断（100–1500） |
| `BOT_SEARCH_LANGUAGE` | `zh-CN` | SearXNG 语言参数 |
| `BOT_SEARCH_SAFESEARCH` | `true` | SearXNG safe search |
| `BOT_SEARCH_ENGINES` | `bing` | 逗号分隔引擎名；生产网络只启用 Bing，避免被墙引擎超时 |
| `BOT_SEARCH_RATE_PER_HOUR` | `60` | 每 Bot×用户每小时搜索上限（1–600） |

`BOT_SECRET_KEY` 丢失或轮换会导致已存 QQ AppSecret 无法解密，必须重新录入。不要把它写入仓库/前端/日志。
`bootstrap-env.sh` 已纳管上述 `BOT_*` 键，包括 `BOT_AI_MEMORY_RETENTION_DAYS`/`BOT_AI_MEMORY_BATCH_MESSAGES`/`BOT_AI_MEMORY_IDLE_FLUSH_SECONDS`；
 `BOT_MEMORY_MAX_ITEMS`/`BOT_MEMORY_PROMPT_MAX_CHARS`/`BOT_MEMORY_PROMPT_MAX_ITEMS`/`BOT_MEMORY_TTL_EPISODE_DAYS`/`BOT_MEMORY_TTL_TASK_DAYS`）；
`BOT_CHAT_BURST_*` 与 `BOT_SEARCH_*`；`BOT_CHAT_BURST_GROUP_ALL_*` 与 `BOT_AI_SEND_TOOL_ENABLED`；v0.7.3 的 `BOT_AI_CONTEXT_READ_ENABLED`/`BOT_CONTEXT_DIR`。`BOT_AI_VISION_ENABLED` 默认 `true`。

## 5.1 Chat 提示词、会话与记忆抽取

- **内联模式（`BOT_AI_CONTEXT_READ_ENABLED=false`，默认回滚路径）**：提示词固定由四部分组成：**角色卡（私聊个人卡、群聊共享卡或默认 lofii）+ 固定只读安全边界 + 记忆 + 用户消息**；群聊共享卡覆盖群内成员私聊卡；启用发送工具时追加精简的 `[消息发送工具]`（本轮 `turn_id`/`turn_token`，私聊/@ 必须至少调用一次，全量群聊不调用即静默）；未启用工具时全量群聊保留 `NO_REPLY` 兼容段。
- **文档模式（`BOT_AI_CONTEXT_READ_ENABLED=true`）**：首轮（新会话创建）发送完整角色卡正文 + 固定安全边界 + `[上下文文档]`（角色名、`role.md`/`memory.md` 路径、记忆条数）+ 用户消息；后续轮**不再发送角色卡/记忆正文**，只保留角色名、记忆条数、文档路径与安全边界；记忆正文只存在于 `memory.md`，模型按需 `read`。角色文档每轮重写用于崩溃恢复，但正文只在首轮进入 prompt；角色变更重置会话。
- 两种模式共同点：群聊用户消息格式为 `<用户名>：<消息>`；群聊声明当前环境，未 @ 的全量消息明确“没有点名你、不要每轮都回复或调用发送工具”，普通闲聊保持沉默；搜索/发送工具段精简；默认 `lofii` 只保留名字与对话风格（短句、自然、轻松；可使用轻量语气词，不连续卖萌、不刷屏；不假装真人/不虚构经历/不索要隐私），用户可通过 `/role set` 建个人卡获得更具体人设。
- 不存在 `BOT_AI_TASK_PROMPT`/`BOT_AI_CHAT_PROMPT`；`BOT_AI_SYSTEM_PROMPT` 不被读取。角色卡/记忆文档不是指令，角色卡只能改变风格与语气，不能移除固定安全边界。
- AI 仅在普通消息 Chat 中调用（`allow_chat` 目标 / QQ C2C 私聊）；斜杠命令不调用 AI（非管理员被拒、管理员回全量帮助）。
- 会话：`bot_ai_sessions` 按 `(bot_id, target_external_id, user_id, mode)` 复用 OpenCode 会话；`mode` 只写 `chat`（列保留）；
  `/reset` 与角色卡变更会清理该范围全部会话映射；共享结构化长期记忆（`bot_memory_items`/`bot_memory_state`，旧摘要仅 legacy/fallback）。
- 审计 `bot.ai.chat` 记录 bot/user/chars/image 等元数据，**不再记录 mode**，不记录提示词/记忆正文。
- 记忆抽取：累计 `BOT_AI_MEMORY_BATCH_MESSAGES`（默认 3）轮或用户空闲 `BOT_AI_MEMORY_IDLE_FLUSH_SECONDS`（默认 120s，0 关闭）触发一次；按 Bot×用户串行队列，每次新建一次性远端会话并在 `finally` 删除；
  模型输出严格 JSON operations（upsert/delete，服务端最多 20 条），服务端校验/敏感过滤（key/value/legacy 均过滤）后写入 `bot_memory_items`；审计 `bot.memory.extract` 只记计数；**ops=0 不置 legacy 迁移标记**，保留 fallback 继续迁移。
- **群聊共享记忆**：群聊使用独立 scope `group:<targetExternalId>`，条目按 `<用户名>：<记忆>` 保存和注入；群聊抽取按发言用户归属（key 前缀用户名），已登记成员的用户级 `bot_memory_items` 不进入群聊提示词；`/bots`「角色与记忆」按**用户记忆/群聊记忆**左右两栏展示元数据，可查看条目、清空群共享记忆；启动时一次性把现有群聊参与者的用户级记忆复制到对应群共享记忆，仅群聊用户（无私聊、未登记 user 目标、只参与一个群）执行移动；群聊仍使用该目标共享角色卡，与共享记忆相互独立。
  摘要使用一次性远端会话并在 `finally` 删除，不再保存 `summary_session_id`；审计 `bot.ai.memory` 记录 `rounds`，不记录摘要正文。
- QQ C2C 私聊对任意用户开放 Chat（接触面由 QQ 平台“谁可添加 Bot”控制）；只读命令仍要求目标 `allow_commands` 与用户白名单。

## 5.2 图片理解（默认开启）

- 开关：`BOT_AI_VISION_ENABLED=true`；开启需 OpenCode 支持 prompt files 与模型支持 image 输入
  （生产只读验证：OpenCode prompt files 接受 `data:` URL，`opencode-go/deepseek-v4.1-flash` 支持 image）。
- 入站：QQ 事件 `d.attachments` 中首个 `content_type` 以 `image/` 开头的附件（`filename`/`size`/`url`）；仅图片无文字也可进入 Chat。
- 下载：只允许域名后缀 `.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（QQ 实际图床如 `multimedia.nt.qq.com.cn`）（完整 DNS 标签边界）；image mime 白名单 jpeg/png/webp/gif；≤`BOT_AI_IMAGE_MAX_BYTES`；
  平台声明大小超限提前拒绝；图片不写磁盘，只在内存转 base64。
- 外发模型：图片内容会以 data URL 经本机 OpenCode API 交给配置的模型 provider，说明见 `docs/SECURITY.md`；不落盘、不写日志/审计正文。
- 降级：vision 关闭/无图片权限/下载失败/mime 非法时，有文字则继续文字回答并附“（图片未能处理，已按文字回答）”；无文字则提示“当前暂不支持处理这张图片，可以用文字描述”。
- 审计 `bot.ai.image` 只记录 mime/大小/跳过原因，不记录内容；QQ 平台对普通消息只推送 @ 事件，图片消息同样受此限制。

## 5.3 平台连接自检

- `POST /api/bots/:id/check`（登录 + CSRF，30 次/分钟）：Bot 必须启用、凭据可解密；调用 QQ 适配器换取 `access_token`，成功即视为可用。
- 返回 `{health:{ok,items:[{name,ok,detail}],checkedAt}}`；`detail` 只含脱敏信息/短错误码（如 `qq_access_token_failed`），不包含 AppSecret/access_token/内部 URL。
- 无论成功失败都刷新 `last_checked_at` 并写审计 `bot.check`；不覆盖投递 `last_error`；`/bots` 配置页“检查连接”展示通过/异常项。

## 5.4 诊断与管理

- 事件诊断：见 §4；`outcome` 缺省返回全部，非法值 400；`hours` 1–720（默认 24）、`limit` 1–200（默认 50）、`offset` ≥0。
- 错误提示：`server/src/bot/errors.ts` 把队列 `last_error`/事件短码映射为中文提示；未知错误返回 null。`BotDelivery`/`BotPublishJob`/`BotMetrics` 增加 `lastErrorHint`。
- 角色管理：`GET /api/bots/:id/roles?limit&offset` 返回私聊角色卡元数据（userId/userName/name/enabled/promptLength/时间）；`PATCH` body `{enabled}` 启停；`DELETE` 删除并清理该用户 chat 会话。
  群聊角色卡：`GET /api/bots/:id/group-roles` 列出全部群聊目标；`GET/PUT/PATCH/DELETE /api/bots/:id/group-roles/:targetId` 读取/编辑正文、启停、删除；名字 1–32、正文 1–1000，仅管理员可读写。
- 记忆管理：`GET /api/bots/:id/memories?limit&offset` 返回用户级元数据（userId/userName/itemCount/kinds/memoryEnabled/updatedAt）；`GET /api/bots/:id/memories/:userId/items?limit&offset` 返回条目元数据（id/kind/importance/confidence/updatedAt/expiresAt）；
  `DELETE /api/bots/:id/memories/:userId/items/:itemId` 删除单条；`DELETE /api/bots/:id/memories/:userId` 删除整用户；均只操作元数据，**绝不返回 key/value**；审计 `bot.memory.delete_item`/`bot.memory.delete_user`。
- 审计：`bot.check`、`bot.reset`、`bot.memory.forget`、`bot.role.admin`、`bot.memory.admin` 只记录动作、数量/长度与截断 ID，不含正文。

## 5.5 结构化长期记忆

- **条目模型**：7 类 `profile`（资料）/`preference`（偏好）/`fact`（事实）/`project`（项目）/`task`（任务）/`relationship`（关系）/`episode`（事件）；字段 key/value/confidence/importance/source/created_at/updated_at/last_used_at/expires_at；
  唯一键 `(bot_id,user_id,kind,mem_key)`；`bot_memory_state` 保存每用户 `memory_enabled` 与 `legacy_migrated_at`；旧 `bot_ai_memories` 仅作 legacy 迁移来源/未迁移 fallback（验收后 CLI 清理）。
- **抽取**：批量触发 = 累计 `BOT_AI_MEMORY_BATCH_MESSAGES`（默认 3）或空闲 `BOT_AI_MEMORY_IDLE_FLUSH_SECONDS`（默认 120s）；同用户串行；一次性 OpenCode 会话（用后删除）；模型只输出严格 JSON `operations`，服务端校验 kind/key/value 长度、敏感过滤（自然语言密码/令牌/密钥前缀/URL/IP/内部路径/UNC/提示结构标记，key 与 value 均过滤）、最多 20 条 ops；
  upsert 按唯一键合并并续期，delete 删除；容量超 `BOT_MEMORY_MAX_ITEMS`（默认 200）时先淘汰低重要度非核心条目（profile/preference 受保护）；故障只记日志不影响本轮回复。
- **TTL**：`profile`/`preference` 不过期；`fact`/`project`/`relationship` 365 天（`BOT_AI_MEMORY_RETENTION_DAYS`）；`episode` 90 天（`BOT_MEMORY_TTL_EPISODE_DAYS`）；`task` 30 天（`BOT_MEMORY_TTL_TASK_DAYS`）；更新操作续期。
- **召回**：核心 `profile`/`preference`/`task` 优先，其余按关键词命中 + 重要度/时效挑选；预算 `BOT_MEMORY_PROMPT_MAX_CHARS`（默认 3000 字）/`BOT_MEMORY_PROMPT_MAX_ITEMS`（默认 12 条）；命中条目更新 `last_used_at`；
  `/memory off` 时返回空上下文（不注入、不抽取）；未迁移旧摘要作为 fallback 注入并受同一预算约束。
- **自助命令**：`/memory` 显示总条数/各类型计数/启停/最近更新时间（不含 key/value）；`/memory off|on` 暂停/恢复；`/forget confirm` 清空该用户 items/state/legacy 摘要并清空会话（含远端）；审计 `bot.memory.toggle`/`bot.memory.extract`/`bot.memory.forget`。
- **Legacy 清理**：验收后运行 `node scripts/cleanup-legacy-memory.mjs`（默认 dry-run）核对数量，再 `--confirm` 删除已迁移用户的 `bot_ai_memories` 行 + 镜像文件（写审计 `bot.memory.legacy_cleanup`，不输出正文）。

## 5.6 连续消息处理

- 同一 `Bot×目标×用户` 的普通消息进入内存 burst 缓冲：默认在最后一条后 `BOT_CHAT_BURST_WINDOW_MS=3000` 合并，且从首条起最多等待 `BOT_CHAT_BURST_MAX_WAIT_MS=10000`，单批最多 `BOT_CHAT_BURST_MAX_MESSAGES=10` 条；达到条数立即触发。
- 合并后只调用一次 AI、只回复一次；不同会话可并行，同一会话严格串行（处理期间到达的消息进入下一批）。Webhook 仍立即 ack，不因等待合并而超时。
- 合并文本按换行拼接并按 `BOT_AI_MAX_PROMPT_CHARS` 截断；图片批次只处理最后一张，文字仍保留；仅图片无正文时使用中性占位。
- `/reset`、`/forget confirm` 和角色卡变更会清理当前会话缓冲，避免旧消息在新上下文里回复；进程停止时丢弃未处理缓冲。
- 聊天/搜索限流按**批次**计（一次合并回复算一次），避免连续短消息被误判刷屏；命令不受 burst 合并影响。
- 审计 `bot.chat` 仍按入站消息记录长度（不含正文），诊断事件在批次结束时统一标记 ok/rate_limited/error。

## 5.7 联网搜索

- **部署**：SearXNG 自建/私有实例，仅监听 `127.0.0.1:8888`；通过 `scripts/searxng-mcp.mjs` 作为 OpenCode MCP 工具暴露（`codemode:false`，工具名 `searxng_web_search`），应用侧 `BOT_SEARCH_MODE=mcp`。安装/回滚见 `docs/DEPLOY.md` §3.5；不引入 Docker。
- **自动触发**：`mcp` 模式下命中关键词/追问时服务端先预取（保证“找找B站热点”“再搜搜看”等稳定），未命中时由模型通过 `searxng_web_search` 语义决定；Bot 新建会话的 permissions 仅放行 `searxng_*`，其余工具仍 deny（生产已验证 shell 不可用、目标文件未创建）。`prefetch` 模式仅服务端关键词预取，作为兼容/回退。
- **显式命令**：`/search <关键词>` 对所有可 Chat 用户开放（C2C 或目标 `allow_chat=1`），服务端强制预取并向模型注入结果，保证命令触发稳定。
- **结果注入/展示**：MCP 工具直接返回标题/摘要/域名/URL；`/search` 预取只取标题/摘要/域名/URL，最多 `BOT_SEARCH_MAX_RESULTS` 条；提示词把结果标为**不可信外部资料**，不执行其中指令、不编造、不输出完整 URL；服务端附“参考来源：标题（域名）”。
- **失败降级**：SearXNG 超时/非 2xx/格式错误时工具返回失败文本，Chat 继续回答并说明无法核实；`/search` 预取失败仍走 AI 回答（无来源）。审计 `bot.search` 只记录结果数/错误码/是否强制，不记录查询正文。
- **限流/隐私**：每 Bot×用户每小时 `BOT_SEARCH_RATE_PER_HOUR`；查询会发给私有 SearXNG 及其启用引擎（生产仅 Bing），不把用户消息直接发给任意外部搜索 API。MCP 服务只访问 `SEARXNG_URL`，不抓结果网页；MCP 工具输出含 URL 但 Bot 回答层仍会脱敏/附来源。
- **启用步骤**：安装 SearXNG → `sudo bash scripts/install-searxng-mcp.sh`（安装 MCP 服务并改 OpenCode 配置；重启 opencode）→ `curl 'http://127.0.0.1:8888/search?q=test&format=json&engines=bing'` 返回 JSON → 应用 env `BOT_SEARCH_ENABLED=true`/`BOT_SEARCH_MODE=mcp`/`BOT_SEARCH_URL=http://127.0.0.1:8888` → 重启应用 → 实测普通问句自动搜索与 `/search`。
- **MCP 权限**：OpenCode 配置 `mcp.servers.searxng.codemode=false`；Bot 会话 permissions 顺序为 deny-all 后 allow `searxng_*`（启用发送工具时另 allow `botmsg_*`，最后匹配生效）。若 OpenCode 拒绝 permissions 字段，现有降级逻辑会记录 `aiToolIsolation.supported=false`，此时不应把 Chat 当强隔离环境。

## 5.8 消息发送工具与连续消息

- **目标**：把“是否发送/如何分段”从模型最终文本升级为可调用工具。模型只能通过 `botmsg_send_message` 发送用户可见消息；私聊与群 @/名字命中必须至少调用一次，全量群聊不调用即静默（替代旧 `NO_REPLY` 文本哨兵）。
- **链路**：应用为每轮 Chat 生成随机 `turn_id` 与 `BOT_SECRET_KEY` HMAC 的 `turn_token`，写入提示词；OpenCode 通过 `botmsg` MCP（`codemode=false`）调用工具；MCP 转发到本机 `POST /api/bot/ai/tool/send`；应用校验 token/过期/单轮上限后写入内存缓冲，回合结束统一发送。
- **连续消息**：模型可多次调用工具发送 1–5 条独立消息；单条 ≤1800 字，服务端仍做路径/URL 清洗、QQ 2000 字符分段；最终 assistant 文本不会自动发送。工具调用失败/超限返回错误文本给模型，不把内部错误暴露给用户。
- **兜底**：私聊/@ 提及在工具未启用、MCP 未安装或模型漏调用时，服务端发送最终文本（审计 `bot.ai.send_fallback`），避免用户无响应；全量群聊不调用工具时不发送。无论成功/失败，回合结束清理 turn 上下文。
- **会话命名**：新建 OpenCode Chat 会话标题为「目标名称 Chat」，记忆抽取一次性会话为「目标名称 Memory」；已有会话不主动重命名，清理逻辑按 Bot×目标×用户映射执行。
- **部署**：`sudo bash scripts/install-bot-tool-mcp.sh` 将 `scripts/bot-tool-mcp.mjs` 安装为 `/opt/botmsg-mcp/bot-tool-mcp.mjs` 并写入 OpenCode `mcp.servers.botmsg`（重启 opencode）；随后 app env `BOT_AI_SEND_TOOL_ENABLED=true` 并重启应用。OpenCode 会话 permissions 顺序为 deny-all 后 allow `botmsg_*`（搜索启用时另 allow `searxng_*`）。
- **全量群聊合并**：非 @ 全量消息使用 `BOT_CHAT_BURST_GROUP_ALL_WINDOW_MS`（默认 8000ms）/`BOT_CHAT_BURST_GROUP_ALL_MAX_WAIT_MS`（默认 20000ms），减少逐条调用模型；@/名字命中仍用默认 3000/10000ms，保证及时回复。
- **代码边界**：`server/src/bot/inbound.ts`（入站验签/限流/去重/命令与 Chat 分发）、`chat.ts`（Chat 回合、工具缓冲、记忆触发与串行锁）、
  `diagnostics.ts`（bot_events/入站目标/指标/最近错误）、`queue.ts`（投递/发布状态机）；`service.ts` 保留 `BotService` facade 与依赖装配。
  重构不改变 schema/提示词/外部行为；每步以 bot 测试全绿为门禁。

## 5.9 审计与行为边界

- **AI 工具隔离 fail-closed（D-12/SEC-11）**：OpenCode 明确 400 拒绝 `permissions` 时不再进程级永久降级，而是进入 10 分钟重试窗口；
  启用 `BOT_AI_SEND_TOOL_ENABLED` 且隔离不可用时**拒绝新 Chat**：inbound/chat 侧返回固定提示“安全隔离不可用，暂时停止 AI 对话。”并写 `bot_events`（群/@ 为 denied，全量群为 ignored），
  OpenCode 层抛 `503 bot_ai_tool_isolation_unavailable`；窗口到点放行一次重试，上游恢复后 `aiToolIsolation.supported=true` 自动恢复。未启用发送工具时纯文本 Chat 行为不变。
  状态 `BotStatus.aiToolIsolation{ supported, fallbackCount, fallbackAt, retryAt }` 可查；降级审计 `bot.ai.permissions_fallback` 仍只记计数。
- **群共享记忆归属（D-13/BOT-03/BOT-10）**：群 scope 条目 key 前缀由显示名改为稳定 `member_openid`，显示名只存 value；同名/改名成员不再互相覆盖或删除。
  启动一次性迁移 `meta.bot_group_memory_owner_migrated_v1`：按 `bot_inbound_targets` 的「群目标 + 显示名 + 用户」唯一映射旧键；无法唯一映射的条目加 `legacy:` 前缀保留（不参与按成员删除）；
  目标键冲突时跳过不覆盖。`/forget confirm` 在清用户级记忆/会话之外，同时删除本人在各群 scope 贡献的条目并取消在途抽取（审计 `bot.memory.forget` 增加 `groupItems/groupScopes`）。
- **孤儿会话清理保守化（BOT-01）**：启动清理只删除标题精确等于旧默认值（`AntifieldCloud Chat`/`AntifieldCloud Memory`）且不在当前映射中的远端会话；
  新命名「目标名称 Chat/Memory」与前缀相似会话不误删；2.1.4 的 archived 语义在升级矩阵 V6 中记录后再评估主动清理。
- **混批 @ 语义（BOT-02）**：全量群聊批次中只要任一消息被 @/名字命中，整批按“被点名”处理（必回复），不再由最后一条非 @ 全量消息决定静默。
- **回合异常工具消息（BOT-04）**：模型已通过 `botmsg_send_message` 写入缓冲后若回合异常，先补发缓冲消息并审计 `bot.ai.send`（`partialTurn`），
  而不是直接回错误兜底；补发失败才回“暂时没回应上来”，保证“模型认为已发送/用户看不到”的情况最小化。
- **同会话串行（BOT-05）**：`/search` 与普通 Chat 共用 per-session 串行锁；burst 批次、`/search`、直调路径不会并发调用同一会话 AI，不同会话仍并行。
- **群记忆清空竞态（BOT-06）**：管理端清空群共享记忆会取消该 scope 所有成员在途/待处理抽取（gen 递增），清空后不会被在途批次写回。
- **死字段（BOT-07）**：`BotStatus.lastError`/`BotSummary.lastError` 改为从 `bot_deliveries`/`bot_publish_jobs` 失败派生；`bots.last_error` 列保留但不再作为唯一来源。
- **Webhook 限流与审计（BOT-08）**：未验签请求每 Bot 120/min、已验签事件每 Bot 300/min 分桶（验签后才扣业务桶）；拒绝/限流审计按「每 Bot×动作×分钟」聚合（首条 + 每 50 条），
  未认证流量不能饿死合法事件或写满审计表；IP 取统一 `requestMeta`（仅 loopback 对端采信 Cloudflare 头）。
- **burst.clear 竞态（BOT-13）**：`clear` 标记 cancelled 并清空 items，运行中批次的 finally 不再为旧消息排队；`/reset`/`/forget`/角色变更后的旧缓冲不会再回复。
- **名称匹配（BOT-15）**：Bot 名称提及按词边界匹配，降低短名/子串过度触发；未 @ 的群消息仍可由模型选择沉默。
- **关闭排空（ARCH-04）**：应用关闭时有限等待在途回复/工具缓冲/投递（最多 15s，超时 warn），减少部署/重启丢回复与重复投递。

## 5.10 群聊共享会话

- **唯一会话**：`target.kind = group` 的群聊目标统一使用合成会话键 `__group__`，每个群只保留一条 `bot_ai_sessions` Chat 映射；同一群的不同成员不再各建会话。私聊（C2C）仍按真实用户独立会话。
- **多用户上下文**：群内用户消息继续带 `<用户名>：` head；同一群的 Chat 批次/命令按群目标串行，模型可在同一 OpenCode 会话中看到群内不同成员的历史消息。
- **真实用户边界**：限流（`botId:userId`）、结构化记忆 scope/归属、审计 actor 与发送工具 `turn_id`/`turn_token` 仍归属真实成员，不因共享会话合并。
- **启动清理**：`BotService.start()` 在群记忆迁移后清理所有群目标的分用户 Chat 映射，并异步尽力删除远端旧会话；首条群消息创建唯一共享会话。旧摘要迁移的参与者查询排除 `__group__`。
- **范围**：本版仅 QQ 群目标（`kind=group`）；QQ 频道（channel）行为未变，仍按原有会话归属。
- **测试**：`bot-v071.test.ts` 覆盖同群共享键/真实用户记账、私聊不共享、启动清理；`bot-ai.test.ts` 覆盖真实 `OpenCodeBotAi` 同群单会话与旧映射删除。Bot 定向 **195 pass**、全量 **497**。

## 6. 网络出站（QQ / OpenCode，Pi 直连）

- Bot 出站不依赖 PC 代理隧道/环境代理：应用使用 Node 全局 `fetch` 直接访问 `bots.qq.com`/`api.sgroup.qq.com`（Webhook 入站不依赖出站）；
  生产 env 不再设置 `HTTPS_PROXY`/`HTTP_PROXY`/`NODE_USE_ENV_PROXY`/`BOT_PROXY_URL`/`NO_PROXY`，仓库也不再包含隧道脚本/PC 计划任务。
- Chat 只访问 `OPENCODE_URL`（默认 `http://127.0.0.1:4096`），图片经同一本地 OpenCode 接口交给模型 provider；均不使用外部代理。
- 验证（Pi 直连）：

```bash
curl -sS -m 10 -o /dev/null -w '%{http_code}\n' https://bots.qq.com/app/getAppAccessToken   # 4xx/2xx 均说明网络可达
sudo journalctl -u antifieldcloud -n 50 --no-pager | grep -i bot
```

- 不要恢复旧代理变量或安装旧隧道任务；本机部署信息放在 gitignored 的 `.local/DEPLOYMENT.md`。

### 6.1 连通性探测

- `BOT_CONNECTIVITY_ENABLED=true` 时，服务端每 `BOT_CONNECTIVITY_INTERVAL_SECONDS`（默认 60）探测：
  1. 外网（中立站点只读 GET）；
  2. QQ 平台只读 API URL（4xx 也算网络可达）。
- `GET /api/bots/connectivity` 返回 `{checkedAt, checking, internet, platforms}`；`POST /api/bots/connectivity/check` 手动复检（30 次/分钟）；
  `/bots` 概览卡片展示外网与 QQ 平台状态/延迟。
- 外网从不可达恢复时触发投递/发布队列扫描；探测不携带 Bot 凭据、不记录响应正文。
- 常见问题：无需安装任何 Windows 计划任务/隧道；若外网不可达请检查 Pi 路由/DNS/出站防火墙，而不是恢复旧代理变量。
### 6.2 QQ 群/频道无响应排查

按顺序确认，避免把平台配置问题误判为代码问题：

1. QQ 开放平台已订阅群事件 `GROUP_AT_MESSAGE_CREATE`（频道为 `AT_MESSAGE_CREATE`；全量消息另订阅 `GROUP_MESSAGE_CREATE` 并开启接收所有消息），回调地址为 `https://app.<域名>/api/bot/webhook/<botId>`，且回调校验 `op=13` 已通过。
2. Bot 已被拉入该群/频道；QQ 群/频道默认必须 **@Bot** 才会推送事件；可在目标中设为“接受全部消息”，并在 QQ 后台开启接收所有消息（推送 `GROUP_MESSAGE_CREATE`）。
3. 发送后查看服务端：`bot_events` 是否有新事件（`GET /api/bots/:id/events` 可查元数据）；若事件到达但正文为空/未知，会记录 `audit_log.action='bot.event.ignored'`（只含事件类型，不含正文）。
   若 `bot_inbound_targets` 出现 `target_kind='group'`，到 `/bots` 目标分区从“最近入站目标”登记该 group_openid，再开启 `allow_chat`；群聊/频道不执行斜杠命令，命令用户请在 C2C 私聊登记 `kind='user'` 且允许命令的目标。
4. 若没有新事件，优先检查开放平台事件订阅、Bot 入群状态与 @ 方式；入站 Webhook 不依赖出站代理。
5. 有事件但无回复：查看 `/bots` 出站网络卡片（外网/QQ 平台状态与延迟）和投递 `lastError`/`lastErrorHint`；QQ 回复需 Pi 直连 `bots.qq.com`/`api.sgroup.qq.com`。
6. 图片无响应/提示不支持：确认 `BOT_AI_VISION_ENABLED=true`、`BOT_AI_ENABLED=true`、模型支持 image；附件 URL 域名在 `.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（QQ 实际图床如 `multimedia.nt.qq.com.cn`） 白名单内、mime 与大小合规；看审计 `bot.ai.image`（只含 mime/大小/跳过原因）。

## 7. 结构化记忆存储与运维

- **数据表**：`bot_memory_items`（`(bot_id,user_id,kind,mem_key)` 唯一，value ≤500 字、key ≤64 字、confidence 0–1、importance 1–5、source ∈ chat/legacy、时间戳/`expires_at`）为权威；`bot_memory_state` 保存启停与 legacy 迁移标记；旧 `bot_ai_memories` 仅 legacy/fallback。
- **群共享记忆**：群 scope 为 `group:<targetExternalId>`；条目 key 前缀为稳定 `<member_openid>:`，显示名只存 value（`<用户名>：<记忆>`），
  同名/改名成员不能互相覆盖/删除；启动一次性迁移旧显示名 key（无法唯一映射加 `legacy:` 保留）；`/forget confirm` 清本人在各群条目并取消在途抽取；
  管理端清空群记忆会取消在途抽取；管理员 `DELETE /api/bots/:id/group-memories/:scope` 清空该群共享记忆（审计 `bot.memory.delete_user`）。
- **当前 schema v17**：`bot_memory_items`/`bot_memory_state` 为结构化记忆表；`scripts/deploy.ps1` 切换前自动做迁移前 DB 快照；回滚必须恢复迁移前快照。
- **写入**：抽取批处理按 Bot×用户串行；一次性 OpenCode 会话（`finally` 删除）；服务端严格校验 ops、敏感过滤（密钥/URL/内部路径/UNC/提示结构标记，key/value/legacy 均过滤）、容量清理（默认 200，先淘汰低重要度非核心条目）；更新续期；ops=0 不置 legacy 迁移标记。
- **读取/召回**：核心层优先 + 关键词相关层，预算 3000 字/12 条；命中更新 `last_used_at`；`/memory off` 无注入；未迁移旧摘要 fallback 注入（受 `BOT_AI_MEMORY_MAX_CHARS` legacy 上限约束）。文档模式把同一召回文本写入 `memory.md`（每轮 AI 调用前刷新），prompt 只保留条数；模型按需 `read`。
- **TTL**：profile/preference 不过期；fact/project/relationship 365 天（`BOT_AI_MEMORY_RETENTION_DAYS`）；episode 90 天（`BOT_MEMORY_TTL_EPISODE_DAYS`）；task 30 天（`BOT_MEMORY_TTL_TASK_DAYS`）；过期条目清理并从召回/列表排除。
- **删除**：用户 `/forget confirm` 清空该 Bot×用户 items/state/legacy 摘要与全部会话，并尽力删除远端会话；管理员 `DELETE .../memories/:userId` 只删条目/状态/legacy，不删会话；`DELETE .../items/:itemId` 删单条并审计；两种管理删除均不返回 key/value。
- **审计**：`bot.memory.extract`（仅计数：upserts/deletes/skipped/pruned/migrated）、`bot.memory.toggle`、`bot.memory.forget`、`bot.memory.delete_item`、`bot.memory.delete_user`、`bot.memory.legacy_cleanup`；不记录正文。
- **Legacy 清理 CLI**：`node scripts/cleanup-legacy-memory.mjs` 默认 dry-run；`--confirm` 删除已迁移用户的 `bot_ai_memories` 行 + `DATA_DIR/bot-memory` 镜像并写审计；验收通过后执行一次，不输出正文。
- **备份**：DB 快照包含结构化条目/状态与角色卡正文；legacy 镜像目录不是恢复必需项。v0.7.3 上下文文档目录为派生数据，不进入备份；
  恢复后首轮自动重建；`/forget confirm` 删除用户作用域与全部群作用域文档，Bot/目标删除与维护任务（无活动会话且超 24h）也会清理。


## 8. 测试与验收边界

- 适配器/验签/队列/命令白名单/发布 TOTP+`PUBLISH`/AI/Chat/记忆/文本分段/图片下载/连接自检/诊断/角色与记忆管理均有进程内测试（不访问真实平台/模型）。
- QQ 适配器以 mock/fixture 覆盖（op=13/op=0、C2C/群@/频道、attachments 图片、access_token 自检、长文本分段）；AI 使用假 OpenCode HTTP 服务。
- 当前本地门禁（2026-10-27）：全量 `npm test` **520**（1 skip）、`test:web` **222**；覆盖群聊共享会话键/串行、真实 `OpenCodeBotAi` 同群单会话、私聊独立会话、Bot 记忆镜像孤儿清理、BotService 拆分、AI 429 负路径、工具隔离 fail-closed 与重试窗口、群记忆 `member_openid` 与一次性迁移、`/forget` 群条目、混批/@、回合异常补发、`/search` 串行、lastError 派生、Webhook 限流分桶与审计聚合、**上下文文档 scope/原子写/sweep、首轮/后续提示词差异、read 权限精确规则、permissions 拒绝 fail-closed、群/私聊作用域隔离、角色/目标/Bot/forget 清理**；**连续外发 1000ms 间隔**由 `bot-send-interval.test.ts` 覆盖。
- 真实平台前置条件：QQ 开放平台已创建机器人并配置回调地址，`op=13` 校验通过；已订阅 C2C/群@/频道事件；Bot 已加入目标群/频道；图片需 `BOT_AI_VISION_ENABLED=true`、`BOT_AI_ENABLED=true`、模型支持 image 输入。
- 真实 QQ 正向验收已通过；真实平台限流/签名漂移/故障负路径仍需部署后联调，不把 mock 全绿等同于线上通过。
- 手工验收：创建/启用 QQ Bot → 添加目标并勾选 `allow_chat` → C2C/群 @Bot 多轮 Chat 触发抽取（≥3 条或空闲 120s）→ 检查 `bot_memory_items` 条目与 `bot.memory.extract` 计数 → `/memory` 查看计数/类型/启停（无正文）→ `/memory off` 后 Chat 无注入、`on` 恢复 → `/forget confirm` 清空 items/state/legacy/会话并核对远端会话 → 管理页记忆列表/条目元数据/删除 → 图片识别回归 → 验收通过后 `cleanup-legacy-memory.mjs` dry-run/`--confirm`。
- 发布前请确认 Cloudflare Access 对 `/api/bot/webhook/*` 做 bypass，见 `docs/DEPLOY.md` §5.2。
