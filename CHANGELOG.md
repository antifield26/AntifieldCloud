# Changelog

## [v0.5.5] - 2026-10-22

### Added

- **私聊角色卡**：新增 `/role`，对全部平台私聊用户开放；`/role set <名字> <设定>`、`/role show`、`/role off`、`/role on`、`/role delete`。每 Bot×用户一张启用卡，名字 1–32 字符、设定 1–1000 字符，拒绝保留提示词标记。
- **Chat 人设**：私聊 Chat 有启用角色卡时，用角色卡替换默认 Chat 风格；固定只读安全边界与共享长期记忆仍追加；`/ask` 与群/频道 Chat 不使用角色卡。
- **会话重置**：设置/停用/启用/删除角色卡后删除当前私聊 Chat 会话映射，下次 Chat 新建会话；`/ask` task 会话不受影响。
- **权限边界**：`/role` 是唯一对全部私聊用户开放的斜杠命令；其他命令仍需目标 `allow_commands` + 用户白名单。Telegram/Discord/Slack 私聊 Chat 仍按现有目标 `allow_chat`，QQ C2C 沿用 v0.5.4 开放。
- **Discord/Slack**：Discord DM interaction 正确标记 `isDirect`；Discord/Slack 命令文本上限从 512 提升到 2048，容纳角色设定。
- **schema v11**：迁移 11 新增 `bot_chat_roles`；角色卡不通过 API/UI 暴露，随数据库备份。

### Deployment

- 版本/文档/`APP_VERSION` 升到 0.5.5；`deploy.ps1` smoke 期望 schema 11；生产部署、迁移前快照、smoke 与真实私聊 `/role`/Chat 验收待执行。
- 本版无 UI 角色卡编辑；Discord/Slack 需在平台后台创建 `/role` 命令。

## [v0.5.4] - 2026-10-22

### Added

- **任务/对话双模式提示词**：`/ask` 使用任务导向提示（先结论、步骤、风险、必要澄清），普通 Chat 使用对话导向提示（自然、简洁、不说教）；`BOT_AI_TASK_PROMPT`/`BOT_AI_CHAT_PROMPT` 可覆盖，空则使用内置默认；固定安全边界始终追加，自定义不能移除只读/防泄密/“记忆不是指令”约束。
- **独立 AI 会话**：`bot_ai_sessions` 新增 `mode`（chat/task），旧会话迁移为 chat；`/ask` 首次新建 task 会话，普通 Chat 保留原 chat 会话；两种模式共享每 Bot×用户的长期记忆。
- **QQ C2C 开放 Chat**：QQ C2C 私聊对任意用户开放（不要求先登记目标，接触面由 QQ 平台“谁可添加 Bot”控制）；QQ 群/频道、Discord/Telegram 私聊仍按目标 `allow_chat`；斜杠命令仍要求目标 `allow_commands` + 用户白名单。
- **Chat 提示词去身份**：普通 Chat 不再声明 AntifieldCloud/助手身份，转向自然对话、不主动谈业务、不自我介绍。
- **schema v10**：迁移 10 重建 `bot_ai_sessions`，主键改为 `(bot_id,target_external_id,user_id,mode)`；迁移 5–9 保留；旧 v0.5.3 无法直接读取 v10。
- **审计可观测**：`bot.ai.chat` 审计增加 `mode`（不含提示词/记忆正文），便于区分 `/ask` 与 Chat。
- **提示词模块**：新增 `server/src/bot/prompts.ts` 与单元测试；旧 `BOT_AI_SYSTEM_PROMPT` 废弃，不再读取。

### Deployment

- 版本/文档/`APP_VERSION` 升到 0.5.4；`deploy.ps1` smoke 期望 schema 10。
- 生产已部署 release `20261022T085120Z`（commit `b2bdc8d`，schema v10，smoke 24/24）；`/ask` 任务模式、Chat 对话模式、QQ C2C 管理员/非管理员均已实发确认。
- Windows Bot 隧道改为 wscript/VBS 静默启动（无前台 shell、单实例互斥，安装器清理旧实例）；`-Foreground` 仅用于调试，应用版本不变。
- 本版无 UI 提示词编辑；修改提示词需改 env 并重启。

## [v0.5.3] - 2026-10-22

### Added

- **Bot 出站连通性与自动恢复**：新增 `server/src/bot/connectivity.ts`，按“代理端口 → 外网 → 各平台 API”三层探测，默认每 60 秒一次（`BOT_CONNECTIVITY_ENABLED`/`BOT_CONNECTIVITY_INTERVAL_SECONDS`/`BOT_CONNECTIVITY_TIMEOUT_SECONDS`；`BOT_PROXY_URL` 留空时复用 `HTTPS_PROXY`/`HTTP_PROXY`）。代理端口恢复或外网恢复时自动唤醒 Discord Gateway 重连并触发队列扫描；`GET /api/bots/connectivity` 与 `POST /api/bots/connectivity/check` 返回不含凭据的状态。
- **Bot 概览出站网络卡片**：展示设备在线、代理端口、外网、Discord/Telegram/Slack/QQ 平台探测延迟，支持手动复检；每 60 秒自动刷新。
- **Windows 代理隧道自恢复**：新增 `scripts/discord-tunnel.ps1` 与 `scripts/install-tunnel-task.ps1`。先探测 PC 代理端口 10090，再建立 SSH 反向隧道；SSH 退出/代理不可用时循环重试；计划任务登录启动并异常重启。
- **QQ 群事件诊断**：QQ 适配器对未知事件/空正文返回 `detail`，服务端审计 `bot.event.ignored`（只记录 QQ 事件类型，不记录正文），用于确认群事件是否到达；群事件仍需 `GROUP_AT_MESSAGE_CREATE` 订阅、Bot 入群 @ 与目标登记。
- **OpenCode v2.1.2**：生产从 v2.1.1 升级到 v2.1.2（备份二进制/数据/env/unit，重启后 Basic API 200，兼容性见 `docs/DEPLOY.md` §3.2）。

### Deployment

- 2026-10-22 部署 `20261022T065126Z`/commit `df06383` 到生产 Pi，schema 保持 v9；`/healthz` 0.5.3、完整 Access smoke 24/24。
- 迁移前 DB 快照 `db-predeploy-20261022T065156149Z.sqlite`；部署后 inc `snapshot-20261022T065651320Z-inc.tar.gz` + 密钥包 `secrets-20261022T065652Z.tar.age`（secrets=ok）。
- Windows 隧道计划任务已安装；断开/恢复 PC 代理的实测日志为 `Bot 出站网络不可用` → `Bot 出站网络已恢复` → `Discord Gateway 网络恢复，立即重连` → `会话已恢复`。
- QQ 群事件 `68611590B477339A04302BB23B426244` 到达后审计 `bot.chat.denied`，定位为群目标未登记；登记 `kind=group`（`allow_chat=1`/`allow_commands=1`）后用户确认群 @Bot 收到 AI 回复。

### Security

- 连通性探测只做无凭据只读 GET，不携带 Bot Token/AppSecret；响应/日志不包含平台响应正文。
- 代理隧道计划任务以当前用户 Limited 权限运行，仅转发 loopback；日志不包含 Token。
- Node.js 运行时已更新到 v26.12.1（v0.5.2 维护项，见下）。

### Docs

- README/AGENTS/CHANGELOG/ACCEPTANCE/PLAN/ROADMAP/API/UI-SPEC/ARCHITECTURE/SECURITY/DEPLOY/BOT 同步到 v0.5.3；新增连通性接口、界面、Windows 任务与 QQ 群排查步骤。

