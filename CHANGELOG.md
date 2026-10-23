# Changelog

## [v0.5.11] - 2026-10-23

### Added

- **结构化长期记忆**：新增 `bot_memory_items`（7 类 `profile/preference/fact/project/task/relationship/episode`；字段 key/value/confidence/importance/source/created_at/updated_at/last_used_at/expires_at；唯一 `(bot_id,user_id,kind,mem_key)`）
  与 `bot_memory_state`（每用户启停 + legacy 迁移标记）；schema 升到 **v14**（迁移 14），旧 `bot_ai_memories` 保留为 legacy 迁移来源（验收后 CLI 清理）。
- **记忆抽取**：沿用累计 3 条或空闲 120s 批处理与同用户串行队列；每次抽取新建一次性 OpenCode 会话并在 `finally` 删除；模型输出严格 JSON operations（upsert/delete，服务端最多 20 条），
  服务端校验/敏感过滤（密钥、URL、内部路径等跳过）/容量清理（默认 200 条，先淘汰低重要度非核心条目）；审计 `bot.memory.extract` 只记计数。
- **TTL**：`profile`/`preference` 不过期；`fact`/`project`/`relationship` **365 天**（`BOT_AI_MEMORY_RETENTION_DAYS`）；`episode` **90 天**（`BOT_MEMORY_TTL_EPISODE_DAYS`）；`task` **30 天**（`BOT_MEMORY_TTL_TASK_DAYS`）；更新续期。
- **分层召回**：核心 `profile`/`preference`/`task` 优先，其余按关键词 + 重要度/时效挑选；预算 **3000 字/12 条**（`BOT_MEMORY_PROMPT_MAX_CHARS`/`BOT_MEMORY_PROMPT_MAX_ITEMS`）；未迁移旧摘要作为 fallback 注入；`/memory off` 时无注入。
- **`/memory` 自助命令（全用户）**：显示总条数/各类型计数/启停/最近更新时间（不含 key/value）；`/memory off|on` 暂停/恢复抽取与注入；`/forget confirm` 清空 items/state/legacy/会话（含远端）。
- **管理 API**：`GET /api/bots/:id/memories`（用户级 itemCount/kinds/memoryEnabled/updatedAt）、`GET /api/bots/:id/memories/:userId/items`（条目元数据 id/kind/importance/confidence/updatedAt/expiresAt）、
  `DELETE .../memories/:userId/items/:itemId`、`DELETE .../memories/:userId`；**绝不返回 key/value**；审计 `bot.memory.delete_item`/`bot.memory.delete_user`。
- **Legacy 迁移与清理**：旧滚动摘要一次性 LLM 转换（迁移后标记，未迁移用户继续 fallback 注入）；验收后可执行 `node scripts/cleanup-legacy-memory.mjs`（默认 dry-run；`--confirm` 删除已迁移用户的旧摘要行 + 镜像文件，写审计 `bot.memory.legacy_cleanup`）。
- **新增 env**：`BOT_MEMORY_MAX_ITEMS=200`、`BOT_MEMORY_PROMPT_MAX_CHARS=3000`、`BOT_MEMORY_PROMPT_MAX_ITEMS=12`、`BOT_MEMORY_TTL_EPISODE_DAYS=90`、`BOT_MEMORY_TTL_TASK_DAYS=30`；
  沿用 `BOT_AI_MEMORY_BATCH_MESSAGES=3`、`BOT_AI_MEMORY_IDLE_FLUSH_SECONDS=120`、`BOT_AI_MEMORY_RETENTION_DAYS=365`（fact/project）、`BOT_AI_MEMORY_MAX_CHARS`（legacy fallback 上限）。

### Changed

- 记忆写入从“滚动摘要覆盖”改为“结构化条目 upsert/delete”；旧 `bot_ai_memories` 仅保留 legacy/fallback，不再作为主记忆写入。
- `/forget confirm` 同时清空结构化条目、状态与旧摘要，并尽力删除远端会话；`/memory off` 后暂停抽取/注入，进行中的抽取结果在写回前发现状态变化会丢弃。
- `/help` 自助列表加入 `/memory`（查看与 off/on）；管理页“角色与记忆”改为用户级条目计数/类型分布 + 单条元数据列表/删除。
- `bot.memory.*` 审计动作扩展：`bot.memory.extract`（只计数）、`bot.memory.toggle`、`bot.memory.delete_item`、`bot.memory.delete_user`、`bot.memory.legacy_cleanup`。

### Security

- 抽取结果敏感过滤（密钥/URL/内部路径跳过），条目 key/value 不通过任何 Web/API 返回；TTL + 每用户容量上限（含核心类型保护）；`/memory off` 即时停止抽取与注入；删除用户记忆同时清理本地/远端会话；
  legacy fallback 只在预算内注入，且公开帮助/状态不展示记忆正文或 key/value。

### Deployment

