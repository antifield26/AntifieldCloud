# AntifieldCloud v0.5.x 实施计划（摘要）

本文件是 v0.5.x 的权威范围/决策摘要；v0.4.x 历史见下方补充；完整交付与验收见 `docs/ACCEPTANCE.md`，界面见 `docs/UI-SPEC.md`，契约见 `docs/API.md`。当前版本 **v0.5.2**（schema v9）；生产已部署 v0.5.2/schema v9（release `20261021T114908Z`，commit `abeabc7`）。

## v0.5.2 补充（当前）

- **Bot Chat**：非斜杠普通消息进入 AI Chat；目标级 `allow_chat`（默认 0）与 `allow_commands` 分离；群/频道仅 @Bot 或回复 Bot，私聊全部；Telegram/Slack/QQ Webhook 与 Discord Gateway 支持；非管理员只能 Chat，管理员斜杠命令仍由 `allow_commands` 目标 + user 白名单双校验；Chat 只读，不执行写操作。
- **长期记忆**：每 Bot×用户一份；DB `bot_ai_memories` 摘要为权威 + `summary_session_id`，`DATA_DIR/bot-memory/memory-<uuid>.md` 为镜像（0700/0600）；每轮滚动摘要；摘要失败保留旧摘要；记忆不通过 API/UI 暴露；系统提示内置，`BOT_AI_SYSTEM_PROMPT` 覆盖；摘要不额外占对话轮次或 AI 每小时配额。
- **多附件发布**：最多 5 个、单文件 ≤10 MiB、总 ≤50 MiB；Telegram 图片 media group/混合逐文件、Discord 单次 multipart、Slack 逐文件；QQ 仅文本；部分成功不自动重试（`partial_media_sent`）。
- **只读按钮**：Telegram inline keyboard 与 Discord message components 的 `/status`、`/help` 刷新/帮助按钮；需 `allow_commands` 目标 + user 白名单；无写操作；Slack/QQ 不做按钮。
- **Discord Gateway**：Node 内置 WebSocket 长连接；`intents=37377`（含 `MESSAGE_CONTENT`）；需 Developer Portal 开启 intent；HELLO/IDENTIFY/RESUME、心跳、重连与致命关闭码；`BOT_DISCORD_GATEWAY_ENABLED=false` 默认关闭；`BotSummary.gateway` 暴露状态。
- **管理面**：目标 `allowChat`、最近入站目标 `GET /api/bots/:id/inbound-targets` 与 `/bots` 登记；发布媒体多选；Discord/Telegram/QQ 配置提示。
- **数据**：schema v9（迁移 9：`bot_targets.allow_chat`、`bot_ai_memories`、`bot_inbound_targets`）；迁移 5–8 保留。
- **env**：`BOT_CHAT_RATE_PER_MINUTE=6`、`BOT_AI_MEMORY_MAX_CHARS=4096`、`BOT_AI_SYSTEM_PROMPT=`、`BOT_DISCORD_GATEWAY_ENABLED=false`、`BOT_PUBLISH_MAX_MEDIA_FILES=5`、`BOT_PUBLISH_MAX_MEDIA_TOTAL_BYTES=52428800`；已有 `BOT_AI_RATE_PER_HOUR=10`。
- **状态**：版本 0.5.2；本地测试基线 `npm test` 293（服务端 277 + 运维脚本 16）、`npm run test:web` 140（28 文件），`npm run check` 本地通过；生产已部署 v0.5.2/schema v9，带 Access token 的完整 smoke 24/24；Discord Gateway 真实长连接与各平台 Chat/多附件联调待在生产目标开启 `allow_chat`/Gateway 后执行。

## v0.5.1 补充（历史）

