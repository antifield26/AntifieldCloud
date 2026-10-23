# Bot 集成（v0.5.8，QQ 官方 Bot 单平台）

AntifieldCloud 的 Bot 模块把运维告警、只读状态查询、AI 问答（命令与普通消息 Chat）、QQ 入站图片理解和手动/定时文本发布接到 **QQ 官方 Bot**。
v0.5.8 起平台收敛为 **QQ 单平台**：Telegram / Discord / Slack 适配器、Discord Gateway、只读按钮、多附件/媒体发布、群聊触发方式（`chatTrigger`）
以及 Telegram HTML/引用/线程等能力全部移除；schema v13 会删除非 QQ Bot 配置及其级联数据（目标/队列/事件/会话/记忆/角色卡）。
QQ 入站图片理解默认开启（`BOT_AI_VISION_ENABLED=true`），图片经 OpenCode 交给模型 provider 处理。
企业微信/钉钉/飞书与多管理员审批仍未实现。

> v0.5.8 已部署（2026-10-22，release `20261022T134852Z`/commit `96294e4`，schema v13；`/healthz` version 0.5.8/schemaVersion 13，部署内只读 smoke 16/16、带 Access token 完整 smoke 24/24）。
> 迁移 13 后 `bots` 仅剩 1 行 QQ Bot，原 Discord Bot 及级联数据已删除（迁移前快照 `db-predeploy-20261022T134921798Z.sqlite` 可回滚）；QQ 数据保留，图片理解默认开启。真实 QQ 消息已由用户实发验收通过（2026-10-22 21:59–22:08 CST，图片端到端成功；用户 22:10 CST 确认“验收通过”）。
> **v0.5.9 已部署**（2026-10-22 22:35 CST，release `20261022T143451Z`/commit `97996dc`，schema v13、无迁移；`/healthz` version 0.5.9/schemaVersion 13，smoke 16/16 与 24/24）。
> 移除 `/ask`（AI 全部由普通消息 Chat 承担）、限速放宽为 Chat 30/min、AI 120/hour、命令 120/min、`/help` 对非管理员开放且按身份动态显示；生产 env 迁移已完成（命令 120/AI 120/Chat 30、提示词变量已删除）。
> 用户已实发验收通过（2026-10-22 22:39–22:41 CST：非管理员 `/help` 有生产事件证据，其余为用户确认）；回滚切回 `20261022T134852Z` + 还原 env 备份（20/10/6）。
>
> **v0.5.10 已部署**（2026-10-22 23:20–23:23 CST，release `20261022T152053Z`/commit `4619c91`，schema v13、无迁移；`/healthz` version 0.5.10/schemaVersion 13，smoke 16/16 与 24/24）。
> 生产 env 实测（3 个记忆变量就位、代理变量与 `BOT_PROXY_URL` 均无、运行时 365/3/120/7、config 无 proxy 字段）；无代理环境 QQ `checkBot` ok、连通性日志 detail 仅 `internet:true, platforms:["qq"]`；PC 隧道任务/进程已移除、PC/Pi 无 18090 监听；前端 `/`、`/bots` 200（bundle `index-Bx6EBCIp.js` 644262 bytes，含“Pi 直连”，不含“代理端口/设备在线”）。
> **用户已实发验收通过**（2026-10-22 23:26–23:29 CST：合并摘要 rounds=3、远端会话删除 404 两例、图片 145172 B 有服务端证据；`/bots` 卡片用户确认；23:29 完成验收）；回滚切回 `20261022T143451Z` 并恢复 env（含代理变量/旧隧道脚本）后重启。
>
> **v0.5.11 已部署并验收通过**（2026-10-23，最终 release `20261023T022831Z`/commit `931b10d`，schema **v14**，迁移 14 不可逆；同版本早前 release `20261023T021339Z`/`20261023T014328Z` 保留）：`/healthz` version 0.5.11/schemaVersion 14，smoke 16/16 与 24/24；生产 env 5 个 `BOT_MEMORY_*`、运行配置 365/3/120/3000/12/90/30。
> **用户实发验收通过**（2026-10-23 10:39 CST）：三条 Chat → `bot.memory.extract` rounds=3 ops=2、`/memory` 成功、`/forget confirm` items=2 legacy=0 且未误删其他用户；早前 `/memory off`→Chat 无新 extract→`on`→`/forget` 亦通过；`/bots` 面板用户确认；首次短消息 ops=0 判定提示词过保守，commit `931b10d` 修正后重试 ops=2；legacy 清理 users=0 files=0；回滚必须恢复最终迁移前快照 + v0.5.10 release。

> 安全边界：QQ AppSecret 只写不读，数据库只存 AES-256-GCM 密文；Webhook 只按平台 Ed25519 签名/时间戳鉴权；
> 除自助命令（`/help`、`/memory`、`/role` 仅私聊；`/reset`、`/forget confirm` 全用户）外，斜杠命令需要目标 + 用户双重白名单；Chat 只授予目标内普通消息 AI 对话，不授予命令权限；
> 发布必须 TOTP + `PUBLISH` 二次确认，且仅文本；通知/命令/Chat 输出不包含内部路径或 URL；记忆/角色正文不通过 API/UI 暴露；
> 诊断只存事件元数据、不存消息正文；入站图片只从 QQ 固定域名后缀下载、mime 白名单与大小上限处理且不落盘；Bot 默认关闭（`BOT_ENABLED=false`），Webhook 关闭时返回 404。