- 版本/`APP_VERSION` 升到 0.5.11；schema **v14**（迁移 14，新增两张表，不可逆）；`scripts/deploy.ps1` 期望 schema 14，切换前自动迁移前 DB 快照。
- **v0.5.10 不支持 schema v14**：回滚必须恢复迁移前快照（不能仅切回旧 release）。
- 生产 env 需新增 5 个 `BOT_MEMORY_*`；部署步骤：env → deploy（迁移 14 + 快照）→ `/healthz` v0.5.11/schema 14 → smoke（`-ExpectedSchemaVersion 14`）→ 真实记忆验收 → `cleanup-legacy-memory.mjs --confirm` → 部署后备份。
- 测试基线（Lead 实测 2026-10-23）：`npm test` **360**（v0.5.10 的 341 + 新增 19：记忆存储/抽取/检索/迁移/管理 API/`/memory` 等）、`npm run test:web` **162**（30 文件，+5）、`npm run typecheck` 通过；覆盖率 Lines **92.05%** / Branches **77.43%** / Functions **86.39%**（`npm run test:coverage` exit 0）、`npm run build` 通过。
- **已部署并验收通过（2026-10-23，最终 release `20261023T022831Z`/commit `931b10d`，schema v14）**：同版本早前 release `20261023T021339Z`（fix forget 回复）与 `20261023T014328Z`（首次 v0.5.11 部署）保留。
  `/healthz` = `{"ok":true,"version":"0.5.11","schemaVersion":14}`；部署内只读 smoke **16/16**、完整 Access smoke **24/24**；运行配置 `365/3/120/3000/12/90/30`；生产 env 5 个 `BOT_MEMORY_*`、权限 `640 root:antifieldcloud`；
  最终迁移前快照 `/var/lib/antifieldcloud/backups/db-predeploy-20261023T022902018Z.sqlite`（sha256 `937a0bc84dc317e1e815bc480f03b8e065935bed7a1e09bf5edac6da76a98d3c`）。
- **部署后备份**：`snapshot-20261023T023941878Z-inc.tar.gz`（154594 bytes，sha256 `db55178851004dd80353cdbb31213679d61cfc8a0eb72050f8f70a34fe68a21f`，secrets=ok，PC 已拉取/ack）。
- **真实 QQ 验收（用户实发，2026-10-23 10:39 CST 通过）**：最终 release 10:34:39/10:35:39/10:37:22 CST 三条 Chat → 10:37:30 `bot.memory.extract` `rounds=3 ops=2 upserts=2`（偏好+资料各 1）；10:38:40 `/memory` 成功；
  10:39:15 `/forget confirm` 审计 `items=2 legacy=0`、回复含“记忆条目 2 条”，之后 items=0/state=0/legacy 仅剩 2 条其他未迁移用户（未误删）/sessions 仅剩其他用户。同版本早前 A/B：`/memory off`（10:06:47）→ off 期间 Chat 无新 extract（10:07:14）→ `/memory on`（10:09:54）→ `/forget confirm`（10:10:12，items=1 legacy=1）均成功；`/bots` 记忆面板由用户确认可用。
  诚实记录：首次短消息测试抽取 `ops=0`（10:18:47、10:21:17），判定提示词过保守；修正提示词（commit `931b10d`）并重新部署后重试得到 `ops=2`。
- **Legacy 清理**：10:12:27 dry-run 与 `--confirm` 均 `users=0 files=0`（测试用户 legacy 已随 `/forget` 删除，另 2 条属未迁移用户未触碰），审计 `bot.memory.legacy_cleanup`。
- **已知环境事件**：2026-10-23 01:08–01:13 CST Cloudflare 边缘 7844 不可达致 tunnel 短暂中断，重启 cloudflared 后恢复；公共 smoke 24/24（环境事件，不计应用问题）。
- **回滚**：v0.5.10 不支持 schema v14；必须恢复最终迁移前快照 + 切回 release `20261022T152053Z`（v0.5.10）。本地提交 `0b1dd03`（feat）/`dc912bb`（docs）/`a62eb34`（fix）/`931b10d`（prompt fix），尚未推送/打 Tag。

## [v0.5.10] - 2026-10-22

### Added

- **记忆摘要合并策略**：累计 `BOT_AI_MEMORY_BATCH_MESSAGES=3`（1–20）条对话或用户空闲 `BOT_AI_MEMORY_IDLE_FLUSH_SECONDS=120`（0 或 10–3600，0 关闭空闲触发）时触发一次摘要；
  审计 `bot.ai.memory` 增加 `rounds`（本批合并轮数）。
- **新环境变量**：`BOT_AI_MEMORY_RETENTION_DAYS=365`（30–3650，独立于会话 7 天保留）、`BOT_AI_MEMORY_BATCH_MESSAGES=3`、`BOT_AI_MEMORY_IDLE_FLUSH_SECONDS=120`。
- 连通性快照仅含 `internet` 与 `platforms`（外网 + QQ 平台，Pi 直连），不再有 `deviceOnline`/`proxy`。

### Changed

- **摘要会话一次性**：每次记忆摘要新建远端 OpenCode 会话并在 `finally` 删除；不再保存 `summary_session_id`（列保留兼容，旧值仅历史遗留）。
- **记忆更新串行化**：按 Bot×用户队列串行执行摘要更新，避免并发覆盖；摘要失败只记日志并保留旧摘要。
- **会话清理增强**：`/reset`、`/forget confirm`、角色卡变更（含管理员删除角色）在清理本地映射时尽力删除对应远端 OpenCode 会话与旧摘要会话；删除失败不阻塞主流程。
- **保留期分离**：AI 会话映射保留 7 天（`BOT_AI_SESSION_RETENTION_DAYS`），长期记忆保留 365 天（`BOT_AI_MEMORY_RETENTION_DAYS`），互不影响。
- **连通性探测改为 Pi 直连**：只探测外网与 QQ 平台 API，删除代理端口探测；移除 `BOT_PROXY_URL` 配置与生产 `HTTPS_PROXY`/`HTTP_PROXY`/`NODE_USE_ENV_PROXY` 依赖。