- **QQ 官方 Bot**：新增 `server/src/bot/adapters/qq.ts` 与 `bots.platform='qq'`；op=13 Ed25519 回调地址校验、op=0 事件验签、`{opcode:12}` 确认体；C2C/群@/频道文本命令与通知；仅文本、单条 ≤2000 字符，不支持媒体。
- **OpenCode AI `/ask`**：`server/src/bot/ai.ts` 通过本地 OpenCode API 提供 AI 对话；`BOT_AI_*` 默认关闭、按用户每小时限流、仅命令白名单用户、`bot_ai_sessions` 会话复用、新建会话 deny-all 工具权限；生产已启用 `opencode-go/deepseek-v4.1-flash` 并验证真实回复。
- **Bot 运维**：`GET /api/bots/:id/metrics?hours=24` 24 小时指标卡；目标静默时段 `quietStartMinute`/`quietEndMinute`（0–1439，成对设置、不能相同），通知延后到窗口结束；发布新增 `confirmText:'PUBLISH'` 二次确认，TOTP 仍必填。
- **数据**：schema v8（迁移 8 重建 `bots`/`bot_targets`/`bot_deliveries`/`bot_publish_jobs`/`bot_events` 以扩展 `bots.platform` CHECK 到 `qq`，`bot_targets` 增加静默分钟列，新增 `bot_ai_sessions`）；迁移 6/7 保留。
- **安全收口**：fail2ban dbfile 持久化（`/var/lib/fail2ban/fail2ban.sqlite3`）；`deploy/systemd/nftables.service.d/10-fail2ban-restore.conf` 在 nftables 启动后异步重启 fail2ban 恢复封禁 set；`smoke.ps1` 新增 `-AccessClientId/-AccessClientSecret` Access service token 头，未配置 Access 时仍可跑。
- **工具链评估**：typescript-eslint 8.x 仍不支持 TS7 API，v0.5.1 结论为暂不升级、保留双 alias。
- **状态**：版本 0.5.1；本地测试基线 `npm test` 265（服务端 249 + 运维脚本 16）、`npm run test:web` 139，`npm run check` 本地通过；生产部署、QQ 真实回调、AI 真实模型与 Cloudflare Access（含 service token）均已完成验收。

## v0.5.0 补充（历史）

- **Bot 平台**：Telegram/Discord/Slack 适配器；公开签名 Webhook；管理 API/页面；只读命令；告警通知；TXT + 云端单媒体发布、定时/取消/重试；TOTP 再认证；默认关闭。
- **数据**：schema v7（迁移 7 新增 `bots/bot_targets/bot_deliveries/bot_publish_jobs/bot_events`；迁移 6 孤儿 shares 修复保留）；Bot 凭据 AES-256-GCM（`BOT_SECRET_KEY`）。
- **安全**：Token 只写/加密；日志/响应/审计脱敏；签名 + 时间戳 + 去重；IP/命令/发布限流；通知/命令输出路径清洗；Bot 关闭时 Webhook 404。
- **运维**：v0.5.0 部署顺序（备份/校验 → `bootstrap-env` 生成 key → 迁移 v7 → 默认关闭 → 显式启用）；回滚（迁移前快照 + `APP_VERSION`）；SSH 仅公钥 24h 回滚 + `fail2ban` sshd jail；Cloudflare Access 策略与 bypass；PC 备份任务重装；世界拉取任务复核；数据清理清单。
- **审计**：第四轮（v0.4.2 基线 P0=0/P1=0/P2=3/P3=12；Bot WIP P1=2/P2=4），残余明确。

## v0.4.1 补充

- 维护版：OpenCode 服务端 v2.0.32 → v2.1.1 升级与兼容性复核（Basic/session/垫片/公开入口）；OpenCode Basic 密码轮换并同步 env/service.json。
- 处理 Dependabot PR（actions/checkout 4→7、actions/setup-node 4→7、gitleaks-action 2→3）；关闭不兼容的 TypeScript 7 major。
- 清理 Pi legacy 世界归档（约 9 GiB），旧 cron 保持停用；应用版本 0.4.1，schema 仍为 v6。

