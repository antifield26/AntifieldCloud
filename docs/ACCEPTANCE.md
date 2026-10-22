# AntifieldCloud 验收记录

> 当前版本 v0.5.10（已部署并验收通过，用户实发 2026-10-22 23:26–23:29 CST；记忆/会话修复 + 移除代理隧道依赖）；v0.5.9（已部署并验收通过，用户实发 2026-10-22 22:39–22:41 CST；移除 `/ask`、限速放宽、`/help` 动态开放）；v0.5.8（已部署并验收通过，用户实发 2026-10-22 21:59–22:08 CST）/ v0.5.7 / v0.5.6 / v0.5.5 / v0.5.4 / v0.5.3 / v0.5.2 / v0.5.1 / v0.5.0 / v0.4.2 / v0.4.1 / v0.4.0 / v0.3.2 / v0.3.1 / v0.3.0 / v0.2.2 / v0.2.1 / v0.2.0 作为历史保留。v0.1.0 的交付摘要见 CHANGELOG。
>
> v0.5.1 已于 2026-10-21 部署到生产 Pi（release `20261021T091001Z`，schema v8，smoke 24/24）；QQ 真实回调与 `/help`、AI DeepSeek V4.1 Flash 真实回复、Cloudflare Access 主策略 + 4 个 bypass + service token 均已配置并验证。
>
> **v0.5.2 已部署**：2026-10-21 部署到生产 Pi（release `20261021T114908Z`，commit `abeabc7`，schema v9）；带 Cloudflare Access service token 的完整 smoke **24/24**。生产已开启 `BOT_DISCORD_GATEWAY_ENABLED=true`（日志 `Discord Gateway 已连接`）；Discord DM、Discord #general @Bot、QQ C2C 的普通消息 Chat 已由用户实发确认收到 AI 回复，`bot_ai_sessions`/`bot_ai_memories` 已写入；其他目标仍默认关闭。
>
> **v0.5.3 已部署**：2026-10-22 部署到生产 Pi（release `20261022T065126Z`，commit `df06383`，schema v9）；带 Cloudflare Access service token 的完整 smoke **24/24**。出站连通性探测已记录代理端口/外网/平台可达，断开 PC 隧道后检测为不可用、恢复后 Gateway 立即重连；OpenCode 已升级 v2.1.2。QQ 群事件已到达并定位为群目标未登记，登记 `68611590B477339A04302BB23B426244` 后用户确认 @Bot 已收到 AI 回复。
>
> **v0.5.4 已部署**：2026-10-22 部署到生产 Pi（release `20261022T085120Z`，commit `b2bdc8d`，schema v10）；带 Cloudflare Access service token 的完整 smoke **24/24**。`/ask` 任务模式、Chat 对话模式、QQ C2C 管理员/非管理员对话均实发确认；schema v9→v10 迁移通过，旧会话归 chat，task/chat 会话分离；共享长期记忆。
>
> **v0.5.5 已部署**：2026-10-22 部署到生产 Pi（release `20261022T104834Z`，commit `a92c0a9`，schema v11）；带 Cloudflare Access service token 的完整 smoke **24/24**。私聊 `/role set/show/off/on/delete` 与 Chat 人设生效/停用恢复已由用户实发确认；schema v10→v11 迁移通过。
>
> **v0.5.6 已部署**：2026-10-22 部署到生产 Pi（release `20261022T114546Z`，commit `38dfe70`，schema v11，无新迁移）；带 Cloudflare Access service token 的完整 smoke **24/24**。私聊/群聊默认 lofii、个人角色覆盖/`off` 回落、简洁 `/role` 文案均已由用户实发确认。
>
> **v0.5.7 已部署（含修复发布）**：2026-10-22 首次部署 release `20261022T131121Z`（commit `8dcd10f`，schema v12）后，生产只读验证发现错误提示映射缺陷（适配器包装消息如 `平台请求失败（0:qq_access_token_failed）` 的 `lastErrorHint` 为 null）；修复 commit `2f429be`（`fix(bot): 错误提示识别适配器包装消息中的平台错误码`），重新部署 release `20261022T131813Z`（commit `2f429be`，version 0.5.7/schema v12），current 指向该 release，另保留 `20261022T131121Z`、`20261022T114546Z`。第二次迁移前快照 `db-predeploy-20261022T131844841Z.sqlite`（sha256 `ad534db8ca5b806cf09b0abbd5ba7459a92fcfedad8d4d05afe9930e2df28794`）；`/healthz` = `{"ok":true,"version":"0.5.7","schemaVersion":12}`；部署内只读 smoke **16/16**、带 Access token 的完整 smoke **24/24**；重启后 Discord Gateway `已连接`（21:18:48）。生产只读复验通过：服务层 events/roles/memories/metrics/deliveries、`lastErrorHint` 对 `network`/`qq_access_token_failed` 均正确、`/` 与 `/bots` 页面及新 bundle 均 200。**真实平台消息级联调待用户实发验收；Discord 尚缺 `role`/`reset`/`forget` 斜杠命令注册（实测缺口）。**自 v0.5.8 起 Telegram/Discord/Slack 平台与相关能力移除，本节作为历史记录保留。
>
> **v0.5.8 已部署**：2026-10-22 部署到生产 Pi（release `20261022T134852Z`，commit `96294e4`，version 0.5.8/schema v13）；current 指向该 release，保留上一 release `20261022T131813Z`（v0.5.7）。迁移前 DB 快照（含删除前 Discord Bot 数据，供回滚）`db-predeploy-20261022T134921798Z.sqlite`（sha256 `fed84a0a4024ece85c4de50eabe41b20bf6a2d2821350d295d36faa1e98ec1ce`）；`/healthz` = `{"ok":true,"version":"0.5.8","schemaVersion":13}`；部署内只读 smoke **16/16**、带 Access token 完整 smoke **24/24**。迁移 13 后 `bots` 仅 1 行 QQ Bot（`2456ea90-7fed-42ec-81d0-9c478d2a9d47`/QQ 运维 Bot/enabled=1），原 Discord Bot `853f85e6…` 在目标/队列/事件/会话/记忆/角色/入站表均 0 行；QQ 数据保留（目标 2/投递 4/事件 44/会话 4/记忆 3/角色 1/入站 4）。前端 `/` 与 `/bots` 均 200（bundle `index-C-fPrxEf.js` 644795 bytes）；QQ 连接自检 `access_token 已获取`。**真实 QQ 消息级验收已由用户实发并于 2026-10-22 22:10 CST 确认通过**（21:59–22:08 CST 共 13 条真实入站事件全部符合预期；命令/自助命令/权限拒绝/文本 Chat 与图片端到端均有生产证据，详见下方“用户实发验收”）；用户原话“验收通过”。

> **v0.5.9 已部署**：2026-10-22 部署到生产 Pi（release `20261022T143451Z`，commit `97996dc`，version 0.5.9/schema v13，无迁移）；current 指向该 release，上一 release `20261022T134852Z`（v0.5.8）保留。
> 迁移前 DB 快照（无迁移，仅部署保护）`db-predeploy-20261022T143520649Z.sqlite`（sha256 `14ca82ed9cfc54556faeadc4914fb1c797fc177aa5d1f2b27d3b2db72e42968b`）；`/healthz` = `{"ok":true,"version":"0.5.9","schemaVersion":13}`；
> 部署内只读 smoke **16/16**、带 Access token 完整 smoke **24/24**（首次因 Cloudflare Access 请求 20s 超时 1 项失败，重试后全通过，无代码/服务异常）。
> 生产 env 迁移已完成（命令 120/AI 120/Chat 30、删除两个提示词变量、权限 640、APP_VERSION=0.5.9）；前端 `/` 与 `/bots` 200（bundle `index-CFrhFtH2.js` 644849 bytes）。
> **用户实发验收（通过，2026-10-22 22:39–22:41 CST）**：22:39:52 CST 非管理员 QQ 用户 `6B7DAC9B…` 实发 `/help`，`bot_events` 记录 `command/ok/command_help`、`audit_log` 记录 `command=help`，事件 200 ack 且命令正常回复（无异常投递）；22:41 CST 用户原话“验收通过”。管理员 `/help` 全量、`/ask` 只回帮助不调用 AI、放宽后限速体验、Chat/图片回归为用户口头确认通过（服务端无单独事件证据），详见下方 v0.5.9 段。

> **v0.5.10 已部署**：2026-10-22 部署到生产 Pi（release `20261022T152053Z`，commit `4619c91`，version 0.5.10/schema v13，无迁移）；current 指向该 release，上一 release `20261022T143451Z`（v0.5.9）保留。
> 迁移前 DB 快照（仅部署保护）`db-predeploy-20261022T152150860Z.sqlite`（sha256 `3e48eb3359c00408903adde5ac642dd9f2b190e106e2d502112c3ff3ce7078e6`）；`/healthz` = `{"ok":true,"version":"0.5.10","schemaVersion":13}`；部署内只读 smoke **16/16**、带 Access token 完整 smoke **24/24**。
> 生产 env 实测：`BOT_AI_MEMORY_RETENTION_DAYS=365`/`BOT_AI_MEMORY_BATCH_MESSAGES=3`/`BOT_AI_MEMORY_IDLE_FLUSH_SECONDS=120`；`HTTPS_PROXY`/`HTTP_PROXY`/`NODE_USE_ENV_PROXY`/`NO_PROXY`/`BOT_PROXY_URL` 均无；
> 直连 QQ `checkBot` ok（access_token 已获取），启动日志“Bot 连通性检查完成” detail 仅 `internet:true, platforms:["qq"]`（无 proxyPort）；PC 隧道任务/进程已移除、PC/Pi 均无 18090 监听；前端 bundle `index-Bx6EBCIp.js`（644262 bytes）含“Pi 直连”，不含“代理端口/设备在线”。
> 部署后增量备份 `snapshot-20261022T152331855Z-inc.tar.gz`（132980 bytes，sha256 `c53e4ab2c428ed7412363ebb9977e7458e8e7692edc0248213ce62f2be66d42c`）已拉取；密钥包 `secrets-20261022T152333Z.tar.age` secrets=ok。
> **用户实发验收（通过，2026-10-22 23:26–23:29 CST / UTC 15:26–15:29）**：用户 `5B7B32E7…` 实发 8 条事件全部 outcome=ok——4 条 Chat（含 1 条仅图片 `image/jpeg, size=145172`，`bot.ai.image` 记录 mime/size、`bot.ai.chat` 带 image 标志）、3 条 `/forget`（2 次 confirm：`bot.memory.forget removed:1`；1 次用法提示）、1 条 `/reset`（`bot.reset` 审计）。
> **合并摘要生效**：4 条 Chat 仅产生 1 次 `bot.ai.memory`，detail `rounds:3`（15:28:37Z）；**远端会话删除生效**：部署前快照会话 `ses_e9c15b42effez0wu1ngmcSY0Bd`（chat）与 `ses_e9c15a6fbffe2CLM753O0NNqoc`（旧摘要）在 `/forget confirm` 后经 OpenCode API 查询均为 404，该用户本地会话/记忆已清空，其他用户（`E259399F…`、`6B7DAC9B…`）会话/记忆保持 200 未受影响，无“删除远端 AI 会话失败”日志。
> 图片回归通过（真实 145172 B JPEG 端到端）；`/bots` 出站网络卡片按用户确认验收通过（服务端无单独 UI 证据）；23:29 CST 用户明确“完成验收”。详见下方 v0.5.10 段。

## v0.5.10（当前，已部署并验收通过；用户实发 2026-10-22 23:26–23:29 CST）

- 日期：2026-10-22（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64（release `20261022T152053Z`，commit `4619c91`，schema 13）+ Windows 本地工作区
- **状态**：已部署 v0.5.10/schema v13（无迁移），部署验证（env 实测、直连连通性、隧道清理、健康检查、两次 smoke、前端产物）通过。
  **用户实发验收于 2026-10-22 23:29 CST 确认通过**：合并摘要 rounds=3（4 条 Chat 仅 1 次摘要）、远端会话删除 404 两例且其他用户不受影响、真实图片 145172 B 端到端、`/forget confirm`/`/reset` 均有服务端证据；`/bots` 出站网络卡片为用户确认（服务端无单独 UI 证据）。
- **交付范围**：
  - **记忆摘要一次性**：每次摘要新建远端 OpenCode 会话并在 `finally` 删除；不再保存 `summary_session_id`（列保留兼容，旧值仅历史遗留）。
  - **记忆更新串行化**：按 Bot×用户队列串行更新，避免并发覆盖；摘要失败只记日志并保留旧摘要。
  - **合并策略/审计**：累计 `BOT_AI_MEMORY_BATCH_MESSAGES=3`（1–20）条或用户空闲 `BOT_AI_MEMORY_IDLE_FLUSH_SECONDS=120`（0 或 10–3600，0 关闭空闲触发）触发一次摘要；审计 `bot.ai.memory` 增加 `rounds`。
  - **保留期分离**：AI 会话映射保留 7 天（`BOT_AI_SESSION_RETENTION_DAYS`）；长期记忆保留 `BOT_AI_MEMORY_RETENTION_DAYS=365`（30–3650），互不影响。
  - **远端会话清理增强**：`/reset`、`/forget confirm`、角色卡变更（含管理员删除角色）清理本地映射时尽力删除远端 OpenCode 会话与旧摘要会话。
  - **移除代理隧道依赖**：删除 `scripts/discord-tunnel.ps1`/`discord-tunnel.vbs`/`install-tunnel-task.ps1` 与 PC 计划任务 `AntifieldCloudDiscordTunnel`；删除 `BOT_PROXY_URL`；
    生产 env 删除 `HTTPS_PROXY`/`HTTP_PROXY`/`NODE_USE_ENV_PROXY`/`NO_PROXY`；连通性只探测外网 + QQ 平台（Pi 直连），`BotConnectivitySnapshot` 去掉 `deviceOnline`/`proxy`。
  - **版本/数据**：version 0.5.10；schema 保持 v13（无迁移）；`scripts/deploy.ps1` 无需改（期望 schema 13 不变）。
- **本地验证**（Lead 实测 2026-10-22）：`npm test` **341**（v0.5.9 的 333 + 新增 8 个 v0.5.10 用例：摘要一次性/删除、合并/空闲/并发串行、`/forget` 与 `/reset` 远端删除、记忆/会话保留期分离）、
  `npm run test:web` **157**（30 文件）、`npm run typecheck` 通过；`npm run test:coverage` exit 0（Lines **91.98%** / Branches **76.92%** / Functions **85.99%**）、`npm run build` 通过。