## [v0.5.2] - 2026-10-21

### Added

- **Bot Chat（普通消息 AI 对话）**：`server/src/bot/service.ts`、`types.ts`、Telegram/Slack/QQ 适配器与 Discord Gateway 扩展。非斜杠普通消息在目标 `allow_chat=1` 时进入 AI Chat；群/频道需 @Bot 或回复 Bot，私聊直接进入；管理员斜杠命令仍由目标 `allow_commands` + user 白名单双校验，非管理员只能 Chat。Chat 每 Bot×用户每分钟 `BOT_CHAT_RATE_PER_MINUTE`（默认 6）次，并与 `/ask` 共用每小时 `BOT_AI_RATE_PER_HOUR`（默认 10）次；Chat 不产生任何写操作。
- **Bot 长期记忆**：新增 `server/src/bot/memory.ts` 与 `bot_ai_memories`（迁移 9）。每 Bot×用户一份摘要，DB 为权威、`DATA_DIR/bot-memory/memory-<uuid>.md` 为镜像（0700/0600、临时文件 + 原子 rename）；每轮对话后滚动摘要，摘要失败保留旧摘要；记忆不通过任何 API/UI 暴露。系统提示内置，可用 `BOT_AI_SYSTEM_PROMPT` 覆盖；摘要不额外占用对话轮次或 AI 每小时配额。
- **多附件发布**：`BOT_PUBLISH_MAX_MEDIA_FILES`（默认 5）、`BOT_PUBLISH_MAX_MEDIA_BYTES`（单文件默认 10 MiB）、`BOT_PUBLISH_MAX_MEDIA_TOTAL_BYTES`（总默认 50 MiB）。Telegram 全图片使用 media group、混合类型逐文件；Discord 单次 multipart；Slack 逐文件上传后一次完成；QQ 仅文本。部分附件已外发时不自动重试，任务标记 `failed`/`partial_media_sent`，需人工重建。
- **只读按钮**：Telegram inline keyboard 与 Discord message components 支持 `/status`、`/help` 的“刷新状态/帮助”按钮；按钮动作仍需目标 `allow_commands` + user 白名单，只调用只读 provider，无写操作。Slack/QQ 本轮不做按钮。
- **Discord Gateway**：新增 `server/src/bot/discord-gateway.ts`，使用 Node 内置 WebSocket 建立长连接；`intents=37377`（GUILDS + GUILD_MESSAGES + DIRECT_MESSAGES + MESSAGE_CONTENT），需在 Discord Developer Portal 开启 Message Content Intent。实现 HELLO/IDENTIFY/RESUME、心跳、RECONNECT/INVALID_SESSION、指数退避重连与致命关闭码处理；`BOT_DISCORD_GATEWAY_ENABLED=false` 默认关闭；`BotSummary.gateway` 返回 `disabled/connecting/connected/reconnecting/error` 状态。
- **最近入站目标**：新增 `bot_inbound_targets`（迁移 9），只记录目标/用户/类型/时间，不记录消息正文；每 Bot 最多 500 条、按事件保留期清理。`GET /api/bots/:id/inbound-targets?limit=50`（需登录）；`/bots` 目标分区可从最近入站目标一键登记。
- **schema v9（迁移 9）**：`bot_targets.allow_chat`（默认 0）、`bot_ai_memories`（`summary_session_id`）、`bot_inbound_targets`；迁移 5–8 保留。
- **env**：`BOT_CHAT_RATE_PER_MINUTE=6`、`BOT_AI_MEMORY_MAX_CHARS=4096`、`BOT_AI_SYSTEM_PROMPT=`（空）、`BOT_DISCORD_GATEWAY_ENABLED=false`、`BOT_PUBLISH_MAX_MEDIA_FILES=5`、`BOT_PUBLISH_MAX_MEDIA_TOTAL_BYTES=52428800`；已有 `BOT_AI_RATE_PER_HOUR=10` 继续作为 Chat/`/ask` 共用小时配额。`bootstrap-env.sh` 已纳管 6 个新键。
- **测试**：新增 `server/test/bot-chat-adapters.test.ts`（12）、`bot-discord-gateway.test.ts`（10）、`bot-v052.test.ts`（5）；`bot-migration.test.ts` 覆盖 v6→v9。前端 `Bots.test.tsx` 新增目标 `allow_chat`/最近入站目标用例。本地 `npm test` **293**（服务端 277 + 运维脚本 16）、`npm run test:web` **140**（28 个测试文件）；`npm run check` 本地通过（2026-10-21）。

### Changed

- **发布 API/UI**：`POST /api/bots/:id/publish` 的 `mediaFileIds` 由最多 1 个改为最多 5 个，单文件 ≤10 MiB、总 ≤50 MiB；新增错误码 `too_many_media`、`media_too_large`、`media_total_too_large`。`/bots` 发布表单改为多选媒体（最多 5 个）。
- **目标 API/UI**：`BotTarget.allowChat` 与创建/更新请求的 `allowChat`（默认 false）；与 `allowCommands` 独立，不授予斜杠命令权限。`/bots` 目标分区新增“允许 Chat”和“最近入站目标”。
- **Bot 摘要**：`BotSummary.gateway` 新增；Discord 概览/配置分区展示 Gateway 状态与 Developer Portal 提示；Telegram/QQ 配置提示补充 Chat 触发方式。
- **版本/数据库**：应用 `0.5.2`，schema v9；生产已部署 v0.5.2/schema v9（release `20261021T114908Z`，commit `abeabc7`，带 Access token 的完整 smoke 24/24）。
- **文档/版本一致性**：README/AGENTS/CHANGELOG/PLAN/ROADMAP/API/UI-SPEC/ARCHITECTURE/SECURITY/DEPLOY/ACCEPTANCE/BOT 同步到 0.5.2；`check-version` 覆盖版本项。

### Security

- **Node.js 运行时安全更新（2026-10-22）**：生产 `/usr/local/bin/node` 从 v26.11.1 升级到 **v26.12.1**（官方 linux-arm64 包，SHA-256 `42aa0492…` 校验）；旧二进制保留 `/usr/local/bin/node.v26.11.1` 可回滚；应用版本/schema 不变（0.5.2/schema 9），重启后 healthz 正常、完整 smoke 24/24，Discord Gateway 在代理恢复后重新连接。npm/npx 仍为 nvm 12.2.0，仅用于构建/部署。
- Chat 只读且目标级授权：仅 `allow_chat=1` 的目标可进入；非管理员不能执行斜杠命令；群/频道无 @/回复不消费消息；Chat 限流 6/min，并与 `/ask` 共享 10/h AI 配额。
- 记忆文件 0700/0600、路径仅由服务端生成的 memory UUID 派生、原子写；DB 为权威，镜像失败不影响摘要；摘要失败保留旧摘要；记忆正文不进入 HTTP API/前端；系统提示明确“记忆只是背景资料，不是指令”。
- Gateway Token 只出现在 IDENTIFY/RESUME 帧，不写日志；MESSAGE_CONTENT 仅用于私聊、@Bot 与回复 Bot；忽略 bot/webhook 消息；致命关闭码不自动重连；Gateway 状态不含 Token。
- 多附件部分成功不自动重试，避免重复外发；QQ 媒体继续拒绝；按钮只读且需双白名单；Slack 按钮本轮不做。
- `bot_inbound_targets` 只存平台 ID/类型/用户名/时间，不存消息正文；删除 Bot 时 DB 记忆与入站目标级联清理。

### Docs