## 1. 架构

```text
QQ 开放平台 ──签名 Webhook──▶ POST /api/bot/webhook/:botId
                               │ op=13 回调地址校验 / op=0 Ed25519 验签 + 时间戳 + IP/Bot 限流
                               ├─ 事件去重 → bot_events(received/ignored 诊断) + bot_inbound_targets（目标/用户，不存正文）
                               ├─ 斜杠命令 → 自助命令(/help、/memory、/role 私聊、/reset、/forget confirm) 或 目标 allow_commands + 用户白名单
                               │              → 只读 provider / OpenCode AI → 平台回复
                               ├─ 普通消息 → 目标 allow_chat（C2C 私聊直接进入；群/频道仅 @Bot 事件）
                               │              → 文本或入站图片 → OpenCode AI → 清洗/格式化/分段 → 平台回复
                               └─ 入站错误 → 401/404/429（不执行业务）

入站图片管线（默认开启）：d.attachments → image/* 元数据(content_type/filename/size/url)
  → 固定域名后缀白名单(.qpic.cn/.qq.com/.qq.com.cn/.gtimg.cn，实际图床如 multimedia.nt.qq.com.cn) + image mime 白名单 + ≤BOT_AI_IMAGE_MAX_BYTES
  → 内存下载（不落盘）→ OpenCode prompt files(data URL) → 模型 provider；失败降级为文字回答

命令/Chat 回复管线：AI 文本 → sanitize（路径/URL/控制字符）→ QQ 纯文本格式化（去 Markdown 标记）
  → 按 QQ 单条 2000 字符分段（最多 4 段、续段前缀“（续 n/m）”、超限截断标记）

平台连接自检 ──▶ POST /api/bots/:id/check → 适配器换取 access_token（detail 不含 token）
诊断查询 ──▶ GET /api/bots/:id/events（bot_events 元数据，无正文）
角色/记忆管理 ──▶ GET/PATCH/DELETE roles；GET memories（用户级）、GET memories/:userId/items、DELETE 单条/整用户（仅元数据）

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
- `server/src/bot/ai.ts`：OpenCode 本地 API 客户端，提供 Chat 会话复用、deny-all 工具、超时/截断、图片 prompt files 与记忆摘要（v0.5.9 起 AI 仅 Chat；v0.5.10 摘要使用一次性远端会话并在 `finally` 删除）；回答上限 `BOT_AI_MAX_REPLY_CHARS`，QQ 层再分段。
- `server/src/bot/memory.ts`：结构化长期记忆（v0.5.11）：`bot_memory_items` 7 类条目 + `bot_memory_state` 启停/legacy 标记；抽取校验/敏感过滤/容量与 TTL/分层召回；旧摘要仅作 legacy 来源与 fallback。
- `server/src/bot/roles.ts`：每 Bot×用户私聊角色卡；提供元数据列表、启停、删除（正文只供 `/role show` 与 Chat 提示词）。
- `server/src/bot/prompts.ts`：任务/对话提示与固定安全边界；Chat 默认个人角色或内置 lofii，群聊固定默认。
- `server/src/bot/service.ts`：CRUD、Webhook、Chat/命令分发、回复管线（sanitize→format→split）、图片降级、事件诊断、连接自检、角色/记忆管理、指标、静默时段、通知/发布队列、重试、清理、限流。
- `server/src/http/routes/bots.ts`：管理 API；`bot-webhook.ts`：公开回调入口。
- web `/bots`：概览、配置、目标、投递与发布、角色与记忆、诊断六个分区；配置页“检查连接”，目标页 `allowChat`，角色/记忆与诊断面板只展示元数据/脱敏错误。

### 1.1 v0.5.8 平台收敛（移除清单）

- 删除 Telegram / Discord / Slack 适配器与 `server/src/bot/discord-gateway.ts`，公开 Webhook 只接受 QQ 官方 Bot。
- 删除 Discord Gateway、只读按钮（Telegram inline keyboard / Discord components）、Telegram HTML `parse_mode`、群聊引用/线程、目标 `chatTrigger`（QQ 群/频道仅 @，C2C 直接）。
- 删除媒体/多附件发布与 `BOT_PUBLISH_MAX_MEDIA_BYTES/FILES/TOTAL_BYTES`；发布仅文本（QQ 单条 ≤2000，长文本按分段发送）。
- schema v13（迁移 13）：`DELETE FROM bots WHERE platform <> 'qq'`，级联删除非 QQ Bot 的目标/队列/事件/会话/记忆/角色卡；生产 Discord Bot 数据在部署前已备份，迁移后从应用数据库移除。
- 保留：QQ 官方 Bot 接入/命令/自助命令/Chat/结构化长期记忆/角色卡、事件诊断、平台连接自检、角色/记忆元数据管理、文本发布、图片理解（默认开启）。
- 历史验收记录（v0.5.0–v0.5.7）保留多平台内容，但自 **v0.5.8 起移除**，不再作为当前能力。

## 2. QQ 平台接入

1. 在 QQ 开放平台（q.qq.com）创建机器人，取得 **AppID** 与 **AppSecret**；AppID 填公开配置（`config.appId`，5–32 位数字），AppSecret 只提交保存为密文。
2. “开发设置 → 回调地址”填 `https://app.example.com/api/bot/webhook/<botId>`；平台会发送 `op=13` 校验，服务端用 AppSecret 派生 Ed25519 私钥返回 `{plain_token, signature}`。
3. 事件订阅按场景勾选 `C2C_MESSAGE_CREATE`（私聊）、`GROUP_AT_MESSAGE_CREATE`（群@）、`AT_MESSAGE_CREATE`（频道）。
4. 目标登记：C2C 填 `user_openid`、群聊填 `group_openid`、频道填 `channel_id`；命令用户另建 `kind=user` 且允许命令的目标。
5. 命令（无需平台注册，直接发送）：`/help`（动态）、`/memory`（查看/`off|on`）、`/status`、`/backup`、`/world`、`/mc`、`/files <关键词>`、`/role`（仅私聊）、`/reset`、`/forget confirm`；v0.5.9 起 `/ask` 已移除。
6. 触发：C2C 私聊普通文本直接进入 Chat；群/频道只有 @Bot 事件进入（平台本身只推送 @ 消息），**不支持“全部消息”触发**。
7. **入站图片（默认开启）**：QQ 事件 `d.attachments` 提供 `content_type`/`filename`/`size`/`url`；只取首个 `image/*` 附件，仅图片无文字也可进入 Chat。
   适配器只从固定域名后缀 `.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（QQ 实际图床如 `multimedia.nt.qq.com.cn`） 下载，校验 image mime 白名单（jpeg/png/webp/gif）与 `BOT_AI_IMAGE_MAX_BYTES`；
   图片在内存中转 base64，以 OpenCode prompt files data URL 随本轮 prompt 发送给模型 provider（本地 AI 服务），**不落盘、不写日志/审计正文**。
   `BOT_AI_VISION_ENABLED=false`、无图片权限、下载失败或 mime/大小不合规时降级为文字回答（有文字时附“图片未能处理”说明；无文字时提示改用文字）。
8. 文本输出：单条 ≤2000 字符；被动回复带入站 `msg_id`，主动通知/发布不带 `msg_id`；长回复按 2000 字符分段（最多 4 段、续段前缀、超限截断）；
   QQ 仅支持文本，**不支持媒体/附件/按钮/引用回复**。
9. QQ 真实回调需用户后台配置；未配置前只能做进程内契约测试。平台限制：群/频道必须 @Bot、无普通消息全量推送、无按钮/媒体、无编辑消息。

## 3. 权限模型

- **命令目标**：`bot_targets` 中 `allow_commands=1` 的频道/群组/私聊。
- **用户白名单**：发送者必须是 `kind='user'` 且 `allow_commands=1` 的目标；频道/群里的普通成员即使目标开启命令也无法执行。
- **自助命令（所有用户）**：`/help`（按身份动态帮助）、`/memory`（查看记忆计数/类型/启停/最近更新，不含 key/value；`/memory off|on` 暂停/恢复）、`/role`（仅私聊，管理个人角色卡）、
`/reset`（重置当前目标全部对话，保留长期记忆）、`/forget confirm`（清除结构化条目/状态/legacy 旧摘要与该 Bot×用户的全部会话，含远端）。五条不需要目标 `allow_commands` 或 user 白名单；

## 4. 队列、回复管线与失败处理

- 通知/命令回复/发布统一入队，`dedupe_key` 保证同一事件/目标只投递一次。
- 静默时段：目标设置 `quiet_start_minute`/`quiet_end_minute`（Asia/Shanghai 本地分钟 0–1439，成对设置、不能相同）后，窗口内新通知的 `next_attempt_at` 延后到窗口结束；跨午夜按 start > end 处理；通知不丢弃。
- 30 秒 tick，指数退避（30s 起，≤1h），达到 `BOT_DELIVERY_MAX_ATTEMPTS`（默认 5）进入 `failed/dead`。
- 长文本分段（QQ 2000/段，最多 4 段，续段前缀“（续 n/m）”，超出截断并标记“内容过长已截断”）；第 2 段起发送失败时把已发送消息 ID 挂到错误对象，
  队列/命令记录 `partial_text_sent` 且**不自动重试**，由管理员核对平台消息后处理。
- 格式：AI 回答经 sanitize（路径/URL/控制字符）→ `format.ts` 去 Markdown 标记保留可读正文 → 按 QQ 上限分段发送；仅 http(s) 链接保留为文字。
- 图片（默认开启）：`d.attachments` → image/* 元数据 → 固定域名后缀白名单 + mime 白名单 + 大小上限 → 内存下载 → OpenCode prompt files；
  关闭/失败/mime 非法时降级为纯文字回答；不落盘、不写日志/审计正文。
- 进程重启后，`sending` 超过 10 分钟的记录自动回队；`assembling` 等异常由各模块维护清理。
- 事件保留 `BOT_EVENT_RETENTION_DAYS`（默认 7 天）；AI 会话映射按 `BOT_AI_SESSION_RETENTION_DAYS`（默认 7 天）清理；
  结构化记忆按条目 `expires_at` 清理（资料/偏好不过期；事实/项目/关系 365 天、事件 90 天、任务 30 天，更新续期）并受 `BOT_MEMORY_MAX_ITEMS` 容量约束；旧摘要仅 legacy/fallback，验收后 CLI 清理；
  已发送投递/发布 30 天后清理；`failed/dead` 保留供人工重投，不自动删除。
- 诊断事件：入站 Webhook 事件按 `(bot_id, platform_event_id)` 去重写入 `bot_events`，先记 `received`，处理完成后更新为
  `ok`/`denied`/`rate_limited`/`ignored`/`error`，`detail` 只放短码（如 `command_denied`/`chat_rate_limited`/`partial_reply`），不写消息正文。
- 指标：`GET /api/bots/:id/metrics?hours=24`（1–720 小时）返回投递/发布/事件统计、成功率、最近错误（含 `lastErrorHint` 中文提示）与最近发送；
  `/bots` 页面展示近 24 小时卡与诊断分区。

## 5. 配置

见 `deploy/env.example` 的 `BOT_*` 段与 `docs/DEPLOY.md` §2/§3.1（以下为最终保留项；v0.5.8 已删除 `BOT_DISCORD_GATEWAY_ENABLED` 与 `BOT_PUBLISH_MAX_MEDIA_*`）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BOT_ENABLED` | `false` | 总开关；完成 QQ 平台联调后再显式开启 |
| `BOT_SECRET_KEY` | 由 `bootstrap-env.sh` 生成 | 32 字节 base64；必须与 DB 一起备份 |
| `BOT_WEBHOOK_MAX_BODY_BYTES` | `262144` | Webhook body 上限 |
| `BOT_DELIVERY_INTERVAL_SECONDS` | `30` | 队列轮询间隔 |
| `BOT_DELIVERY_MAX_ATTEMPTS` | `5` | 最大尝试次数 |
| `BOT_EVENT_RETENTION_DAYS` | `7` | 入站事件/入站目标保留 |
| `BOT_COMMAND_RATE_PER_MINUTE` | `120` | 每用户命令限流（1–600，v0.5.9 放宽） |
| `BOT_PUBLISH_MAX_SCHEDULED_DAYS` | `30` | 定时发布最远天数 |
| `BOT_MAX_BOTS` | `10` | Bot 数量上限 |
| `BOT_AI_ENABLED` | `false` | 普通消息 Chat 的 AI 总开关（v0.5.9 起 AI 仅 Chat）；默认关闭 |
| `BOT_AI_PROVIDER` | 空 | 可选 OpenCode provider；与 `BOT_AI_MODEL` 同时设置才指定模型 |
| `BOT_AI_MODEL` | 空 | 可选模型 ID；为空使用 OpenCode 默认模型 |
| `BOT_AI_TIMEOUT_SECONDS` | `60` | AI 超时（10–180 秒） |
| `BOT_AI_MAX_PROMPT_CHARS` | `2000` | 提示词截断（100–8000） |
| `BOT_AI_RATE_PER_HOUR` | `120` | 每 Bot×用户每小时 AI 调用上限（1–600，v0.5.9 放宽；仅 Chat） |
| `BOT_AI_SESSION_RETENTION_DAYS` | `7` | AI 会话映射保留天数（1–90；v0.5.10 起与会话记忆分离） |
| `BOT_CHAT_RATE_PER_MINUTE` | `30` | Chat 每 Bot×用户每分钟上限（1–120，v0.5.9 放宽） |
| `BOT_AI_MEMORY_MAX_CHARS` | `4096` | legacy 旧摘要/fallback 上限（512–16384；v0.5.11 起仅 legacy） |
| `BOT_AI_MEMORY_RETENTION_DAYS` | `365` | fact/project/relationship 条目 TTL 天数（30–3650，v0.5.11 起用于结构化条目） |
| `BOT_AI_MEMORY_BATCH_MESSAGES` | `3` | 累计多少轮对话触发一次记忆抽取（1–20） |
| `BOT_AI_MEMORY_IDLE_FLUSH_SECONDS` | `120` | 用户空闲多少秒触发记忆抽取（0 或 10–3600，0 关闭空闲触发） |
| `BOT_MEMORY_MAX_ITEMS` | `200` | 每 Bot×用户结构化记忆容量上限（20–1000；超限先淘汰低重要度非核心条目；v0.5.11 新增） |
| `BOT_MEMORY_PROMPT_MAX_CHARS` | `3000` | 记忆召回注入上限字符数（500–8000；v0.5.11 新增） |
| `BOT_MEMORY_PROMPT_MAX_ITEMS` | `12` | 记忆召回注入上限条数（1–50；v0.5.11 新增） |
| `BOT_MEMORY_TTL_EPISODE_DAYS` | `90` | episode 条目 TTL（1–365；v0.5.11 新增） |
| `BOT_MEMORY_TTL_TASK_DAYS` | `30` | task 条目 TTL（1–180；v0.5.11 新增） |
| `BOT_AI_MAX_REPLY_CHARS` | `4000` | AI 单次回答字符上限（1000–12000）；QQ 层再按 2000 分段 |
| `BOT_AI_VISION_ENABLED` | `true` | QQ 入站图片理解总开关，默认开启；开启需 OpenCode prompt files + 支持 image 输入的模型 |
| `BOT_AI_IMAGE_MAX_BYTES` | `10485760` | 单张入站图片上限（1–20 MiB）；image mime 白名单、固定域名、不落盘 |
| `BOT_CONNECTIVITY_ENABLED` | `true` | 出站连通性探测开关 |
| `BOT_CONNECTIVITY_INTERVAL_SECONDS` | `60` | 探测间隔（15–600） |
| `BOT_CONNECTIVITY_TIMEOUT_SECONDS` | `8` | 单次探测超时（2–30） |