- **部署验证**：
  - release `20261022T152053Z`（commit `4619c91`，version 0.5.10/schema v13）已切换并重启；current 指向该 release，上一 release `20261022T143451Z`（v0.5.9）保留；schema 无迁移。
  - 迁移前 DB 快照（仅部署保护）：`db-predeploy-20261022T152150860Z.sqlite`（sha256 `3e48eb3359c00408903adde5ac642dd9f2b190e106e2d502112c3ff3ce7078e6`）。
  - `/healthz` = `{"ok":true,"version":"0.5.10","schemaVersion":13}`；部署内只读 smoke **16/16**；带 Cloudflare Access service token 完整 smoke **24/24**。
  - **生产 env 实测**：`BOT_AI_MEMORY_RETENTION_DAYS=365`、`BOT_AI_MEMORY_BATCH_MESSAGES=3`、`BOT_AI_MEMORY_IDLE_FLUSH_SECONDS=120`；`HTTPS_PROXY`/`HTTP_PROXY`/`NODE_USE_ENV_PROXY`/`NO_PROXY`/`BOT_PROXY_URL` 均无；
    运行时 `botAiMemoryRetentionDays=365`、`botAiMemoryBatchMessages=3`、`botAiMemoryIdleFlushSeconds=120`、`botAiSessionRetentionDays=7`，config 中无 proxy 字段。
  - **直连与连通性**：无代理环境下 QQ `checkBot` ok（access_token 已获取）；启动日志“Bot 连通性检查完成” detail 仅 `internet:true, platforms:["qq"]`（无 proxyPort）。
  - **PC 隧道清理**：计划任务 `AntifieldCloudDiscordTunnel` 已移除、无隧道进程、PC/Pi 均无 `18090` 监听；仓库隧道脚本已删除。
  - **前端产物**：带 Access token 访问 `/` 与 `/bots` 均 **200**；新 bundle `/assets/index-Bx6EBCIp.js`（644262 bytes），含“Pi 直连”，**不含**“代理端口”“设备在线”。
  - **部署后备份**：增量 `snapshot-20261022T152331855Z-inc.tar.gz`（132980 bytes，sha256 `c53e4ab2c428ed7412363ebb9977e7458e8e7692edc0248213ce62f2be66d42c`）已由 PC `backup-pull` 拉取并 ack；密钥包 `secrets-20261022T152333Z.tar.age` 拉取成功，`secrets=ok`。
- **用户实发验收（通过，2026-10-22 23:26–23:29 CST / UTC 15:26–15:29）**：
  1. **事件与自助命令**：用户 `5B7B32E7…` 实发 8 条事件全部 outcome=ok：4 条 Chat、3 条 `/forget`（2 次 confirm：`bot.memory.forget removed:1`；1 次用法提示）、1 条 `/reset`（`bot.reset` 审计）。
  2. **合并摘要（有服务端证据）**：4 条 Chat 仅产生 1 次 `bot.ai.memory`，detail `rounds:3`（15:28:37Z），明显少于 Chat 次数，证明“3 条或空闲 120s 触发一次”。
  3. **远端会话删除（有服务端证据）**：部署前快照的两个会话 `ses_e9c15b42effez0wu1ngmcSY0Bd`（chat）与 `ses_e9c15a6fbffe2CLM753O0NNqoc`（旧摘要会话），在 `/forget confirm` 后经 OpenCode API 查询均为 **404**；
     该用户本地 `bot_ai_sessions`/`bot_ai_memories` 已清空；其他用户（`E259399F…`、`6B7DAC9B…`）的会话/记忆保持 200/未受影响；无“删除远端 AI 会话失败”日志。
  4. **图片回归（有服务端证据）**：真实图片消息 `image/jpeg, size=145172` 端到端成功，`bot.ai.image` 记录 mime/size、`bot.ai.chat` 带 image 标志。
  5. **出站网络卡片**：`/bots` 卡片只显示外网/QQ 平台、无代理端口/设备在线，检测可用——用户确认验收通过（服务端无单独 UI 证据，如实记录）。
  6. 用户于 **23:29 CST** 明确“完成验收”。
- **回滚**：schema 无迁移；切回 release `20261022T143451Z`（v0.5.9）并还原 env 备份（含代理变量与旧 `BOT_PROXY_URL`）+ 恢复旧隧道脚本/计划任务后重启；无 schema 回滚需求。
## v0.5.9（历史，已部署并验收通过；用户实发 2026-10-22 22:39–22:41 CST；v0.5.10 起移除代理隧道依赖）

- 日期：2026-10-22（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64（release `20261022T143451Z`，commit `97996dc`，schema 13）+ Windows 本地工作区
- **状态**：已部署 v0.5.9/schema v13（无迁移），部署验证（env 迁移、健康检查、两次 smoke、运行时配置、前端产物）通过。
  **用户实发验收于 2026-10-22 22:41 CST 确认通过**：非管理员 `/help` 有服务端事件证据（22:39:52 `command/ok/command_help`），其余项目为用户口头确认通过（服务端无单独事件证据，详见“用户实发验收”）。
- **交付范围**：
  - **移除 `/ask`**：`BOT_COMMANDS` 删除 `ask`，现为 `/help /status /backup /world /mc /files /role /reset /forget`；`/ask` 作为未知命令——非管理员被拒（`bot.command.denied`、无回复），
    管理员回全量帮助、不调用 AI；斜杠命令不再触发 AI。
  - **AI 仅普通消息 Chat**：提示词固定为「角色卡（个人卡或默认 lofii）+ 固定只读安全边界 + 长期记忆 + 用户消息」；`BotAiMode`/task 提示词移除；
    `BOT_AI_TASK_PROMPT`/`BOT_AI_CHAT_PROMPT` 从 `config.ts`/`bootstrap-env.sh`/`env.example` 删除；`bot_ai_sessions.mode` 列保留但只写 `chat`（旧 task 行为历史遗留）；
    `/reset` 与角色卡变更清理该范围全部会话映射；审计 `bot.ai.chat` 不再记录 `mode`。
  - **限速宽松档**：`BOT_CHAT_RATE_PER_MINUTE=30`（1–120）、`BOT_AI_RATE_PER_HOUR=120`（1–600）、`BOT_COMMAND_RATE_PER_MINUTE=120`（1–600）；
    限流仍按 Bot×用户维度，超限回复中文提示并写 `rate_limited` 诊断事件。
  - **`/help` 自助且动态**：`/help` 与 `/role`（私聊）、`/reset`、`/forget confirm` 一样对全部用户开放；非管理员仅公开命令 + Chat 说明（`publicHelpText()`），
    管理员全量（`helpText()`，无 `/ask`）；未知命令对管理员回全量帮助、对非管理员被拒。
  - **版本/数据**：version 0.5.9；schema 保持 v13，无迁移；`deploy.ps1` 期望 `-ExpectedSchemaVersion 13` 不变。
  - **文档**：BOT/API/AGENTS/README/CHANGELOG/ROADMAP/PLAN/DEPLOY/SECURITY/UI-SPEC 全量同步；历史验收段落保留，v0.5.9 起 `/ask`/task 模式标注移除。
- **本地验证**（Lead 实测 2026-10-22）：`npm test` **333**（server + 运维脚本；较 v0.5.8 的 337 少 4 个已移除的 /ask/task 用例）、`npm run test:web` **157**（30 文件）、
  `npm run check` 通过；`npm run test:coverage` 通过（Lines **91.77%** / Branches **76.98%** / Functions **85.96%**）；`npm run build` 通过。
- **部署验证**：
  - release `20261022T143451Z`（commit `97996dc`，version 0.5.9/schema v13）已切换并重启；current 指向该 release，上一 release `20261022T134852Z`（v0.5.8）保留；schema 无迁移。
  - 迁移前 DB 快照（无迁移，仅部署保护）：`db-predeploy-20261022T143520649Z.sqlite`（sha256 `14ca82ed9cfc54556faeadc4914fb1c797fc177aa5d1f2b27d3b2db72e42968b`）。
  - **生产 env 迁移已完成**：`BOT_COMMAND_RATE_PER_MINUTE=120`、`BOT_AI_RATE_PER_HOUR=120`、`BOT_CHAT_RATE_PER_MINUTE=30`（原旧值/缺失 20、10）；
    `BOT_AI_TASK_PROMPT`/`BOT_AI_CHAT_PROMPT` 已删除（计数 0）；env 权限保持 `640 root:antifieldcloud`；`APP_VERSION=0.5.9`；
    原 env 备份 `/var/lib/antifieldcloud/env-backup-v058-20261022223449.bak`（供回滚）。
  - `/healthz` = `{"ok":true,"version":"0.5.9","schemaVersion":13}`；部署内只读 smoke **16/16**；带 Cloudflare Access service token 完整 smoke **24/24**
    （首次因 Access 请求 **20s 超时**导致 1 项失败，重试后全通过；无代码/服务异常）。
  - **运行时配置实测**：`appVersion=0.5.9`、`botChatRatePerMinute=30`、`botAiRatePerHour=120`、`botCommandRatePerMinute=120`、`botAiVisionEnabled=true`、`botAiEnabled=true`。
  - **前端产物**：带 Access token 访问 `/` 与 `/bots` 均 **200**；新 bundle `/assets/index-CFrhFtH2.js`（644849 bytes）；bundle 含“每分钟 30 次”新限速文案与“AI 对话由普通消息 Chat 承担”，**不含 `/ask`**。
  - 部署后增量备份：`snapshot-20261022T143749907Z-inc.tar.gz`（131088 bytes，sha256 `702a0d42221939a0d9e6b5bd2509dfa18ccf4e62622991d98e02de53b055c5a4`）已由 PC `backup-pull` 拉取并 ack（PC 侧 daily 目录）；密钥包 `secrets-20261022T143751Z.tar.age` 拉取成功，`secrets=ok`。
  - 回滚：schema 无回滚需求；切回 release `20261022T134852Z`（v0.5.8）+ 还原 env 备份（20/10/6 与两个提示词键占位）+ 重启。
- **用户实发验收（通过，2026-10-22 22:39–22:41 CST）**：
  1. **非管理员 `/help`（有服务端证据）**：22:39:52 CST（UTC 14:39:52）非管理员 QQ 用户 `6B7DAC9B…` 实发 `/help`；`bot_events` 记录 `event_kind=command, outcome=ok, detail=command_help`，`audit_log` 记录 `bot.command`（`command=help`）；
     事件 200 ack 且命令正常回复，无异常投递。自 v0.5.9 部署（22:35 CST）以来生产仅有这 1 条真实入站事件。
  2. **管理员 `/help` 全量、`/ask` 只回帮助且不调用 AI、放宽后限速体验（30/min、120/hour、命令 120/min）、普通 Chat/图片回归**：用户口头确认通过；服务端无单独事件证据，本段如实记录为“用户确认”，不写成自动验证。
  3. 用户于 **22:41 CST** 原话确认“验收通过”。
- **回滚**：schema 未变（v13），切回 release `20261022T134852Z`（v0.5.8）并还原 env 备份（`BOT_COMMAND_RATE_PER_MINUTE=20`、`BOT_AI_RATE_PER_HOUR=10`、`BOT_CHAT_RATE_PER_MINUTE=6`；两个提示词键占位）后重启；无 schema 回滚需求。
## v0.5.8（历史，已部署并验收通过；用户实发 2026-10-22 21:59–22:08 CST；v0.5.9 起移除 /ask 与 task 模式）