- 同步 README/AGENTS/CHANGELOG/PLAN/ROADMAP/API/UI-SPEC/ARCHITECTURE/SECURITY/DEPLOY/ACCEPTANCE/`docs/BOT.md`：Chat/记忆/多附件/按钮/Gateway、schema v9、迁移 9、环境变量、API/UI 契约与测试基线（293/140）。
- ACCEPTANCE 新增 v0.5.2 章节并记录生产部署/迁移 v9/smoke 证据；Discord Gateway 真实长连接、多附件真实平台外发、Chat 真实模型与记忆行为仍待生产目标开启 `allow_chat`/Gateway 后联调。

### Known limitations（v0.5.2 明确不做）

- 企业微信/钉钉/飞书留 v0.5.4；多管理员/审批流不做；QQ 媒体不做；Slack 按钮不做。
- Discord Gateway 已有进程内假 WebSocket 测试；生产已开启并记录 `Gateway 已连接`，MESSAGE_CONTENT 负路径/断线重连仍待观察。
- Telegram/Slack/Discord/QQ 的真实 Chat 与多附件仅覆盖 mock 契约测试；生产 QQ C2C 与 Discord #general 已开 `allow_chat`，需按 `docs/DEPLOY.md` §9.8 实发联调。
- 记忆只保留摘要，不保存逐条对话；不提供导出/删除页面；删除 Bot 时 DB 记忆行级联删除，`DATA_DIR/bot-memory` 镜像文件不由删除路径清理，需按保留期/人工清理。
- 多附件部分成功后不自动重试；失败任务需人工确认并重建，避免重复外发。
- 生产已部署 v0.5.2/schema v9，Gateway 已连接；Discord DM、Discord #general @Bot、QQ C2C 普通消息 Chat 已由用户实发确认；多附件与按钮真实平台验收待补充，其余目标默认关闭。

## [v0.5.1] - 2026-10-21

### Added

- **QQ 官方 Bot**：`server/src/bot/adapters/qq.ts` 与 schema v8 的 `bots.platform='qq'`。
  - Webhook 使用 AppSecret 派生 Ed25519 密钥：`op=13` 回调地址校验返回 `{plain_token, signature}`；`op=0` 事件校验 `X-Signature-Ed25519` + `X-Signature-Timestamp`（±300 秒），成功/忽略/重复事件统一回 `{opcode:12}`。
  - 事件：`C2C_MESSAGE_CREATE`、`GROUP_AT_MESSAGE_CREATE`、`AT_MESSAGE_CREATE`；目标填 `user_openid`/`group_openid`/`channel_id`。
  - 发送：被动回复带 `msg_id` 与随机 `msg_seq`，主动通知走 `v2/users|groups` 或 `channels` 消息接口；AppSecret 只用于本地派生密钥与换取 `access_token`（进程内缓存、提前 60 秒过期）。
  - **仅文本**：单条 ≤2000 字符；发布接口对 QQ 带媒体直接 400 拒绝，适配器发送媒体返回 `qq_media_unsupported`。
- **OpenCode AI `/ask`**（`server/src/bot/ai.ts`）：新增 `/ask <问题>` 命令与 `BOT_AI_*` 环境变量；通过 `OPENCODE_URL`（默认 `http://127.0.0.1:4096`）Basic Auth 调用 OpenCode 本地 API。
  - 默认关闭；仅对已登记的目标 + user 白名单开放，按 `botId:userId` 每小时限流（默认 10 次），提示词截断到 `BOT_AI_MAX_PROMPT_CHARS`（默认 2000），超时由 `BOT_AI_TIMEOUT_SECONDS`（默认 60）控制。
  - 会话复用：`bot_ai_sessions` 按 `(bot_id, target_external_id, user_id)` 映射 `session_id`，过期映射按 `BOT_AI_SESSION_RETENTION_DAYS`（默认 7）清理。
  - 新建会话传入 deny-all 的 OpenCode Permission.Ruleset 关闭工具；仅当服务端明确 400 拒绝 `permissions` 时降级为默认权限，并在日志标注“未隔离”，不宣称已隔离。
  - 只返回 assistant 文本段，单次回复截断 4000 字符；错误只暴露短码/状态码，不返回 OpenCode 密码、URL 或上游响应体。
- **Bot 运维增强**：
  - `GET /api/bots/:id/metrics?hours=24`（1–720 小时）：返回投递总数/成功/失败/死信/成功率、发布总数/成功/失败、事件数、最近错误与最近发送时间；`/bots` 投递与发布分区新增“近 24 小时指标”卡。
  - `bot_targets` 新增 `quiet_start_minute`/`quiet_end_minute`（Asia/Shanghai 本地 0–1439）；目标创建/更新接受 `quietStartMinute`/`quietEndMinute`，必须同时设置或同时留空、不能相同；静默窗口内的告警通知延后到窗口结束时刻。
  - 发布新增 `confirmText: 'PUBLISH'` 二次确认；缺失返回 400 `publish_confirm_required`，即使有 TOTP 也不能省略。
- **schema v8（迁移 8）**：重建 `bots`/`bot_targets`/`bot_deliveries`/`bot_publish_jobs`/`bot_events` 以把 `bots.platform` CHECK 扩到 `qq`；`bot_targets` 增加静默分钟列；新增 `bot_ai_sessions` 会话映射。迁移 6/7 保留。
- **env**：`BOT_AI_ENABLED=false`、`BOT_AI_PROVIDER=`、`BOT_AI_MODEL=`、`BOT_AI_TIMEOUT_SECONDS=60`、`BOT_AI_MAX_PROMPT_CHARS=2000`、`BOT_AI_RATE_PER_HOUR=10`、`BOT_AI_SESSION_RETENTION_DAYS=7`；`bootstrap-env.sh` 已纳管这 7 项。
- **安全收口**：
  - fail2ban dbfile 持久化已启用（`/var/lib/fail2ban/fail2ban.sqlite3`）；新增 `deploy/systemd/nftables.service.d/10-fail2ban-restore.conf`，nftables 启动后以 `systemd-run --collect --on-active=3` 异步重启 fail2ban，从数据库恢复封禁 set，避免同步 restart 的 ordering 死锁。
  - `smoke.ps1` 新增 `-AccessClientId/-AccessClientSecret`：两者同时提供时附加 `CF-Access-Client-Id`/`CF-Access-Client-Secret` 请求头，并新增“Access token 到达应用但未登录 → 401”检查；凭据不打印。
- **测试**：新增 `server/test/bot-qq.test.ts`（8）、`bot-ai.test.ts`（9）、`bot-v051.test.ts`（3）；`bot-migration.test.ts` 覆盖 v6→v8（含 qq CHECK 与静默列）。本地基线 `npm test` 265（服务端 249 + 运维脚本 16）、`npm run test:web` 139；`npm run check` 本地通过。

### Changed

- **发布 API**：`POST /api/bots/:id/publish` 的请求体新增必填 `confirmText: 'PUBLISH'`；TOTP 仍为必填，两者缺一不可。
- **Bot 平台枚举**：`/api/version` 的 `botPlatforms` 变为 `["telegram","discord","slack","qq"]`；`BotSummary.platform`、`BotTarget` 响应同步增加 `qq` 与静默字段。
- **`bootstrap-env.sh`**：纳入 7 个 `BOT_AI_*` 键，默认值来自 `deploy/env.example`；`--force` 沿用已有非空值。
- **版本/数据库**：应用 `0.5.1`，schema v8；生产仍为 v0.5.0/schema v7，待部署。
- **工具链评估**：typescript-eslint 8.x 仍不支持 TS7 API，v0.5.1 结论为**暂不升级**，保留 `@typescript/native` + `@typescript/typescript6@6.0.2` 双 alias。

