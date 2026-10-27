# Changelog

## [v1.0.0] - 2026-10-28

v1.0.0 是 AntifieldComplexx 的架构收敛版本：工作台与 Minecraft bot 合并为 npm workspaces 单仓库，QQ Bot 子系统更名 chatbot（DB schema v18），原 lofii-bot 以全历史导入 `apps/mcbot` 并硬切换。

### Changed

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
- schema v18 迁移测试覆盖 v6/v9/v11/v12/v13/v17→v18；生产未变更（待 Phase 7 授权）。

历史版本请见 [docs/legacy/CHANGELOG.md](docs/legacy/CHANGELOG.md)。