### Removed

- 删除 `scripts/discord-tunnel.ps1`、`scripts/discord-tunnel.vbs`、`scripts/install-tunnel-task.ps1`；PC 计划任务 `AntifieldCloudDiscordTunnel` 已移除；
  `BOT_PROXY_URL` 配置删除；连通性快照去掉 `deviceOnline`/`proxy`（历史文档中的代理隧道说明自 v0.5.10 起失效）。

### Security

- 摘要会话用后即删，减少远端会话残留；`/forget`/`/reset` 同时清理远端会话与旧摘要会话；记忆保留期独立避免长期记忆被 7 天会话清理误删；串行队列避免并发覆盖。
- 连通性探测仍只发无凭据只读 GET，不记录平台响应正文或 AppSecret。

### Deployment

- 版本/文档/`APP_VERSION` 升到 0.5.10；schema 保持 **v13（无迁移）**；`scripts/deploy.ps1` 无需改动（期望 schema 13 不变）。
- **生产 env 变更**：删除 `HTTPS_PROXY`/`HTTP_PROXY`/`NODE_USE_ENV_PROXY`/`BOT_PROXY_URL`/`NO_PROXY`（空值）；确认新增/保留 `BOT_AI_MEMORY_RETENTION_DAYS`/`BOT_AI_MEMORY_BATCH_MESSAGES`/`BOT_AI_MEMORY_IDLE_FLUSH_SECONDS`；重启服务。
- PC 侧 `AntifieldCloudDiscordTunnel` 计划任务已移除，仓库不再包含隧道脚本；Pi 出站改为直连。
- 测试基线（Lead 实测）：`npm test` **341**（v0.5.9 的 333 + 新增 v0.5.10 用例 8：记忆摘要一次性/删除、合并/空闲/并发串行、`/forget` 与 `/reset` 远端删除、记忆/会话保留期分离）、`npm run test:web` **157**（30 文件）、`npm run typecheck` 通过；`npm run test:coverage` exit 0（Lines **91.98%** / Branches **76.92%** / Functions **85.99%**）、`npm run build` 通过。
- **已部署（2026-10-22 23:20–23:23 CST）**：release `20261022T152053Z`（commit `4619c91`，version 0.5.10/schema v13，无迁移）；current 指向该 release，上一 release `20261022T143451Z`（v0.5.9）保留；
  迁移前 DB 快照（仅部署保护）`db-predeploy-20261022T152150860Z.sqlite`（sha256 `3e48eb3359c00408903adde5ac642dd9f2b190e106e2d502112c3ff3ce7078e6`）。
- **部署验证**：`/healthz` = `{"ok":true,"version":"0.5.10","schemaVersion":13}`；部署内只读 smoke **16/16**、带 Access token 完整 smoke **24/24**；
  生产 env 实测（3 个记忆变量就位、代理变量与 `BOT_PROXY_URL` 均无、运行时 365/3/120/7、config 无 proxy 字段）；无代理环境下 QQ `checkBot` ok，启动日志 detail 仅 `internet:true, platforms:["qq"]`（无 proxyPort）；
  PC 隧道任务/进程已移除、PC/Pi 无 `18090` 监听；前端 `/`、`/bots` 200（bundle `index-Bx6EBCIp.js` 644262 bytes，含“Pi 直连”，不含“代理端口/设备在线”）。
- **部署后备份**：增量 `snapshot-20261022T152331855Z-inc.tar.gz`（132980 bytes，sha256 `c53e4ab2c428ed7412363ebb9977e7458e8e7692edc0248213ce62f2be66d42c`）已拉取并 ack；密钥包 `secrets-20261022T152333Z.tar.age` secrets=ok。
- **回滚**：schema 无迁移；切回 release `20261022T143451Z`（v0.5.9）并还原 env 备份（含代理变量与旧 `BOT_PROXY_URL`）+ 恢复旧隧道脚本/计划任务；无 schema 回滚。
- **验收通过（用户实发，2026-10-22 23:26–23:29 CST / UTC 15:26–15:29）**：用户 `5B7B32E7…` 实发 8 条事件全部 outcome=ok——4 条 Chat（含 1 条仅图片 `image/jpeg, size=145172`）、3 条 `/forget`（2 次 confirm：`bot.memory.forget removed:1`；1 次用法提示）、1 条 `/reset`（`bot.reset`）。
  合并摘要：4 条 Chat 仅 1 次 `bot.ai.memory`、detail `rounds:3`（15:28:37Z）；远端会话删除：部署前快照 `ses_e9c15b42effez0wu1ngmcSY0Bd`（chat）与 `ses_e9c15a6fbffe2CLM753O0NNqoc`（旧摘要）在 `/forget confirm` 后经 OpenCode API 查询均 404，该用户本地会话/记忆清空、其他用户不受影响、无删除失败日志；图片 145172 B JPEG 端到端成功；`/bots` 出站网络卡片按用户确认通过（服务端无单独 UI 证据）；23:29 CST 用户明确“完成验收”。

