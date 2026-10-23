# AntifieldCloud v0.6.x 实施计划（摘要）

本文件是 v0.6.x 的权威范围/决策摘要；v0.5.x 历史见下方补充；完整交付与验收见 `docs/ACCEPTANCE.md`，界面见 `docs/UI-SPEC.md`，契约见 `docs/API.md`。当前版本 **v0.6.3（已发布：Tag/Release v0.6.3）**：每个群聊目标一张共享角色卡（管理员编辑）；群消息模式 `mention|all`；全量 `GROUP_MESSAGE_CREATE` 由模型 `NO_REPLY` 决定是否发送；群聊/频道禁用斜杠命令；schema v16。生产 release `20261023T142411Z`/commit `7ac1d27`；上一版 v0.6.2 已发布（Tag/Release v0.6.2，release `20261023T123055Z`/commit `77e42c7`，schema v15 兼容列）。

## v0.6.3（已发布：Tag/Release v0.6.3；群聊独立角色卡 + 群消息模式 + 全量消息 + 群聊禁用命令；schema v16）

- **范围**：群聊目标独立共享角色卡（管理员在“角色与记忆”新建/编辑正文/启停/删除，覆盖群成员私聊个人卡）；群目标独立设置“仅接受 @/名字提及”（默认）或“接受全部消息并由模型选择是否发送”（实验性）；适配器支持 `GROUP_MESSAGE_CREATE`；模型以 `NO_REPLY` 表示本轮不发送；群聊/频道不再接受任何斜杠命令（C2C 保留）。
- **决策（2026-10-23 用户确认）**：每个群一张共享卡（推荐）；群聊+频道都禁用命令（推荐）；按官方全量事件实现 `GROUP_MESSAGE_CREATE`，QQ 后台需开启“接收所有消息”，仅@/名字模式用 Bot 名称文本匹配，全量模式模型输出 `NO_REPLY` 保持静默。
- **数据**：schema v16（迁移 16 新增 `bot_group_roles`，`target_id` 主键 FK 级联；群消息模式复用 `bot_targets.chat_trigger`，默认 `mention`，不新增列）。
- **状态**：已发布（生产 release `20261023T142411Z`/commit `7ac1d27`，schema16；smoke 16/16 + 24/24，drill schema16 通过；用户 2026-10-23 23:09 CST 验收通过；annotated Tag `v0.6.3` + GitHub Release）。

## v0.6.2（已发布：Tag/Release v0.6.2；目标名称编辑 + 测试消息辨识 + 入站查重 + 投递与发布单列）

- **范围**：Web “Bot/投递与发布”主网格由双列改单列；目标名可内联编辑；目标行“测试”按钮向指定目标发送测试消息，确认 openid 对应 QQ 用户/群；最近入站目标按已配置 externalId 查重隐藏。
- **决策（2026-10-23）**：手填 QQ 号/群号功能回滚（QQ 官方不提供真实号码，且号码无法解决辨识）；改用测试消息 + 名称编辑；schema v15 的 `qq_number` 列保留为兼容列，API/发送不使用。
- **状态**：生产 release `20261023T123055Z`/commit `77e42c7`（v0.6.2/schema 15）；smoke 16/16 + 24/24（0 警告）；恢复演练 schema15 通过；用户验收通过并发布。

## v0.6.1（已发布：Tag/Release v0.6.1；Bot 连续消息 + SearXNG MCP 联网搜索 + 备份状态 hotfix）