`BOT_SECRET_KEY` 丢失或轮换会导致已存 QQ AppSecret 无法解密，必须重新录入。不要把它写入仓库/前端/日志。
`bootstrap-env.sh` 已纳管上述 `BOT_*` 键（v0.5.8 移除 `BOT_DISCORD_GATEWAY_ENABLED` 与 `BOT_PUBLISH_MAX_MEDIA_BYTES/FILES/TOTAL_BYTES`；
v0.5.9 移除 `BOT_AI_TASK_PROMPT`/`BOT_AI_CHAT_PROMPT`，AI 提示词固定不再可覆盖；
v0.5.10 删除 `BOT_PROXY_URL`（Pi 直连）并新增 `BOT_AI_MEMORY_RETENTION_DAYS`/`BOT_AI_MEMORY_BATCH_MESSAGES`/`BOT_AI_MEMORY_IDLE_FLUSH_SECONDS`；
v0.5.11 新增 `BOT_MEMORY_MAX_ITEMS`/`BOT_MEMORY_PROMPT_MAX_CHARS`/`BOT_MEMORY_PROMPT_MAX_ITEMS`/`BOT_MEMORY_TTL_EPISODE_DAYS`/`BOT_MEMORY_TTL_TASK_DAYS`）；`BOT_AI_VISION_ENABLED` 默认 `true`。