### Security

- QQ AppSecret 与其它平台 Token 一样只写不读、AES-256-GCM 落库；错误/日志/审计不含 AppSecret、`access_token` 或签名原文。
- QQ Webhook 只接受 Ed25519 签名与 ±300 秒时间戳；非命令/未知事件也返回确认体，避免平台重推；重复事件由 `bot_events` 去重。
- `/ask` 不向 Bot 用户暴露 OpenCode 工具执行能力（deny-all）；未启用、超限或越权均只返回提示文本，不执行业务。
- 静默时段只延后通知，不丢弃；通知仍按告警事件去重。
- 发布双确认：会话 + CSRF + TOTP + `PUBLISH` 文本，降低误发/会话劫持外发风险。
- `smoke.ps1` 的 Access service token 仅从命令行读取，不写入日志/仓库；建议专用 token、最小范围与定期轮换。

### Docs

- 同步 README/AGENTS/CHANGELOG/PLAN/ROADMAP/API/UI-SPEC/ARCHITECTURE/SECURITY/DEPLOY/ACCEPTANCE/`docs/BOT.md` 与 `deploy/env.example`：QQ 配置、AI 边界、metrics/quiet/confirm、schema v8、迁移 8、fail2ban drop-in、smoke Access token、v0.5.1 测试基线与待部署状态。
- ACCEPTANCE 新增 v0.5.1 当前章节；生产部署/QQ 真实回调/AI 真实模型/Cloudflare Access 标为待验收，不提前声明通过。

### Known limitations（v0.5.1 明确不做）

- QQ 官方 Bot 仅文本、不支持媒体；企业微信/钉钉/飞书未实现；多管理员审批流未实现。
- QQ 真实回调需用户在 QQ 开放平台后台配置；AI 真实模型回复需部署后在 OpenCode 侧验证；两者当前只有进程内测试。
- Cloudflare Access 策略、bypass 与 service token 仍需用户后台配置；应用侧无法自证边缘策略。
- `fail2ban` drop-in 已在生产安装并实测 nftables restart 后封禁恢复，但完整安全验收仍待 Cloudflare Access 等项完成。
- Bot 单次发布最多 1 个媒体文件（QQ 为 0）；命令严格只读；无平台主动拉取/长连接。
- `typescript-eslint` 仍不支持 TS7 API，双 alias 保留到其支持 TS7.1。

## [0.5.0] - 2026-10-21

### Added

- **Bot 平台（Telegram / Discord / Slack）**：新增 `server/src/bot/`（适配器、`crypto.ts`、`service.ts`、`templates.ts`）与 `server/src/http/routes/bots.ts`、`bot-webhook.ts`。
  - 公开入口 `POST /api/bot/webhook/:botId`（raw body，独立限流）：Telegram `X-Telegram-Bot-Api-Secret-Token`、Discord Ed25519 + 300s 时间戳、Slack HMAC-SHA256 + 300s 时间戳；按 `(bot_id, platform_event_id)` 去重。
  - 管理 API `/api/bots*`：状态、Bot CRUD/启停/测试、目标 CRUD、投递列表/重投、发布列表/创建/取消；Token 与签名密钥只写不读。
  - 只读命令 `/help`、`/status`、`/backup`、`/world`、`/mc`、`/files <关键词>`；必须同时命中目标 `allow_commands` 与显式 user 白名单（`kind='user'` 且 `allow_commands=1`）。
  - 告警通知：告警事件写入后按目标 `allow_notifications` 入队（`dedupe_key=alert:<event>:<bot>:<target>`）。
  - 发布：文本 + 最多 1 个云端普通文件媒体（默认 ≤10 MiB），目标限频道/群组；支持定时（≤30 天）、取消、指数退避重试、死信重投。
  - 前端 `/bots` 页：概览、配置、目标、投递与发布四个分区；未启用时展示服务端配置指引且不请求列表。
- **schema v7**：迁移 7 新增 `bots`、`bot_targets`、`bot_deliveries`、`bot_publish_jobs`、`bot_events`；迁移 6（孤儿 shares 数据修复）保持原样。
- **Bot 凭据加密**：AES-256-GCM（12 字节 IV、32 字节 `BOT_SECRET_KEY`），只存 `secret_ciphertext/secret_iv/secret_tag/key_version`；解密失败只返回 `BotSecretError`，不含明文/密钥。
- **env**：`BOT_ENABLED`（默认 `false`）、`BOT_SECRET_KEY`、`BOT_WEBHOOK_MAX_BODY_BYTES`、`BOT_DELIVERY_INTERVAL_SECONDS`、`BOT_DELIVERY_MAX_ATTEMPTS`、`BOT_EVENT_RETENTION_DAYS`、`BOT_COMMAND_RATE_PER_MINUTE`、`BOT_PUBLISH_MAX_MEDIA_BYTES`、`BOT_PUBLISH_MAX_SCHEDULED_DAYS`、`BOT_MAX_BOTS`；`/api/version` 增加 `botsEnabled`/`botPlatforms`。
- **运维可见性**：`/healthz` 增加 `schemaVersion`；`smoke.ps1` 支持 `-ExpectedSchemaVersion`（v0.5.0 用 7）并校验版本+迁移。
- **测试**：新增 `bot-core`、`bot-routes`、`bot-migration`、`bot-webhook-route` 与前端 `Bots.test.tsx`；基线 `npm test` 245（服务端 229 + 脚本 16）、`npm run test:web` 137。

### Changed

- **Bot 默认关闭**：`BOT_ENABLED=false` 或缺少 `BOT_SECRET_KEY` 时不启动投递/发布队列，Webhook 返回 404、管理写接口返回 503，不影响应用主功能。
- **`bootstrap-env.sh`**：新增 Bot 键；`BOT_SECRET_KEY` 只在缺失时生成（32 字节 base64），`--force` 复用旧值并校验长度，避免轮换导致已存 Token 不可解密。
- **`deploy.ps1`**：发布前要求工作树干净（`-AllowDirty` 显式放行）；自动回滚同时从上一 release 读取并还原 `APP_VERSION`（读不到则拒绝自动回滚，避免旧版本以新版本号通过 `/healthz`）；部署后 smoke 失败默认中止（`-AllowSmokeFailure` 仅告警）。
- **`check-version.mjs`**：纳入 `deploy/env.example` 的 `APP_VERSION`、`docs/DEPLOY.md` 标题与 `package-lock.json` 根版本。
- **告警**：`AlertService` 在事件落库后触发 Bot 通知，通知失败不影响告警主流程。
- **认证**：新增 `AuthService.confirmTotp`（只验 TOTP，复用再认证/TOTP 限流与审计，`reauth_bot_publish`），用于发布再认证。
- **分享**：解锁增加全局 100 次/15 分钟桶，避免单 IP 轮换 token 放大 scrypt 开销。
- **世界备份**：`backup-world.mjs` 增加 SIGTERM/SIGINT 处理，信号到达时优先 `save-on`，减少长期 `save-off` 风险。
- **Pi 定时任务统一到正午 12:00**：`antifieldcloud-world.timer` 从「周日 04:00」改为「**周日 12:00 Asia/Shanghai**」（显式时区，`Persistent=true` 保留）；健康探针仍 60s；系统维护 timer（apt/logrotate/fstrim 等）保持发行版默认。用户 2026-10-21 确认。

### Fixed