## [v0.5.9] - 2026-10-22

### Added

- **`/help` 对所有用户开放且动态显示**：非管理员收到 `publicHelpText()`（`/help`、`/role` 私聊、`/reset`、`/forget confirm` + Chat 说明，不出现 `/status` 等管理命令）；
  管理员收到 `helpText()` 全量帮助（无 `/ask`）；未知命令对管理员回全量帮助、对非管理员被拒（无回复），均不调用 AI。
- **限速宽松档**：`BOT_CHAT_RATE_PER_MINUTE=30`（范围 1–120）、`BOT_AI_RATE_PER_HOUR=120`（范围 1–600）、`BOT_COMMAND_RATE_PER_MINUTE=120`。

### Changed

- **AI 仅普通消息 Chat**：提示词固定为「角色卡（个人卡或默认 lofii）+ 固定只读安全边界 + 长期记忆 + 用户消息」；`BotAiMode`/task 提示词全部移除；
  `bot_ai_sessions.mode` 列保留但只写 `chat`（旧 task 行为历史遗留）；`/reset` 与角色卡变更清理该范围全部会话映射（不再区分 task/chat）；审计 `bot.ai.chat` 不再记录 `mode`。
- **`/ask` 移除**：`BOT_COMMANDS` 删除 `ask`（现为 `/help /status /backup /world /mc /files /role /reset /forget`）；`/ask` 作为未知命令：
  非管理员被拒（`bot.command.denied`、无回复），管理员回全量帮助、不调用 AI。
- 配置：`BOT_AI_TASK_PROMPT`/`BOT_AI_CHAT_PROMPT` 从 `config.ts`/`bootstrap-env.sh`/`deploy/env.example` 删除。

### Removed

- 删除 `/ask` 命令、AI task 模式与 `BOT_AI_TASK_PROMPT`/`BOT_AI_CHAT_PROMPT`；AI 会话不再创建 task 会话（旧 task 映射保留在 DB，仅历史遗留）。

### Security

- `/help` 非管理员不暴露管理命令名；未知命令不执行任何只读/AI 操作；限速放宽后仍按 Bot×用户维度限流（Chat 30/min、AI 120/h、命令 120/min）。

### Deployment

- 版本/文档/`APP_VERSION` 升到 0.5.9；schema 保持 **v13（无迁移）**；`scripts/deploy.ps1` 期望 `-ExpectedSchemaVersion 13` 不变。
- **生产 env 迁移（必须，否则仍是旧限速）**：`/etc/antifieldcloud/env` 中 `BOT_COMMAND_RATE_PER_MINUTE` 改为 `120`、`BOT_AI_RATE_PER_HOUR` 改为 `120`、
  新增 `BOT_CHAT_RATE_PER_MINUTE=30`、删除 `BOT_AI_TASK_PROMPT`/`BOT_AI_CHAT_PROMPT` 两行，然后重启 `antifieldcloud`。
- 回滚：schema 未变，可切回上一 release 并还原旧 env 值（命令 20 / AI 10 / Chat 6）后重启；部署脚本仍会生成迁移前快照但无迁移需恢复。
- 测试基线（Lead 实测 2026-10-22）：`npm test` **333**（server + 运维脚本；较 v0.5.8 的 337 少 4 个已移除的 /ask/task 用例）、`npm run test:web` **157**（30 文件）、
  `npm run check` 通过、`npm run test:coverage` 通过（Lines **91.77%** / Branches **76.98%** / Functions **85.96%**）、`npm run build` 通过。
- **已部署（2026-10-22 22:35 CST）**：release `20261022T143451Z`（commit `97996dc`，version 0.5.9/schema v13，无迁移）；current 指向该 release，上一 release `20261022T134852Z`（v0.5.8）保留；
  迁移前 DB 快照（无迁移，仅部署保护）`db-predeploy-20261022T143520649Z.sqlite`（sha256 `14ca82ed9cfc54556faeadc4914fb1c797fc177aa5d1f2b27d3b2db72e42968b`）。
- **部署验证**：`/healthz` = `{"ok":true,"version":"0.5.9","schemaVersion":13}`；部署内只读 smoke **16/16**、带 Access token 完整 smoke **24/24**（首次 Access 请求 20s 超时 1 项失败，重试全通过，无代码/服务异常）；
  生产 env 迁移实测：命令 120/AI 120/Chat 30、两个提示词变量计数 0、权限 640、`APP_VERSION=0.5.9`；运行时 `botChatRatePerMinute=30`/`botAiRatePerHour=120`/`botCommandRatePerMinute=120`/`botAiVisionEnabled=true`/`botAiEnabled=true`；
  前端 `/`、`/bots` 200（bundle `index-CFrhFtH2.js` 644849 bytes，含“每分钟 30 次”与“AI 对话由普通消息 Chat 承担”，不含 `/ask`）。