## 5.1 Chat 提示词、会话与记忆抽取（v0.5.11）

- 提示词固定由四部分组成：**角色卡（私聊个人卡或默认 lofii）+ 固定只读安全边界 + 结构化记忆召回 + 用户消息**；不再提供任务/对话提示词覆盖，
  `BOT_AI_TASK_PROMPT`/`BOT_AI_CHAT_PROMPT` 已删除；旧 `BOT_AI_SYSTEM_PROMPT` 已废弃且不再读取。
- AI 仅在普通消息 Chat 中调用（`allow_chat` 目标 / QQ C2C 私聊）；斜杠命令不调用 AI，`/ask` 已移除（非管理员被拒、管理员回全量帮助）。
- 会话：`bot_ai_sessions` 按 `(bot_id, target_external_id, user_id, mode)` 复用 OpenCode 会话；v0.5.9 起 `mode` 只写 `chat`（列保留，旧 `task` 行为历史遗留）；
  `/reset` 与角色卡变更会清理该范围全部会话映射（不再区分 task/chat）；共享结构化长期记忆（`bot_memory_items`/`bot_memory_state`，v0.5.11 起；旧摘要仅 legacy/fallback）。
- 审计 `bot.ai.chat` 记录 bot/user/chars/image 等元数据，**不再记录 mode**，不记录提示词/记忆正文。
- 记忆抽取（v0.5.11）：累计 `BOT_AI_MEMORY_BATCH_MESSAGES`（默认 3）轮或用户空闲 `BOT_AI_MEMORY_IDLE_FLUSH_SECONDS`（默认 120s，0 关闭）触发一次；按 Bot×用户串行队列，每次新建一次性远端会话并在 `finally` 删除；
  模型输出严格 JSON operations（upsert/delete，服务端最多 20 条），服务端校验/敏感过滤/容量清理后写入 `bot_memory_items`；审计 `bot.memory.extract` 只记计数（不再有旧摘要 `bot.ai.memory` 主路径，仅 legacy 兼容）。
  摘要使用一次性远端会话并在 `finally` 删除，不再保存 `summary_session_id`；审计 `bot.ai.memory` 记录 `rounds`，不记录摘要正文。
