# Changelog

## [v1.0.3] - 2026-10-28（已部署生产；未打 Tag/Release）

v1.0.3 是 mcbot 环境感知/自主决策增强与文档-实现一致性审计版本：新增有界环境快照、附近方块/容器扫描、只读容器读取、进食/装备工具与事件驱动重决策；未变更 schema。2026-10-28 已部署生产（app `/opt/antifieldcloud/releases/20261028T144416Z`、mcbot `/opt/mcbot/releases/20261028T144253Z`），完整 Access smoke 36/0/1/2；未打 Tag/Release。

### Added

- **mcbot 环境感知**：`observe` 提供基础状态 + 安全区 allowlist 方块/容器扫描（默认半径 16、最多 48，只读已加载区块）；普通聊天仍使用轻量上下文。
- **只读容器**：`inspect_chest` 仅安全区、allowlist 容器、无 active/queue/pending 时短距寻路打开；不传送、不破块、不取物，读取摘要后立即关闭。
- **生存动作**：`eat` / `equip` 仅空闲时对背包内食物/护甲/工具生效，固定冷却、策略校验与审计。
- **事件驱动自主决策**：任务生命周期与安全告警触发重决策；同原因 30s 去重、最多 6 次，无周期空转；任务存在才保持会话。
- **文档审计**：新增 `docs/mcbot/CONSISTENCY-AUDIT.md` 声明/实现矩阵与 `scripts/check-mcbot-claims.mjs` 自动检查；修正 v1.0.2 生产状态、AI 能力、工具语义等陈旧声明。

### Verification

- 本地：`npm run check`、`npm run build`、`check-version`（1.0.3）、`check-naming`、`check:docs` 全绿；app 591（590 pass、1 skip）+ web 273 + mcbot 122；服务端覆盖率 93.10/78.88/88.86，前端 56.27/51.88/49.16。
- 生产：mcbot 1.0.3、app 1.0.3/schema18/OpenCode2.2.0；部署内只读 smoke 26/0/1/2，完整 Access smoke 36/0/1/2（WARN=drill schema17；2 SKIP=加密/异地默认关闭）；Windows 备份任务标记 1.0.3。
- 实机 Agentic：`observe` + `task_status` + `finish`（toolCalls=3），`low_health` 安全告警触发事件驱动重决策，任务未启动，session/MCP 清理；`FORCE_ONLINE` 恢复 false。

### Migration / Rollback

- 无 schema/DB 迁移；部署前快照 `/var/lib/antifieldcloud/backups/db-predeploy-20261028T144601033Z.sqlite`；人工备份 `/var/backups/antifieldcomplexx/v1.0.3-predeploy-20261028T144245Z`。
- 回滚：切回 app `/opt/antifieldcloud/releases/20261028T085429Z`、mcbot `/opt/mcbot/releases/20261028T091246Z`，并恢复部署前 env；自主模式仍默认关闭，生产 `AUTONOMY_ENABLED=true` 保持不变。未打 Tag/Release。

## [v1.0.2] - 2026-10-28（已部署生产；未打 Tag/Release）

v1.0.2 是 mcbot AI 自主能力与 Agentic 验收版本：模型通过 OpenCode 原生 MCP 工具循环驱动现有 10 种任务与回家/存箱，确定性策略层负责权限、预算、急停和审计；应用面板增加自主控制，并补 mcbot 运维残余。2026-10-28 已部署生产（app `/opt/antifieldcloud/releases/20261028T085429Z`、mcbot `/opt/mcbot/releases/20261028T091246Z`）；生产已启用自主模式（仅主人显式启动），Windows 备份任务已重装到 1.0.2；未打 Tag/Release。

### Added

- **mcbot AI 自主会话**：仅主人显式启动；OpenCode 运行时注册 MCP server，模型原生调用 `start_task`/`stop_task`/`go_home`/`deposit`/`task_status`/`finish`；每次会话随机 run_id + Bearer；OpenCode session 使用 deny-all + `mcbot_autonomy_*` 白名单；预算/失败/超时/断线/急停/任务清理；审计与 `autonomy` 事件。
- **应用**：mcbot 面板新增自主模式卡（状态/目标/时间/工具调用/最近决策，启动/急停二次确认）；任务下拉同步 10 种任务（guard/escort/explore）；`GET /api/mcbot/autonomy`、`POST /api/mcbot/autonomy/start|stop`，CSRF/限流/审计。
- **运维**：mcbot 纳入服务监控与 `service_down` 告警；`McbotService.stop()` 中止并等待在途轮询、停止后不写告警游标；`/api/mcbot/status|history` GET 60/min 限流。
- **Agentic 验收**：`test/agentic` 离线 scenario harness（CI）；`scripts/agentic-acceptance.mjs` 可选实机 conductor（默认 dry-run，需显式 `--allow-writes`）；`docs/mcbot/AGENTIC-ACCEPTANCE.md` 三角色流程。