- **部署后备份**：增量 `snapshot-20261022T143749907Z-inc.tar.gz`（131088 bytes，sha256 `702a0d42221939a0d9e6b5bd2509dfa18ccf4e62622991d98e02de53b055c5a4`）已由 PC `backup-pull` 拉取并 ack；密钥包 `secrets-20261022T143751Z.tar.age` 拉取成功，`secrets=ok`。
- **回滚**：schema 无回滚需求；切回 release `20261022T134852Z`（v0.5.8）+ 还原 env 备份（20/10/6 与两个提示词键占位）+ 重启。
- **验收通过（用户实发，2026-10-22 22:39–22:41 CST）**：22:39:52 CST 非管理员 QQ 用户 `6B7DAC9B…` 实发 `/help`，`bot_events` 记录 `command/ok/command_help`、`audit_log` 记录 `command=help`，事件 200 ack 且命令正常回复；22:41 CST 用户原话“验收通过”。
  管理员 `/help` 全量、`/ask` 只回帮助不调用 AI、放宽后限速体验（30/min、120/h、命令 120/min）、普通 Chat/图片回归为用户口头确认通过（服务端无单独事件证据，如实记录为用户确认）。

## [v0.5.8] - 2026-10-22

### Added

- **QQ 入站图片理解默认开启**：`BOT_AI_VISION_ENABLED=true`（默认）；QQ 事件 `d.attachments` 中首个 `image/*` 附件（`content_type`/`filename`/`size`/`url`）经
  `.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（QQ 实际图床如 `multimedia.nt.qq.com.cn`） 域名后缀白名单、image mime 白名单（jpeg/png/webp/gif）、≤`BOT_AI_IMAGE_MAX_BYTES` 内存下载（不落盘）后，
  以 OpenCode prompt files data URL 交给模型 provider；仅图片无文字也可进入 Chat；失败/关闭/非法图片降级为纯文字回答。
- **schema v13（迁移 13）**：`DELETE FROM bots WHERE platform <> 'qq'`，级联删除非 QQ Bot 的目标/队列/事件/会话/记忆/角色卡；迁移 5–12 保留。
- **QQ 单平台能力**：保留 QQ 官方 Bot 接入（AppID/AppSecret、`op=13` 回调校验、`op=0` Ed25519 验签）、命令（`/help /status /backup /world /mc /files /ask /role /reset /forget`）、
  C2C/群@/频道 Chat、长期记忆、私聊角色卡、事件诊断、平台连接自检（`access_token`）、角色/记忆元数据管理、文本发布（TOTP + `PUBLISH`，≤2000 字符分段）。

### Changed

- **平台收敛为 QQ 官方 Bot 单平台**：删除 Telegram/Discord/Slack 适配器、`server/src/bot/discord-gateway.ts`、只读按钮、媒体/多附件发布、目标 `chatTrigger`、
  Telegram HTML/引用/线程；`BotPlatform` 仅 `qq`；公开 Webhook 只接受 QQ；`BotSummary` 无 `gateway`、`BotTarget` 无 `chatTrigger`、`BotPublishJob` 无 `mediaFileIds`。
- **env 收敛**：删除 `BOT_DISCORD_GATEWAY_ENABLED`、`BOT_PUBLISH_MAX_MEDIA_BYTES/FILES/TOTAL_BYTES`；保留 QQ/AI/连通性/队列键，`BOT_AI_VISION_ENABLED` 默认改为 `true`。
- **发布仅文本**：`POST /api/bots/:id/publish` 不再接受媒体；文本 ≤2000 字符，超长由服务端分段；长文本 partial 失败标记 `partial_text_sent` 且不自动重试。
- **Web `/bots`**：去掉 Discord Gateway/媒体选择器/触发方式，保留 6 分区（概览/配置/目标/投递与发布/角色与记忆/诊断）与“检查连接”、诊断、角色/记忆元数据管理。

### Removed

- 删除 Telegram/Discord/Slack 平台注册与配置说明、Discord Gateway 与 `BOT_DISCORD_GATEWAY_ENABLED`、只读按钮、媒体/多附件发布与 `BOT_PUBLISH_MAX_MEDIA_*`、
  目标触发方式 `chatTrigger` 与 `chat_trigger_unsupported` 错误码、媒体相关错误码、Telegram HTML/引用/线程、`BotSummary.gateway`。
- 生产 Discord Bot 及级联数据（迁移 13 删除，迁移前已备份；不可逆，回滚只能还原迁移前 DB 快照）。
- v0.5.0–v0.5.7 历史验收记录保留，但自 v0.5.8 起不再是当前能力。

### Security

- QQ 入站图片只从固定域名后缀下载、image mime 白名单、大小上限、不落盘；图片会经本机 OpenCode 交给模型 provider，数据外发范围已在 SECURITY 明示。
- AppSecret 只写不读、AES-256-GCM 落库；管理 API 与诊断只返回元数据；自助 `/reset`/`/forget confirm` 审计不含正文；发布仍为 TOTP + `PUBLISH` 双确认。
- 迁移 13 删除非 QQ Bot 数据前必须备份；回滚依赖迁移前 DB 快照。

### Deployment

- 版本/文档/`APP_VERSION` 升到 0.5.8；`docs/DEPLOY.md` 的 schema/健康检查/smoke 期望同步为 v0.5.8/schema 13；`scripts/deploy.ps1` 部署后 smoke `-ExpectedSchemaVersion 13`。
- 部署顺序：**备份生产 Discord Bot 数据** → 迁移前 DB 快照 → 部署（迁移 13）→ `/healthz` 断言 `version=0.5.8`/`schemaVersion=13` → 带 Access token 的 smoke → QQ env/Bot 校验。
- **已部署（2026-10-22）**：release `20261022T134852Z`（commit `96294e4`，version 0.5.8/schema v13）已切换并重启；current 指向该 release，上一 release `20261022T131813Z`（v0.5.7）保留。
- **部署验证**：`/healthz` = `{"ok":true,"version":"0.5.8","schemaVersion":13}`；部署内只读 smoke **16/16**、带 Cloudflare Access service token 完整 smoke **24/24**；迁移 13 后 `bots` 仅 1 行 QQ Bot（`2456ea90-7fed-42ec-81d0-9c478d2a9d47`/QQ 运维 Bot/enabled=1），原 Discord Bot `853f85e6…` 在目标/队列/事件/会话/记忆/角色/入站表均 0 行，QQ 数据保留（targets 2/deliveries 4/events 44/sessions 4/memories 3/roles 1/inbound 4），`chat_trigger` 列保留但不读写；运行时 `botAiVisionEnabled=true`、`botAiImageMaxBytes=10485760`、`botAiMaxReplyChars=4000`、`BOT_ENABLED`/`BOT_AI_ENABLED` 均为 true；连通性仅 `platforms:["qq"]`，无 Discord Gateway；`/` 与 `/bots` 均 200（新 bundle `index-C-fPrxEf.js` 644795 bytes），bundle 含「AppID/检查连接/角色与记忆/诊断」不含「Discord Gateway/Telegram/Slack」；QQ webhook 负路径 `op=0` 无签名 401、`op=99` 200、未知 bot 404；QQ 连接自检 `access_token 已获取` ok。
- **迁移前快照/回滚**：`db-predeploy-20261022T134921798Z.sqlite`（sha256 `fed84a0a4024ece85c4de50eabe41b20bf6a2d2821350d295d36faa1e98ec1ce`，含删除前 Discord Bot 数据）。迁移 13 不可逆，回滚必须恢复该快照并同步还原 `APP_VERSION`、切回 `20261022T131813Z`。
- **部署后备份**：增量 `snapshot-20261022T135052128Z-inc.tar.gz`（126419 bytes，sha256 `262afd2d4cbd39c2ae12ab5ae152517f0ff470e59cfc9b641aed5982b56fb78a`）已由 PC `backup-pull` 拉取并 ack；密钥包 `secrets-20261022T135053Z.tar.age` 拉取成功，`secrets=ok`。
- **验收通过（用户实发，2026-10-22 21:59–22:08 CST）**：13 条真实 QQ 入站事件全部符合预期（C2C 管理员 `5B7B32E7…`/`6B7DAC9B…`）；`/help`、`/forget`(confirm，`bot.memory.forget removed:1`)、`/reset`、`/role`(show/set/off/on/delete，delete 审计)、`/reset` 均 ok；一条命令被 `bot.command.denied` 后 `/role` 正常（自助命令绕过白名单）符合权限模型；两条文本 Chat → `bot.ai.chat` + `bot.ai.memory`（sessions/memories 更新）；真实图片消息（仅图片 `chars:0`）→ `bot.chat` image/`bot.ai.image` `mime=image/jpeg,size=148563`/`bot.ai.chat` image 标志/outcome=ok，随后记忆更新，attachments→下载→OpenCode 视觉→回复→记忆整条链路成功；期间无 `bot_deliveries` 失败、无 `bot_publish_jobs`。诊断/角色记忆面板与文本发布按用户确认整体通过（服务端未单独留存 UI/发布证据）。

## [v0.5.7] - 2026-10-22

### Added

- **schema v12（迁移 12）**：`bot_targets.chat_trigger`（`mention`/`all`，默认 `mention`）；`bot_events` 新增 `event_kind`/`outcome`/`detail`/`target_external_id`/`user_id`/`updated_at` 与 `(bot_id, outcome, received_at)` 索引；迁移 5–11 保留。
- **群聊触发策略**：目标级 `chatTrigger`（仅 @/回复、全部消息）。Telegram/Discord/Slack 的“全部消息”需平台前置配置（关闭 privacy mode、开启 Message Content Intent、订阅 `message.channels`）；QQ 群/频道仅支持 @Bot（传 `all` 返回 `chat_trigger_unsupported`）；未授权目标/关闭 Chat 时的 message 触发静默忽略（只记诊断事件）。
- **引用回复/线程**：Telegram 群/频道使用 `reply_to_message_id`，Slack 频道使用 `thread_ts`，Discord Gateway 使用 `message_reference`；私聊不引用；被引消息失效/线程失效时降级为无引用重发一次。
- **长回复分段**：按平台单项上限（Telegram 4096 / Discord 2000 / Slack 4000 / QQ 2000）分段发送，单次最多 4 段，续段前缀“（续 n/m）”，超出截断并标记“内容过长已截断”；Telegram HTML 按标签边界安全分段；partial 失败记录 `partial_text_sent` 且不自动重试，避免重复外发。
- **Markdown 格式化**：AI 回答按平台转换（Telegram HTML `parse_mode`、Discord markdown、Slack mrkdwn、QQ 纯文本），链接只放行 http(s)。
- **图片理解（默认关闭）**：开启后 Telegram photo/document、Discord/Slack 图片附件经固定平台域名下载（image mime 白名单、≤`BOT_AI_IMAGE_MAX_BYTES`、不落盘）交给 AI；关闭/失败/无文字时降级提示；QQ 不支持图片。生产已完成只读验证：OpenCode prompt files data URL + `opencode-go/deepseek-v4.1-flash` 支持 image 输入。
- **自助命令**：`/reset` 重置当前目标 Chat/任务会话（保留长期记忆）；`/forget confirm` 清除长期记忆（DB+镜像）与该 Bot×用户的全部会话；对所有用户开放，`/help` 文案已更新。
- **平台连接自检**：`POST /api/bots/:id/check`（Telegram `getMe`+`getWebhookInfo`、Discord `/users/@me`、Slack `auth.test`、QQ `access_token`），结果脱敏并刷新 `last_checked_at`。
- **诊断**：`GET /api/bots/:id/events?hours&limit&offset&outcome` 返回入站事件元数据（不含正文；outcome：`received`/`ok`/`denied`/`rate_limited`/`ignored`/`error`）；投递、发布、指标增加 `lastErrorHint` 中文提示。
- **角色/记忆管理**：`GET/PATCH/DELETE /api/bots/:id/roles…`、`GET/DELETE /api/bots/:id/memories…`，只返回元数据（用户、名字、长度、启停、时间）；删除角色清该用户 chat 会话，删除记忆清 DB 行+镜像文件；正文不进入 Web/API。
- **目标触发字段**：目标创建/更新接受 `chatTrigger`，`BotTarget` 返回 `chatTrigger`。
- **Web `/bots`**：标签扩展为 6 个（概览/配置/目标/投递与发布/角色与记忆/诊断）；配置页“检查连接”；目标页触发方式选择与快捷切换；角色/记忆与诊断面板只展示元数据/脱敏错误。

### Changed

- **AI 回答上限**：由固定 4000 字符改为 `BOT_AI_MAX_REPLY_CHARS`（默认 4000，1000–12000）；统一管线为 sanitize → 平台格式化 → 分段发送，适配器接收 `textMode`/`replyTo`。
- **outcome 语义**：入站事件先记 `received` 再更新最终结果；Webhook 重复事件仍按 `bot_events` 去重；`message` 触发仅在目标 `allow_chat=1` 且目标 `chatTrigger=all` 时进入 Chat。
- **环境变量**：新增 `BOT_AI_MAX_REPLY_CHARS=4000`、`BOT_AI_VISION_ENABLED=false`、`BOT_AI_IMAGE_MAX_BYTES=10485760`（1–20 MiB），`bootstrap-env.sh` 已纳管这 3 项。
- **部署脚本**：`scripts/deploy.ps1` 部署后 smoke 的 `-ExpectedSchemaVersion` 由 11 改为 12。

### Security

- 自助 `/reset`/`/forget confirm` 只清理当前 Bot 的会话/记忆，审计只记录动作与数量，不记录正文；命令输出不泄露内部路径/URL。
- 管理 API 的角色/记忆只返回元数据，角色设定与记忆摘要正文不通过 Web/API 暴露；删除操作需登录 + CSRF。
- 诊断事件只存事件类型/结果/短码/目标与用户 ID，不存消息正文；图片输入不可信：固定域名、mime 白名单、大小上限、不落盘，失败降级为文字。
- 长回复/多附件 partial 失败不自动重试（`partial_text_sent`/`partial_media_sent`），避免重复外发；发布仍需 TOTP + `PUBLISH` 双确认。

### Fixed

- **错误提示映射**：修复适配器包装消息中的平台错误码未被 `describeBotError` 识别、导致 `lastErrorHint` 为 null 的问题（如 `平台请求失败（0:qq_access_token_failed）`）；修复 commit `2f429be`（`fix(bot): 错误提示识别适配器包装消息中的平台错误码`），生产复验 Discord `network` 与 QQ `qq_access_token_failed` 均返回对应中文提示，`metrics.lastErrorHint` 同步。

### Deployment

- 版本/文档/`APP_VERSION` 升到 0.5.7；`docs/DEPLOY.md` 的 schema/健康检查/smoke 期望同步为 v0.5.7/schema 12。
- 部署顺序：迁移前 DB 快照 → 部署（迁移 12）→ `/healthz` 断言 `version=0.5.7`/`schemaVersion=12` → 带 Access token 的 smoke → Bot env 校验（迁移 12 只加列/索引，不重建表）。
- 迁移 12 单向、无 down：回滚必须恢复迁移前 DB 快照并同步还原 `APP_VERSION`；回滚窗口内保持 Bot/AI/Gateway 关闭。
- **已部署（含修复发布）**：2026-10-22 首次部署 release `20261022T131121Z`（commit `8dcd10f`，version 0.5.7/schema v12）后，生产只读验证发现 `lastErrorHint` 错误码识别缺陷；修复 commit `2f429be` 并重新部署 release `20261022T131813Z`（commit `2f429be`，version 0.5.7/schema v12），current 指向该 release，保留 `20261022T131121Z`、`20261022T114546Z`。第二次迁移前快照 `db-predeploy-20261022T131844841Z.sqlite`（sha256 `ad534db8ca5b806cf09b0abbd5ba7459a92fcfedad8d4d05afe9930e2df28794`）。
- **部署后校验**：`/healthz` = `{"ok":true,"version":"0.5.7","schemaVersion":12}`；部署内只读 smoke 16/16、带 Cloudflare Access service token 的完整 smoke **24/24**；重启后 Discord Gateway `已连接`（21:18:48）；`bot_targets.chat_trigger` 存在且 5 个既有目标均为默认 `mention`，`bot_events` 6 个诊断列存在；真实网络连接自检 Discord `@lofii.bot` 与 QQ access_token 通过。
- **生产只读复验**：服务层 `listEvents`/`listRoles`/`listMemories`/`metrics`/`listDeliveries` 只读调用通过（角色/记忆仅元数据、不含正文）；`lastErrorHint` 修复对 Discord `network`、QQ `qq_access_token_failed` 均生效且 metrics 同步；带 Access token 访问 `/` 与 `/bots` 均 200，新 bundle `/assets/index-CH38JtCp.js`、`/assets/index-BJSYA4Y6.css` 均 200；Discord 已注册命令实测为 `status/backup/world/mc/files/help/ask`，缺 `role/reset/forget`（用户平台后台步骤，待补）。
- **部署后备份**：第二次增量 `snapshot-20261022T132013585Z-inc.tar.gz`（125874 bytes，sha256 `fb01cc1724b32c4f3db6608934cf0cd9a622f67bf1c4b17ff171170093cbe423`）已由 PC 拉取并 ack；密钥包 `secrets-20261022T132014Z.tar.age` 拉取成功（`secrets=ok`）。
- **待用户实发验收**：本地基线 `npm test` 387、`npm run test:web` 157（30 文件）；真实平台消息级联调（`/reset`、`/forget confirm`、分段/Markdown、群聊引用、`all` 触发、图片、诊断/角色/记忆面板实际交互）**尚未由用户实发验收**（Discord 需先补注册 `/role` `/reset` `/forget`），证据待用户实发后回填 `docs/ACCEPTANCE.md`。

## [v0.5.6] - 2026-10-22

### Added

- **默认角色 lofii**：内置猫系轻松伙伴 `lofii`，私聊与群聊普通对话默认都用它；角色语气轻松但正事认真。
- **个人角色只覆盖私聊**：`/role` 仍对全部平台私聊用户开放；个人卡存在且启用时覆盖默认 lofii；`/role off` 收起个人卡并回落到默认 lofii，`/role delete` 删除后也回到默认。
- **群聊统一默认角色**：群/频道普通对话固定使用 lofii；群内 `/role` 只回复友好提示，不读取/修改任何人的个人角色。
- **全用户友好文案**：`/role` 用法、设置/停用/删除回复和错误提示只写当前角色与分支命令，不注入默认角色个性，也不出现 Chat、会话、保留标记、`/ask` 等技术词；Chat 异常回复改为中性说法。
- **兼容性**：`BOT_AI_CHAT_PROMPT` 不再影响 Chat（Chat 固定个人角色或 lofii）；任务提示与 `BOT_AI_TASK_PROMPT` 不变；schema 保持 v11，无新增 env。

### Deployment

- 生产已部署 release `20261022T114546Z`（commit `38dfe70`，schema v11，无新迁移，smoke 24/24）。
- 私聊/群聊默认 lofii、个人角色覆盖/`off` 回落、简洁 `/role` 文案均已由用户实发确认。

## [v0.5.5] - 2026-10-22

### Added

- **私聊角色卡**：新增 `/role`，对全部平台私聊用户开放；`/role set <名字> <设定>`、`/role show`、`/role off`、`/role on`、`/role delete`。每 Bot×用户一张启用卡，名字 1–32 字符、设定 1–1000 字符，拒绝保留提示词标记。
- **Chat 人设**：私聊 Chat 有启用角色卡时，用角色卡替换默认 Chat 风格；固定只读安全边界与共享长期记忆仍追加；`/ask` 与群/频道 Chat 不使用角色卡。
- **会话重置**：设置/停用/启用/删除角色卡后删除当前私聊 Chat 会话映射，下次 Chat 新建会话；`/ask` task 会话不受影响。
- **权限边界**：`/role` 是唯一对全部私聊用户开放的斜杠命令；其他命令仍需目标 `allow_commands` + 用户白名单。Telegram/Discord/Slack 私聊 Chat 仍按现有目标 `allow_chat`，QQ C2C 沿用 v0.5.4 开放。
- **Discord/Slack**：Discord DM interaction 正确标记 `isDirect`；Discord/Slack 命令文本上限从 512 提升到 2048，容纳角色设定。
- **schema v11**：迁移 11 新增 `bot_chat_roles`；角色卡不通过 API/UI 暴露，随数据库备份。

### Deployment

- 版本/文档/`APP_VERSION` 升到 0.5.5；`deploy.ps1` smoke 期望 schema 11。
- 生产已部署 release `20261022T104834Z`（commit `a92c0a9`，schema v11，smoke 24/24）；私聊 `/role set/show/off/on` 与 Chat 人设生效/停用恢复已由用户实发确认。
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