- QQ C2C 私聊对任意用户开放 Chat（接触面由 QQ 平台“谁可添加 Bot”控制）；只读命令仍要求目标 `allow_commands` 与用户白名单。

## 5.2 图片理解（默认开启）

- 开关：`BOT_AI_VISION_ENABLED=true`（v0.5.8 默认）；开启需 OpenCode 支持 prompt files 与模型支持 image 输入
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
- 角色管理：`GET /api/bots/:id/roles?limit&offset` 返回元数据（userId/userName/name/enabled/promptLength/时间）；`PATCH` body `{enabled}` 启停；`DELETE` 删除并清理该用户 chat 会话。
- 记忆管理（v0.5.11）：`GET /api/bots/:id/memories?limit&offset` 返回用户级元数据（userId/userName/itemCount/kinds/memoryEnabled/updatedAt）；`GET /api/bots/:id/memories/:userId/items?limit&offset` 返回条目元数据（id/kind/importance/confidence/updatedAt/expiresAt）；
  `DELETE /api/bots/:id/memories/:userId/items/:itemId` 删除单条；`DELETE /api/bots/:id/memories/:userId` 删除整用户；均只操作元数据，**绝不返回 key/value**；审计 `bot.memory.delete_item`/`bot.memory.delete_user`。
- 审计：`bot.check`、`bot.reset`、`bot.memory.forget`、`bot.role.admin`、`bot.memory.admin` 只记录动作、数量/长度与截断 ID，不含正文。

## 5.5 结构化长期记忆（v0.5.11）

- **条目模型**：7 类 `profile`（资料）/`preference`（偏好）/`fact`（事实）/`project`（项目）/`task`（任务）/`relationship`（关系）/`episode`（事件）；字段 key/value/confidence/importance/source/created_at/updated_at/last_used_at/expires_at；
  唯一键 `(bot_id,user_id,kind,mem_key)`；`bot_memory_state` 保存每用户 `memory_enabled` 与 `legacy_migrated_at`；旧 `bot_ai_memories` 仅作 legacy 迁移来源/未迁移 fallback（验收后 CLI 清理）。