- **BOT-02（P1）**：发布曾只依赖会话 + CSRF，登录会话即可把云端文件外发到第三方平台；v0.5.0 修复为必须 `totpCode` + `auth.confirmTotp`，缺码返回 400 `totp_required`，失败计入 TOTP/再认证限流与审计。验证：`server/test/bot-routes.test.ts`（无 TOTP 400、有效 TOTP 才建任务）、`server/test/bot-core.test.ts`。
- **BOT-04（P1）**：通知/命令回复可能拼接内部路径、SSH/HTTP URL；v0.5.0 修复为 `sanitizeExternalText`（路径/URL 替换为 `[path]`/`[url]`，去控制字符，≤1500 字符）。验证：`server/test/bot-core.test.ts`（通知/命令文本）。
- **BOT-01/03/05/06（P2）**：命令仅校验目标、缺少显式用户白名单；Webhook 无时间戳/去重；Bot 关闭时入口语义不一致；Token 可能进入 API/日志。v0.5.0 修复为双白名单、300s 时间戳 + `bot_events` 去重、`BOT_ENABLED=false` 一律 404、AES-256-GCM + 只写字段 + 日志/响应脱敏。验证：`node --test server/test/bot-core.test.ts server/test/bot-webhook-route.test.ts`、`node --test server/test/bot-migration.test.ts`。
- **OPS4-03（P2）**：自动回滚未还原 `APP_VERSION`，旧 release 可能以新版本号通过健康检查；v0.5.0 修复（见 Changed）。
- **OPS4-04（P2）**：脏工作树可被当作旧版本发布；v0.5.0 修复为默认拒绝（`-AllowDirty` 显式放行）。
- **OPS4-10（P3）**：`package-lock.json` 根版本未纳入版本一致性检查；v0.5.0 修复。
- 其它 P3：`docs/AUDIT.md` 标题/索引只覆盖前两轮、`docs/PLAN.md` 验收摘要停留在 0.4.0、`API.md` `/healthz` 示例 0.3.2、`README`/`AGENTS` 测试基线 234/129、`deploy/env.example` 版本、`UI-SPEC` 标题等文档漂移，本轮一并修正。

### Security

- Bot 凭据 AES-256-GCM 加密、API 只写不读；错误/日志/审计不含 Token、签名密钥或 `BOT_SECRET_KEY`。
- Webhook 签名 + 时间戳 + 事件去重；IP 120 次/分钟（Webhook scope）、Bot 300 次/分钟、命令每用户 20 次/分钟、发布/测试各 20 次/小时。
- 命令输出与通知文本清洗内部路径/URL；`/files` 只返回文件名/大小（≤10 条），不返回内容。
- 发布仅允许频道/群组、单媒体、普通文件（`origin='user'` 且未删除）、媒体大小上限；Slack `response_url` 只允许 `https://hooks.slack.com/`，平台请求禁止重定向、响应体 ≤1 MiB。
- SSH 改为仅公钥：`/etc/ssh/sshd_config.d/00-` drop-in 禁用密码/键盘交互，旧配置保留 24h 回滚窗口。
- `fail2ban` 启用 `sshd` jail（nftables 后端，24h ban）；nftables 重载后需重启 fail2ban 恢复已有封禁。Cloudflare Access：文档补充 `app` 策略与 `/api/bot/webhook/*`、`/healthz`、`/s/*`、`/api/public/shares/*` bypass；需用户在后台配置。

### Docs

- 同步 README/AGENTS/CHANGELOG/PLAN/ROADMAP/API/UI-SPEC/ARCHITECTURE/SECURITY/DEPLOY/BACKUP/ACCEPTANCE/AUDIT/`docs/BOT.md` 与 `deploy/env.example`：schema v7、Bot API/命令/通知/发布、BOT_* 环境变量、Cloudflare Access、SSH 仅公钥与 24h 回滚、fail2ban sshd jail、v0.5.0 部署/回滚顺序与清理清单。
- 新增 `docs/AUDIT.md` 第四轮（v0.4.2 基线 P0=0/P1=0/P2=3/P3=12；Bot WIP P1=2/P2=4）与 `docs/ACCEPTANCE.md` v0.5.0 占位（部署/测试证据待部署后补）。

### Known limitations（v0.5.0 明确不修）

- Bot 单次发布最多 1 个媒体文件；不支持平台主动拉取/长连接；命令严格只读；无多管理员审批流。
- Bot 适配器/队列测试为进程内 mock（T/S mock-only），未做真实 Telegram/Discord/Slack 网络与限流负路径验收。
- Cloudflare Access 策略与 bypass 必须由用户在后台配置，应用侧无法自证；未配置时 Webhook/health/公开分享可能被边缘拦截。
- `fail2ban` 已启用但封禁依赖 nftables set；`nft -f`/重启 nftables 后需重启 fail2ban 恢复已有封禁。SSH 仍为 24h 回滚观察窗口，`antifield` 的 `NOPASSWD ALL` sudo 未改。
- `typescript-eslint` 尚不支持 TS7 API，`@typescript/typescript6` alias 继续保留。

## [0.4.2] - 2026-10-20

### Changed

- **TypeScript 7 迁移**：采用官方并排方案——`@typescript/native` 别名安装 TypeScript 7.0.2 提供 `tsc`，`typescript` 别名指向 `@typescript/typescript6@6.0.2` 供 typescript-eslint 使用（8.71.2 尚不支持 TS7 API）；`typecheck`/`lint`/`test`/`build`/`npm ci` 全部通过。
- **Android 指标趋势布局**：周期范围按钮不再被 flex 压缩、标签不换行；趋势卡头部在 ≤900px 纵向排列，范围选择器横向滚动（隐藏滚动条），修复窄屏文字标签被挤压。
- **工作区清理与文档对齐**：删除生成的 `web/coverage`、`web/node_modules` 缓存与 `.vite-temp`；重新生成 `web/dist`；README/AGENTS/PLAN/ROADMAP/UI-SPEC/API/DEPLOY/BACKUP 版本与测试基线同步；CI 增加 `check-version` 校验。

### Dependencies

- `typescript` 6.0.3 → **7.0.2**（经 `@typescript/native` 别名）；保留 `@typescript/typescript6@6.0.2` 仅供 lint 工具链使用。

## [0.4.1] - 2026-10-20

### Changed

- **OpenCode 升级**：生产从 v2.0.32 升级到 **v2.1.1**（`opencode upgrade --method curl`）；升级前把二进制、配置、数据备份到 `/var/backups/opencode/`（93 MB 二进制 + 2 MB 数据快照 + env/service 副本）。
- **兼容性复核**：Basic `/api/session`、`POST /api/session`（垫片新建会话路径）、`/api/config|agent|provider`、真实 HTML 垫片注入（`data-cfasync` + `__af/oc-help.js`）、公开 `ai.*` 401、app healthz 均正常；Web 包仍含“新建会话/New session”标记，垫片选择器继续匹配。
- **凭据卫生**：轮换 OpenCode Basic 密码，同步 `/etc/opencode/opencode.env`、`/etc/antifieldcloud/env` 与两个 `service.json`；重启 opencode/antifieldcloud 后 Basic 与代理验证通过。
- **运维清理**：删除 Pi 旧世界归档 `/home/antifield/minecraft-backups`（3×约 3 GiB，释放约 9 GiB）；新世界备份与 PC 副本保留，旧 cron 保持停用。

### Dependencies

- 合并 Dependabot：`actions/checkout` 4→7、`actions/setup-node` 4→7、`gitleaks/gitleaks-action` 2→3（CI 全绿）。

### Docs