## v0.4.2 补充

- 维护版：TypeScript 7.0.2 迁移（官方并排方案：`@typescript/native` 提供 `tsc`，`typescript` 别名到 `@typescript/typescript6` 供 typescript-eslint）。
- 修复 Android 指标趋势周期选择器压缩文字标签；工作区/文档清理，CI 增加 check-version。
- 版本 0.4.2；schema v6 不变。

## 目标

在 v0.5.1 已交付的 Bot 平台（Telegram/Discord/Slack/QQ、`/ask`、指标/静默/发布双确认）基础上，完成 v0.5.2：**普通消息 Chat 与长期记忆、多附件发布、Telegram/Discord 只读按钮、Discord Gateway 长连接，以及目标 `allow_chat`/最近入站目标与 schema v9**；企业微信/钉钉/飞书留到 v0.5.3。

## 范围

### Bot 平台（v0.5.2 增量）

- Chat：普通消息（非斜杠）在目标 `allow_chat=1` 时进入 AI Chat；群/频道仅 @Bot 或回复 Bot，私聊全部；Telegram/Slack/QQ Webhook 与 Discord Gateway（`MESSAGE_CONTENT`）支持；非管理员只能 Chat，管理员斜杠命令仍走双白名单；Chat 每 Bot×用户每分钟 6 次（`BOT_CHAT_RATE_PER_MINUTE`），与 `/ask` 共用每小时 10 次 AI 配额（`BOT_AI_RATE_PER_HOUR`）；不把 Chat 当写操作。
- 记忆：每 Bot×用户一份；每轮对话后摘要；DB `bot_ai_memories` 权威 + `summary_session_id`；镜像 `DATA_DIR/bot-memory/memory-<uuid>.md`（0700/0600、原子写）；摘要失败保留旧摘要；不通过 API/UI 暴露；系统提示内置，`BOT_AI_SYSTEM_PROMPT` 覆盖；摘要不额外占对话轮次或 AI 每小时配额。
- 多附件：最多 5 个、单 10 MiB、总 50 MiB；Telegram 全图片 media group、混合逐文件；Discord 单次 multipart；Slack 逐文件上传后一次完成；QQ 仅文本；partial 不自动重试，任务标记 `failed`/`partial_media_sent`。
- 按钮：Telegram/Discord 的 `/status`、`/help` 刷新/帮助只读按钮；需目标 `allow_commands` + user 白名单；无写操作；Slack/QQ 不做。
- Discord Gateway：Node 内置 WebSocket；`intents=37377`（含 `MESSAGE_CONTENT`）；需 Developer Portal 开启 intent；HELLO/IDENTIFY/RESUME、心跳、RECONNECT/INVALID_SESSION、指数退避与致命关闭码；`BOT_DISCORD_GATEWAY_ENABLED=false` 默认关闭；状态显示。
- 管理面：目标 `allowChat`、最近入站目标（`GET /api/bots/:id/inbound-targets`，需登录；`/bots` 可登记）；发布媒体多选（最多 5）；Discord Gateway 状态与 Telegram/QQ 配置提示。
- 数据：schema v9（迁移 9：`bot_targets.allow_chat` 默认 0、`bot_ai_memories`、`bot_inbound_targets`）；迁移 5–8 保留。
- 保留 v0.5.1 的 QQ 官方 Bot、`/ask` AI、指标、静默时段、发布 TOTP + `PUBLISH`、默认关闭与凭据加密语义。

### Bot 平台（v0.5.1 增量，历史）