- **抽取**：批量触发 = 累计 `BOT_AI_MEMORY_BATCH_MESSAGES`（默认 3）或空闲 `BOT_AI_MEMORY_IDLE_FLUSH_SECONDS`（默认 120s）；同用户串行；一次性 OpenCode 会话（用后删除）；模型只输出严格 JSON `operations`，服务端校验 kind/key/value 长度、敏感过滤（密钥/URL/内部路径跳过）、最多 20 条 ops；
  upsert 按唯一键合并并续期，delete 删除；容量超 `BOT_MEMORY_MAX_ITEMS`（默认 200）时先淘汰低重要度非核心条目（profile/preference 受保护）；故障只记日志不影响本轮回复。
- **TTL**：`profile`/`preference` 不过期；`fact`/`project`/`relationship` 365 天（`BOT_AI_MEMORY_RETENTION_DAYS`）；`episode` 90 天（`BOT_MEMORY_TTL_EPISODE_DAYS`）；`task` 30 天（`BOT_MEMORY_TTL_TASK_DAYS`）；更新操作续期。
- **召回**：核心 `profile`/`preference`/`task` 优先，其余按关键词命中 + 重要度/时效挑选；预算 `BOT_MEMORY_PROMPT_MAX_CHARS`（默认 3000 字）/`BOT_MEMORY_PROMPT_MAX_ITEMS`（默认 12 条）；命中条目更新 `last_used_at`；
  `/memory off` 时返回空上下文（不注入、不抽取）；未迁移旧摘要作为 fallback 注入并受同一预算约束。
- **自助命令**：`/memory` 显示总条数/各类型计数/启停/最近更新时间（不含 key/value）；`/memory off|on` 暂停/恢复；`/forget confirm` 清空该用户 items/state/legacy 摘要并清空会话（含远端）；审计 `bot.memory.toggle`/`bot.memory.extract`/`bot.memory.forget`。
- **Legacy 清理**：验收后运行 `node scripts/cleanup-legacy-memory.mjs`（默认 dry-run）核对数量，再 `--confirm` 删除已迁移用户的 `bot_ai_memories` 行 + 镜像文件（写审计 `bot.memory.legacy_cleanup`，不输出正文）。

## 6. 网络出站（QQ / OpenCode，Pi 直连）

- v0.5.10 起 Bot 出站不再依赖 PC 代理隧道/环境代理：应用使用 Node 全局 `fetch` 直接访问 `bots.qq.com`/`api.sgroup.qq.com`（Webhook 入站不依赖出站）；
  生产 env 不再设置 `HTTPS_PROXY`/`HTTP_PROXY`/`NODE_USE_ENV_PROXY`/`BOT_PROXY_URL`/`NO_PROXY`，仓库也不再包含隧道脚本/PC 计划任务。
- Chat 只访问 `OPENCODE_URL`（默认 `http://127.0.0.1:4096`），图片经同一本地 OpenCode 接口交给模型 provider；均不使用外部代理。
- 验证（Pi 直连）：

```bash
curl -sS -m 10 -o /dev/null -w '%{http_code}\n' https://bots.qq.com/app/getAppAccessToken   # 4xx/2xx 均说明网络可达
sudo journalctl -u antifieldcloud -n 50 --no-pager | grep -i bot
```

- 不要恢复旧代理变量或安装旧隧道任务（v0.5.10 代码不再读取代理配置）；本机部署信息放在 gitignored 的 `.local/DEPLOYMENT.md`。

### 6.1 连通性探测

- `BOT_CONNECTIVITY_ENABLED=true` 时，服务端每 `BOT_CONNECTIVITY_INTERVAL_SECONDS`（默认 60）探测：
  1. 外网（中立站点只读 GET）；
  2. QQ 平台只读 API URL（4xx 也算网络可达）。
- `GET /api/bots/connectivity` 返回 `{checkedAt, checking, internet, platforms}`（v0.5.10 起无 `deviceOnline`/`proxy`）；`POST /api/bots/connectivity/check` 手动复检（30 次/分钟）；
  `/bots` 概览卡片展示外网与 QQ 平台状态/延迟。
- 外网从不可达恢复时触发投递/发布队列扫描；探测不携带 Bot 凭据、不记录响应正文。
- 常见问题：无需安装任何 Windows 计划任务/隧道；若外网不可达请检查 Pi 路由/DNS/出站防火墙，而不是恢复旧代理变量。
### 6.2 QQ 群/频道无响应排查

按顺序确认，避免把平台配置问题误判为代码问题：

1. QQ 开放平台已订阅群事件 `GROUP_AT_MESSAGE_CREATE`（频道为 `AT_MESSAGE_CREATE`），回调地址为 `https://app.<域名>/api/bot/webhook/<botId>`，且回调校验 `op=13` 已通过。
2. Bot 已被拉入该群/频道；QQ 群/频道消息必须 **@Bot** 才会推送给机器人，普通群聊不会产生事件（也不支持“全部消息”触发）。
3. 发送后查看服务端：`bot_events` 是否有新事件（`GET /api/bots/:id/events` 可查元数据）；若事件到达但正文为空/未知，会记录 `audit_log.action='bot.event.ignored'`（只含事件类型，不含正文）。
   若 `bot_inbound_targets` 出现 `target_kind='group'`，到 `/bots` 目标分区从“最近入站目标”登记该 group_openid，再开启 `allow_chat`（命令另开 `allow_commands`）。