- `docs/DEPLOY.md` 增加 OpenCode v2.1.1 升级/兼容检查/回滚；`docs/ACCEPTANCE.md` 增加 v0.4.1；`docs/SECURITY.md` 更新 OpenCode 版本行为与凭据轮换说明；版本号升至 v0.4.1。

## [0.4.0] - 2026-10-20

### Added

- **可观测性**：主机指标每 60s 采样、保留 30 天（`metrics_samples`）；`GET /api/metrics?range=1h|6h|24h|7d|30d` 按桶聚合（CPU/内存/温度取平均、磁盘剩余取最小值、load1 取平均，最多 240 点）；Dashboard 四张 SVG 趋势卡；Activity 关键词 + 时间范围筛选；AlertsCard 状态/事件筛选与分页；`/api/storage` 轻量配额端点。
- **笔记附件**：每请求 1–5 个、单文件 ≤25 MiB、每笔记 ≤100 个；附件计入总配额但以 `origin='note'` 隔离，不出现在普通文件列表/搜索/回收站；`GET/POST/DELETE /api/notes/:id/attachments`，删除笔记级联硬删附件。
- **笔记版本历史**：标题/正文/标签变化时自动快照，每笔记保留最近 20 个版本；列表/详情/恢复接口，恢复前自动保存当前版本，跨笔记版本 404。
- **多文件分享**：`POST /api/shares {fileIds}` 一次分享 1–50 个活动普通文件；`ShareItem/PublicShareInfo` 增加 `itemCount/totalSizeBytes`；公开页返回 `items` 并支持逐文件 `/api/public/shares/:token/items/:itemId/content`；多文件分享的旧 `/content` 返回 409 `share_bundle`；下载次数按分享会话计；任一文件删除/回收站吊销整个分享。
- **Minecraft 世界一致性备份**：`scripts/backup-world.mjs`（root）按 `save-off → save-all flush → tar → save-on`（finally）生成 gzip 归档，校验 gzip/SHA-256，写状态 JSON，保留最新 4 份且不触碰旧 legacy 归档；`deploy/antifieldcloud-world.service/.timer`（周日 04:00、Persistent、flock、4h 超时、systemd 加固）。
- **世界备份拉取**：`scripts/world-pull.ps1` 两阶段拉取（scp `.part` → SHA 比对 → 原子改名 → 远端 ack 删除 → 本地保留 4 份）；失败保留远端不 ack；UTF-8、硬超时与杀进程树。
- **恢复演练自动化**：`scripts/drill.ps1` + `drill-verify.mjs` 校验 full+inc 链、`.sha256` 旁文件、tar 条目安全、最新 DB `integrity_check/foreign_key_check/schema_version`、manifest；输出 `report.json/report.md`、保留 180 天；可选 `-IncludeWorld` 解包验证 `world/level.dat` 并回写 `drill-status.json`。
- **灾备状态与告警**：`/var/lib/antifieldcloud/{world-backup,world-pull,drill}-status.json`（0644，应用只读）；Dashboard/Settings 与 `/api/dashboard`、`/api/backups` 展示；新增 `world_backup_stale`、`world_pull_stale`、`drill_stale` 告警。
- **部署**：APP_VERSION 从 release `package.json` 注入并校验 `/healthz.version`；部署后运行只读 smoke 子集；磁盘/tar SHA/npm 预检；备份拉取状态写失败不触发重复归档；PS 5.1 UTF-8 输出编码修复。
- **env**：`BACKUP_PREPARE_TIMEOUT_SEC`、`WORLD_BACKUP_STATUS_FILE`、`WORLD_PULL_STATUS_FILE`、`DRILL_STATUS_FILE`、`ALERT_WORLD_BACKUP_MAX_AGE_HOURS`、`ALERT_DRILL_MAX_AGE_DAYS`、`NOTE_ATTACHMENT_MAX_BYTES`、`NOTE_MAX_ATTACHMENTS`、`NOTE_VERSIONS_KEEP`、`SHARE_MAX_ITEMS`、`METRICS_ENABLED`、`METRICS_SAMPLE_SECONDS`、`METRICS_RETENTION_DAYS`；`APP_VERSION` 默认读 `package.json`。
- **CI/测试**：新增 coverage（服务端/前端覆盖率门禁，阈值不变）、audit（生产依赖）、secret-scan（gitleaks）、Dependabot；
  CI 增加 concurrency/timeout；PowerShell job 覆盖全部 `scripts/*.ps1`（UTF-8 BOM + PS 5.1 解析）；`scripts/test/` 运维脚本单元测试纳入 `npm test`；
  新增 `npm run test:coverage`、`npm run test:web:coverage`、`node scripts/check-version.mjs`。最终基线：`npm test` 234 项（服务端 218 + 脚本 16）、前端 129 项。

### Changed

- **数据库 schema v6**：迁移 5 为结构变更（`files.origin`、唯一索引含 origin、`note_attachments`、`note_versions`、`share_items` 回填、`metrics_samples`）；迁移 6 为数据修复（删除指向不存在文件的孤儿 shares、`INSERT OR IGNORE` 回填 `share_items`，不改变表结构）；数据库 schema 高于程序支持版本时拒绝启动。
- 文件/分享/恢复路径统一按 `files.origin` 隔离：普通云盘只操作 `origin='user'`，笔记附件仅经笔记接口管理；配额仍统计全部 `kind='file'`。
- 备份 CLI：`--pending` 只统计 `origin='pi'` 的归档；新增 `warnings/skippedMissing/missingFiles/missingFileCount/partials` 输出；manifest 增加 `skippedMissing/warnings`；
  `--prepare` 超时对齐 3300s（env `BACKUP_PREPARE_TIMEOUT_SEC`，60–7200 秒）；`--ack` 在同一事务内提交归档行、游标、`meta.backup_missing_files` 与审计；
  物理文件缺失记录到 `skippedMissing`/meta，恢复后强制纳入下一次增量；陈旧锁（>1h）可接管并 warn；归档先写 `.part` 后原子改名；恢复链按来源（Pi/导入）隔离；
  归档快照行数/staging 字节上限；归档内容浏览按 IP 限流（30 次/分钟）。
- 密钥包：明文临时目录优先 `/run/antifieldcloud/secrets-tmp`（tmpfs，退出清理）；opencode 快照失败降级为 warning 并继续打包其它密钥文件；Pi 端 `KEEP=2` 滚动保留，PC 拉取后不再立即删除远端。
- 旧世界备份 cron 在验收后停用（`crontab` 移除 `minecraft-backups` 行）；旧 9 GiB 归档不自动删除，`docs/DEPLOY.md`/`docs/BACKUP.md` 给出手动清理命令。
- 部署回滚顺序改为 stop → 还原迁移前 DB 快照 → 切换 release → start → 健康检查；无迁移前快照时拒绝自动回滚并打印手工步骤。
- 登录/TOTP 全局限流调整（全局 60 次/小时、TOTP 全局 120 次/小时，loopback 不占全局桶）；未认证用户名超长直接拒绝；审计 actor/target/detail 截断。
- opencode 代理对 HTTP 与 WebSocket 均校验 `Origin`（仅 app/ai 正式 origin，loopback 开发例外），拒绝时 403 + `opencode_origin_rejected` 审计。
- 分享下载计数改为内容流完整读完后 +1（客户端中断不计次）；多文件分享只暴露首文件名用于审计。

### Fixed