- **发布决策（2026-10-23）**：用户确认 `/help` 简化文案与整体验收后发布；annotated Tag `v0.6.1` + GitHub Release。生产最终 release `20261023T094819Z`/commit `ceb2e8f`（v0.6.1/schema 14）。
- **连续消息处理（已确认方案）**：同一 `Bot×目标×用户` 的短窗口多条消息**合并为一次 AI 请求**；默认防抖窗口 `BOT_CHAT_BURST_WINDOW_MS=3000`、最长等待 `BOT_CHAT_BURST_MAX_WAIT_MS=10000`、单批上限 `BOT_CHAT_BURST_MAX_MESSAGES=10`；同一会话**严格串行**（处理中到达的消息进入下一批），不同会话可并行；Webhook 仍立即 ack，最终只回复一次；`/reset`/`/forget`/角色变更清理待处理缓冲；超长合并文本按 `BOT_AI_MAX_PROMPT_CHARS` 截断；图片批次只处理最后一张并保留文字。
- **联网搜索（已确认方案）**：**自建/私有 SearXNG** + **OpenCode MCP 工具**（`searxng_web_search`，`codemode=false`）作为稳定自动触发；`/search` 命令仍由服务端强制预取保证确定性。Bot 会话 permissions 仅放行 `searxng_*`，其余工具 deny；MCP 服务只访问 loopback SearXNG，不抓取结果网页，不保存查询正文；结果只注入标题/摘要/域名，回答末尾由服务端附来源（不暴露完整 URL）；搜索失败不阻断 Chat；按 Bot×用户每小时限流；提示词把结果标为不可信外部资料。`prefetch` 模式保留关键词预取作为兼容/回退。
- **配置**：`BOT_CHAT_BURST_WINDOW_MS/MAX_WAIT_MS/MAX_MESSAGES`；`BOT_SEARCH_ENABLED/URL/AUTO/MODE/MAX_RESULTS/TIMEOUT_SECONDS/MAX_SNIPPET_CHARS/LANGUAGE/SAFESEARCH/ENGINES/RATE_PER_HOUR`。`BOT_SEARCH_ENABLED=true` 时必须配置 URL；schema 保持 v14（无迁移）。
- **备份状态 hotfix（预部署）**：已 ack 且 PC 清理服务端文件的归档返回 `status=acked` + `available=false`，Dashboard/备份页不再误报“应用归档文件缺失”；`/api/auth/me` 补清旧父域 Cookie；生产 25 个 acked 归档复核与用户确认通过。
- **验收门禁**：单元/服务测试覆盖 burst 合并/串行、搜索客户端解析/过滤、自动/命令触发、失败降级、来源展示；本地 `npm run check` + 覆盖率；SearXNG 生产只读 JSON 验证；部署后 smoke 16/16 与 24/24；真实 QQ 连续消息与 `/search` 用户验收；之后再 Tag/Release。
- **状态**：功能已实现并验收；预部署 smoke 16/16 与 Access 24/24、MCP 连接、会话清理、`/help` 简化、用户实发复测通过；Tag/Release 已发布。

## v0.6.0 补充（已部署并验收通过；质量/安全加固 + OpenCode v2.1.3）

- **范围决策**：用户确认 v0.6.0 以质量/安全加固为主，不新增功能；P0–P2 全部修复，P3 记录；允许必要迁移但本版**不需要 schema 迁移**（保持 v14）。
- **审计**：第五轮 5 个工作流（安全/数据/灾备/Bot-AI/前端/运维）深度审计；P0=0、P1=1（QQ op=13 签名预言机）、P2=14 去重/工作流合计 16、P3 记录；修复与验证见 `docs/AUDIT.md` 第五轮。
- **安全修复**：op=13 严格 token/时间戳并审计；app/ai 改 **host-only Cookie + 一次性 AI SSO ticket**（不再父域共享）；app API/公开 unlock Origin 只信 app（+ loopback）；公开端点 octet-stream 大 body 收口；记忆敏感过滤；AI 工具隔离降级可见；SSO ticket 日志脱敏。
- **数据/灾备修复**：密钥包 opencode 快照硬失败并向 `secretsOk` 传播；多 pending ack 缺失集合合并；恢复解包按 tar 实测字节预检；legacy ops=0 不误标迁移；世界备份 `kept/keptCount`、演练真实字段与 schema 检查、恢复 `skippedMissing` 展示。
- **Bot 修复**：wait 回退只取本轮新回答；发布 >2000 字符明确 400（不静默截断、不再分段）；op=13 成功审计；`aiToolIsolation` + `bot.ai.permissions_fallback`。
- **OpenCode**：v2.1.2 → **v2.1.3**（先于 v0.6.0 单独升级并验证 Basic/会话/prompt/wait/content/model；备份与回滚见 `.local/audit/round5-opencode.md`）。
- **门禁（2026-10-23）**：`npm run check` 通过；`npm test` **383**、`npm run test:web` **176**（32 文件）；服务端覆盖率 Lines **92.39%** / Branches **77.83%** / Functions **87.14%**、build 通过；`check-version` 通过。
- **待办**：本地提交 → 合并 main → 部署（无迁移，仍做 DB 快照）→ smoke → 用户真实验收 → Tag/GitHub Release/CI；部署后回填 `docs/ACCEPTANCE.md`/CHANGELOG 证据。

## v0.5.11 补充（历史，已部署并验收通过；用户实发 2026-10-23 10:39 CST）

