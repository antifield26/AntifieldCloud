# mcbot Agentic 测试验收流程（v1.0.2/v1.0.3）

本文定义 mcbot AI 自主会话的离线与可选实机验收方式。它验证的是“模型通过原生 MCP 工具驱动受控动作”这条链路，而不是让模型自证成功。

## 1. 目标与不变量

验收必须证明：

- 主人显式启动/停止；默认关闭，非主人不能触发。
- 模型只能调用 `start_task` / `stop_task` / `go_home` / `deposit` / `task_status` / `observe` / `inspect_chest` / `eat` / `equip` / `finish`（v1.0.2 为前 6 个；后 4 个为 v1.0.3）。
- 任务名只能是现有 10 种任务；不能出现任意命令、坐标、玩家名或未注册工具。
- v1.0.3 额外验证：`observe` 只读、`inspect_chest` 不取物/不传送/不破块、`eat`/`equip` 仅空闲且仅背包物品、事件驱动重决策有去重/上限、会话结束清理容器/寻路。
- 每次会话随机 `run_id` + Bearer token；跨会话/错误 token 被拒绝。
- 工具预算、时间预算、连续失败上限、断线、pending resume、手动指令抢占均能安全收敛。
- 会话结束时清理 OpenCode session、MCP server、活动任务；不跨重启恢复。

## 2. 三角色

| 角色 | 职责 | 不能做 |
|---|---|---|
| Planner | 从目标/风险生成测试计划与场景清单 | 不直接执行、不修改断言 |
| Executor | 只执行固定测试动作（HTTP/MCP/等待/取证） | 不采信自己的成功判断 |
| Verifier | 独立读取 status/events/audit/任务结果并裁决 | 不执行写操作、不依赖 Agent 自报 |

离线 CI 使用脚本化 Executor；可选实机模式由真实 OpenCode 自主 Agent 充当被验收对象，Verifier 仍是确定性脚本/人工复核。

## 3. 离线 harness（CI）

位置：`apps/mcbot/test/agentic/`。

- `harness.ts`：进程内假 TaskController/OpenCode session/bot，驱动真实 `AutonomyService` 与 MCP 工具处理。
- `agentic.test.ts`：场景化验收，不访问网络/真实 Minecraft/模型。
- 命令：`npm run test:agentic -w @antifieldcomplexx/mcbot`；`npm run check:mcbot` 已包含。
- 覆盖场景：
  1. 目标 → `start_task` → `task_status` → `finish` → 清理；
  2. 非法任务 / 错误 run_id 无副作用；
  3. 手动急停抢占；
  4. 未知工具不能逃逸；
  5. 错误 token 401；
  6. 预算/连续失败（由策略单测与场景组合覆盖）。

## 4. 可选实机 Agent 验收

前置：mcbot v1.0.2 已部署到测试/生产 Pi，`AUTONOMY_ENABLED=true`，主人通过面板或聊天启动；OpenCode 2.2.0 可用且模型支持工具调用。

```powershell
$env:MCBOT_READ_TOKEN = '<read token>'
$env:MCBOT_CONTROL_TOKEN = '<control token>'
node apps/mcbot/scripts/agentic-acceptance.mjs `
  --base-url http://127.0.0.1:3010 `
  --allow-writes `
  --goal "整理基地并准备一些食物" `
  --timeout-sec 120 `
  --report .local/agentic-acceptance.json
```

- 默认 dry-run 只读；`--allow-writes` 才会启动/停止自主会话。
- 脚本只访问显式 loopback 地址；Token 从环境读取，不打印、不写入报告。
- 报告记录步骤、状态、工具调用数、autonomy 事件；失败时保留证据供复核。
- 实机验收还应人工观察：任务确实执行、面板可急停、审计含 `autonomy.*` 且无 prompt/Token、会话结束后无残留 MCP/session。

### v1.0.2 实机结果（2026-10-28）

- 生产已部署；受控开启自主模式与 FORCE_ONLINE，限制 4 次工具/3 分钟。
- 真实模型通过 MCP 调用 `task_status` + `finish`（toolCalls=2），任务保持 idle，OpenCode session/MCP 清理；随后恢复 `AUTONOMY_ENABLED=false`、`FORCE_ONLINE=false`，禁用启动返回 503 `autonomy_disabled`；2026-10-28 按用户要求最终启用 `AUTONOMY_ENABLED=true`，Windows 任务重装到 1.0.2。
- 发现并修复：OpenCode 运行时 MCP 工具列表异步刷新，注册后立即建 session 会导致模型看不到工具；`AUTONOMY_MCP_WARMUP_MS=3000` 等待后再 prompt，提示词使用原始工具名（服务前缀由权限层处理）。

## 5. 手动三角色流程

1. Planner 依据变更范围列出场景和不变量；
2. Executor 在隔离测试环境执行，保留 status/events/audit/游戏内截图/面板截图；
3. Verifier 独立重放断言，检查“无越权动作、无残留、可急停”；
4. 结果写入 `docs/mcbot/ACCEPTANCE.md`，失败项标注证据边界与残余；
5. 清理测试任务、会话、临时 MCP、测试 allowlist/白名单。

## 6. 证据边界

- 离线 harness 证明策略/协议/状态机，不证明模型行为；
- 实机 Agent 验收证明特定模型/OpenCode 版本的行为，但不可完全复现；
- 模型可能选择不调用工具或生成非预期文本；此类结果应 fail-closed 或人工复核，不得计为 PASS；
- 不向生产玩家/外部通知通道发送测试消息；不触发真实 QQ/告警投递。

## 7. OpenCode 原生工具兼容性门禁（v1.0.2 已实测）

2026-10-28 在生产 OpenCode 2.2.0 上用临时 MCP 端点验证：

- 运行时 `PUT /api/experimental/mcp/<name>` 注册成功（204）；
- `initialize` / `tools/list` / `tools/call` 正常；
- `deny-all + <server>_* allow` permissions 下工具可执行；精确前缀为 `<server 名>_<tool 名>`；
- `Authorization` 头随运行时注册传递到 Bearer 保护的 MCP 端点；
- 临时 session 与 MCP server 均可清理。

详见 `docs/app/DEPLOY.md` §3.2 与 `docs/mcbot/ACCEPTANCE.md` v1.0.2 节。