- 孤儿分享行会导致迁移 5 回填失败：迁移前清理 + 迁移 6 数据修复；迁移前执行 `PRAGMA foreign_key_check`，其它外键损坏拒绝启动（避免迁移中写入更混乱数据）。
- 笔记附件上传失败回滚、删除笔记后附件清理、无关联附件孤儿维护对账；列表接口批量读取附件避免 N+1。
- 备份生成超时/失败后清理本次锁与 `.part` 残片；物理文件缺失时跳过并记录 `skippedMissing`，避免每日备份永久失败。
- opencode 代理未登录 HTML/WS 与 Origin 拒绝路径的安全头/审计一致性；回收站/目录删除吊销包含该文件的多文件分享。
- 前端：笔记附件与版本抽屉、多文件选择与分享、公开页文件清单、Dashboard 趋势/备份状态卡、告警筛选分页、Activity 筛选、上传“放弃并清理”（显式 DELETE 分片会话）等交互修复。
- Windows 脚本：ACL 逐项校验、icacls 退出码检查、安装标记、任务参数回读校验、状态写入幂等、`Start-Process` 硬超时杀进程树。

### Security

- `antifieldcloud.service` 加固：`CapabilityBoundingSet=`（空）、`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`、`PrivateDevices`、`ProtectClock/Hostname/KernelLogs`、`RestrictNamespaces/SUIDSGID/Realtime`、`LockPersonality`、`StartLimitIntervalSec/Burst`；世界备份 unit 同样加固并限制可写路径。
- nftables：默认拒绝入站；22 仅允许 `169.254.77.0/24` + `172.23.88.0/21` 且新建连接限速 5/min；25565 仅同网段；25575 仅 loopback；DHCP 仅 `eth0`/`wlan0`；80 不再放行。
- 世界备份脚本 root-only、RCON 仅执行固定 `save-off/save-all flush/save-on`；应用 API 仍不提供任意 RCON。
- 笔记附件 origin 隔离、多文件分享条目归属校验（跨分享 itemId 404）、公开逐项下载计数与会话绑定；metrics 端点需登录；备份归档浏览限流、tar/staging 上限；审计字段截断。
- 残留风险明确披露：SSH 密码登录与 `antifield` 用户 `NOPASSWD ALL` sudo 未改（用户选择）、RCON 监听 0.0.0.0、单 SD、Cloudflare 明文、限流内存态等（见 `docs/SECURITY.md`）。

### Docs

- 同步 README/AGENTS/ARCHITECTURE/SECURITY/DEPLOY/BACKUP/ROADMAP/PLAN/UI-SPEC；修正测试数字、服务监控 3 项、nftables 网段、隧道名 `pi`、备份保留语义（30 天/56 天/90 天）、分享密码规则（≥8）、上传总进度等文档漂移（审计 OP-19/WE-24）。
- 新增世界备份/PC 拉取/恢复演练安装与回滚、nftables/systemd 加固应用与回滚、v0.4.0 部署步骤、迁移前快照/回滚与常见问题；更新备份覆盖范围与旧 cron/旧归档迁移说明。

### Known limitations（v0.4.0 明确不修）

- DR-1：增量依赖 `created_at` 水位，系统时钟回拨或同毫秒写入仍可能漏备；prepare 写 warnings，依赖 NTP + 每周全量兜底。
- DR-7：Web 导入归档（`origin='import'`）无删除/保留策略，会持续占用磁盘，需人工核对清理。
- DR-22：告警只在状态变化时投递，持续故障跨周期不重复提醒。
- DR-23：`.backup.lock` 无心跳续租，超过 1 小时按陈旧锁接管，长任务与并发运行可能竞争。
- 其余残留（SSH/sudo、RCON 监听、单 SD、Cloudflare 明文、限流内存态等）见 `docs/SECURITY.md` §4。

## [0.3.2] - 2026-10-20

### Changed

- 移除旧入口：`nginx`/`nginx-common`/`certbot`/`python3-certbot*` 及 `/etc/nginx`、`/etc/letsencrypt`、`/var/www/html`、nginx 日志/状态；80 端口关闭。
- 服务监控与告警从 4 项降为 `minecraft/cloudflared/opencode`；前端服务状态卡同步为 3 项，避免误报 nginx 离线。
- nftables 移除 80 端口放行，仅保留 Minecraft 25565（直连/校园网段）。
- 清理 workbench/piforge 残留、旧 `antifieldcloud.service.pre-*`、`cloudflared-update.*`、旧 env/RCON 备份；`.local` 冗余记录清理。

### Docs

- 更新 DEPLOY/API/UI/ARCH/SECURITY/ACCEPTANCE/AGENTS；补充旧入口与残留清理记录。

## [0.3.1] - 2026-10-20

### Added

- 大文件分片上传：单文件 5 GiB、8 MiB/块、断点续传、配额预留、24h 会话过期、每用户 3 并发；不做对象存储。
- `POST /api/uploads`、`PUT /api/uploads/:id/chunks/:idx`、`GET`、`complete`、`abort`；migration 4（`upload_sessions` / `upload_chunks`）。
- 前端大文件自动分片：>100 MiB 走分片，并发 2 块，localStorage 只保存 uploadId/已收块号；刷新/断线自动补缺块；取消后重试可续传。
- 审计/运维：persistent journald（log2ram 64 MiB 上限）、cloudflared 2026.10.1 + systemd 加固、nftables WiFi 源收窄到 `/21`、rpcbind 禁用、unattended-upgrades dry-run 验证。

### Docs

- 补档第二轮审计记录 `docs/AUDIT.md`（A2-01～A2-10、执行边界、回归证据与残留）；工作区临时测试产物清理。

## [0.3.0] - 2026-10-20

### Added

- 备份管理：列表、手动生成 pending、归档导入/校验、文件级恢复到新目录（TOTP + typed confirmation）；整库恢复仅离线 CLI。
- 备份覆盖：opencode DB/config 纳入 age 加密密钥包；文件备份 + 密钥包状态分离。
- 音视频播放：mp4/webm/mp3/m4a/ogg/flac/wav 原生 Range 播放，不转码；mkv/avi 回退下载。
- OpenCode `OPENCODE_HTML_MODE=shim|attributes|passthrough`，支持关闭 Cloudflare 注入后的无垫片验证。
- migration 3：`backup_archives` 扩展 + `restore_plans`；`/api/backups`、`/api/restores` 路由。

### Fixed

- 备份任务 SSH/SCP 硬超时；secrets 拉取独立状态（`secretsOk/lastSecretsError`），不再“文件成功即全部成功”。
- 回收站文件旧分享返回 410；分享下载审计节流；密码≥8；公开备注移除；token 日志脱敏；过期/吊销 GC。
- 告警 unknown 降级与恢复、事件+状态事务化、90 天保留；备份密钥包告警。
- legacy 无参备份改为显式 `--legacy`；孤儿归档可观测并计入空间预算；sidecar 清理。
- 前端分享备注/一次性 URL/PWA 缓存/审计映射；媒体与备份向导测试。
- OpenCode 无垫片尝试：Cloudflare 关闭 `ai` 的 Rocket Loader 后，passthrough HTML 的模块脚本未被改写；但无 JS 的 attributes/passthrough 仍无法触发原生新建会话（上游按钮缺陷），按约定保留最小隐藏 click 接管，无可见按钮。
- 文档与 API/UI/ARCH/SECURITY/DEPLOY/BACKUP 同步。

## [0.2.2] - 2026-10-19

### Fixed

- **移除 v0.2.1 添加的可见“＋ 新会话”浮动按钮**；兼容垫片不再注入任何 UI。
- OpenCode Web：在捕获阶段接管 opencode **原生**“新建会话”按钮（click + pointerup），
  修复 Android/宽屏移动浏览器中原生按钮点击无响应；仍调用 opencode `POST /api/session`，不改服务/数据。