- **结构化记忆**：schema **v14**（迁移 14 新增 `bot_memory_items`/`bot_memory_state`；旧 `bot_ai_memories` 保留为 legacy 来源）；7 类条目（profile/preference/fact/project/task/relationship/episode），key/value/confidence/importance/source/时间/expires_at，唯一键 `(bot,user,kind,key)`。
- **抽取/召回**：3 条或空闲 120s 批处理 + 同用户串行，一次性会话、严格 JSON ops、敏感过滤、容量/TTL（profile/preference 不过期；fact/project 365、episode 90、task 30）；召回核心层优先 + 关键词相关层，3000 字/12 条预算，legacy fallback。
- **自助/管理**：`/memory`（计数/类型/启停/最近更新，不含 key/value；`off|on`）；`/forget confirm` 清空 items/state/legacy/会话（含远端）；管理 API 用户级/条目元数据/单条删除/整用户删除（绝不返回 key/value）。
- **Legacy 清理**：验收后 `node scripts/cleanup-legacy-memory.mjs`（默认 dry-run，`--confirm` 删除已迁移用户旧摘要行+镜像）。
- **数据/部署**：version 0.5.11；schema v14（迁移 14，不可逆，v0.5.10 不支持，回滚必须恢复迁移前快照）；`deploy.ps1` 期望 14；生产 env 新增 5 个 `BOT_MEMORY_*`。
- **状态**：已部署 v0.5.11/schema v14（最终 release `20261023T022831Z`/commit `931b10d`，smoke 16/16 与 24/24，env 5 个 `BOT_MEMORY_*` 就位）；用户实发验收通过（2026-10-23 10:39 CST：三条 Chat → extract rounds=3 ops=2、`/memory`、`/forget confirm` items=2 legacy=0；legacy 清理 users=0 files=0）；测试基线 `npm test` **360**（341+19）、`npm run test:web` **162**（30 文件，+5）；覆盖率 Lines **92.05%** / Branches **77.43%** / Functions **86.39%**、`npm run build` 通过。

## v0.5.10 补充（历史，已部署并验收通过；v0.5.11 起升级 schema v14）

- **记忆与会话修复**：摘要会话一次性并删除远端会话（不再保存 `summary_session_id`，列保留）；记忆更新按 Bot×用户串行队列；合并策略=累计 3 条或空闲 120s 触发，审计 `bot.ai.memory` 含 `rounds`；
  `/reset`、`/forget confirm`、角色卡变更（含管理员删除）尽力删除远端会话与旧摘要会话。
- **保留期分离**：会话 7 天（`BOT_AI_SESSION_RETENTION_DAYS`）与长期记忆 `BOT_AI_MEMORY_RETENTION_DAYS=365`（30–3650）独立。
- **移除代理隧道依赖**：删除 `scripts/discord-tunnel.ps1/.vbs`、`scripts/install-tunnel-task.ps1` 与 PC 计划任务；删除 `BOT_PROXY_URL`；生产 env 删除代理变量；
  连通性仅 `internet` + `platforms`（外网 + QQ 平台，Pi 直连），不再有 `deviceOnline`/`proxy`。
- **数据/部署**：version 0.5.10，schema 保持 v13（无迁移）；`deploy.ps1` 无需改；回滚切回 v0.5.9 release 并恢复 env（代理变量/旧隧道脚本与计划任务，如需）。
- **状态**：本地测试基线 `npm test` 341（333+8）、`npm run test:web` 157（30 文件）、`npm run typecheck` 通过；覆盖率 Lines **91.98%** / Branches **76.92%** / Functions **85.99%**、build 通过；已部署 v0.5.10/schema v13（release `20261022T152053Z`/commit `4619c91`，smoke 16/16 与 24/24，env 实测/直连/隧道清理通过）；**用户已实发验收通过**（2026-10-22 23:26–23:29 CST：合并摘要 rounds=3、远端会话删除 404 两例、图片 145172 B 有服务端证据；`/bots` 卡片用户确认；证据见 `docs/ACCEPTANCE.md`）。

## v0.5.9 补充（历史，已部署并验收通过；v0.5.10 起移除代理隧道依赖）

- **移除 `/ask`**：`BOT_COMMANDS` 无 `ask`；非管理员按未知命令被拒（无回复），管理员回全量帮助、不调用 AI；斜杠命令不再触发 AI。
- **AI 仅普通消息 Chat**：提示词固定为「角色卡（个人卡或 lofii）+ 固定只读安全边界 + 长期记忆 + 用户」，`BotAiMode`/task 提示词与 `BOT_AI_TASK_PROMPT`/`BOT_AI_CHAT_PROMPT` 移除；
  `bot_ai_sessions.mode` 列保留但只写 `chat`；`/reset` 与角色卡变更清理该范围全部会话映射；审计 `bot.ai.chat` 不再记录 `mode`。