- QQ 官方 Bot：AppID 公开配置 + AppSecret（写入 Token 字段，只存密文）；`op=13` 回调地址校验（Ed25519 返回 `plain_token`/`signature`）；`op=0` 事件验签（`X-Signature-Ed25519` + 时间戳 ±300 秒）；`C2C_MESSAGE_CREATE`/`GROUP_AT_MESSAGE_CREATE`/`AT_MESSAGE_CREATE`；被动回复带 `msg_id`/`msg_seq`，主动通知走 `v2/users|groups` 或 `channels`；仅文本。
- AI `/ask`：默认 `BOT_AI_ENABLED=false`；仅已登记目标 + user 白名单；`BOT_AI_RATE_PER_HOUR`（默认 10）按 `botId:userId` 每小时限流；提示词 ≤`BOT_AI_MAX_PROMPT_CHARS`（默认 2000）；`BOT_AI_TIMEOUT_SECONDS`（默认 60）；会话按 `(bot,target,user)` 复用，保留 `BOT_AI_SESSION_RETENTION_DAYS`（默认 7）；新建会话 deny-all 工具；可选 `BOT_AI_PROVIDER`/`BOT_AI_MODEL`（两者同时设置才指定模型）。
- 指标：`GET /api/bots/:id/metrics?hours=24`（1–720 小时），返回投递/发布/事件统计、成功率、最近错误与最近发送；`/bots` 投递与发布分区展示近 24 小时指标卡。
- 静默：`bot_targets.quiet_start_minute`/`quiet_end_minute`（Asia/Shanghai 本地分钟 0–1439，成对设置、不能相同）；静默窗口内告警通知延后到结束，跨午夜按 `start > end` 处理。
- 发布确认：`POST /api/bots/:id/publish` 必须同时带 `totpCode` 与 `confirmText:'PUBLISH'`；缺失确认文本返回 400 `publish_confirm_required`。
- 保留 v0.5.0 的 Telegram/Discord/Slack 适配器、只读命令、通知、单媒体发布、TOTP、默认关闭与凭据加密语义。

### 可观测性与备份可视化

- 主机指标 60s 采样、30 天保留；范围查询 1h/6h/24h/7d/30d，桶聚合最多 240 点。
- Dashboard 四张 SVG 趋势卡；Activity 关键词/时间范围筛选；AlertsCard 状态/事件筛选与分页；轻量 `/api/storage`。
- 备份健康卡：应用归档链（待拉取/已确认/孤儿）、密钥包、世界备份、PC 拉取、恢复演练；Dashboard 与 Settings 共用只读状态。

### 知识库

- 笔记附件：每请求 1–5 个、单文件 25 MiB、每笔记 100 个，计入配额并以 `origin='note'` 与普通云盘隔离。
- 版本历史：标题/正文/标签变化自动快照，保留 20 个；查看/恢复；删除笔记级联删除版本与附件。

### 文件分享

- 多文件分享：一次 1–50 个活动普通文件，逐文件下载（不生成 zip）；`itemCount/totalSizeBytes`；旧单文件入口保持兼容。
- 次数按分享会话计；任一文件删除/回收站吊销整个分享；公开页解锁后展示文件清单。

### Minecraft 世界备份与灾备

- `scripts/backup-world.mjs` + `antifieldcloud-world.service/.timer`：周日 12:00 一致性 gzip 归档，保留 4 份，gzip/SHA 校验，状态 JSON，`save-on` 放 finally。
- `scripts/world-pull.ps1`：Windows 周度两阶段拉取（`.part` → SHA → 原子改名 → 远端 ack），失败保留远端不 ack，本地保留 4 份。
- `scripts/drill.ps1` + `drill-verify.mjs`：full+inc 链、sidecar SHA、tar 安全、DB integrity/FK/schema、manifest 校验，报告保留 180 天，可选世界解包验证。
- 状态文件 `/var/lib/antifieldcloud/{world-backup,world-pull,drill}-status.json`（0644，应用只读），新增三类超期告警。
- 备份链路完善：pending 只算 `origin='pi'`、`skippedMissing/warnings`、prepare 超时对齐、`--ack` 事务、恢复 origin 过滤、快照行数/staging 上限、entries 限流、密钥包 tmpfs 与 `KEEP=2`。