- 日期：2026-10-22（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64（release `20261022T134852Z`，commit `96294e4`，schema 13）+ Windows 本地工作区
- **状态**：已部署 v0.5.8/schema v13，部署验证（迁移 13、健康检查、两次 smoke、运行时配置、QQ 连通性、前端产物、webhook 负路径）通过；**用户实发验收已于 2026-10-22 22:10 CST 确认通过**（21:59–22:08 CST 真实 QQ 消息，13 条入站事件全部符合预期，图片端到端通过），详见下方“用户实发验收”。
- **交付范围**：
  - **平台收敛**：Bot 仅支持 QQ 官方 Bot；删除 Telegram/Discord/Slack 适配器、`discord-gateway.ts`、只读按钮、媒体/多附件发布、群聊触发方式（`chatTrigger`）、
    Telegram HTML/引用/线程；公开 Webhook 只接受 QQ。删除 env：`BOT_DISCORD_GATEWAY_ENABLED`、`BOT_PUBLISH_MAX_MEDIA_BYTES/FILES/TOTAL_BYTES`。
  - **schema v13（迁移 13）**：`DELETE FROM bots WHERE platform <> 'qq'`，级联删除非 QQ Bot 的目标/队列/事件/会话/记忆/角色卡；迁移 5–12 保留；
    迁移前已备份生产 Discord Bot 数据（DB 快照覆盖）。迁移不可逆，回滚只能还原迁移前快照。
  - **QQ 单平台能力保留**：QQ 官方 Bot 接入（AppID/AppSecret/op=13 回调与 op=0 Ed25519 验签）、命令（`/help /status /backup /world /mc /files /ask /role /reset /forget`）、
    C2C/群@/频道 Chat、长期记忆、私聊角色卡、事件诊断、平台连接自检（`access_token`）、角色/记忆元数据管理、文本发布（TOTP + `PUBLISH`，≤2000 分段）。
  - **QQ 入站图片理解默认开启**：`BOT_AI_VISION_ENABLED=true`；QQ `d.attachments` 中 image/* 附件经 `.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（QQ 实际图床如 `multimedia.nt.qq.com.cn`） 域名后缀白名单、
    image mime 白名单、≤`BOT_AI_IMAGE_MAX_BYTES`、内存不落盘下载后，以 OpenCode prompt files 交给模型 provider（图片会外发给模型服务，SECURITY 已写明）；
    失败/关闭降级为纯文字回答；QQ 群/频道仅 @Bot 事件，图片消息同样受平台限制。
  - **API/UI 收敛**：`BotPlatform` 仅 `qq`；`BotSummary` 无 `gateway`、`BotTarget` 无 `chatTrigger`、`BotPublishJob` 无 `mediaFileIds`；
    删除 `chat_trigger_unsupported` 与媒体相关错误码；Web `/bots` 去掉 Gateway/媒体选择/触发方式，保留 6 分区（概览/配置/目标/投递与发布/角色与记忆/诊断）。
  - **文档**：BOT.md 重写为 QQ 单平台（含 attachments 字段/域名白名单/腾讯平台限制）；API/UI-SPEC/SECURITY/ARCHITECTURE/DEPLOY/README/AGENTS/CHANGELOG/ROADMAP/PLAN 全量同步；
    v0.5.0–v0.5.7 历史验收记录保留并标注“v0.5.8 起移除”。
- **本地验证**（Lead 全量实测 2026-10-22）：`npm test` **337**（服务端 321 + 运维脚本 16）、`npm run test:web` **157**（30 文件）、`node scripts/check-version.mjs` 通过；`npm run check` 通过（typecheck/lint/server/web 全绿）；`npm run test:coverage` 通过（Lines 91.78% / Branches 77.06% / Functions 86.12%）；`npm run build` 通过。
- **部署验证**：
  - release `20261022T134852Z`（commit `96294e4`，version 0.5.8/schema v13）已切换并重启；current 指向该 release，上一 release `20261022T131813Z`（v0.5.7）保留。
  - 迁移前 DB 快照（含删除前 Discord Bot 数据，供回滚）：`/var/lib/antifieldcloud/backups/db-predeploy-20261022T134921798Z.sqlite`（sha256 `fed84a0a4024ece85c4de50eabe41b20bf6a2d2821350d295d36faa1e98ec1ce`）。
  - `/healthz` = `{"ok":true,"version":"0.5.8","schemaVersion":13}`；部署脚本内部只读 smoke **16/16**；带 Cloudflare Access service token 的完整 smoke **24/24**。
  - **迁移 13 校验**：`bots` 仅剩 1 行 QQ Bot（`2456ea90-7fed-42ec-81d0-9c478d2a9d47`/QQ 运维 Bot/enabled=1）；原 Discord Bot `853f85e6…` 在 `bot_targets`/`bot_deliveries`/`bot_events`/`bot_ai_sessions`/`bot_ai_memories`/`bot_chat_roles`/`bot_inbound_targets` 均为 0 行；QQ 数据保留（targets 2 / deliveries 4 / events 44 / sessions 4 / memories 3 / roles 1 / inbound 4）；`chat_trigger` 列按设计保留但不读写。
  - **运行时配置**：`botAiVisionEnabled=true`（默认开启）、`botAiImageMaxBytes=10485760`、`botAiMaxReplyChars=4000`；`BOT_ENABLED`/`BOT_AI_ENABLED` 均为 true。
  - **连通性/Gateway**：出站连通性探测仅 `platforms:["qq"]`；新进程无 Discord Gateway；旧进程在切换时 `Discord Gateway 已停止`。
  - **前端产物**：带 Access token 访问 `https://app.antifield.work/` 与 `/bots`（Accept: text/html）均 **200**；新 bundle `/assets/index-C-fPrxEf.js`（644795 bytes）与 `/assets/index-BJSYA4Y6.css`；bundle 含「AppID/检查连接/角色与记忆/诊断」，**不含**「Discord Gateway/Telegram/Slack」。
  - **QQ Webhook 真实网络负路径**：`op=0` 无签名 → **401 `invalid_signature`**；`op=99` → **200 `{"ok":true}`**（仅确认不处理）；未知 bot → **404**。
  - **QQ 连接自检（真实网络）**：`access_token 已获取`，ok（经 PC 代理隧道）。
  - **QQ Webhook 端到端合成自检（非真实平台消息，2026-10-22 21:56）**：用生产 QQ AppSecret 派生密钥对合成事件签名后 POST 本机 webhook——① op=13 回调校验返回 **200** 且签名格式正确；② 合成 `/help` C2C 事件返回 **200 `{"opcode":12}`**，事件记录为 `command/denied`（假 openid 未登记命令白名单，符合预期）；③ 合成“仅图片无正文”C2C 事件返回 **200**，审计 `bot.chat` 记录 `chars:0, image:"image/png", open:qq_c2c`，日志出现“Bot 入站图片处理失败，降级为纯文本”（探测 URL 不存在，验证降级路径），因假 `msg_id` 回复发送失败属预期。自检后已清理探测事件/入站记录（仅保留审计），**该自检不能替代用户真实 QQ 消息验收**。
  - **OpenCode 视觉链路复验（2026-10-22 21:56）**：在生产 OpenCode 上用临时会话发送 data URL 图片，模型正确返回颜色（“粉色”），随后删除会话；说明“图片→模型”路径可用；QQ 真实入站图片已于 2026-10-22 21:59–22:08 CST 实发验收通过。
  - **QQ attachments 契约核对**：对照 QQ 官方文档（[单聊消息事件](https://bot.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html) / 群@事件），`attachments[]` 字段为 `url/filename/width/height/size/content_type`（`image/jpeg|image/png|image/gif` 等），与适配器实现一致；图床域名后缀白名单覆盖 `.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（实际图床如 `multimedia.nt.qq.com.cn`）。实现只取首个 `image/*`、仅图片无正文也进入 Chat、内存下载不落盘、失败降级为纯文字。
  - 部署后增量备份：`snapshot-20261022T135052128Z-inc.tar.gz`（126419 bytes，sha256 `262afd2d4cbd39c2ae12ab5ae152517f0ff470e59cfc9b641aed5982b56fb78a`）已由 PC `backup-pull` 拉取并 ack（PC 侧 `daily/2026-10-22` 目录）；密钥包 `secrets-20261022T135053Z.tar.age` 拉取成功，`secrets=ok`。
- **用户实发验收（通过，2026-10-22 21:59–22:08 CST）**：生产 13 条真实 QQ 入站事件全部符合预期（来源 C2C 管理员 `5B7B32E7…` 与 `6B7DAC9B…`）；用户于 22:10 CST 确认“验收通过”。证据逐条如下：
  1. **文本命令**：`/help` → ok（14:08:04Z）；`/forget`（confirm）→ `command_forget` ok + 审计 `bot.memory.forget removed:1`（14:00:04Z）；`/reset` → ok + 审计 `bot.reset`（13:59:47Z、14:07:43Z）；`/role`（show/set/off/on/delete）→ ok + 审计 `bot.role` delete（14:07:34Z）。
  2. **权限边界**：`6B7DAC9B…` 于 14:06:26Z 一条命令被拒（`bot.command.denied`），随后 `/role` 正常开放（自助命令绕过白名单），符合目标 `allow_commands` + 用户双白名单与自助命令例外设计。
  3. **文本 Chat**：14:01:01Z、14:03:25Z 两条普通消息 → `bot.ai.chat`（`mode=chat`）并写入 `bot.ai.memory`；`bot_ai_sessions` 更新 14:03:53Z、`bot_ai_memories` 更新 14:03:59Z，会话/记忆链路正常。
  4. **QQ 图片理解端到端**：14:03:36Z 真实图片消息（仅图片、`chars:0`）→ `bot.chat` 记录 `chars:0, image:"image/jpeg"`；`bot.ai.image` 记录 `mime=image/jpeg, size=148563`；`bot.ai.chat` 记录 `image` 标志；事件 outcome=`ok`；随后 `bot.ai.memory` 更新（14:03:59Z）——证明 attachments 解析 → 域名/大小/mime 校验 → 内存下载 → OpenCode 视觉 → 回复 → 记忆整条链路成功。
  5. 实测期间无 `bot_deliveries` 失败、无 `bot_publish_jobs` 记录。
  6. **诊断/角色与记忆/检查连接面板与文本发布**：用户确认整体验收通过；服务端未单独留存 UI 面板交互与发布任务证据（`bot_publish_jobs` 无记录），此处按“用户确认验收通过”如实记录，不写成自动验证通过。
- **回滚**：schema 13 迁移不可逆（非 QQ Bot 数据已删除），回滚必须恢复迁移前快照 `db-predeploy-20261022T134921798Z.sqlite` 并同步还原 `APP_VERSION`、切回 `20261022T131813Z`；回滚窗口内保持 `BOT_ENABLED`/`BOT_AI_ENABLED=false`。

## v0.5.7（历史，已部署；真实平台消息级联调待用户实发；自 v0.5.8 起移除多平台能力）

- 日期：2026-10-22（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64（release `20261022T131813Z`，commit `2f429be`，schema 12）+ Windows 本地工作区
- **状态**：已部署 v0.5.7/schema v12（当前 release `20261022T131813Z`，含错误提示映射修复 `2f429be`）；部署验证、迁移、健康检查、smoke、Discord Gateway 与生产只读服务层/前端产物验证已通过。
  **真实平台消息级联调（`/reset`、`/forget confirm`、分段/Markdown、群聊引用、all 触发、图片、诊断/角色/记忆面板实际交互）尚未由用户实发验收**，完成前不得声明该部分通过。
- **交付范围**：
  - schema v12（迁移 12）：`bot_targets.chat_trigger`、`bot_events` 诊断列与索引。
  - 群聊触发策略（目标级 mention/all；QQ 群/频道仅 @；message 触发未授权时静默）；引用回复/线程（Telegram `reply_to_message_id`、Slack `thread_ts`、Discord `message_reference`）；长回复按平台上限分段（最多 4 段、续段前缀、超限截断、Telegram HTML 安全分段、partial 不自动重试）；Markdown 平台化（Telegram HTML / Discord markdown / Slack mrkdwn / QQ 纯文本）。
  - 图片理解（默认关闭）：Telegram photo/document、Discord/Slack 图片附件、固定域名下载、image mime 白名单、≤`BOT_AI_IMAGE_MAX_BYTES`、不落盘、失败降级；QQ 不支持。生产已完成只读验证：OpenCode prompt files data URL + `opencode-go/deepseek-v4.1-flash` 支持 image。
  - 自助命令 `/reset`、`/forget confirm`（所有用户）；`/help` 更新。
  - `POST /api/bots/:id/check` 连接自检；`GET /api/bots/:id/events` 诊断事件（无正文）；deliveries/publish/metrics 的 `lastErrorHint`。
  - 角色/记忆管理 API（仅元数据、可启停/删除）；目标 `chatTrigger`；Web `/bots` 6 标签与新面板。
  - 新 env：`BOT_AI_MAX_REPLY_CHARS=4000`、`BOT_AI_VISION_ENABLED=false`、`BOT_AI_IMAGE_MAX_BYTES=10485760`。
- **本地验证**：`npm test` 387（服务端 + 运维脚本）、`npm run test:web` 157（30 文件）、`node scripts/check-version.mjs` 通过；`npm run check`、`test:coverage`、`test:web:coverage`、`npm run build` 均通过（Lead 最终验证）。
- **部署验证**：
  - **修复发布**：首次部署 release `20261022T131121Z`（commit `8dcd10f`）后，生产只读验证发现 **`lastErrorHint` 对适配器包装消息识别失败**（如 `平台请求失败（0:qq_access_token_failed）` 返回 null）；修复 commit `2f429be`（`fix(bot): 错误提示识别适配器包装消息中的平台错误码`），重新部署 release `20261022T131813Z`（commit `2f429be`，version 0.5.7/schema v12）；current 指向该 release，保留 `20261022T131121Z`、`20261022T114546Z`。
  - 第二次迁移前 DB 快照：`/var/lib/antifieldcloud/backups/db-predeploy-20261022T131844841Z.sqlite`（sha256 `ad534db8ca5b806cf09b0abbd5ba7459a92fcfedad8d4d05afe9930e2df28794`）；首轮快照 `db-predeploy-20261022T131150335Z.sqlite` 保留；schema v11→v12 迁移（首轮）与修复重部署均成功。
  - `/healthz` = `{"ok":true,"version":"0.5.7","schemaVersion":12}`；部署脚本内部只读 smoke **16/16**；带 Cloudflare Access service token 的完整 smoke 再次 **24/24**；重启后 `Discord Gateway 已连接`（2026-10-22 21:18:48，bot `853f85e6-f757-4060-8692-19ec06dea4aa`）。
  - schema 校验：`bot_targets.chat_trigger` 存在，5 个既有目标全部为默认 `mention`；`bot_events` 的 event_kind/outcome/detail/target_external_id/user_id/updated_at 6 列存在（修复重部署无新迁移）。
  - **错误提示映射修复生产复验**：Discord dead 投递 `平台请求失败（0:network）` → “出站网络不可用：检查 Pi 出站代理/隧道与 BOT_PROXY_URL”；QQ dead 投递 `平台请求失败（0:qq_access_token_failed）` → “QQ access_token 获取失败：检查出站网络/代理与 AppSecret”；`metrics.lastErrorHint` 同步返回对应中文提示。
  - **生产服务层只读验证**：对真实 DB 只读调用 `listEvents`/`listRoles`/`listMemories`/`metrics`/`listDeliveries` 均通过；角色/记忆列表只返回元数据（未含 prompt/summary 正文）；events 查询正常（部署后暂无新入站事件）。
  - **前端产物核验**：带 Access token 访问 `https://app.antifield.work/` 与 `/bots`（`Accept: text/html`）均 **200**；HTML 引用的新 bundle `/assets/index-CH38JtCp.js`、`/assets/index-BJSYA4Y6.css` 均 **200**（刷新后加载新版本）；部署 bundle 内已确认包含「角色与记忆」「诊断」「全部消息」「检查连接」「lastErrorHint」「重置当前对话」「清除长期记忆」等 v0.5.7 文案。
  - **Webhook 真实网络负路径验证**：无签名 `POST /api/bot/webhook/<botId>`（Discord/QQ 各一次）均返回 **401 `invalid_signature`**；未知 `botId` 返回 **404**；Cloudflare Access 对 webhook 路径 bypass 生效（不带 Access token 也能到达应用鉴权层）。QQ 非 `op=0/13` 回调返回 **200 `{ok:true}`**(仅确认不处理)；审计写入 `bot.webhook.rejected`，**拒绝事件不写入 `bot_events`**（不可信输入不落诊断表，符合设计）。
  - **Discord 命令注册实测（只读）**：global + guild `950388705846255688` 现有 `/status`、`/backup`、`/world`、`/mc`、`/files`、`/help`、`/ask`；**缺 `/role`、`/reset`、`/forget`**（属用户在 Developer Portal 的平台后台步骤；Telegram/QQ 无需注册，Slack 尚未配置）。
  - 第二次部署后增量备份：`snapshot-20261022T132013585Z-inc.tar.gz`（125874 bytes，sha256 `fb01cc1724b32c4f3db6608934cf0cd9a622f67bf1c4b17ff171170093cbe423`）已由 PC 侧 `backup-pull` 拉取并 ack（保存于 PC 侧 `daily/2026-10-22` 目录）；密钥包 `secrets-20261022T132014Z.tar.age` 拉取成功，`secrets=ok`。
  - 真实网络平台连接自检（首轮部署记录）：Discord `@lofii.bot`（`1562353648732868709`）ok、QQ access_token 获取 ok（经 PC 代理隧道）；页面“检查连接”展示脱敏结果。
- **待用户实发验收项**（用户实际发送消息/操作后回填证据）：
  1. 自助命令与平台注册：实际发送 `/reset` 与 `/forget confirm`（确认会话/记忆清理与审计；`/forget` 无参数时只返回用法）。**Discord 当前缺 `/role`、`/reset`、`/forget` 斜杠命令注册**（实测 global + guild `950388705846255688` 仅有 `status/backup/world/mc/files/help/ask`），需在 Developer Portal 补注册后才能实发；Telegram/QQ 无需注册，Slack 尚未配置。
  2. 回复形态：长回复分段（续段前缀/截断）、Markdown 展示、群/频道引用或线程（Telegram/Discord/Slack）。
  3. 触发方式：默认 `mention` 生效；“全部消息”按平台前置逐个验证（Telegram 关 privacy mode、Discord Message Content Intent、Slack 订阅 `message.channels`）；QQ 群/频道仅 @。
  4. 连接自检与诊断：`POST /api/bots/:id/check` 结果、`GET /api/bots/:id/events` 事件/筛选、`lastErrorHint`；`/bots` 角色与记忆面板启停/删除实际交互（仅元数据）。
  5. 图片理解：确认关闭时降级提示；在用户同意下临时开启验证一张图片（不落盘、失败降级），随后恢复 `BOT_AI_VISION_ENABLED=false`；QQ 不支持。
  6. 失败/partial 场景（长回复中途失败、附件部分外发）不自动重试；迁移前快照与回滚路径可用（本次快照已确认存在）。
- **回滚**：迁移 12 只加列/索引；回滚必须恢复迁移前 DB 快照（当前 release 对应 `db-predeploy-20261022T131844841Z.sqlite`；回退首轮 v0.5.7 用 `db-predeploy-20261022T131150335Z.sqlite`；回退 v0.5.6 用 `db-predeploy-20261022T114615308Z.sqlite`）并同步还原 `APP_VERSION`，窗口内保持 `BOT_ENABLED`/`BOT_AI_ENABLED`/`BOT_DISCORD_GATEWAY_ENABLED`/`BOT_AI_VISION_ENABLED=false`。

## v0.5.6（历史，已部署）

- 日期：2026-10-22（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64（release `20261022T114546Z`，schema 11）+ Windows 本地工作区
- **默认角色**：内置猫系轻松伙伴 `lofii`，私聊/群聊普通对话默认使用；语气轻松，正事认真。
- **个人角色**：`/role` 仍对全部平台私聊用户开放；个人卡启用时覆盖默认；`/role off` 收起个人卡并回落到 lofii；`/role delete` 同样回到默认。
- **群聊**：普通对话固定 lofii；群内 `/role` 只回复友好提示，不读取/修改个人角色。
- **文案**：`/role` 用法、设置/停用/删除回复与错误提示只写当前角色与分支命令，不注入默认角色个性，也不出现技术术语；Chat 异常回复改为中性说法。
- **兼容**：schema 保持 v11；`BOT_AI_CHAT_PROMPT` 不再影响 Chat；`/ask`、任务提示、个人卡与记忆不变。
- **本地验证**：`npm test` 324、`test:web` 141、`check-version`、coverage。
- **部署验证**：`/healthz` `{"ok":true,"version":"0.5.6","schemaVersion":11}`；完整 smoke **24/24**；迁移前快照 `db-predeploy-20261022T114615308Z.sqlite`（sha256 `5ce4e642…`）。
- **真实对话**：用户确认私聊/群聊默认 lofii 正常、个人卡 `off` 回落正常；群内 `/role` 返回提示；二次复核确认 `/role` 文案仅含当前角色与命令用法。
- **备份**：部署后 inc `snapshot-20261022T115427825Z-inc.tar.gz`（113205 bytes，sha256 `9b7c1ef5…`）已由 Windows 计划任务拉取并 ack，`secrets=ok`。

## v0.5.5（历史，已部署）

- 日期：2026-10-22（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64（release `20261022T104834Z`，schema 11）+ Windows 本地工作区
- **角色卡**：`/role` 对全部平台私聊用户开放，`set/show/off/on/delete`；每 Bot×用户一张“名字+设定”卡；名字≤32、设定≤1000；保留提示词标记被拒绝。
- **Chat 集成**：仅私聊 Chat 使用启用卡；替换默认 Chat 风格；安全边界与共享记忆仍追加；`/ask` 与群/频道不使用；角色变更重置 chat 会话映射。
- **权限**：仅 `/role` 绕过命令白名单；其他命令仍要求目标 `allow_commands` + 用户白名单；Telegram/Discord/Slack 私聊 Chat 仍按目标 `allow_chat`，QQ C2C 沿用 v0.5.4。
- **schema v11**：新增 `bot_chat_roles`；Discord DM `isDirect` 修正；Discord/Slack 命令文本上限 2048。
- **本地验证**：`npm test` 324、`test:web` 141、`check-version`、coverage；迁移 v6→v11、v9→v11、v10→v11 测试通过。
- **部署验证**：`/healthz` `{"ok":true,"version":"0.5.5","schemaVersion":11}`；完整 smoke **24/24**；迁移前快照 `db-predeploy-20261022T104901134Z.sqlite`（sha256 `33a09f1f…`）。
- **真实对话**：用户确认 `/role set`、`/role show`、Chat 角色生效、`/role off` 后恢复默认均正常；审计 `bot.role` 只记录动作与长度，`bot.ai.chat` 含 `role:true`；`bot_ai_sessions` 角色变更后出现新 chat 会话。
- **备份**：部署后 inc `snapshot-20261022T105908606Z-inc.tar.gz`（109566 bytes，sha256 `f27d1665…`）已由 Windows 计划任务拉取并 ack，`secrets=ok`。

## v0.5.4（历史，已部署）

- 日期：2026-10-22（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64（release `20261022T085120Z`，schema 10）+ Windows 本地工作区
- **双模式提示词**：`/ask` 任务导向、普通 Chat 对话导向；Chat 不再声明 AntifieldCloud/助手身份、不主动谈业务；`BOT_AI_TASK_PROMPT`/`BOT_AI_CHAT_PROMPT` 可覆盖；固定安全边界始终追加；旧 `BOT_AI_SYSTEM_PROMPT` 废弃。
- **独立会话**：schema v10 的 `bot_ai_sessions.mode`；旧会话迁为 chat，`/ask` 新建 task；shared memory 不变。
- **QQ C2C**：QQ 私聊对任意用户开放 Chat（平台侧限制 Bot 可添加性）；QQ 群/频道与其他平台私聊仍需目标 `allow_chat`；命令仍只认白名单。
- **本地验证**：`npm test` 312（含 QQ C2C 开放/非 QQ 不扩散/群拒绝测试）、`npm run test:web` 141、`npm run check`、`check-version`、coverage；迁移 v6→v10 与 v9→v10 测试通过。
- **部署验证**：`/healthz` `{"ok":true,"version":"0.5.4","schemaVersion":10}`；完整 smoke **24/24**；v9→v10 迁移前快照 `db-predeploy-20261022T082056427Z.sqlite`（sha256 `840abf79…`）；补丁部署前快照 `db-predeploy-20261022T085149190Z.sqlite`（sha256 `dd24862d…`）。
- **真实对话**：管理员 `/ask` 审计 `mode=task`、普通 Chat `mode=chat`；非管理员 QQ C2C 审计 `bot.chat` 含 `open=qq_c2c`，`bot.ai.chat` `mode=chat`；`bot_ai_sessions` 出现独立 task/chat 行，`bot_ai_memories` 共享写入。
- **临时故障**：首次验收时 PC 反向代理隧道进程退出导致 QQ 回复 `qq_access_token_failed`（非提示词逻辑）；重启计划任务后 `Bot 出站网络已恢复`，Discord Gateway 重连，`/ask`/Chat 恢复正常。隧道已改为 wscript/VBS 静默启动（无前台 shell、单实例互斥），并重装计划任务验证代理 302/Gateway 重连。
- **备份**：部署后 inc `snapshot-20261022T085536550Z-inc.tar.gz`（98506 bytes，sha256 `6c503057…`）已由 Windows 计划任务拉取并 ack，`secrets=ok`。

## v0.5.3（历史，已部署）

- 日期：2026-10-22（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64（release `20261022T065126Z`，schema 9）+ Windows 本地工作区
- **出站连通性**：新增 `server/src/bot/connectivity.ts`；代理端口 TCP 探测 + 外网/平台只读 GET；`GET /api/bots/connectivity` 与 `POST /api/bots/connectivity/check`；`/bots` 概览新增“出站网络”卡片（设备在线/代理端口/外网/平台延迟）。
- **自动恢复**：网络从不可用恢复时，Discord Gateway `wake()` 跳过退避立即重连，并触发队列扫描；PC 隧道由 `scripts/install-tunnel-task.ps1` 注册登录启动、异常重启计划任务。
- **QQ 群**：事件到达后审计 `bot.chat.denied`（target `68611590B477339A04302BB23B426244`），确认根因是群目标未登记；登记 `kind=group`、`allow_chat=1`/`allow_commands=1` 后用户确认 @Bot AI 回复，审计 `bot.chat`/`bot.ai.chat`/`bot.ai.memory` 写入该群。QQ 空 @ 正文仍会 `bot.event.ignored`（detail `qq:event:empty_content`），需带正文。
- **OpenCode v2.1.2**：生产 v2.1.1 → v2.1.2 已完成（备份/重启/`GET`+`POST /api/session` 200、测试 session 已删除）。
- **部署验证**：`/healthz` `{"ok":true,"version":"0.5.3","schemaVersion":9}`；完整 smoke **24/24**；迁移前快照 `db-predeploy-20261022T065156149Z.sqlite`（sha256 `17524d02…`）。
- **连通性实测**：正常检查日志 `proxyPort=true, internet=true, platforms=[discord,qq]`；停止 PC 隧道后出现 `Bot 出站网络不可用 (proxyPort=false)`；恢复隧道后出现 `Bot 出站网络已恢复`、`Discord Gateway 网络恢复，立即重连`、`Gateway 会话已恢复`。
- **备份**：部署后 inc `snapshot-20261022T065651320Z-inc.tar.gz`（91150 bytes）+ `secrets-20261022T065652Z.tar.age`；QQ 群目标登记后再拉取 `snapshot-20261022T071549472Z-inc.tar.gz`（92882 bytes）+ `secrets-20261022T071550Z.tar.age`（secrets=ok）。
- 本地验证：`npm test` 300、`npm run test:web` 141、`npm run check`、`check-version`、覆盖率门禁均通过。
- **未决**：Telegram/Slack/QQ 频道真实 Chat、多附件/按钮平台联调未完成；QQ 空 @ 正文无回复属平台/适配器预期，需带正文。

## v0.5.2（历史，已部署）

- 日期：2026-10-21（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64（生产 release `20261021T114908Z`）+ Windows 本地工作区
- 版本：`v0.5.2`
- 范围：Bot Chat 与长期记忆、多附件发布、Telegram/Discord 只读按钮、Discord Gateway、目标 `allow_chat`/最近入站目标、schema v9。

### 1. 交付

- **Bot Chat**：`server/src/bot/service.ts`、Telegram/Slack/QQ 适配器与 Discord Gateway 支持普通消息 Chat；目标 `allow_chat`（默认 0）；群/频道仅 @Bot 或回复 Bot，私聊全部；非管理员只能 Chat，斜杠命令仍走 `allow_commands` + user 白名单；Chat 每 Bot×用户 6 次/分钟（`BOT_CHAT_RATE_PER_MINUTE`），与 `/ask` 共用 10 次/小时（`BOT_AI_RATE_PER_HOUR`）。
- **长期记忆**：`server/src/bot/memory.ts` + `bot_ai_memories`；DB 摘要权威 + `DATA_DIR/bot-memory/memory-<uuid>.md` 镜像（0700/0600、原子写）；每轮摘要；失败保留旧摘要；不通过 API/UI 暴露；系统提示内置，`BOT_AI_SYSTEM_PROMPT` 覆盖；摘要不额外占 AI 配额。
- **多附件**：最多 5 个、单 10 MiB、总 50 MiB；Telegram 全图片 media group/混合逐文件、Discord 单次 multipart、Slack 逐文件；QQ 仅文本；partial 不自动重试。
- **只读按钮**：Telegram inline keyboard / Discord components 的 `/status`、`/help` 刷新/帮助；需目标 `allow_commands` + user 白名单；无写操作；Slack/QQ 不做。
- **Discord Gateway**：`server/src/bot/discord-gateway.ts`；Node 内置 WebSocket；`intents=37377`（含 `MESSAGE_CONTENT`）；HELLO/IDENTIFY/RESUME、心跳、RECONNECT/INVALID_SESSION、指数退避与致命关闭码；需 Developer Portal 开启 intent；`BOT_DISCORD_GATEWAY_ENABLED=false` 默认关闭；`BotSummary.gateway` 状态。
- **数据/API/UI**：schema v9（迁移 9：`bot_targets.allow_chat`、`bot_ai_memories`、`bot_inbound_targets`）；`GET /api/bots/:id/inbound-targets`；`BotSummary.gateway`；`BotTarget.allowChat`；发布媒体多选（≤5）；`/bots` 目标/最近入站/多附件/Gateway 提示。
- **env/文档**：6 个新 `BOT_*` 键进入 `bootstrap-env.sh`；README/AGENTS/CHANGELOG/PLAN/ROADMAP/API/UI-SPEC/ARCHITECTURE/SECURITY/DEPLOY/BOT 同步到 0.5.2。

### 2. 本地验证

| 项目 | 结果 |
|---|---|
| `npm test` | **293/293 通过**（服务端 277 + 运维脚本 16；本地实测 2026-10-21） |
| `npm run test:web` | **140/140 通过**（28 个测试文件；本地实测 2026-10-21） |
| `npm run check` | **通过**（typecheck + lint + 293 + 140；本地 2026-10-21） |
| v0.5.2 新增服务端测试 | `bot-chat-adapters.test.ts`（12）、`bot-discord-gateway.test.ts`（10）、`bot-v052.test.ts`（5）；`bot-migration.test.ts` 覆盖 v6→v9 |
| 前端新增用例 | `web/src/pages/Bots.test.tsx` 增加目标 `allow_chat`/最近入站目标用例（9 项，总计 140） |
| schema | 生产 **v8→v9 迁移通过**：`/healthz.schemaVersion=9`；迁移前快照 `db-predeploy-20261021T114936153Z.sqlite`（sha256 `5dc7855f…`） |
| 应用部署 / `/healthz` | **通过**：`{"ok":true,"version":"0.5.2","schemaVersion":9}`；release `20261021T114908Z`，commit `abeabc7` |
| `smoke.ps1 -ExpectedVersion 0.5.2 -ExpectedSchemaVersion 9` | **24 通过 / 0 失败 / 0 警告**（公网 Access token/CSP/PWA/分享/告警/备份/世界/演练/脚本 SHA） |
| Discord Gateway 真实长连接 | **已连接**：生产 `BOT_DISCORD_GATEWAY_ENABLED=true`，日志 `Discord Gateway 已连接`；MESSAGE_CONTENT 负路径与断线重连待补充观察 |
| 各平台 Chat 真实外发 | **已确认**：Discord DM、Discord #general @Bot、QQ C2C 普通消息均收到 AI 回复；DM 频道目标已登记、`allow_chat=1`；多附件发布与按钮仍待验收 |
| `node scripts/check-version.mjs` | **通过**：`packageVersion=0.5.2`；README/CHANGELOG/ACCEPTANCE/env.example/DEPLOY/AGENTS 与 lock 根版本一致（2026-10-21） |

### 3. 部署

```text
应用: v0.5.2（生产 release 20261021T114908Z；发布 commit abeabc7）
schema: v9（迁移 9：allow_chat/bot_ai_memories/bot_inbound_targets；迁移前快照 db-predeploy-20261021T114936153Z.sqlite）
env: 生产 env 保留原有 BOT_ENABLED/BOT_AI_ENABLED；新增 BOT_DISCORD_GATEWAY_ENABLED=true；其余 5 个 v0.5.2 键使用默认值（媒体 5/50MiB、Chat 6/min、记忆 4096）
数据: 8 张 bot* 表存在；bots 2 个（Discord/QQ）启用；QQ C2C 与 Discord #general 的 allow_chat=1，其余目标 0
平台: Discord Message Content Intent 已开启；Telegram/QQ 群/频道目标与各平台多附件联调待执行
smoke: 24/24（-ExpectedVersion 0.5.2 -ExpectedSchemaVersion 9，带 Access service token）
备份: 部署后 inc 已拉取/ack（snapshot-20261021T115245394Z-inc.tar.gz，69139 bytes；开启 Gateway/Chat 后再拉取 snapshot-20261021T123559613Z-inc.tar.gz，72641 bytes）；密钥包 secrets-20261021T123600Z.tar.age（secrets=ok）
```

### 4. 未决

- **Chat**：已确认 Discord DM、Discord #general @Bot、QQ C2C 普通消息收到 AI 回复；审计 `bot.chat`/`bot.ai.chat`、`bot_ai_sessions` 与 `bot_ai_memories` 均写入。其他目标保持 `allow_chat=0`。
- **按钮/多附件**：`/status` 按钮刷新、多附件真实发布、Telegram/Slack/QQ 群/频道 Chat 与记忆多轮行为仍待补充验收。
- **DM 目标**：生产为 Discord DM 登记了独立频道目标（`allow_chat=1`）；代码侧 DM user-target 回退修复已提交但未部署，留待下一版本统一发版。
- **记忆清理**：删除 Bot 后 DB 记忆行级联删除，`DATA_DIR/bot-memory` 镜像文件无自动清理路径，列为已知残留。

### 5. 运行时安全更新（2026-10-22）

- **Node.js v26.11.1 → v26.12.1**：官方 linux-arm64 包，SHA-256 `42aa04922591ee5d4dbc7740d452621acf28508239daa512f5ee8c47ee224fdb` 校验通过；
  安装到 `/usr/local/lib/nodejs/node-v26.12.1-linux-arm64`，`/usr/local/bin/node` 已替换；旧二进制保留 `/usr/local/bin/node.v26.11.1`。
- 服务重启后 `/healthz` 返回 `0.5.2`/schema `9`；完整 smoke **24/24**；Discord Gateway 在 PC 代理隧道恢复后重新 `connected`。
- npm/npx 仍指向 nvm v26.11.1 的 npm 12.2.0（仅构建/部署工具）；应用运行时为 v26.12.1。更新步骤/回滚见 `docs/DEPLOY.md` §3.3。
- 注意：Gateway 依赖 Pi 出站代理；本次更新期间发现 PC 隧道未运行导致短暂重连，恢复隧道后已连接，非 Node 回归。

## v0.5.1（历史）

- 日期：2026-10-21（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64（生产，release `20261021T091001Z`）+ Windows 本地工作区
- 版本：`v0.5.1`
- 范围：QQ 官方 Bot、OpenCode `/ask` AI、Bot 24h 指标/静默时段/发布 `PUBLISH` 双确认、schema v8、fail2ban 封禁持久化与 smoke Access service token。

### 1. 交付

- **QQ 官方 Bot**：`server/src/bot/adapters/qq.ts`；op=13 Ed25519 回调地址校验、op=0 事件验签与 `{opcode:12}` 确认；C2C/群@/频道文本命令与通知；仅文本（≤2000 字符）、不支持媒体；AppSecret 只存 AES-256-GCM 密文。
- **OpenCode AI `/ask`**：`server/src/bot/ai.ts`；`BOT_AI_*` 默认关闭；仅命令白名单用户；每小时限流；`bot_ai_sessions` 会话复用；新建会话 deny-all 工具权限（OpenCode 明确 400 才降级并标注“未隔离”）。
- **Bot 运维**：`GET /api/bots/:id/metrics?hours=24` 指标卡；目标静默时段（0–1439，成对设置，通知延后）；发布 `confirmText:'PUBLISH'` 二次确认（TOTP 仍必填）。
- **数据**：schema v8（迁移 8 重建 Bot 表扩展 `qq`、增加 `quiet_start_minute`/`quiet_end_minute`、新增 `bot_ai_sessions`；迁移 6/7 保留）。
- **安全**：fail2ban dbfile 持久化（`/var/lib/fail2ban/fail2ban.sqlite3`）；`deploy/systemd/nftables.service.d/10-fail2ban-restore.conf` 在 nftables 启动后以 `systemd-run --collect --on-active=3` 异步重启 fail2ban 恢复 set；`smoke.ps1` 新增 `-AccessClientId/-AccessClientSecret` 头与 401 检查。
- **env**：`BOT_AI_ENABLED`、`BOT_AI_PROVIDER`、`BOT_AI_MODEL`、`BOT_AI_TIMEOUT_SECONDS`、`BOT_AI_MAX_PROMPT_CHARS`、`BOT_AI_RATE_PER_HOUR`、`BOT_AI_SESSION_RETENTION_DAYS`；`bootstrap-env.sh` 已纳管。
- **文档**：README/AGENTS/CHANGELOG/PLAN/ROADMAP/API/UI-SPEC/ARCHITECTURE/SECURITY/DEPLOY/BOT 与 `deploy/env.example` 同步到 0.5.1；`check-version` 覆盖版本项。

### 2. 验证

| 项目 | 结果 |
|---|---|
| `npm test` | **265/265 通过**（服务端 249 + 运维脚本 16；本地实测 2026-10-21） |
| `npm run test:web` | **139/139 通过**（28 个测试文件；本地实测 2026-10-21） |
| `npm run check` | **通过**（typecheck + lint + 265 + 139；本地 2026-10-21） |
| `npm run build` | **通过**（部署脚本执行；Vite 2026 modules，产物 `web/dist`） |
| 覆盖率/CI | 本地 `npm run test:coverage` **265/265** 与 `npm run test:web:coverage` **139/139** 通过；CI 以最新 main 提交为准 |
| schema | 生产迁移 **v7→v8 通过**：`/healthz` schemaVersion=8，迁移前快照 `db-predeploy-20261021T091026904Z.sqlite`；本地 v6→v8 迁移测试通过 |
| 应用部署 / `/healthz` | **通过**：`{"ok":true,"version":"0.5.1","schemaVersion":8}`；发布 commit `5122ad5` |
| `smoke.ps1 -ExpectedVersion 0.5.1 -ExpectedSchemaVersion 8` | **23 通过 / 0 失败 / 0 警告**（公网+CSP/PWA/分享/告警/备份/世界/演练/脚本 SHA） |
| QQ 真实回调 | **通过**：回调地址 op=13 校验通过；C2C `C2C_MESSAGE_CREATE` 事件到达，登记 openid 后 `/help` 收到回复；仅文本，媒体未支持 |
| AI 真实模型 | **通过**：OpenCode provider/model `opencode-go/deepseek-v4.1-flash`，真实回复 `MODEL_OK`；Discord `/ask` 正常响应；默认关闭已显式开启 |
| Bot 指标/静默/二次确认 | 生产 API/BotService 实测指标：Discord 24h deliveries sent=2、successRate=100、events=1；发布 confirmText 服务端/前端测试覆盖；静默时段单测覆盖 |
| Cloudflare Access | **通过**：主应用 `app.antifield.work`（One-time PIN + Owner allow + Service Auth）；4 个 Bypass：`/healthz`、`/api/bot/webhook`、`/s`、`/api/public/shares`；未登录 `/` 302 到 `*.cloudflareaccess.com`，service token 访问应用返回 401；完整 smoke **24/24**（含 Access token 检查） |
| fail2ban 封禁持久化 | **生产实测通过**：nftables restart 后 15s 内 fail2ban 恢复封禁 set；drop-in 已安装；手工 `systemctl reload nftables` 仍需手动 `systemctl restart fail2ban` |
| Bot 关闭态 | 本地测试覆盖：`BOT_ENABLED=false` Webhook 404、写接口 503、队列不启动；生产保持启用 |

### 3. 部署

```text
应用: v0.5.1（生产 release 20261021T091001Z；发布 commit 5122ad5）
schema: v8（迁移 8：QQ/静默/AI 会话；迁移前快照 db-predeploy-20261021T091026904Z.sqlite）
env: BOT_AI_ENABLED=true、BOT_AI_PROVIDER=opencode-go、BOT_AI_MODEL=deepseek-v4.1-flash；BOT_SECRET_KEY 未轮换
QQ: Bot 2456ea90-7fed-42ec-81d0-9c478d2a9d47；回调地址已配置；C2C 目标 openid 已登记并收到 /help 回复
AI: OpenCode 真实模型 deepseek-v4.1-flash；Discord /ask 正常响应
Cloudflare Access: 已启用主应用（Owner OTP + service token）；4 个 bypass 路径已创建；service token 保存在 PC `.local/cf-access.env`（gitignored），smoke 已带 token 通过
fail2ban: dbfile + nftables drop-in 已安装；nftables restart 后封禁 set 恢复实测通过
```

### 4. 未决

- `npm run build`、覆盖率、CI 与生产部署/迁移 v8/smoke 已执行并通过本文件记录；CI 以最新 main 提交为准。
- Cloudflare Access 已配置；高权限配置用 API Token 应轮换/Revoke，service token（有效期 1 年）轮换需同步 PC `.local/cf-access.env` 与 smoke 参数。
- QQ 仅文本已验证；媒体、群/频道目标与通知需后续真实场景补充；企业微信/钉钉/飞书、多管理员审批未实现。
- `typescript-eslint` 仍不支持 TS7 API，双 alias 保留；`http-proxy` Node 27 替代继续跟踪。
- 发布 `confirmText` 二次确认与 TOTP 双门禁已覆盖；真实发布外发未在本轮执行（避免向平台发送测试内容）。

## v0.5.0（历史）

- 日期：2026-10-21（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64，生产环境 + Windows 本地工作区
- 版本：`v0.5.0`
- 范围：Bot 平台（Telegram/Discord/Slack）、schema v7、Bot 凭据加密与 Webhook/命令/通知/发布安全边界、部署/回滚/SSH/Cloudflare Access/备份任务运维收口、第四轮审计与文档同步。

### 1. 交付

- **Bot 平台**：`server/src/bot/`（`crypto.ts` AES-256-GCM、`service.ts` 配置/验签/命令/通知/发布队列、三平台适配器、模板）与 `server/src/http/routes/bots.ts`、`bot-webhook.ts`；Web `/bots` 四分区页面。
- **命令**：`/help` `/status` `/backup` `/world` `/mc` `/files <关键词>`；目标 `allow_commands` + 显式 user 白名单双校验；输出清洗路径/URL、文件元数据 ≤10 条。
- **通知/发布**：告警事件按目标 `allow_notifications` 入队（`dedupe_key` 去重）；发布 TXT + 最多 1 个云端普通文件媒体（≤10 MiB）、频道/群组、TOTP 再认证、定时 ≤30 天、取消、指数退避重试/死信重投。
- **数据**：schema v7（迁移 7 新增 `bots/bot_targets/bot_deliveries/bot_publish_jobs/bot_events`；迁移 6 孤儿 shares 修复保留）；Bot 凭据只存密文；`bot_events` 7 天、已发送投递/发布 30 天清理。
- **安全**：Token 只写不读；签名 + 时间戳（±300 秒）+ 事件去重；IP 120/min、Bot 300/min、命令 20/min、发布/测试 20/h；未授权命令不执行并审计；`BOT_ENABLED=false` 时 Webhook 404、写接口 503。
- **运维**：`bootstrap-env.sh` 生成/复用 `BOT_SECRET_KEY`（`--force` 不轮换）；`deploy.ps1` 干净工作树门禁、回滚还原 `APP_VERSION`、smoke 失败门禁；`check-version` 覆盖 env.example/DEPLOY 标题/lock；SSH 仅公钥 `00-` drop-in + 24h 回滚 + `fail2ban` sshd jail；Cloudflare Access 策略与 bypass 文档；`backup-world.mjs` 信号时优先 `save-on`。
- **审计/文档**：`docs/AUDIT.md` 第四轮（v0.4.2 基线 P0=0/P1=0/P2=3/P3=12；Bot WIP P1=2/P2=4，已修复项带测试/命令）；README/AGENTS/CHANGELOG/PLAN/ROADMAP/API/UI-SPEC/ARCHITECTURE/SECURITY/DEPLOY/BACKUP/ACCEPTANCE/AUDIT 与 `docs/BOT.md`、`deploy/env.example` 全量同步到 0.5.0。
- **前端审计 P1**：修复 Files 移动端多选重复复选框、NoteEditor 未保存关闭确认、API 默认超时、设置页 hash 深链、笔记正文 UTF-8 字节校验、Bot 发布媒体选择器；新增 `Table.test.tsx` 回归。
- **测试**：新增 `server/test/bot-core.test.ts`（6）、`bot-routes.test.ts`（1）、`bot-webhook-route.test.ts`（1）、`bot-migration.test.ts`（1）与 `web/src/pages/Bots.test.tsx`（8）、`web/src/components/Table.test.tsx`（2）。

### 2. 验证

| 项目 | 结果 |
|---|---|
| `npm test` | **245/245 通过**（服务端 229 + 运维脚本 16；本地工作树实测，2026-10-21） |
| `npm run test:web` | **139/139 通过**（28 个测试文件；含 Table 卡片模式 2 项与 Bots 8 项） |
| `npm run typecheck` / `lint` | 通过（2026-10-21 本地工作树；TS7 native + ESLint 0 警告） |
| `npm run check` | 通过（245 服务端/脚本 + 139 前端；2026-10-21 部署前最终工作树） |
| `npm run build` | 通过（部署时构建 `web/dist`，v0.5.0） |
| 覆盖率（`test:coverage` / `test:web:coverage`） | 服务端覆盖率门禁通过；前端门禁通过（Lines 约 39%） |
| CI（main/tag） | **success**：main run `39554286586`、v0.5.0 tag run `39554290976`（8 job 全绿，2026-10-21） |
| schema | **v7**（`/healthz.schemaVersion=7`；迁移 6 保留 + 迁移 7 五张 Bot 表；`bot-migration` 测试通过） |
| 应用部署 / `/healthz` | release `20261021T060807Z`；`version=0.5.0`、`schemaVersion=7`；迁移前快照 `db-predeploy-20261021T060832328Z.sqlite`（sha256 `36ab1dd4…`） |
| `smoke.ps1 -ExpectedVersion 0.5.0 -ExpectedSchemaVersion 7` | **23 通过 / 0 失败 / 0 警告**（部署后只读 smoke 16/16；完整 smoke 含公网/CSP/PWA/备份/世界/演练） |
| Bot 关闭态 | 部署后未设 key 时 Webhook POST 返回 404、`/api/bots/status` 未登录 401；生成 32 字节 `BOT_SECRET_KEY` 后显式 `BOT_ENABLED=true` |
| Bot 三平台联调 | **Discord 真实联调通过（2026-10-21）**：Bot `853f85e6…` 加入测试服务器，Interactions Endpoint 验证通过，6 个斜杠命令注册，`/status` 收到回复；`#general` 收到测试通知（DB 证据：`bot.command=1`、`test sent=1`）。Telegram/Slack 仍为 mock 契约；QQ 官方 Bot 留 v0.5.1 |
| 备份/世界拉取/演练 | 新全量归档 `snapshot-20261021T061911104Z-full.tar.gz`（v7，PC 校验并 ack）；密钥包 `secrets-20261021T061917Z.tar.age`（含 env/BOT key，secrets=ok）；`drill.ps1 -ExpectedSchemaVersion 7` **通过**（报告 `20261021T061932Z`）；世界备份/拉取 smoke 通过 |
| SSH 仅公钥 / Access bypass | `sshd -T` 为 `passwordauthentication no`/`permitrootlogin no`；公钥新会话与密码拒绝均实测；fail2ban sshd jail active。Cloudflare Access 策略/bypass **待用户后台配置** |

### 3. 部署

```text
应用: v0.5.0（release /opt/antifieldcloud/releases/20261021T060807Z；迁移前快照 db-predeploy-20261021T060832328Z.sqlite）
schema: v7（迁移 6 保留 + 迁移 7 新增 5 张 bot* 表）
BOT_SECRET_KEY: bootstrap-env.sh --force 生成（32 字节 base64，不回显）；密钥包 secrets-20261021T061917Z.tar.age 已包含 env
Bot 出站: Pi 直连 Discord/Telegram 被阻断；经 PC 127.0.0.1:10090 的 SSH 反向隧道（Pi 127.0.0.1:18090）+ `NODE_USE_ENV_PROXY=1` 验证 Discord 出站 200，PC 用户级启动项负责重连
Cloudflare Access: 待用户后台配置 app 策略 + webhook/health/分享 bypass
SSH: 仅公钥（00-antifield-hardening.conf，2026-10-21 13:49 CST 切换；24h 回滚窗口至 10-22 13:49）；fail2ban sshd jail 已启用
tag: v0.5.0
release: https://github.com/antifield26/AntifieldCloud/releases/tag/v0.5.0
清理: 已二次确认并删除旧 release 20261020T150609Z、8 份旧 predeploy 快照、1 个孤儿归档（约 38 MB）；保留当前+上一 release、最新 2 份快照与用户/世界数据
```

### 4. 未决

- `npm run check`、`npm run build`、CI、smoke、Bot 平台联调与部署证据由主代理在部署后补齐；在此之前本文件不构成 v0.5.0 验收通过。
- Bot 适配器/队列测试为进程内 mock（T/S mock-only）；真实平台限流、签名漂移、平台 5xx 的负路径需沙箱联调。
- Cloudflare Access 策略/bypass 需用户在后台配置，应用侧无法自证；未配置时 Webhook/health/公开分享会被边缘拦截。
- SSH 24h 回滚窗口内保留旧 drop-in 备份；`fail2ban` sshd jail 已启用（nftables 后端），但 nftables 重载后需重启 fail2ban 恢复封禁；`antifield` 的 `NOPASSWD ALL` sudo 未改（残余）。
- `typescript-eslint` 仍不支持 TS7 API，`@typescript/typescript6` 双 alias 保留到其支持 TS7.1。
- Bot 单次发布最多 1 个媒体文件、命令严格只读、无平台主动拉取/长连接；`BOT_SECRET_KEY` 轮换需重录全部 Token。

## v0.4.2（历史）

- 日期：2026-10-20（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64，生产环境 + Windows 本地工作区
- 版本：`v0.4.2`
- 范围：TypeScript 7 兼容性迁移；Android 指标趋势周期选择器窄屏修复；工作区清理与文档对齐；应用发布。

### 1. 交付

- **TypeScript 7**：按官方并排方案，`@typescript/native` 别名安装 TypeScript 7.0.2（提供 `tsc` 7.0.2），`typescript` 别名指向 `@typescript/typescript6@6.0.2` 供 typescript-eslint 8.71.2（尚不支持 TS7 API）；`npm ci` 可复现，typecheck/lint/test/build 全绿。
- **Android 趋势布局**：`.segmented-button` 增加 `flex: 0 0 auto` 与 `white-space: nowrap`；≤900px 时趋势卡头部纵向排列、范围选择器占满一行并横向滚动（隐藏滚动条），周期文字不再被压缩；范围切换/aria/轮询逻辑不变。
- **工作区清理**：删除生成的 `web/coverage`、`web/node_modules` 缓存、`web/.vite-temp` 等；重新构建 `web/dist`；保留 `scripts/*` 中仍在使用的稳定入口（`backup.mjs`/`provision.mjs` 被服务端与文档引用）。
- **文档对齐**：README/AGENTS/PLAN/ROADMAP/UI-SPEC/API/DEPLOY/BACKUP 版本与测试基线同步；CI 增加 `check-version.mjs`。
- 应用 v0.4.2，schema v6 不变；无服务端功能变更。

### 2. 验证

| 项目 | 结果 |
|---|---|
| `npm ci --dry-run` | 通过（lockfile 与 TS alias 可复现） |
| `npx tsc --version` | **7.0.2** |
| `npm run typecheck` / `lint` | 通过（lint 使用 `typescript@6.0.2` alias） |
| `npm run check` | 通过：服务端/脚本 234、前端 129 |
| `npm run build` | 通过（web/dist 重建） |
| CI（main） | success（run `39450435315`，含 TS7/Android/清理与文档） |
| Android 真机 | CSS 修复已在 Edge headless 390×420 视口渲染验证：周期标签完整不压缩、刷新按钮换行；真实 Android 浏览器待用户复测 |
| 应用部署 | release `/opt/antifieldcloud/releases/20261020T153138Z`；healthz `0.4.2`；迁移前快照 `db-predeploy-20261020T153204366Z.sqlite`；部署后只读 smoke 15/15 |
| `smoke.ps1` | **22 通过 / 0 失败 / 0 警告**（含公网/CSP/PWA/分享/告警/服务/版本/cgroup/nftables/备份/世界/演练/脚本 hash/本地 SHA） |

### 3. 部署

```text
应用: v0.4.2（release 20261020T153138Z；迁移前快照 db-predeploy-20261020T153204366Z.sqlite）
类型工具链: tsc 7.0.2（@typescript/native）+ typescript 6.0.2 alias（typescript-eslint）
Pi: schema v6 不变；OpenCode v2.1.1 不受影响
tag: v0.4.2
release: https://github.com/antifield26/AntifieldCloud/releases/tag/v0.4.2
```

### 4. 未决

- `typescript-eslint@8.71.2` 不支持 TS7 API，双 alias 需保留到其支持 TS7.1；升级 typescript-eslint 后重新评估移除 `@typescript/typescript6`。
- Android 真机验收由用户完成（本次仅代码/CSS 级修复与构建验证）。
- 工作区未删除 `scripts/backup.mjs`/`provision.mjs`：它们是服务端 `backups/service.ts`、部署/备份文档依赖的稳定入口，删除需跨域改代码，不在本维护版做破坏性清理。

### 5. 运维调整：定时任务统一 12:00（2026-10-21）

- 盘点：Pi 上无 cron（antifield/root）、无 at、无用户 timer；项目 timer 仅 `antifieldcloud-health.timer`（每 60s）与 `antifieldcloud-world.timer`。
- 调整：`antifieldcloud-world.timer` 改为 **`OnCalendar=Sun 12:00 Asia/Shanghai`**，`Persistent=true`；`antifieldcloud-world.service` 不变。
- 验证：`systemctl list-timers antifieldcloud-world.timer` 显示下次 `Sun 2026-10-25 12:00:00 CST`；timer active、`Persistent=yes`；健康探针仍约每 60s 触发。
- 例外：健康探针保持 60s（改为每日会失去监控/告警意义）；OS 维护 timer（apt-daily、logrotate、fstrim、log2ram、e2scrub、systemd-tmpfiles 等）保持发行版默认，不属于项目任务。
- Windows：`AntifieldCloud-Backup-Pull` 已是每日 12:00（另有登录后补跑）；周度 world-pull/drill 任务未安装。
- 时区/周期确认：**用户 2026-10-21 确认不改系统维护 timer、维持健康探针周期**；仅世界备份 timer 在周日 12:00。
- 回滚：`/etc/systemd/system/antifieldcloud-world.timer.bak-v042` + `systemctl daemon-reload && systemctl restart antifieldcloud-world.timer`。
- 文档：`deploy/antifieldcloud-world.timer`、README/AGENTS/ARCHITECTURE/BACKUP/DEPLOY/PLAN 已同步；CHANGELOG 记入 Unreleased。

## v0.4.1（历史）

- 日期：2026-10-20（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64，生产环境
- 版本：`v0.4.1`
- 范围：OpenCode 服务端 v2.0.32 → v2.1.1 升级与兼容性复核；Dependabot CI action 更新；Pi legacy 世界归档清理；OpenCode Basic 密码轮换；应用版本发布。

### 1. 交付

- OpenCode 升级：`opencode upgrade --method curl`（v2.0.32 → v2.1.1）；升级前备份二进制、配置、数据到 `/var/backups/opencode/`（93 MB 二进制 tar + 2 MB 数据 tar + env/service 副本）。
- 兼容性：Basic `/api/session`、`POST /api/session`（垫片新建会话路径）、`/api/config|agent|provider`、真实 HTML 垫片注入（`data-cfasync` + `__af/oc-help.js`）、公开 `ai.*` 401、app healthz 全部正常；Web 包仍含“新建会话/New session”标记，垫片选择器匹配。
- 凭据：轮换 OpenCode Basic 密码，同步 `/etc/opencode/opencode.env`、`/etc/antifieldcloud/env`、两个 `service.json`；重启 opencode/antifieldcloud 后 Basic 200、应用 healthz 200。
- 依赖：合并 Dependabot `actions/checkout` 4→7、`actions/setup-node` 4→7、`gitleaks/gitleaks-action` 2→3；main CI 全绿；不兼容的 TypeScript 7 major PR 已关闭。
- 清理：删除 Pi `/home/antifield/minecraft-backups` 3 个 legacy 世界归档（约 9 GiB），磁盘可用从 31 GiB 增至 **40 GiB**；新世界备份与 PC `world` 副本保留，旧 cron 保持停用。
- 应用：版本升至 0.4.1 并部署（代码无功能变更，仅版本/文档与运行环境变更）。

### 2. 验证

| 项目 | 结果 |
|---|---|
| `npm run check` | 通过：服务端/脚本 234、前端 129（与 v0.4.0 相同基线） |
| CI（main/tag） | 通过（含 PR 合并后的最新 main） |
| OpenCode 版本 | `opencode v2.1.1`；`opencode.service` active，监听 127.0.0.1:4096 |
| 兼容性 API | Basic `/api/session` 200；`POST /api/session` 200（`data.id` 形状不变）；`/api/config|agent|provider` 均 200 |
| HTML/垫片 | 真实首页 6,962 B、1 个 module script；`injectOpenCodeShim` 插入 `__af/oc-help.js` + 3 个 `data-cfasync="false"`；bundle 含“新建会话/New session/新会话” |
| 公开入口 | `https://ai.antifield.work/` 401（未登录）；`https://app.antifield.work/healthz` 200 |
| 密码轮换 | env(两份) 一致、Basic 200、应用 healthz 200、代理与 dashboard 探测路径不变 |
| 旧归档清理 | `/home/antifield/minecraft-backups` 已删除；`df /` 可用 40 GiB；新 `world-backups` 与 PC 副本保留 |
| 应用部署 | release `/opt/antifieldcloud/releases/20261020T150609Z`；healthz `0.4.1`；迁移前快照 `db-predeploy-20261020T150659110Z.sqlite`；部署后只读 smoke 15/15 |
| `smoke.ps1` | **22 通过 / 0 失败 / 0 警告**（含公网/CSP/PWA/分享/告警/服务/版本/cgroup/nftables/备份/世界/演练/脚本 hash/本地 SHA）；直连 SSH/TCP 偶发瞬时超时，重试后通过 |

### 3. 部署

```text
OpenCode: v2.1.1（/var/lib/opencode/.opencode/bin/opencode）
备份: /var/backups/opencode/opencode-v2.0.32-bin-*.tar.gz、opencode-data-*.tar.gz
Pi: 旧 legacy 世界归档已清理；旧 cron 停用
应用: v0.4.1（release 20261020T150609Z；迁移前快照 db-predeploy-20261020T150659110Z.sqlite）
nftables: 22 限速调整为 20/min burst 40（兼容 smoke/备份的多次 SSH）
tag: v0.4.1
release: https://github.com/antifield26/AntifieldCloud/releases/tag/v0.4.1
```

### 4. 未决

- OpenCode UI 原生“新建会话”按钮/WS 实时事件需用户浏览器最终复测（垫片与 API 路径已验证，但无登录凭据做端到端浏览器验收）。
- OpenCode 2.1.1 发布说明未取到（GitHub API 该版本 notes 不可用），兼容性以实际接口/HTML 验证为准。
- 后续升级建议按 `docs/DEPLOY.md` 的备份/验证/回滚流程执行，并复测本表兼容项。

## v0.4.0（历史）

- 日期：2026-10-20（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64，生产环境
- 版本：`v0.4.0`
- 范围：第三轮深度审计与 P0/P1/非破坏 P2 修复；可观测性（指标历史/筛选/备份状态）；笔记附件与版本历史；多文件打包分享；Minecraft 世界一致性备份/PC 拉取/恢复演练自动化；工程与 CI 门禁；系统加固。

### 1. 交付

- 审计：`docs/AUDIT.md` 第三轮（4 路并行只读审计 + Lead 复核）；六维评分卡；P0/P1 修复与残余风险清单。
- 数据：migration 5（`files.origin`、含 origin 唯一索引、`note_attachments`、`note_versions`、`share_items` 回填、`metrics_samples`）+ migration 6（孤儿 shares 数据修复，不改表结构）；v4→v6 迁移测试。
- 可观测性：60s 采样/30 天保留、`GET /api/metrics`（1h/6h/24h/7d/30d、≤240 点）；Dashboard 四张 SVG 趋势卡；Activity 搜索/时间范围；AlertsCard 筛选分页；备份健康卡（应用归档/密钥包/pending/acked/孤儿/世界备份/PC 拉取/演练）。
- 笔记：附件（1–5/请求、25 MiB、每笔记 100、计入配额、origin=note 隐藏）；版本历史（变更快照、保留 20、预览/恢复）。
- 分享：多文件 `POST /api/shares`（1–50 个、`itemCount/totalSizeBytes`）；公开页 items + 逐文件下载；次数按会话计；删除文件吊销整个分享。
- 世界备份：`scripts/backup-world.mjs`（save-off/save-all flush/save-on finally、tar 0/1 容忍、gzip 校验、SHA/状态、保留 4）+ weekly systemd timer；旧 cron 验收后停用，旧 9 GiB 归档保留。
- 灾备：`scripts/world-pull.ps1` 两阶段拉取（PC 保留 4）；`scripts/drill.ps1` + `drill-verify.mjs` 恢复演练（SHA/tar/DB integrity/manifest，报告 180 天）；状态文件接入 Dashboard 与告警（world/pull/drill stale）。
- 工程：版本单源（package.json，app 默认读取）；CI 覆盖 check/coverage/audit/secret-scan/shellcheck/nftables/PowerShell + Dependabot；`test:coverage`/`test:web:coverage`；部署脚本版本注入/DB 回滚/预检/smoke；PS 5.1 UTF-8 修复；bootstrap-env 保留未知键；systemd 加固；nftables 22/25565 收窄。
- 测试：服务端/脚本 **234**（服务端 218 + 运维脚本 16）、前端 **129**；`npm run check` / `npm run build` 通过。
- 文档：API/UI-SPEC/ARCHITECTURE/SECURITY/DEPLOY/BACKUP/ROADMAP/PLAN/AGENTS/README/CHANGELOG 同步。

### 2. 验证

| 项目 | 结果 |
|---|---|
| `npm run check` | 通过：服务端/脚本 234/234（服务端 218 + 脚本 16）、前端 129/129 |
| `npm run build` | 通过（Vite 构建，chunk 体积警告已知） |
| 覆盖率 | 服务端 lines/functions/branches 91.7/86.7/77.4；前端 36.6/31.5/34.2（阈值 75/75/65 与 35/30/33） |
| schema | v6；v4→v6 迁移测试通过；生产启动日志 `migrated to schema v5`/`v6` |
| 部署 | 成功：`/opt/antifieldcloud/releases/20261020T135813Z`；迁移前快照 `db-predeploy-20261020T135842657Z.sqlite`；自动回滚流程已由脚本实现 |
| 生产 Health | `{"ok":true,"version":"0.4.0"}`；服务 active、`systemctl --failed` 0 |
| `smoke.ps1` | **22 通过 / 0 失败 / 0 警告**（公网/CSP/PWA/分享 404/告警 401/服务/版本/cgroup/nftables/备份/世界/演练/脚本 hash/本地 SHA） |
| 世界备份 | systemd 手动触发成功：`world-20261020T140037Z.tar.gz`，3,203,778,333 B，SHA-256 `d9e5049298ec68f9cbbae43186e6ebf02617bbd554b714a584af6609bf18b85e`；`saveOffOk/saveOnOk=true`、tar/gzip 校验通过；timer 已 enable（周日 04:00） |
| PC 世界拉取 | `world-pull.ps1` 成功：拉取 1、待拉取 0、本地保留 1、SHA 校验通过；远端已 ack 删除；`world-pull-status.json` ok=true |
| 恢复演练 | `drill.ps1 -ExpectedSchemaVersion 6 -IncludeWorld` 通过：full+inc 链 SHA/manifest、DB schema=6/integrity=ok/FK 0 违规、世界 `world/level.dat` 解包校验成功；报告 `D:\Backups\AntifieldCloud\drills\20261020T140730Z`，已回写 Pi |
| 旧 cron | 已停用（原 `minecraft-backups` 行移除，备份 `/home/antifield/crontab.bak-v040`）；旧 9 GiB 归档保留未删 |
| 系统加固 | app unit 加固后 `systemd-analyze security` ≈3.2 OK；nftables 22/25565 收窄到直连/校园网段且 22 限速，应用后新 SSH、25565、25575 行为符合预期 |
| 指标采样 | 部署后 22 条 `metrics_samples`（60s 采样运行中）；`/api/metrics` 未登录 401 |
| 功能抽查 | 自动化测试覆盖指标/附件/版本/多文件分享/备份状态；公网 UI 交互与 390px/PWA 需用户最终人工验收 |

### 3. 部署

```text
部署目录: /opt/antifieldcloud/releases/20261020T135813Z
迁移前 DB 快照: /var/lib/antifieldcloud/backups/db-predeploy-20261020T135842657Z.sqlite
服务: antifieldcloud.service (active, v0.4.0)；schema v6
tag: v0.4.0
release: https://github.com/antifield26/AntifieldCloud/releases/tag/v0.4.0
```

### 4. 未决

- SSH/sudo 暴露面按用户选择仅文档披露（未改配置）；建议后续收敛（见 AUDIT §4）。
- 增量备份时钟水位（DR-1）、导入归档保留（DR-7）、告警未投递重试（DR-22）等列后续。
- 5 GiB 公网上传未跑满；世界备份/拉取/演练已完成首轮生产验证，后续按周/季度执行。
- Windows 周度世界拉取与演练计划任务需用户手动安装（AGENTS §9）。
- 旧 `/home/antifield/minecraft-backups` 约 9 GiB 未自动删除，确认 PC 副本后手动清理。
- 真机 390px/PWA 视觉与交互需用户最终人工验收。

## v0.3.2（历史）

- 日期：2026-10-20（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64，生产环境
- 版本：`v0.3.2`
- 范围：旧 nginx/certbot 入口与 TLS 状态清理、服务监控收敛、workbench/piforge/旧配置清理。

### 1. 交付

- 移除 `nginx`/`nginx-common`/`certbot`/`python3-certbot*` 及 `/etc/nginx`、`/etc/letsencrypt`、`/var/www/html`、nginx 日志/状态；80 端口无监听。
- `minecraft/cloudflared/opencode` 为受监控服务；Dashboard/告警/前端状态卡同步为 3 项，避免 nginx 误报。
- nftables 移除 80 端口放行，仅保留 25565。
- 删除 workbench 用户/组/103M 旧数据、piforge subuid/gid、旧 `antifieldcloud.service.pre-*`、`cloudflared-update.*`、旧 env/RCON 备份；`.local` 清理旧脚本/全量快照/样本/历史 bundle。
- 文档/烟测脚本更新为 4 个系统服务（不含 nginx）。

### 2. 验证

| 项目 | 结果 |
|---|---|
| `npm run check` | 通过：服务端 150/150、前端 52/52 |
| `npm run build` | 通过 |
| 生产 Health | `{"ok":true,"version":"0.3.2"}` |
| `smoke.ps1` | 16/16（服务状态 4 项 active） |
| 旧入口 | nginx/certbot inactive/not-found；80 无监听；`/etc/nginx`、`/etc/letsencrypt` 已删除 |
| 服务监控 | minecraft/cloudflared/opencode 3 项；`systemctl --failed` 0 |
| 残留清理 | workbench/piforge/旧 unit/旧 env/RCON 已清理；`.local` 仅保留部署/演练/扫描/age 私钥 |
| 备份 | `lastPullAt=2026-10-20T04:00:08Z`，secretsOk=true |

### 3. 部署

```text
部署目录: /opt/antifieldcloud/releases/20261020T102328Z
迁移前 DB 快照: /var/lib/antifieldcloud/backups/db-predeploy-20261020T102331729Z.sqlite
服务: antifieldcloud.service (active, v0.3.2)
tag: v0.3.2
release: https://github.com/antifield26/AntifieldCloud/releases/tag/v0.3.2
```

### 4. 未决

- 5 GiB 真实公网上传未跑满；OpenCode 上游原生按钮仍失效，保留最小隐藏接管。
- RCON 仍监听所有接口（Paper 无 bind 配置），由 nftables 阻断非 loopback。
- age 私钥仍需用户离线化；Minecraft 世界未纳入应用备份。

## v0.3.1（历史）

- 日期：2026-10-20（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64，生产环境
- 版本：`v0.3.1`
- 范围：5 GiB 分片上传/断点续传；配套系统加固（journald、cloudflared、nftables、rpcbind）。

### 1. 交付

- 后端：`UploadService` + `/api/uploads` init/status/chunk/complete/abort；migration 4 `upload_sessions/upload_chunks`；8 MiB 块、5 GiB 上限、24h 会话、每用户 3 并发、配额预留、乱序/幂等/哈希校验、过期清理。
- 前端：>100 MiB 自动分片，2 块并发；`localStorage` 只保存 uploadId/已收块号；刷新/断线补缺块；取消保留断点；进度/重试沿用上传面板。
- 系统：journald `Storage=persistent`（适配 log2ram 64 MiB）、cloudflared 升级 2026.10.1 + systemd 加固、nftables WiFi 源从 `/16` 收窄到实际 `/21`、rpcbind 禁用、unattended-upgrades dry-run 验证。
- 文档：API/UI/ARCH/SECURITY/DEPLOY/PLAN/ROADMAP/README/AGENTS/CHANGELOG 同步。
- 第二轮审计补档：`docs/AUDIT.md`（A2-01～A2-10，含执行边界与残留）。

### 2. 验证

| 项目 | 结果 |
|---|---|
| `npm run check` | 通过：服务端 150/150、前端 52/52 |
| `npm run build` | 通过 |
| 生产 Health | `{"ok":true,"version":"0.3.1"}` |
| schema | v4；`upload_sessions/upload_chunks` 存在 |
| 分片 API | 生产 12 MiB（8 MiB + 尾块）init→chunk→status→complete 成功，文件登记后删除/清空 |
| 前端 | tsc/eslint/test:web 通过；分片纯函数 4 组测试 |
| 系统 | journald persistent、cloudflared 2026.10.1 active、nft `/21`、rpcbind/111 关闭 |
| 备份 | 两阶段任务与 secrets 状态保持；v0.3.0 已验证 |
| 临时数据 | 12 MiB 测试文件已删除；app session 清理 |

### 3. 部署

```text
部署目录: /opt/antifieldcloud/releases/20261020T025708Z
迁移前 DB 快照: /var/lib/antifieldcloud/backups/db-predeploy-20261020T025710864Z.sqlite
服务: antifieldcloud.service (active, v0.3.1)
tag: v0.3.1
release: https://github.com/antifield26/AntifieldCloud/releases/tag/v0.3.1
```

### 4. 未决

- 5 GiB 真实公网上传未跑满（12 MiB 已实测；逻辑/上限/过期测试覆盖），Cloudflare 总时长受网络影响。
- RCON 仍监听所有接口（Paper 无 bind 配置）；已由 nftables 阻断非 loopback，保留为已知限制。
- age 私钥仍需用户移到离线介质并删除本地明文副本。
- OpenCode 无垫片：Cloudflare 规则已验证；上游原生新建按钮仍失效，保留最小隐藏接管（详见 v0.3.0 历史）。

## v0.3.0（历史）

- 日期：2026-10-20（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64，生产环境
- 版本：`v0.3.0`
- 范围：深度审计修复、备份管理/文件级恢复、音视频播放、OpenCode 无垫片门禁；大文件分片留到 v0.3.1。

### 1. 交付

- 审计修复：备份 SSH/SCP 硬超时与 secrets 独立状态；回收站分享 410；分享审计节流/密码≥8/备注私有/token 日志脱敏/GC；告警 unknown 降级与 90 天保留；legacy 无参备份显式化；孤儿归档可观测；备份空间纳入已确认/孤儿。
- 备份管理：`migration 3`（`backup_archives` 扩展 + `restore_plans`）；Web 列表、手动 prepare、归档导入/校验、文件级恢复到新目录（TOTP + `RESTORE`）；整库恢复仅离线 root 手工流程；密钥包纳入 opencode DB/config 一致性快照。
- 媒体：`previewKind` 增加 audio/video，白名单 mp4/webm/mp3/m4a/ogg/flac/wav；CSP `media-src 'self'`；Range/HEAD/416；不转码。
- OpenCode：`OPENCODE_HTML_MODE=shim|attributes|passthrough`；默认 shim（无可见自定义按钮）；无垫片验证需 Cloudflare 关闭 ai 的 Rocket Loader/自动注入（待用户操作）。
- 文档/状态：API/UI/ARCH/SECURITY/DEPLOY/BACKUP/PLAN/ROADMAP/README/AGENTS/CHANGELOG 同步；`.local/preflight` ACL 收紧。

### 2. 验证

| 项目 | 结果 |
|---|---|
| `npm run check` | 通过：服务端 140/140、前端 48/48 |
| `npm run build` | 通过（Vite 构建；仅 chunk 体积警告） |
| `smoke.ps1` | 16/16 |
| 生产 Health | `{"ok":true,"version":"0.3.0"}` |
| schema | v3；`restore_plans` 存在；部署前 DB 快照已生成 |
| 备份 | 手动 prepare 生成 full pending；PC 新脚本拉取 + ack + secrets=ok；PC secrets 含 opencode（约 1.3 MB）；`--no-warnings` 修复 PowerShell 5.1 JSON 解析 |
| 媒体 | 生产上传 mp3 → `previewKind=audio`、`inlineAllowed=true`；`?inline=1` 为 inline，Range 返回 206；测试文件已删除 |
| 文件列表 | 名称列点击修复保留（v0.2.1） |
| OpenCode | Cloudflare Configuration Rule 已生效：passthrough HTML 的 `type="module"` 未被改写；attributes/passthrough 无 JS 时选择器资源可加载，但原生“新建会话”按钮仍无 `POST`（上游缺陷）。已回退 shim，隐藏 click/pointerup 接管可用，页面无可见自定义按钮 |
| 临时数据 | 临时 app session、媒体测试文件已清理；pending 备份已拉取/确认 |

### 3. 部署

```text
部署目录: /opt/antifieldcloud/releases/20261020T012822Z
迁移前 DB 快照: /var/lib/antifieldcloud/backups/db-predeploy-20261020T012824807Z.sqlite
服务: antifieldcloud.service (active, v0.3.0)
tag: v0.3.0
release: https://github.com/antifield26/AntifieldCloud/releases/tag/v0.3.0
```

### 4. 未决

- OpenCode 无垫片尝试：Cloudflare 关闭 Rocket Loader 后，无 JS 的 attributes/passthrough 仍无法触发原生新建会话（上游按钮缺陷）；按约定保留最小隐藏 click 接管，无可见按钮。后续上游修复/升级再复测。
- 系统级加固（journald persistent/RTC、cloudflared 升级、nft 收窄/rpcbind/RCON bind）逐项确认后执行。
- Minecraft 世界未纳入备份；大文件 5 GB 分片在 v0.3.1。
- age 私钥仍需用户移到离线介质并删除本地明文副本。

## v0.2.2（历史）

- 日期：2026-10-19（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64，生产环境
- 版本：`v0.2.2`（v0.2.1 的 UI 修正热修复）
- 范围：移除自定义新会话按钮、修复 Android 原生新建按钮无响应；保留文件列表点击与 Rocket Loader opt-out

### 1. 修复

### 移除可见按钮

- 删除 v0.2.1 注入的“＋ 新会话”浮动按钮及相关样式/文案。
- 兼容垫片不再向页面添加任何 UI 元素。

### 原生“新建会话”按钮

- 在捕获阶段接管 opencode 原生 `button[aria-label="新建会话"]`（兼容 `New session`/`新会话`）的
  `click` 与 `pointerup`；调用 opencode `POST /api/session`，跳转标准
  `/server/<base64-origin>/session/<id>`。
- 不修改 opencode 服务/数据；只对已认证 HTML 注入同源外部脚本 `/__af/oc-help.js`。
- 继续为 opencode 脚本加 `data-cfasync="false"`，避免 Cloudflare Rocket Loader 改写模块脚本导致
  智能体/模型选择器不渲染。

### 文件列表

- v0.2.1 的名称列按钮修复保留：文件夹进入、文件预览。

### 2. 验证

| 项目 | 结果 |
|---|---|
| `npm run check` | 通过：服务端 88/88、前端 23/23 |
| `npm run build` | 通过 |
| `smoke.ps1` | 16/16 |
| 生产 Health | `{"ok":true,"version":"0.2.2"}` |
| Android/宽屏移动 UA 原生按钮 | 点击产生 `POST /api/session`；进入 `/server/.../session/ses_...`；会话内模型选择器显示；页面无自定义按钮 |
| 文件列表点击 | 通过（临时文件夹已清理） |
| CI / Release | main/tag CI success；[v0.2.2 Release](https://github.com/antifield26/AntifieldCloud/releases/tag/v0.2.2) |

### 3. 部署

```text
部署目录: /opt/antifieldcloud/releases/20261019T150230Z
迁移前 DB 快照: /var/lib/antifieldcloud/backups/db-predeploy-20261019T150235470Z.sqlite
服务: antifieldcloud.service (active, v0.2.2)
tag: v0.2.2 → e4d4e8d
release: https://github.com/antifield26/AntifieldCloud/releases/tag/v0.2.2
```

### 4. 说明

- 智能体选择器在 opencode 只有单个 primary agent（当前 build）时由原生 UI 不展示；有多个 primary
  agent 时 Rocket Loader opt-out 保证其正常渲染。
- 测试用临时 app session、opencode 会话和文件夹均已清理。
- 浏览器若仍显示旧 Service Worker/bundle，请清除站点数据或硬刷新。

## v0.2.1（历史，已被 v0.2.2 取代）

> **已被 v0.2.2 取代**：v0.2.1 注入的可见“＋ 新会话”按钮已在 v0.2.2 移除，改为只接管原生按钮。
> 本段保留为历史记录；当前验收见本文件顶部 v0.2.2。

- 日期：2026-10-19（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 / Debian 13 / aarch64，生产环境
- 版本：`v0.2.1`
- 范围：v0.2.0 已知问题修复（文件列表点击、OpenCode Web 移动端/选择器）

### 1. 修复内容

### 文件页列表视图

- 名称列由静态 `div` 改为可访问的 `<button>`；文件夹点击进入，文件点击预览。
- 桌面表格与移动卡片共用；操作列仍是独立按钮，不触发误进目录。
- 保留网格视图原有行为。
- 生产验证：临时创建文件夹 `v021-click-test`，桌面列表点击名称后 URL 变为
  `/files?parent=<id>`；测试后已移入回收站并彻底删除。

### OpenCode Web

- **Rocket Loader 根因**：Cloudflare 把 opencode 的 `type="module"` 改写成随机 type 并延迟执行，
  导致智能体/模型选择器与新建按钮失效。
- 代理注入 HTML 时为 opencode 所有脚本加 `data-cfasync="false"`，并注入同源外部兼容脚本
  `/__af/oc-help.js`（不违反 opencode CSP `script-src 'self'`）。
- 移动端（含 Android UA）显示“＋ 新会话”浮动按钮；调用 opencode `POST /api/session` 后跳转标准
  `/server/<base64-origin>/session/<id>`。
- 桌面端“新建会话”按钮由捕获阶段接管，修复点击无响应。
- 生产验证（Android UA、390×844、临时 session，测试后删除）：
  - 首页出现“＋ 新会话”；
  - 点击后 URL 进入 `/server/.../session/ses_...`；
  - 会话输入框出现模型选择器 “MiniMax M3.1 Flash Free”；
  - 测试 session 已删除，临时 app session 已从 DB 删除。
- 说明：智能体选择器只在 opencode 存在多个 primary agent 时由原生 UI 展示；当前配置的 primary
  agent 为 build，其他为 subagent。本次修复保证有可选智能体时不再被 Rocket Loader 隐藏。

### 2. 自动化与冒烟

| 项目 | 结果 |
|---|---|
| `npm run check`（tsc + ESLint + node:test + Vitest） | 通过；服务端 88/88、前端 23/23 |
| `npm run build` | 通过；PWA 静态资源完整 |
| `scripts/smoke.ps1`（公网 + Pi） | 16/16 通过 |
| `GET https://app.antifield.work/healthz` | `{"ok":true,"version":"0.2.1"}` |
| 生产文件列表点击 | 通过（临时文件夹，已清理） |
| 生产 OpenCode Android UA | 通过（临时 session，已清理） |

### 3. 部署

```text
部署目录: /opt/antifieldcloud/releases/20261019T143637Z
迁移前 DB 快照: /var/lib/antifieldcloud/backups/db-predeploy-20261019T143640775Z.sqlite
服务: antifieldcloud.service (active, v0.2.1)
tag: v0.2.1 → 57cb8d0
release: https://github.com/antifield26/AntifieldCloud/releases/tag/v0.2.1
```

### 4. 注意

- 生产测试使用的临时 app session 已删除；临时文件夹已彻底删除；测试 opencode 会话已删除。
- 若浏览器仍加载旧 Service Worker/旧 bundle，请 Ctrl+F5 或清除站点数据后刷新。
- Cloudflare 仍会注入 Web Analytics/Challenge 脚本，严格 CSP 下可能控制台报错；不影响本次修复。
- 大文件仍受 Cloudflare 约 100 MiB/100s 限制；SSH 密码登录、无 Cloudflare Access 等 v0.2.0 残留不变。

## v0.2.0（历史）

- 日期：2026-10-19（Asia/Shanghai）
- 目标环境：Raspberry Pi 5 Model B（8 GB）/ Debian 13 trixie / aarch64 / 64 GB SD
- 公网入口：`https://app.example.com`、`https://ai.example.com`（Cloudflare Tunnel `antifieldcloud`）
- 代码版本：`v0.2.0`（tag 指向本文件所在提交）
- 结论：**技术验收通过；用户登录/手机/PWA 验收待本人完成**

### 1. 自动化与构建

| 项目 | 结果 |
|---|---|
| `npm run check`（tsc + ESLint + `node --test` + Vitest） | 通过：服务端 86/86、前端 23/23 |
| `npm run build`（Vite + PWA 资源） | 通过；产出 manifest/sw/offline/icons/assets |
| `scripts/smoke.ps1`（公网 + Pi） | 16/16 通过（含 PWA、分享、告警、cgroup、备份 pending/旁文件） |
| `npm ci --omit=dev` + `check-prod-deps.mjs` | 通过 |
| CI（shellcheck / nftables / PowerShell Parse+BOM） | 配置已加入，待推送后跑 |

### 2. 部署与数据库

- 部署 release：`/opt/antifieldcloud/releases/20261019T131401Z`；`current` 指向该版本；健康检查 v0.2.0。
- 迁移前 DB 快照：`/var/lib/antifieldcloud/backups/db-predeploy-20261019T131404874Z.sqlite`（SHA-256 已记录在部署日志）。
- schema version = **2**；新增 `notes/bookmarks/tags/FTS5`、`shares/share_sessions`、`alert_events/alert_state`、`backup_archives`。
- 原有用户/会话/文件数据保留；旧 release 可回滚（新增表 additive）。
- 发布包包含 LICENSE；`deploy.ps1` 健康检查失败自动回滚已实现。

### 3. 安全修复验证

| 审计项 | 验证 |
|---|---|
| C1 畸形 Cookie WebSocket DoS | 回归测试通过；进程不退出；AI HTTP 畸形 Cookie 返回 401 |
| H1 改密/恢复码再认证 | 需要 TOTP；IP 5/15min + 全局/TOTP 限流；失败审计；前端 TOTP 表单 |
| trustProxy | 非 loopback 对端忽略转发头；X-Forwarded-Host 不参与安全判断 |
| RCON | 密码已轮换为 32 位随机；`list` 成功；多包/超时测试通过 |
| 上传/磁盘 | 全局预留、100 MiB 上限、ENOSPC→507、tmp 清理；单元/集成测试通过 |
| 安全头 | HSTS、CSP（含 manifest/worker）、nosniff/referrer、AI 302/401 头、PDF XFO/CSP |
| 分享 | token 只存 SHA-256、密码 scrypt、过期/次数/吊销 410、Origin/限流、软删除同步吊销 |
| 审计/UI | 真实 action 映射、Activity 服务端筛选、Files/Trash 竞态修复、Markdown 禁 style |

### 4. Pi 系统与运维

- 一次 Pi 重启（同时 MC 重启）完成：5 个服务 active（antifieldcloud/cloudflared/minecraft/nginx/opencode）。
- memory cgroup：`/sys/fs/cgroup/cgroup.controllers` 含 `memory`；`MemoryMax=512M`、`MemoryCurrent≈158M`，限制真实生效。
- RCON：`0 位玩家在线`（重启时无人在线）；新密码写入 `server.properties` 与 env；25575 外部仍被 nftables 阻断。
- 健康探针：`antifieldcloud-health.timer` active/enabled；`/run/antifieldcloud/pi-health.json` 字段正常，欠压 sticky 位已清零。
- 安全更新：Debian trixie 安全更新已安装；`unattended-upgrades` active；`age` 1.2.1 已安装。
- Cloudflare：app/ai 302/401 正常；`mc.example.com` 未改；Cloudflare 边缘仍有 Web Analytics/Challenge 注入被严格 CSP 拦截（已知，文档记录）。
- 残留：SSH 密码登录保留、无 Cloudflare Access、单 SD 卡；cloudflared 仍未做 systemd 沙箱加固（后续）。

### 5. 备份与灾备

- 两阶段协议：手动运行新 `backup-pull.ps1`：`--prepare` full → 下载 → SHA 校验 → 原子改名 → `--ack` → 删除远端；pending=0。
- PC 目标：实际 Windows 目录（见本地 `.local/DEPLOYMENT.md`，不提交）；ACL 已收紧为当前用户 + Administrators + SYSTEM。
- Windows 任务：`AntifieldCloud-Backup-Pull` Ready；Arguments 含 `-PiHost/-PiUser/-BackupRoot`；电池不跳过；NextRunTime 2026-10-20 12:00。
- 密钥包：`backup-secrets.sh` 生成 age 加密包（env/cloudflared/MC/opencode 共 6 文件），已在 Pi 上解密验证后删除 Pi 私钥；私钥仅离线保存（本地临时副本需移出）。
- 备份状态 JSON/SHA 旁文件已更新；`smoke` 通过。
- **恢复演练已通过**：解包全量 `snapshot-20261019T130931524Z-full.tar.gz`（SHA 旁文件一致）+ 增量
  `snapshot-20261019T131311313Z-inc.tar.gz`；`PRAGMA integrity_check=ok`、schema=2、users=1；
  密钥包在同一 Pi 上用私钥解密并核对文件列表后删除 Pi 私钥。演练记录见本地 `.local/DR-DRILL.md`。
- 正式从 PC 恢复时的步骤见 `docs/BACKUP.md` §6；全量+增量命令已修正为按 manifest 选最新 DB。

### 6. 功能验收（服务端/公开端点）

- `/healthz` → `{"ok":true,"version":"0.2.0"}`（公网 + Pi）。
- PWA：`/manifest.webmanifest` 200 + `application/manifest+json`；`/sw.js` 200 + `Service-Worker-Allowed: /`；`/offline.html` 200。
- 公开分享页：`/s/<未知>`（浏览器 Accept）→ SPA HTML + `X-Robots-Tag: noindex`；API 404/410 正常。
- `/api/alerts` 未登录 401；告警服务已启动（env 未配置 webhook 时仅面板）。
- `/api/version` 登录后返回 app/ai origin、回收站天数、100 MiB 上限、分享/告警开关。
- 本地真实集成：登录 → 创建笔记 → 上传 → 创建密码分享 → 公开 metadata → unlock → 下载，全部通过。
- **待完成**：用户本人公网登录/改密/恢复码、手机 PWA 安装/拍照上传、分享手机打开、告警 webhook 实际投递。
  服务端已用真实集成脚本验证登录之外的笔记/上传/分享解锁/下载链路，以及 `/api/version`/PWA 静态端点。

### 7. 已知限制

- 分享下载次数为会话级近似；清 Cookie 可在 5 分钟会话内绕过一次计数。
- 笔记无附件/版本历史；分享不含目录。
- Cloudflare 约 100 MiB/100s 限制；大文件后续分片。
- FTS5 中文回退 LIKE。
- Cloudflare 注入与严格 CSP 的冲突需在 Cloudflare 后台关闭自动注入或接受控制台错误。
- `http-proxy` Node 26 弃用警告；Node 27 前评估替换。
- SSH 密码登录、无 Cloudflare Access、单 SD 卡未加密。

### 8. 发布

```text
tag: v0.2.0
tag message: AntifieldCloud v0.2.0
部署目录: /opt/antifieldcloud/releases/20261019T131401Z
服务: antifieldcloud.service (enabled, active, v0.2.0)
迁移前快照: /var/lib/antifieldcloud/backups/db-predeploy-20261019T131404874Z.sqlite
```