- **限速宽松档**：`BOT_CHAT_RATE_PER_MINUTE=30`（1–120）、`BOT_AI_RATE_PER_HOUR=120`（1–600）、`BOT_COMMAND_RATE_PER_MINUTE=120`（1–600）。
- **`/help` 自助且动态**：非管理员 `publicHelpText()`（`/help /role /reset /forget confirm` + Chat 说明），管理员 `helpText()` 全量（无 `/ask`）；未知命令按身份回帮助/被拒。
- **数据/部署**：version 0.5.9，schema 保持 v13（无迁移）；生产需 env 迁移（新限速值 + 删除两个提示词变量）后重启；回滚还原旧 env 值/旧 release。
- **状态**：本地测试基线（Lead 实测 2026-10-22）`npm test` 333（server + 脚本；较 v0.5.8 少 4 个已移除用例）、`npm run test:web` 157（30 文件）、
  `npm run check`/coverage（Lines 91.77% / Branches 76.98% / Functions 85.96%）/build 通过；已部署 v0.5.9/schema v13（release `20261022T143451Z`/commit `97996dc`，smoke 16/16 与 24/24，env 迁移完成）；**用户已实发验收通过**（2026-10-22 22:39–22:41 CST；非管理员 `/help` 有服务端事件证据，其余为用户确认；证据见 `docs/ACCEPTANCE.md`）。
- **下一版**：v0.6 候选（企业微信/钉钉/飞书、多管理员审批、QQ 平台更多能力），范围待用户确认。
## v0.5.8 补充（历史；已部署并验收通过，v0.5.9 起移除 /ask 与 task 模式）

- **平台收敛**：Bot 仅支持 QQ 官方 Bot；删除 Telegram/Discord/Slack 适配器、Discord Gateway、只读按钮、媒体/多附件发布、目标 `chatTrigger`、
  Telegram HTML/引用/线程；删除 env `BOT_DISCORD_GATEWAY_ENABLED`、`BOT_PUBLISH_MAX_MEDIA_BYTES/FILES/TOTAL_BYTES`；`BotPlatform` 仅 `qq`。
- **数据**：schema v13（迁移 13 = `DELETE FROM bots WHERE platform <> 'qq'`，级联删除非 QQ Bot 的目标/队列/事件/会话/记忆/角色卡），迁移不可逆；
  **生产 Discord Bot 数据迁移前必须备份**，回滚只能还原迁移前 DB 快照；迁移 5–12 保留。
- **QQ 单平台能力保留**：QQ 官方 Bot 接入、命令（含 `/role`/`/reset`/`/forget confirm`）、C2C/群@/频道 Chat、长期记忆、私聊角色卡、事件诊断、
  平台连接自检（`access_token`）、角色/记忆元数据管理、文本发布（TOTP + `PUBLISH`，≤2000 分段）。