4. 若没有新事件，优先检查开放平台事件订阅、Bot 入群状态与 @ 方式；入站 Webhook 不依赖出站代理。
5. 有事件但无回复：查看 `/bots` 出站网络卡片（外网/QQ 平台状态与延迟）和投递 `lastError`/`lastErrorHint`；QQ 回复需 Pi 直连 `bots.qq.com`/`api.sgroup.qq.com`（v0.5.10 起不再经 PC 代理隧道）。
6. 图片无响应/提示不支持：确认 `BOT_AI_VISION_ENABLED=true`、`BOT_AI_ENABLED=true`、模型支持 image；附件 URL 域名在 `.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（QQ 实际图床如 `multimedia.nt.qq.com.cn`） 白名单内、mime 与大小合规；看审计 `bot.ai.image`（只含 mime/大小/跳过原因）。

## 7. 结构化记忆存储与运维（v0.5.11）

- **数据表**：`bot_memory_items`（`(bot_id,user_id,kind,mem_key)` 唯一，value ≤500 字、key ≤64 字、confidence 0–1、importance 1–5、source ∈ chat/legacy、时间戳/`expires_at`）为权威；`bot_memory_state` 保存启停与 legacy 迁移标记；旧 `bot_ai_memories` 仅 legacy/fallback。
- **迁移 14**：新增上述两表（不可逆）；`scripts/deploy.ps1` 切换前自动做迁移前 DB 快照；v0.5.10 不支持 schema v14，回滚必须恢复快照。
- **写入**：抽取批处理按 Bot×用户串行；一次性 OpenCode 会话（`finally` 删除）；服务端严格校验 ops、敏感过滤（密钥/URL/内部路径跳过）、容量清理（默认 200，先淘汰低重要度非核心条目）；更新续期。
- **读取/召回**：核心层优先 + 关键词相关层，预算 3000 字/12 条；命中更新 `last_used_at`；`/memory off` 无注入；未迁移旧摘要 fallback 注入（受 `BOT_AI_MEMORY_MAX_CHARS` legacy 上限约束）。
- **TTL**：profile/preference 不过期；fact/project/relationship 365 天（`BOT_AI_MEMORY_RETENTION_DAYS`）；episode 90 天（`BOT_MEMORY_TTL_EPISODE_DAYS`）；task 30 天（`BOT_MEMORY_TTL_TASK_DAYS`）；过期条目清理并从召回/列表排除。
- **删除**：用户 `/forget confirm` 清空该 Bot×用户 items/state/legacy 摘要与全部会话，并尽力删除远端会话；管理员 `DELETE .../memories/:userId` 只删条目/状态/legacy，不删会话；`DELETE .../items/:itemId` 删单条并审计；两种管理删除均不返回 key/value。
- **审计**：`bot.memory.extract`（仅计数：upserts/deletes/skipped/pruned/migrated）、`bot.memory.toggle`、`bot.memory.forget`、`bot.memory.delete_item`、`bot.memory.delete_user`、`bot.memory.legacy_cleanup`；不记录正文。
- **Legacy 清理 CLI**：`node scripts/cleanup-legacy-memory.mjs` 默认 dry-run；`--confirm` 删除已迁移用户的 `bot_ai_memories` 行 + `DATA_DIR/bot-memory` 镜像并写审计；验收通过后执行一次，不输出正文。
- **备份**：DB 快照包含结构化条目/状态与角色卡正文；legacy 镜像目录不是恢复必需项。


## 8. 测试与验收边界

- 适配器/验签/队列/命令白名单/发布 TOTP+`PUBLISH`/AI/Chat/记忆/文本分段/图片下载/连接自检/诊断/角色与记忆管理均有进程内测试（不访问真实平台/模型）。
- QQ 适配器以 mock/fixture 覆盖（op=13/op=0、C2C/群@/频道、attachments 图片、access_token 自检、长文本分段）；AI 使用假 OpenCode HTTP 服务。
- 测试基线（Lead 实测 2026-10-23，v0.5.11）：`npm test` **360** 通过（v0.5.10 的 341 + 新增 19：记忆存储/抽取/检索/迁移/管理 API/`/memory` 等）、`npm run test:web` **162**（30 文件，v0.5.10 为 157，+5）；覆盖率 Lines **92.05%** / Branches **77.43%** / Functions **86.39%**（`npm run test:coverage` exit 0）、`npm run build` 通过。
- **真实平台前置条件**（部署/联调前确认）：
  - QQ 开放平台已创建机器人并配置回调地址，`op=13` 校验通过；已订阅 C2C/群@/频道事件。
  - Bot 已加入目标群/频道；群/频道必须 @Bot 才会产生事件；C2C 私聊无需登记即可 Chat，命令仍需白名单。
  - 图片：`BOT_AI_VISION_ENABLED=true`（默认）、`BOT_AI_ENABLED=true`、模型支持 image 输入、附件域名/mime/大小合规。
- 手工验收（v0.5.11）：创建/启用 QQ Bot → 添加目标并勾选 `allow_chat` → C2C/群 @Bot 多轮 Chat 触发抽取（≥3 条或空闲 120s）→ 检查 `bot_memory_items` 条目与 `bot.memory.extract` 计数 → `/memory` 查看计数/类型/启停（无正文）→ `/memory off` 后 Chat 无注入、`on` 恢复 → `/forget confirm` 清空 items/state/legacy/会话并核对远端会话 → 管理页记忆列表/条目元数据/删除 → 图片识别回归 → 验收通过后 `cleanup-legacy-memory.mjs` dry-run/`--confirm`。
  C2C/群 @Bot 发普通消息确认 Chat → 管理员发 `/help` 与 `/status` 确认管理员命令、非管理员发 `/help` 只出现公开命令 → 发 `/ask` 确认非管理员被拒/管理员回帮助不调用 AI → 发 `/reset`、`/forget confirm` 确认自助命令 →
  发布 1 条文本（含长文本分段）→ 多轮对话后检查 `bot_ai_memories.summary` 与 `DATA_DIR/bot-memory`（不打印内容）→
  配置页“检查连接” → 诊断分区查看事件/中文错误提示 → 角色与记忆分区启停/删除（只显示元数据）→
  发送一张图片确认模型识别或降级提示 → 多轮对话后检查 `bot.ai.memory` 审计含 `rounds`、`bot_ai_memories.summary_session_id` 为 NULL；`/reset`/`/forget confirm` 后远端会话被尽力删除；确认 PC 无 `AntifieldCloudDiscordTunnel` 计划任务、env 无代理变量。
- **v0.5.8 真实验收（通过，v0.5.9 起 `/ask` 与 task 模式移除）**：2026-10-22 21:59–22:08 CST 用户实发 13 条 QQ 入站事件全部符合预期——C2C 文本命令（`/help`、`/forget confirm`、`/reset`、`/role` show/set/off/on/delete）、权限拒绝（`bot.command.denied`，随后自助 `/role` 正常）、两条文本 Chat（`bot.ai.chat` + 记忆写入）、真实图片消息端到端（`bot.chat` image/`bot.ai.image` `mime=image/jpeg,size=148563`/`bot.ai.chat` image 标志/outcome=ok，随后记忆更新）；诊断/角色记忆面板与文本发布按用户确认整体通过（服务端未单独留存 UI/发布证据）。
- **v0.5.9 部署验证（通过）**：release `20261022T143451Z`/commit `97996dc`，`/healthz` v0.5.9/schema 13，smoke 16/16 与 24/24；生产 env 迁移完成（命令 120/AI 120/Chat 30、提示词变量计数 0）；运行时 `botChatRatePerMinute=30`/`botAiRatePerHour=120`/`botCommandRatePerMinute=120`；
  前端 bundle `index-CFrhFtH2.js` 含“每分钟 30 次”与“AI 对话由普通消息 Chat 承担”、不含 `/ask`。**用户实发验收（通过，2026-10-22 22:39–22:41 CST）**：非管理员 `/help` 有服务端事件证据（22:39:52 `command/ok/command_help`）；管理员 `/help` 全量、`/ask` 只回帮助不调用 AI、放宽后限速体验、Chat/图片回归为用户口头确认通过（服务端无单独事件证据）；22:41 原话“验收通过”。
- **v0.5.10 部署验证（通过）**：release `20261022T152053Z`/commit `4619c91`，`/healthz` v0.5.10/schema 13，smoke 16/16 与 24/24；生产 env 实测（3 记忆变量就位、代理变量/`BOT_PROXY_URL` 均无、运行时 365/3/120/7、config 无 proxy 字段）；无代理环境 QQ `checkBot` ok、连通性日志仅 `internet:true, platforms:["qq"]`；PC 隧道任务/进程已移除、无 18090 监听；前端 bundle `index-Bx6EBCIp.js` 含“Pi 直连”，不含“代理端口/设备在线”。
  **用户实发验收（通过，2026-10-22 23:26–23:29 CST）**：8 条事件全部 ok（4 Chat 含 1 条仅图片 145172 B、3 `/forget` 含 2 次 confirm、1 `/reset`）；4 条 Chat 仅 1 次 `bot.ai.memory`（`rounds:3`）；部署前快照会话 `ses_e9c15b42…`/`ses_e9c15a6f…` 在 `/forget confirm` 后经 OpenCode API 均 404，该用户本地会话/记忆清空、其他用户不受影响、无删除失败日志；图片端到端成功；`/bots` 出站卡片用户确认；23:29 CST 完成验收。
- **v0.5.11 部署验证（通过）**：最终 release `20261023T022831Z`/commit `931b10d`，schema v14；`/healthz` v0.5.11/schema 14，smoke 16/16 与 24/24；env 5 个 `BOT_MEMORY_*`、运行配置 365/3/120/3000/12/90/30；迁移前快照 `/var/lib/antifieldcloud/backups/db-predeploy-20261023T022902018Z.sqlite`（sha256 `937a0bc8…76a98d3c`）；部署后备份 `snapshot-20261023T023941878Z-inc.tar.gz`（154594 bytes，secrets=ok）。
  **用户实发验收（通过，2026-10-23 10:39 CST）**：三条 Chat → `bot.memory.extract` rounds=3 ops=2（偏好+资料）；`/memory` 成功；`/forget confirm` items=2 legacy=0、回复含“记忆条目 2 条”，之后 items=0/state=0 且其他用户 legacy/sessions 未误删；早前 `/memory off`→Chat 无新 extract→`on`→`/forget confirm` 亦通过；`/bots` 面板用户确认；首次短消息 ops=0 判定提示词过保守，commit `931b10d` 修正后重试 ops=2；legacy 清理 dry-run/`--confirm` 均 users=0 files=0。
- 发布前请确认 Cloudflare Access 对 `/api/bot/webhook/*` 做 bypass，见 `docs/DEPLOY.md` §5.2。