### 系统与网络安全

- `antifieldcloud.service` capability/设备/时钟/主机名/内核日志/特殊权限收紧；世界备份 unit 独立加固。
- nftables 收窄：22 与 25565 仅实际直连/校园网段（22 新建连接限速 20/min），25575 仅 loopback，DHCP 绑物理网卡；80 不再放行。
- 登录/TOTP 全局限流调整（loopback 免占全局桶）；审计字段截断；opencode HTTP/WS Origin 校验。
- 部署脚本：APP_VERSION 注入与 `/healthz` 版本断言、磁盘/tar SHA/npm 预检、回滚先还原迁移前 DB 快照、部署后只读 smoke。
- v0.5.1：fail2ban dbfile 持久化 + nftables 启动后异步恢复封禁 set；smoke 的 Access service token 头（仅边缘身份层，不替代应用认证）。

### 文档与审计收口

- 同步 README/CHANGELOG/AGENTS/ARCHITECTURE/SECURITY/DEPLOY/ROADMAP/PLAN/UI-SPEC/ACCEPTANCE/BOT，修正过期版本、schema、测试数字、平台数量与待部署状态。
- `scripts/check-version.mjs` 校验 package.json 与 README/CHANGELOG/ACCEPTANCE/AGENTS/env.example/DEPLOY 标题及 lock 根版本一致。

## 阶段

1. 基线确认：v0.5.1 生产/审计待办分拣；确认 Discord Gateway intent、Telegram/QQ 平台 Chat 权限与 v0.5.2 部署前置条件。
2. 服务端：schema v9（迁移 9：`allow_chat`、`bot_ai_memories`、`bot_inbound_targets`）、Chat 分发、记忆摘要与镜像、多附件发送、只读按钮、Discord Gateway；保持 v0.5.1 安全语义。
3. 前端：`/bots` 目标 `allowChat` 与最近入站目标登记、发布媒体多选（≤5）、Gateway 状态、Discord/Telegram/QQ 配置提示；移动端布局不退化。
4. 运维：`bootstrap-env` 纳管 6 个 v0.5.2 键；Discord Developer Portal 开启 Message Content Intent；部署前快照/回滚与迁移 v9 流程；smoke `-ExpectedSchemaVersion 9`。
5. 文档与版本一致性：全量文档同步、`node scripts/check-version.mjs`、CHANGELOG v0.5.2。
6. 本地验证：`npm run check`、`npm test`、`npm run test:web`、`npm run build`（本次记录 `npm test` 293、`npm run test:web` 140、`npm run check` 通过；未执行真实平台验收）。
7. 部署与验收（待执行）：PC 部署、迁移前快照、v9 迁移、`BOT_*` 写入、冒烟、Discord Gateway 真实长连接、各平台 Chat/多附件/按钮、记忆持久化、公网/手机/PWA、世界备份/拉取/恢复演练（schema 9）与 Cloudflare Access 复跑。

## 验收摘要