- **图片默认开启**：`BOT_AI_VISION_ENABLED=true`；QQ `d.attachments` 图片经 `.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（QQ 实际图床如 `multimedia.nt.qq.com.cn`） 后缀白名单、image mime 白名单、≤`BOT_AI_IMAGE_MAX_BYTES`、
  内存不落盘下载后交给 AI；失败/关闭降级；图片会经 OpenCode 发给模型 provider（SECURITY 明示）。
- **API/UI 收敛**：`BotSummary` 无 `gateway`、`BotTarget` 无 `chatTrigger`、`BotPublishJob` 无 `mediaFileIds`；删除媒体/触发方式错误码；
  Web `/bots` 去 Gateway/媒体/触发方式，保留 6 分区。
- **状态**：已部署 v0.5.8/schema v13（release `20261022T134852Z`/commit `96294e4`，smoke 16/16 与 24/24，迁移 13 后仅 1 行 QQ Bot）；测试基线 337/157（Lead 全量实测 2026-10-22，`npm run check`/coverage/build 通过）；**真实 QQ 消息已由用户实发验收通过**（2026-10-22 21:59–22:08 CST，13 条入站事件符合预期；证据见 `docs/ACCEPTANCE.md`）。
- **下一版**：v0.5.9/v0.6 候选（企业微信/钉钉/飞书、多管理员审批、QQ 平台更多能力），范围待用户确认。

## v0.5.7 补充（历史；v0.5.8 起移除多平台能力，v0.5.9 起移除 /ask 与 task 双模式）

- **范围**：群聊触发方式（目标级 `chatTrigger=mention|all`；QQ 群/频道仅 @）、回复引用/线程（Telegram/Discord/Slack）、
  长回复按平台上限分段（最多 4 段、续段前缀、超限截断、Telegram HTML 安全分段）、Markdown 平台化、图片理解（默认关闭）、
  自助 `/reset`/`/forget confirm`、平台连接自检、入站事件诊断与 `lastErrorHint`、角色/记忆元数据管理、Web `/bots` 6 分区。
- **数据**：schema v12（迁移 12：`bot_targets.chat_trigger` 默认 mention；`bot_events` 增加 event_kind/outcome/detail/target_external_id/user_id/updated_at 与索引）；
  迁移 5–11 保留；迁移单向，回滚需迁移前 DB 快照。
- **配置**：新增 `BOT_AI_MAX_REPLY_CHARS=4000`（1000–12000）、`BOT_AI_VISION_ENABLED=false`、`BOT_AI_IMAGE_MAX_BYTES=10485760`（1–20 MiB）；
  `bootstrap-env.sh` 已纳管；图片需 OpenCode prompt files + 支持 image 输入的模型（生产只读验证 `opencode-go/deepseek-v4.1-flash`），默认关闭。
- **安全**：自助命令不要求目标/用户白名单但只影响本人数据且审计无正文；管理 API 仅元数据；诊断不存正文；图片不可信/不落盘/固定域名；
  partial 失败不自动重试；发布仍为 TOTP + `PUBLISH` 双确认。
- **决策**：QQ 群/频道不支持“全部消息”（平台事件本身即 @，服务端拒绝 `all`）；AI 回答上限由固定 4000 改为可配置并由平台层分段；
  图片能力默认关闭，避免无意把图片交给模型；回复在群/频道引用原消息，私聊不引用。
- **状态**：本地测试 387/157、`npm run check` 通过、`check-version` 通过；已部署 v0.5.7/schema v12（当前 release `20261022T131813Z`，commit `2f429be`，含错误提示映射修复；部署内只读 smoke 16/16、完整 smoke 24/24，`/healthz` v0.5.7/schema 12，第二次迁移前快照保留；生产只读复验通过）；真实平台消息级联调待用户实发（Discord 需先补注册 `/role` `/reset` `/forget`）。
- **下一版**：v0.5.8 候选（企业微信/钉钉/飞书、多管理员审批、Slack 按钮），范围待用户确认。

## v0.5.6 补充（历史）

- **默认角色 lofii**：内置猫系轻松伙伴，私聊与群聊普通对话默认使用；个人卡只覆盖私聊，`/role off` 回落到 lofii。
- **全用户语气**：`/role` 文案只写当前角色与用法，不注入默认角色个性或技术术语；群内 `/role` 只给友好提示。
- **兼容**：schema 保持 v11；`BOT_AI_CHAT_PROMPT` 不再影响 Chat；个人角色卡与任务模式不变。
- **状态**：本地测试 324/141、`npm run check` 通过；生产 release `20261022T114546Z`/schema v11、smoke 24/24，私聊/群聊 lofii 与简洁 `/role` 文案已实发确认。

## v0.5.5 补充（历史）

- **私聊角色卡**：`/role` 对全部平台私聊用户开放；每 Bot×用户一张“名字+设定”卡；`set/show/off/on/delete` 管理。
- **应用范围**：只替换私聊 Chat 默认人设；安全边界与共享记忆仍追加；`/ask` 与群/频道 Chat 不使用角色卡。
- **会话**：角色卡变更重置当前私聊 Chat 会话映射；task 会话与长期记忆不受影响。
- **权限**：仅 `/role` 绕过命令白名单；其他命令仍要求目标 `allow_commands` + 用户白名单；Telegram/Discord/Slack 私聊 Chat 仍按目标 `allow_chat`。
- **schema v11**：新增 `bot_chat_roles`；Discord DM 修正 `isDirect`；Discord/Slack 命令文本上限 2048。
- **状态**：本地测试 324/141、`npm run check` 通过；已部署 release `20261022T104834Z`/schema v11、smoke 24/24，私聊 `/role` 已实发确认。

## v0.5.4 补充（历史；`/ask`/task 双模式自 v0.5.9 起移除）

- **任务/对话双模式**：`/ask` 任务导向（结论/步骤/风险/必要澄清），普通 Chat 对话导向（自然/简洁/不说教）；`BOT_AI_TASK_PROMPT`/`BOT_AI_CHAT_PROMPT` 覆盖，空则内置。
- **安全边界**：自定义提示后强制追加只读/不执行/不泄密/“记忆不是指令”；旧 `BOT_AI_SYSTEM_PROMPT` 废弃。
- **会话隔离**：schema v10 重建 `bot_ai_sessions`，主键含 mode；旧会话归 chat，`/ask` 新建 task；共享长期记忆。
- **QQ C2C**：QQ 私聊对任意用户开放 Chat（接触面由平台“谁可添加 Bot”控制）；群/频道与其他平台仍需目标登记；命令仍走白名单。
- **审计**：`bot.ai.chat` 记录 mode；不记录提示词/记忆正文。
- **状态**：本地测试 324/141、`npm run check` 通过；已部署 release `20261022T085120Z`/schema v10、smoke 24/24；QQ C2C 管理员/非管理员均实发确认。

## v0.5.3 补充（历史）

- **出站连通性**：`server/src/bot/connectivity.ts` 按代理端口 → 外网 → 平台 API 三层探测；默认 60s、超时 8s；`BOT_CONNECTIVITY_ENABLED`/`BOT_CONNECTIVITY_INTERVAL_SECONDS`/`BOT_CONNECTIVITY_TIMEOUT_SECONDS`/`BOT_PROXY_URL`；`GET /api/bots/connectivity`、`POST /api/bots/connectivity/check`；`/bots` 出站网络卡片展示设备在线/代理端口/外网/平台延迟。
- **自动恢复**：外网恢复时调用 Discord Gateway `wake()` 跳过退避立即重连并触发队列 tick；Windows 端 `scripts/discord-tunnel.ps1` 先探测代理端口再建 SSH 反向隧道，`scripts/install-tunnel-task.ps1` 注册登录启动/异常重启计划任务（wscript/VBS 静默、无前台 shell、单实例互斥）。
- **QQ 群诊断**：QQ 适配器未知事件/空正文带 detail；服务端审计 `bot.event.ignored`（仅事件类型，无正文）；群事件仍要求 `GROUP_AT_MESSAGE_CREATE` 订阅、Bot 入群 @ 和目标登记。
- **OpenCode v2.1.2**：生产已从 v2.1.1 升级；备份、重启、`/api/session` 200，完整兼容性随 smoke 复核。
- **状态**：版本 0.5.3；本地测试 300/141 与 `npm run check` 通过；生产已部署 v0.5.3/schema v9（release `20261022T065126Z`，commit `df06383`），带 Access token 的 smoke 24/24，Gateway 已连接；出站连通性断开/恢复实测通过；OpenCode v2.1.2；QQ 群目标已登记并确认 @Bot AI 回复。

## v0.5.2 补充（历史）

- **Bot Chat**：非斜杠普通消息进入 AI Chat；目标级 `allow_chat`（默认 0）与 `allow_commands` 分离；群/频道仅 @Bot 或回复 Bot，私聊全部；Telegram/Slack/QQ Webhook 与 Discord Gateway 支持；非管理员只能 Chat，管理员斜杠命令仍由 `allow_commands` 目标 + user 白名单双校验；Chat 只读，不执行写操作。
- **长期记忆**：每 Bot×用户一份；DB `bot_ai_memories` 摘要为权威 + `summary_session_id`，`DATA_DIR/bot-memory/memory-<uuid>.md` 为镜像（0700/0600）；每轮滚动摘要；摘要失败保留旧摘要；记忆不通过 API/UI 暴露；系统提示内置，`BOT_AI_SYSTEM_PROMPT` 覆盖；摘要不额外占对话轮次或 AI 每小时配额。
- **多附件发布**：最多 5 个、单文件 ≤10 MiB、总 ≤50 MiB；Telegram 图片 media group/混合逐文件、Discord 单次 multipart、Slack 逐文件；QQ 仅文本；部分成功不自动重试（`partial_media_sent`）。
- **只读按钮**：Telegram inline keyboard 与 Discord message components 的 `/status`、`/help` 刷新/帮助按钮；需 `allow_commands` 目标 + user 白名单；无写操作；Slack/QQ 不做按钮。
- **Discord Gateway**：Node 内置 WebSocket 长连接；`intents=37377`（含 `MESSAGE_CONTENT`）；需 Developer Portal 开启 intent；HELLO/IDENTIFY/RESUME、心跳、重连与致命关闭码；`BOT_DISCORD_GATEWAY_ENABLED=false` 默认关闭；`BotSummary.gateway` 暴露状态。
- **管理面**：目标 `allowChat`、最近入站目标 `GET /api/bots/:id/inbound-targets` 与 `/bots` 登记；发布媒体多选；Discord/Telegram/QQ 配置提示。
- **数据**：schema v9（迁移 9：`bot_targets.allow_chat`、`bot_ai_memories`、`bot_inbound_targets`）；迁移 5–8 保留。
- **env**：`BOT_CHAT_RATE_PER_MINUTE=6`、`BOT_AI_MEMORY_MAX_CHARS=4096`、`BOT_AI_SYSTEM_PROMPT=`、`BOT_DISCORD_GATEWAY_ENABLED=false`、`BOT_PUBLISH_MAX_MEDIA_FILES=5`、`BOT_PUBLISH_MAX_MEDIA_TOTAL_BYTES=52428800`；已有 `BOT_AI_RATE_PER_HOUR=10`。
- **状态**：版本 0.5.2；本地测试基线 `npm test` 293（服务端 277 + 运维脚本 16）、`npm run test:web` 140（28 文件），`npm run check` 本地通过；生产已部署 v0.5.2/schema v9，带 Access token 的完整 smoke 24/24，Discord Gateway 已连接，Discord DM、Discord #general @Bot、QQ C2C 普通消息 Chat 已实发确认；多附件/按钮行为待补充验证。

## v0.5.1 补充（历史；`/ask`/task 双模式自 v0.5.9 起移除）

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

## 目标（历史，v0.5.2 阶段）

在 v0.5.1 已交付的 Bot 平台（Telegram/Discord/Slack/QQ、`/ask`、指标/静默/发布双确认）基础上，完成 v0.5.2：**普通消息 Chat 与长期记忆、多附件发布、Telegram/Discord 只读按钮、Discord Gateway 长连接，以及目标 `allow_chat`/最近入站目标与 schema v9**；企业微信/钉钉/飞书留到 v0.5.4。

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

## 阶段（历史，v0.5.2 交付时记录）

1. 基线确认：v0.5.1 生产/审计待办分拣；确认 Discord Gateway intent、Telegram/QQ 平台 Chat 权限与 v0.5.2 部署前置条件。
2. 服务端：schema v9（迁移 9：`allow_chat`、`bot_ai_memories`、`bot_inbound_targets`）、Chat 分发、记忆摘要与镜像、多附件发送、只读按钮、Discord Gateway；保持 v0.5.1 安全语义。
3. 前端：`/bots` 目标 `allowChat` 与最近入站目标登记、发布媒体多选（≤5）、Gateway 状态、Discord/Telegram/QQ 配置提示；移动端布局不退化。
4. 运维：`bootstrap-env` 纳管 6 个 v0.5.2 键；Discord Developer Portal 开启 Message Content Intent；部署前快照/回滚与迁移 v9 流程；smoke `-ExpectedSchemaVersion 9`。
5. 文档与版本一致性：全量文档同步、`node scripts/check-version.mjs`、CHANGELOG v0.5.2。
6. 本地验证：`npm run check`、`npm test`、`npm run test:web`、`npm run build`（本次记录 `npm test` 293、`npm run test:web` 140、`npm run check` 通过；未执行真实平台验收）。
7. 部署与验收（待执行）：PC 部署、迁移前快照、v9 迁移、`BOT_*` 写入、冒烟、Discord Gateway 真实长连接、各平台 Chat/多附件/按钮、记忆持久化、公网/手机/PWA、世界备份/拉取/恢复演练（schema 9）与 Cloudflare Access 复跑。

## 验收摘要（历史，v0.5.2 交付时记录）

1. 本地验证：`npm run check` 全绿（`npm test` 293 = 服务端 277 + 运维脚本 16，`npm run test:web` 140；2026-10-21 本次文档更新期间通过）；`npm run build`、覆盖率与 CI 以最新 main 为准（本次未重新执行）。
2. 版本一致：`/healthz`、`/api/version`、`package.json`、README、CHANGELOG、AGENTS、`deploy/env.example`、DEPLOY 标题均为 0.5.2；schema v9（本地代码/迁移测试；生产待迁移）。
3. Chat：目标 `allow_chat` 后端到端生效，群/频道仅 @/回复进入，私聊直接进入；非管理员不能执行斜杠命令；Telegram/Slack/QQ Webhook 与 Discord Gateway 单测覆盖；真实平台待联调。
4. 记忆：每 Bot×用户一份，DB 摘要与镜像文件一致；摘要失败保留旧摘要；文件 0700/0600 且不出现在 Web 静态目录；不通过 API/UI 暴露。
5. 多附件：服务端校验 5 个/10 MiB/50 MiB；Telegram/Discord/Slack 发送策略与 partial 不重试有单测；真实平台外发待验收。
6. 按钮/Gateway：Telegram/Discord 按钮需目标 + 用户双授权且只读；Discord Gateway intents=37377、HELLO/IDENTIFY/RESUME/心跳/重连/致命关闭码有假 WebSocket 单测；真实 Discord 长连接待 Developer Portal 开启 intent 后验收。
7. 安全：Chat 双限流、记忆路径/权限、入站目标不存正文、Gateway Token 不落日志；T/D/S/QQ 原有签名/去重/双白名单/发布 TOTP + `PUBLISH` 不退化。
8. 关闭态：`BOT_ENABLED=false` 时 Webhook 404、写接口 503、队列不启动；`/api/bots/status` 可读；`BOT_DISCORD_GATEWAY_ENABLED=false` 时不建立连接。
9. 备份：应用归档两阶段/密钥包（含 `BOT_*`/`BOT_SECRET_KEY`）/导入恢复；世界备份保留 4 份；PC 拉取失败不 ack；演练 `-ExpectedSchemaVersion 9` 在部署后按计划执行。
10. 生产部署、迁移 v9、smoke 已完成；Discord Gateway 已连接，Discord DM、Discord #general @Bot、QQ C2C 普通消息 Chat 已实发确认；多附件/按钮行为待补充并记录到 `docs/ACCEPTANCE.md`。

## 关键决策

> 下表为 v0.5.2 阶段的累计决策；v0.5.7 的增量（触发方式/引用/分段/格式化/图片/自助命令/诊断/管理）见顶部「v0.5.7 补充（当前）」。

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

企业微信/钉钉/飞书（未排期）、Bot 多管理员审批、QQ 媒体、Slack/QQ 按钮、除 Discord Gateway 外的平台主动拉取/长连接、任意命令执行；目录打包分享、笔记公开分享、整包加密归档、异地副本/对象存储、WebDAV/rclone、Minecraft 启停/控制台、多用户与权限分离、SSD/LUKS 迁移、`antifield` sudo 收紧（用户确认后另做）。Cloudflare Access 只做 `app` 策略与 Bot/health/公开分享 bypass，不覆盖 `ai`（OpenCode 自身认证 + 应用会话已足够，后续再评估）。

## 回滚

- 代码：`scripts/deploy.ps1` 停止服务并还原迁移前 DB 快照、还原上一 release 的 `APP_VERSION` 后切回 previous；无快照/读不到版本时拒绝自动回滚并打印手工步骤；部署后 smoke 失败默认让部署失败（`-AllowSmokeFailure` 仅告警）。
- DB：schema v12 只向上；回滚旧 release 前必须恢复 `/var/lib/antifieldcloud/backups/db-predeploy-*.sqlite`；
  迁移 12 只加 `bot_targets.chat_trigger` 与 `bot_events` 诊断列/索引，旧代码不能直接读 v12（会拒绝启动），不能只回退代码；迁移 5–11 的历史说明见 DEPLOY/BACKUP。
- Bot：`BOT_ENABLED` 保持 false；`BOT_SECRET_KEY` 不轮换（轮换=全部 Token 重录）；`bots`/`bot_targets`/`bot_events`/`bot_ai_sessions`/`bot_ai_memories`/`bot_inbound_targets`/`bot_chat_roles` 随 DB 快照回滚；
  `DATA_DIR/bot-memory` 镜像文件按需人工清理；`/ask`、Chat、Gateway 与 `BOT_AI_VISION_ENABLED` 保持关闭。
- 系统：nftables 恢复 `/etc/nftables.conf.bak` 后 `systemctl restart nftables`；fail2ban drop-in 回滚删除 `/etc/systemd/system/nftables.service.d/10-fail2ban-restore.conf` 后 `daemon-reload`；SSH 删除 `00-` drop-in 后 `sshd -t && systemctl reload ssh`（24h 窗口内）。
- 世界备份：`systemctl disable --now antifieldcloud-world.timer` 并移除 unit；旧 cron 未恢复前不重新启用。
- Windows：`Unregister-ScheduledTask` 世界拉取/演练任务；每日应用备份任务可用 `install-backup-task.ps1` 重装。