### Verification

- 本地：root `npm run check` 通过；app 591（590 pass、1 skip）、web 273、mcbot 108；服务端覆盖率 93.10/78.89/88.86，前端 56.27/51.88/49.16；build/check-version（1.0.2）/check-naming 通过。
- OpenCode 2.2.0 原生 MCP Phase 0：运行时注册/工具调用/权限前缀/Authorization/清理通过。
- 未部署、未打 Tag/Release；生产仍 v1.0.1。

### Migration / Rollback

- 无 schema/DB 迁移；生产回滚使用部署前 DB 快照或切回上一 release；自主模式代码默认关闭（生产当前已启用，可随时设 `AUTONOMY_ENABLED=false` 重启）。未打 Tag/Release。
## [v1.0.1] - 2026-10-28

v1.0.1 是定位同步与 OpenCode 升级版本：运行时 UI/元数据切换为“个人综合交互平台”，OpenCode 从 2.1.4 升级到 2.2.0，无 schema 迁移。

### Changed

- **运行时定位文案**：HTML title/meta、PWA manifest/离线页、Logo/登录页/设置页/页面标题与 systemd Description 从“个人工作台”切换为“个人综合交互平台”。
- **版本**：根/workbench/mcbot 统一 1.0.1；`APP_VERSION=1.0.1`。
- **OpenCode 2.2.0**：2.2.0 的 breaking changes 仅涉及 `@opencode/ai` Promise API、GitHub Action 移除、TUI 插件 OpenTUI 0.7；应用使用原生 HTTP API + MCP，无需业务改动。升级前备份 v2.1.4 binary/data/env/unit/MCP；生产兼容矩阵与 /api/mcp 通过。
- **mcbot 1.0.1**：版本随统一版本轴发布，功能无变更。
- **文档**：README/AGENTS/PLAN/ROADMAP/UI-SPEC/ACCEPTANCE/DEPLOY/SECURITY/CHATBOT/mcbot 文档与版本/OpenCode 事实对齐；修复历史生产 facts 漂移。

### Fixed

- OpenCode 升级后运行进程未重启，导致 CLI 已 2.2.0 而 OpenCode Web/`/api/info` 仍显示 2.1.4；重启服务并在运行中的 2.2.0 上重跑兼容矩阵，smoke 增加 `/api/info` 运行版本与进程 exe 校验。

### Verification

- 本地：`npm run check`、`npm run build`、`check-naming` 通过；app 574/573 pass、web 256、mcbot 94。
- 生产：app `20261028T021311Z`（1.0.1/schema18/OpenCode 2.2.0）、mcbot `20261028T021116Z`（1.0.1）；部署内 smoke 26/0/1/2、完整 Access smoke **36/0/1/2**（WARN=drill schema17）。
- OpenCode 兼容：Basic/session list、permissions deny/allow、prompt/wait/assistant 形状、图片 prompt files、/api/mcp、MCP 进程唯一性、资源余量通过；模型不支持图片的回复不影响 API 兼容。

### Migration / Rollback

- 无 DB/schema 变更；应用回退上一 release；mcbot 回退上一 release；OpenCode 用 `/var/backups/opencode/20261028T020723Z` 备份回滚到 2.1.4。
## [v1.0.0] - 2026-10-28

v1.0.0 是 AntifieldComplexx 的架构收敛版本：工作台与 Minecraft bot 合并为 npm workspaces 单仓库，QQ Bot 子系统更名 chatbot（DB schema v18），原 lofii-bot 以全历史导入 `apps/mcbot` 并硬切换。

### Changed