1. 本地验证：`npm run check` 全绿（`npm test` 293 = 服务端 277 + 运维脚本 16，`npm run test:web` 140；2026-10-21 本次文档更新期间通过）；`npm run build`、覆盖率与 CI 以最新 main 为准（本次未重新执行）。
2. 版本一致：`/healthz`、`/api/version`、`package.json`、README、CHANGELOG、AGENTS、`deploy/env.example`、DEPLOY 标题均为 0.5.2；schema v9（本地代码/迁移测试；生产待迁移）。
3. Chat：目标 `allow_chat` 后端到端生效，群/频道仅 @/回复进入，私聊直接进入；非管理员不能执行斜杠命令；Telegram/Slack/QQ Webhook 与 Discord Gateway 单测覆盖；真实平台待联调。
4. 记忆：每 Bot×用户一份，DB 摘要与镜像文件一致；摘要失败保留旧摘要；文件 0700/0600 且不出现在 Web 静态目录；不通过 API/UI 暴露。
5. 多附件：服务端校验 5 个/10 MiB/50 MiB；Telegram/Discord/Slack 发送策略与 partial 不重试有单测；真实平台外发待验收。
6. 按钮/Gateway：Telegram/Discord 按钮需目标 + 用户双授权且只读；Discord Gateway intents=37377、HELLO/IDENTIFY/RESUME/心跳/重连/致命关闭码有假 WebSocket 单测；真实 Discord 长连接待 Developer Portal 开启 intent 后验收。
7. 安全：Chat 双限流、记忆路径/权限、入站目标不存正文、Gateway Token 不落日志；T/D/S/QQ 原有签名/去重/双白名单/发布 TOTP + `PUBLISH` 不退化。
8. 关闭态：`BOT_ENABLED=false` 时 Webhook 404、写接口 503、队列不启动；`/api/bots/status` 可读；`BOT_DISCORD_GATEWAY_ENABLED=false` 时不建立连接。
9. 备份：应用归档两阶段/密钥包（含 `BOT_*`/`BOT_SECRET_KEY`）/导入恢复；世界备份保留 4 份；PC 拉取失败不 ack；演练 `-ExpectedSchemaVersion 9` 在部署后按计划执行。
10. 生产部署、迁移 v9、smoke 已完成；Discord Gateway 真实长连接、各平台 Chat/多附件/按钮与记忆真实模型行为待在生产目标开启 `allow_chat`/Gateway 后联调；用户完成公网/手机/PWA 与 Cloudflare Access 复跑后记录到 `docs/ACCEPTANCE.md`。

## 关键决策

| 项 | 决策 |
|---|---|
| schema | v9：迁移 9 增加 `bot_targets.allow_chat`（默认 0）、`bot_ai_memories`、`bot_inbound_targets`；迁移 5–8 保留；只向上、无 down |
| Chat | 普通消息（非斜杠）在 `allow_chat=1` 时进入 AI Chat；群/频道仅 @/回复，私聊全部；非管理员只能 Chat；命令仍双白名单；Chat 只读，不占写操作 |
| 记忆 | 每 Bot×用户一份摘要；DB 权威 + `DATA_DIR/bot-memory` 镜像；每轮滚动摘要；失败保留旧摘要；不暴露 API/UI；摘要不额外占 AI 配额 |
| Gateway | Discord Gateway 默认关闭；`intents=37377` 含 `MESSAGE_CONTENT`；需 Developer Portal 开启 intent；Token 只进 IDENTIFY/RESUME |
| QQ 平台 | AppSecret 写入 Token 字段并加密；Ed25519 op=13/op=0；仅文本、≤2000 字符、不支持媒体；目标用 openid/channel_id |
| AI | OpenCode 本地 API；默认关闭；`/ask` 仅命令白名单用户、Chat 仅 `allow_chat` 目标；每小时限流；会话复用；deny-all 工具（明确 400 时才降级并标注未隔离） |
| Bot 开关 | `BOT_ENABLED` 默认 false；`BOT_SECRET_KEY` 由 bootstrap 生成/复用；关闭时 Webhook 404/写接口 503 |
| Bot 凭据 | AES-256-GCM（32 字节 base64 key，12 字节 IV，key_version=1）；API/日志只写不读 |
| Bot 命令 | 固定只读命令 + `/ask`；目标 `allow_commands` + 显式 user 白名单；输出清洗路径/URL，≤10 条文件元数据 |
| Bot 发布 | 仅频道/群组；TXT + 最多 5 个普通文件媒体（单 ≤10 MiB、总 ≤50 MiB；QQ 无媒体）；必须 TOTP + `PUBLISH`；定时 ≤30 天；指数退避/死信重投；部分成功不自动重试 |
| 静默时段 | `quiet_start_minute`/`quiet_end_minute` 本地分钟 0–1439，成对设置、不能相同；通知延后不丢弃 |
| 指标 | `GET /api/bots/:id/metrics?hours=24`（1–720）；成功率 = sent/(sent+failed)；最近错误/发送跨投递与发布 |
| 通知 | 告警事件按目标 `allow_notifications` 入队；`dedupe_key` 去重；失败不影响告警 |
| 单文件上限 | 普通上传 100 MiB（Cloudflare Free/Pro 限制）；分片 5 GiB/8 MiB 块 |
| 配额 | 10 GiB（含回收站与笔记附件）；`fileCount` 只统计 `origin='user'` |
| 笔记附件 | 单文件 25 MiB、每笔记 100、每请求 1–5；`origin='note'` 隔离 |
| 版本历史 | 标题/正文/标签变化时快照，保留 20 |
| 分享 | 单文件兼容 + 多文件 1–50；密码新建 ≥8；默认 7 天/最长 30 天；0=不限次数；不生成 zip |
| 世界备份 | root 脚本固定 RCON 命令；周日 12:00；保留 4 份；PC 校验后 ack |
| 演练 | 自动化脚本季度/升级前执行；报告 180 天；schema 9；世界解包需显式 `-IncludeWorld` |
| 系统 | 允许一次 Pi 重启；nftables 网段按实际直连/校园网段填写；SSH 仅公钥（24h 回滚）；sudo 未改（用户选择） |
| 兼容 | 旧单文件分享、旧归档（无 origin 列按 user/pi 处理）、旧 legacy 世界归档、旧 `/healthz` 版本断言保持可解析；T/D/S Bot 行为保持 |

