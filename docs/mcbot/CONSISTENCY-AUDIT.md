# mcbot 文档声明与代码实现一致性审计（v1.0.5）

本审计以**代码/实际安全行为为真相**，覆盖根 README、AGENTS、docs/mcbot、docs/app/API 与 mcbot 环境模板。自动检查脚本：`scripts/check-mcbot-claims.mjs`（根 `npm run check:docs`，纳入 `npm run check`）。历史发布记录、`docs/legacy` 与已冻结的验收文本标为 `historical`，不回写历史，但会标注当前事实。

## 1. 声明矩阵

| 文档声明 | 位置 | 代码/测试证据 | 状态 | 动作 |
|---|---|---|---|---|
| 自主会话工具为 6 个（start_task/stop_task/go_home/deposit/task_status/finish） | v1.0.2 README/API/AGENTS 历史描述 | `apps/mcbot/src/autonomy/tools.ts` v1.0.2 版本 | historical | v1.0.3 文档改为 10 个工具并标注版本差异 |
| v1.0.3 工具为 10 个：上述 6 个 + observe/inspect_chest/eat/equip | v1.0.3 docs/mcbot/README、API | `AUTONOMY_RAW_TOOLS`、`buildToolDefinitions()`、`test/unit/autonomy-v103.test.ts` | fixed | 自动检查工具名齐全 |
| 任务白名单 11 种（v1.0.5 增加 `clearing`） | README、AGENTS、mcbot README | `AUTONOMY_TASK_NAMES`、`AUTONOMY_TASKS` 校验、config/任务测试 | fixed | 自动检查任务名齐全 |
| v1.0.5 在线模式 `auto/always/off`、`presence.json` | mcbot README/API、app API | `presence/manager.ts`、`presence/store.ts`、HTTP 集成测试 | fixed | 模式/off 冲突/持久化测试 |
| v1.0.5 多步目标 `goals.db`、重启 paused | mcbot README/API、app API | `goals/store.ts`、`goals/runner.ts`、app 代理与面板 | fixed | store 重启测试；不自动执行 |
| v1.0.5 `AUTO_SURVIVAL`/`AUTO_RESTOCK` 默认开启 | mcbot README/API、env 模板 | `config.ts`、`tasks/manager.ts` `autoSurvival()`、main 定时器 | fixed | 默认值与单元测试 |
| 自主会话代码默认关闭、生产 v1.0.2/v1.0.3 已启用 | README、AGENTS、mcbot README、API | `config.ts` 默认 `AUTONOMY_ENABLED=false`；生产部署记录 | fixed | 明确区分代码默认与生产配置 |
| 普通聊天 AI 不执行动作；`AI_TOOLS_ENABLED` 是只读上下文段而非 OpenCode 工具 | 根 README、docs/mcbot/README、AGENTS | `ai/tools.ts` 的 `buildAiToolContext` 只拼提示词；`READ_ONLY_AI_TOOL_NAMES` 仅 allowlist | fixed | 删除“AI 没有任何工具”的绝对声明，限定普通聊天 |
| v1.0.2 生产版本为 1.0.2，而不是 1.0.1 | docs/app/API | 生产 `/healthz`、release 记录 | fixed | 改为 v1.0.3 生产 |
| 环境快照有界：基础状态 + 安全区 allowlist 方块/容器；只读已加载区块 | docs/mcbot/README/API、AGENTS | `environment.ts` 扫描/上限/安全区过滤；环境单测 | consistent | 自动检查关键 env/doc 声明 |
| 容器读取只读、不取物、不传送、不破块；仅空闲 | docs/mcbot/README/API/AGENTS | `inspectChest()` 校验、`movement.goNearPoint(..., false)`、`chest.close()`、测试 | consistent | 保留失败关闭测试 |
| eat/equip 仅空闲、背包内食物/护甲/工具、固定冷却 | docs/mcbot/README/API/AGENTS | `eat()`/`equip()`、`withAction`、单元测试 | consistent | 不接受任意物品/槽位 |
| 事件驱动重决策：任务生命周期 + 安全告警、30s 去重、最多 6 次、无周期空转 | docs/mcbot/README/API、AGENTS | `EVENT_TRIGGERS`、`queueDecision`、`decisionLoop`、事件测试 | consistent | 自动检查 env key |
| 环境/动作 env 键进入 env 模板与 bootstrap | AGENTS、docs/mcbot/API、env.example | `config.ts` 解析、`env.example`、`bootstrap-env.sh` | consistent | 自动检查 17 个 key |
| 生产 v1.0.3 已部署、已补发 Tag/Release | 根 README、CHANGELOG、AGENTS、ACCEPTANCE | 生产 `/healthz`、release 记录、完整 smoke | consistent | 生产保持 v1.0.3；已打 Tag |
| v1.0.2 验收记录（smoke 36/0/1/2、实机 Agentic） | docs/mcbot/README、docs/app/ACCEPTANCE | 历史部署记录 | historical | 保留并标注 v1.0.2 |
| 普通聊天 AI 没有任何工具/命令能力（旧绝对声明） | docs/mcbot/README 旧文本 | 与 v1.0.2 自主 MCP 工具冲突 | fixed | 限定为普通聊天，自主会话另述 |

## 2. 本次修正的漂移

1. `docs/app/API.md` 仍写 mcbot “v1.0.2 开发线 / 生产 v1.0.1”；改为 v1.0.3 生产。
2. 根 README 的 mcbot 版本、任务数（7→10）、测试基线、部署/发布状态与当前事实不符；已校准。
3. `docs/mcbot/README.md` 将 `AI_TOOLS_ENABLED` 的提示词上下文段称为“只读受控工具”，且仍有“AI 没有任何工具/命令执行能力”“AI 输出只用于聊天；不会触发任何游戏操作”的绝对声明；已限定普通聊天并说明自主会话边界。
4. AGENTS 的当前版本、测试基线、自主目录说明、安全红线 16 与 v1.0.3 生产事实已同步。
5. v1.0.3 新工具、环境/动作 env、事件触发与只读容器边界已写入 docs/mcbot/README、API 与 AGENTS。

## 3. 自动检查范围

`scripts/check-mcbot-claims.mjs` 检查：

- 10 个 MCP 工具名、11 个任务名、`mcbot_autonomy_*` 权限前缀；
- `AUTONOMY_*` 与 v1.0.5 的 `PRESENCE_MODE`/`PRESENCE_FILE`/`AUTO_SURVIVAL`/`AUTO_EAT_BELOW`/`AUTO_RESTOCK`/`GOALS_*` 环境键同时出现在 `apps/mcbot/deploy/env.example`、`bootstrap-env.sh`、docs/mcbot/API；
- 根/开发线/生产版本声明（1.0.3 生产）；
- 已知陈旧声明（旧生产版本、旧 mcbot 版本、AI 无工具/只聊天绝对声明）；
- 审计矩阵存在“文档声明/代码/状态”列。

## 4. 未决/不纳入

- 真实 Minecraft/OpenCode 的容器读取路径已在生产做基础 Agentic 验收（observe/task_status/finish），inspect_chest 实机路径未单独触发，由离线测试覆盖。
- 安全阈值事件依赖 `ALERTS_ENABLED=true`；关闭时不会产生 `low_health/low_food/...` 重提示，已在 API 文档注明。
- 历史发布页/`docs/legacy` 不重写；`historical` 项只保证当前文档不再把历史声明当作现状。
- 无 schema/DB 迁移；生产 v1.0.3 已部署，回滚使用部署前快照与上一 release。