- **项目定位**：重新定义为“个人综合交互平台”（统一入口整合个人数据/分享、Minecraft 与 mcbot、QQ chatbot、OpenCode AI、主机监控与备份灾备）；本次同步 README/AGENTS/docs，运行时 UI/API/服务标识不变。
- **仓库布局**：迁移为 npm workspaces（`apps/workbench` + `apps/mcbot`），根包 `antifieldcomplexx` 统一编排；根 `package-lock.json` 单一锁文件；根 `npm run check` 覆盖两个 workspace。
- **chatbot 全量更名**（原 QQ Bot 子系统）：
  - 模块/文件/类型：`server/src/bot` → `server/src/chatbot`，`BotService` → `ChatbotService` 等。
  - HTTP：`/api/bots*` → `/api/chatbots*`，`/api/bot/webhook/:botId` → `/api/chatbot/webhook/:chatbotId`，`/api/bot/ai/tool/send` → `/api/chatbot/ai/tool/send`；错误码 `invalid_chatbot_config`。
  - env：`BOT_*` → `CHATBOT_*`；`CHATBOT_CONTEXT_DIR` 默认 `/var/lib/antifieldcloud-chatbot-context`。
  - DB：`bots`/`bot_*` 表、`bot_id` 列与 meta 键迁移为 `chatbot_*`；历史迁移 SQL 保持只追加，新增迁移 18 一次性改名。
  - Web：`/chatbots` 页面与组件、`/bots` 自动重定向；`/api/version` 字段 `botsEnabled` → `chatbotsEnabled`。
  - 数据：`DATA_DIR/bot-memory` 镜像目录启动时自动迁移到 `chatbot-memory`。
- **mcbot 合并与硬切换**（原 lofii-bot）：
  - `git subtree` 保留全历史导入 `apps/mcbot`；workspace `@antifieldcomplexx/mcbot`。
  - 服务/用户/路径：`mcbot.service`、`mcbot`、`/opt/mcbot`、`/etc/mcbot`、`/var/lib/mcbot`。
  - 接入面：env `MCBOT_*`、API `/api/mcbot/*`、审计 `mcbot.*`、meta `mcbot.event_cursor`（迁移 18 重命名旧游标）。
  - 游戏内人格名保留 `Lofii`，展示为 “mcbot (Lofii)”。
  - 部署脚本改为 workspace 感知布局；`scripts/sync-mcbot-tokens.sh`。

### Added

- mcbot 稳定性与运维：systemd `sd_notify` 看门狗（`Type=notify`/`WatchdogSec=90`）、RSS 内存治理告警、断线重连恢复增强（连接损失不消耗任务重试次数）、故障注入/soak 测试。
- mcbot 任务与存储：深层裸露矿（`MINE_DEEP_ENABLED`）、分类存箱（`CHEST_ORES/FOOD/SAPLINGS/MISC`）、库存/食物告警与自动补货、基地守卫、玩家护送、航点探索任务。
- mcbot AI：只读受控工具（`AI_TOOLS_ENABLED`，`status/inventory/task_status`），AI 动作仍只由确定性指令解析与权限校验执行。
- 迁移与发布：`scripts/migrate-v1.0.0.ps1`（Plan/Apply/Verify/Rollback）；`docs/` 分区为 `app/mcbot/legacy`；`docs/INDEX.md`。
- 门禁：`scripts/check-naming.mjs`（旧标识符扫描）；`check-version` 覆盖 mcbot 版本与文档路径。

### Breaking / Migration

- **旧应用无法读取 schema v18**：生产升级前必须做 DB 快照；回滚 = 恢复快照 + 旧 release/env。
- QQ 开放平台回调地址需改为 `https://app.<domain>/api/chatbot/webhook/<chatbotId>`；Cloudflare Access bypass 同步更新。
- 生产 env 需将 `BOT_*` → `CHATBOT_*`、`LOFII_*` → `MCBOT_*`；mcbot 服务/路径/数据按迁移脚本切换。
- 旧 CHANGELOG 已归档到 [`docs/legacy/CHANGELOG.md`](docs/legacy/CHANGELOG.md)，历史版本号/旧名称仅用于追溯。

### Verification

- root `npm run check`：app 574（573 pass）+ web 256 + mcbot 94（93 pass/1 skip）；typecheck/lint/build 通过。
- app 覆盖率：Lines 93.04% / Branches 78.74% / Functions 88.73%；前端 55.83% / 51.29% / 48.66%。
- schema v18 迁移测试覆盖 v6/v9/v11/v12/v13/v17→v18。
- **生产已部署（2026-10-28）**：app `20261028T002517Z`（1.0.0/schema18）、mcbot `20261028T000632Z`（1.0.0）；迁移前 DB 快照 `db-predeploy-20261028T000918146Z.sqlite`；smoke 27/0/1/2（部署内）与 36/0/1/2（完整 Access，2026-10-28 配置修复后）。

历史版本请见 [docs/legacy/CHANGELOG.md](docs/legacy/CHANGELOG.md)。