- 继续为 opencode 脚本加 `data-cfasync="false"`，避免 Cloudflare Rocket Loader 改写模块脚本导致
  智能体/模型选择器不渲染。
- 文件页列表名称列点击进入文件夹/预览文件的修复保留。

## [0.2.1] - 2026-10-19

### Fixed

- 文件页列表视图的名称列现在可点击进入文件夹/预览文件（名称列改为可访问按钮，保留网格视图）。
- OpenCode Web 兼容垫片：
  - 移动端（含 Android 浏览器）常驻“＋ 新会话”按钮，调用 opencode `POST /api/session` 并跳转标准 session 路由。
  - 接管桌面端“新建会话”按钮，修复点击无响应。
  - 垫片以同源外部脚本 `/__af/oc-help.js` 注入，兼容 opencode CSP `script-src 'self'`，不修改 opencode 数据。
  - OpenCode 原生页面仍由代理透传；仅对已认证 HTML 导航注入。

## [0.2.0] - 2026-10-19

### Added

- 知识库：Markdown 笔记/书签、标签、置顶、分页与 FTS5 搜索（中文回退 LIKE）；独立审计。
- 文件分享：单文件公开链接，可选密码、过期时间（默认 168h/最长 720h）、最大下载次数、吊销；
  token 只存 SHA-256、密码 scrypt、公开页 noindex、独立限流与审计、Range/HEAD/ETag。
- PWA：manifest、Service Worker（只缓存静态壳/资源）、offline.html、本地图标、安装提示、手机拍照上传；
  CSP 增加 `manifest-src`/`worker-src`。
- 监控告警：磁盘/温度/内存/服务/备份超期/待拉取备份/MC/欠压条件；通用 JSON webhook
  （10s×3 重试、可选 HMAC）；去重/冷却/恢复通知；面板告警历史与测试按钮；root 健康探针 units。
- 备份：两阶段协议（`--prepare/--pending/--ack/--snapshot-db`），PC 确认后才推进游标；
  未 ack 归档不删除，acked 最多 2；`.part`→SHA→原子改名→`.sha256` 旁文件；Sunday 漏跑补全量；
  备份任务显式 `-PiHost/-BackupRoot`，ACL 收紧，电池供电也运行，日志轮转。
- 灾备：age 加密 env/cloudflared/MC/opencode 凭证包；恢复文档、真实命令与演练记录模板。
- 部署：迁移前 DB 快照；健康检查失败自动回滚；retention 保护 current/previous；发布包包含 LICENSE。
- CI：前端 Vitest、生产依赖边界、shellcheck、nftables 语法、Windows PowerShell 解析/BOM 检查。

### Fixed / Security（v0.1.0 审计）

- **C1**：未认证 WebSocket upgrade 携带畸形 Cookie 不再导致进程退出；upgrade 全 try/catch +
  `uncaughtException` 兜底；新增回归测试。
- **H1**：改密/恢复码要求 TOTP，增加 IP/全局/TOTP 限流、失败审计、恒定延迟；会话 CSRF Cookie
  丢失时自动补发。
- trustProxy 收紧：仅 loopback 对端才采信 Cloudflare 转发头；X-Forwarded-Host 不参与安全判断。
- RCON 多包响应拼接（>4096B）、1 MiB 上限、超时/关闭不挂起；白名单复核保留。
- 上传全局预留 + statfs 余量 + ENOSPC→507；启动清理 24h tmp；错误映射不回显内部 message/路径。
- HSTS、AI 302/401/502 安全头、inline PDF XFO/CSP；登录限流 Map 容量上限。
- 审计动作名与服务端对齐，Activity 服务端 action 筛选；Files/Trash 请求竞态修复；改密 12 位；
  Markdown DOMPurify 禁 style；上传取消/超时；恢复码弹窗关闭保护；429 `details.retryAfterSec`；
  a11y 焦点/键盘/aria；Minecraft 强制刷新；回收站天数/域名/上传上限由服务端下发。
- 单文件上限按 Cloudflare Free/Pro 调整为 100 MiB。
- 备份软删除文件同步吊销分享；公开分享 metadata 对齐前端契约（active/requiresPassword）。
- RCON 密码已轮换（32 位随机）；Pi 已启用 memory cgroup（`MemoryMax=512M` 实际生效）。

### Operations

- Pi：Debian 安全更新、`age`、`unattended-upgrades`；health probe timer；memory cgroup；
  RCON 密码轮换；一次重启完成 MC 重启与验证。
- Windows：备份任务重装为两阶段脚本，ACL 仅当前用户 + Administrators + SYSTEM；D 盘实际路径见本地
  `.local/DEPLOYMENT.md`（不提交）。
- 公开仓库继续脱敏；实际域名/IP/备份路径/私钥只在本地。

### Known limitations

- SSH 密码登录保留（用户选择）；无 Cloudflare Access；单 SD 卡；Cloudflare 终止 TLS。
- 分享下载次数为会话级近似限制；清 Cookie 可在 5 分钟会话内绕过一次计数（个人分享可接受）。
- FTS5 unicode61 对中文按整段分词，含中文搜索自动回退 LIKE。
- 笔记无附件/版本历史；分享不支持目录；无音视频/WebDAV/多用户。
- Cloudflare 边缘约 100 MiB 请求体与 100s 超时；大文件后续需分片/对象存储。
- `http-proxy` 在 Node 26 有 `util._extend` 弃用警告，Node 27 前需评估替换。
- scrypt 仍为 N=2^15（升级需密码哈希版本迁移）。

## [0.1.0] - 2026-10-19

### Added

- 统一登录：密码（scrypt）+ TOTP 两步验证、恢复码、限流、CSRF、会话管理、审计日志。
- 云盘：目录树、拖拽/多文件上传与进度、10 GiB 配额、文件名搜索、图片/文本/Markdown/PDF 预览、
  Range 下载、回收站（30 天自动清理）、SHA-256 元数据。
- 工作台门户：主机指标（CPU/内存/温度/磁盘）、存储用量、Minecraft 状态/玩家/TPS/白名单数、
  opencode 健康、服务状态、备份状态、最近活动。
- Minecraft：SLP + RCON 只读状态；白名单增删（校验、执行后复核、审计）；不提供启停/任意命令。
- `ai.example.com`：会话校验 + Basic 注入的 opencode 反向代理（SSE/WebSocket）。
- 部署：Cloudflare Tunnel（app/ai）、systemd 服务、nftables 默认拒绝入站、release 目录与回滚脚本。
- 前端入口脚本加入 `data-cfasync="false"`，避免 Cloudflare Rocket Loader 改写 `type="module"`。
- 备份：Pi 端一致性 SQLite 快照 + 全量/增量归档 + SHA-256；Windows 计划任务每日 12:00 拉取到
  `%USERPROFILE%\AntifieldCloudBackups`；恢复文档与演练步骤。
- 工程：AGENTS.md、架构/安全/部署/备份/API/UI 文档、`node --test` 测试、ESLint/tsc、CI。

### Security

- 应用仅监听 loopback；RCON 仅 loopback；25565/80 限直连/校园网段。
- 文件内容不可变；预览类型白名单；SVG/HTML/XML 强制下载；CSP/安全响应头。
- opencode 端口不对外；代理覆写客户端 Authorization/Cookie。
- 服务用户 `antifieldcloud` 无 shell/无 sudo；systemd 沙箱。

### License

- MIT（见 `LICENSE`）。