## 非目标（v0.5.x 不做）

企业微信/钉钉/飞书（v0.5.3）、Bot 多管理员审批、QQ 媒体、Slack/QQ 按钮、除 Discord Gateway 外的平台主动拉取/长连接、任意命令执行；目录打包分享、笔记公开分享、整包加密归档、异地副本/对象存储、WebDAV/rclone、Minecraft 启停/控制台、多用户与权限分离、SSD/LUKS 迁移、`antifield` sudo 收紧（用户确认后另做）。Cloudflare Access 只做 `app` 策略与 Bot/health/公开分享 bypass，不覆盖 `ai`（OpenCode 自身认证 + 应用会话已足够，后续再评估）。

## 回滚

- 代码：`scripts/deploy.ps1` 停止服务并还原迁移前 DB 快照、还原上一 release 的 `APP_VERSION` 后切回 previous；无快照/读不到版本时拒绝自动回滚并打印手工步骤；部署后 smoke 失败默认让部署失败（`-AllowSmokeFailure` 仅告警）。
- DB：schema v9 只向上；回滚旧 release 前必须恢复 `/var/lib/antifieldcloud/backups/db-predeploy-*.sqlite`；迁移 9 新增列/表，旧代码不能直接读 v9（会拒绝启动），不能只回退代码。
- Bot：`BOT_ENABLED` 保持 false；`BOT_SECRET_KEY` 不轮换（轮换=全部 Token 重录）；`bots`/`bot_ai_sessions`/`bot_ai_memories`/`bot_inbound_targets` 随 DB 快照回滚；`DATA_DIR/bot-memory` 镜像文件按需人工清理；`/ask` 保持关闭。
- 系统：nftables 恢复 `/etc/nftables.conf.bak` 后 `systemctl restart nftables`；fail2ban drop-in 回滚删除 `/etc/systemd/system/nftables.service.d/10-fail2ban-restore.conf` 后 `daemon-reload`；SSH 删除 `00-` drop-in 后 `sshd -t && systemctl reload ssh`（24h 窗口内）。
- 世界备份：`systemctl disable --now antifieldcloud-world.timer` 并移除 unit；旧 cron 未恢复前不重新启用。
- Windows：`Unregister-ScheduledTask` 世界拉取/演练任务；每日应用备份任务可用 `install-backup-task.ps1` 重装。
