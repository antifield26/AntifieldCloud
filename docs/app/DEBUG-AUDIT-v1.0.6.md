# v1.0.6 寻路重构与验收报告

> 状态：**2026-10-30 已部署 v1.0.6，实机核心矩阵通过**；按用户流程，验收通过后创建 Tag/Release。  
> 范围：`apps/mcbot` 导航层、`navigation` 状态、AI 路点建议、app 面板；生产 app `/opt/antifieldcloud/releases/20261030T132040Z`、mcbot `/opt/mcbot/releases/20261030T143538Z`。

## 1. 本次改动

- 新增 `apps/mcbot/src/minecraft/routing/`：
  - `sampler.ts`：只读方块碰撞形状（含台阶/楼梯/半砖）、净空/危险/边界检查；不提供放置/挖掘。
  - `planner.ts`：确定性 A*，支持 1 格抬高/2 格下落；超时/节点上限明确失败；**含高度变化的相邻路点不再被压缩折叠**。
  - `executor.ts`：路点执行；只有下一路点抬高 1 格时显式起跳；贴台阶先退半步，卡滞先退一次再重试；停滞/取消清理控制。
  - `trace.ts`：最近失败诊断环形缓冲。
- `movement.ts`：统一 `navigateTo` 顺序：pathfinder → A* → 受控执行 → AI 路点 → 安全锚点/传送/停止；`过来/跟随`允许安全区外路径但不传送；任务/目标/自主仍限安全区。
- `ai/path-advisor.ts`：确定性失败后单次 AI 请求；7×7 高度摘要；严格 JSON/最多 3 点；仅 OpenCode 可用且 `PATH_AI_ENABLED` 生效；AI 不控制、不能传送。
- `/status.navigation` 与 app 面板 Fact；兜底同时写 `movement` 事件、聊天提示。
- 新增 `PATH_*` 九键；无 app schema 迁移，mcbot 契约仍 v1。

## 2. 根因与修复（v1.0.5 残余）

1. **执行器把正常慢速移动误判为停滞**：100ms 内位移约 0.1 格，原阈值 0.18/0.25 永远达不到；降到 0.05，并把 pathfinder 看门狗宽限从 1.8s 提高到 3.5s。
2. **pathfinder 的 `physicsTick` 监控覆写手动控制键**：确定性执行期间临时摘掉 `monitorMovement`，`finally` 恢复；失败/取消不会留下挂起状态。
3. **路点压缩把两级台阶折叠成一次两格跳**：只对同高度路点做共线压缩；逐级台阶必须逐点保留。
4. **贴住台阶边缘起跳被服务端纠正**：跳前先退 220ms；停滞时再退一次，给绕行/台阶留出碰撞空间。
5. **取消 `lookAt` 会朝错方向推进/恢复后跳失败**：恢复水平朝向目标后，受控执行可稳定逐级跳上台阶。

## 3. 实机矩阵（2026-10-30）

已部署：mcbot `/opt/mcbot/releases/20261030T143538Z`、app `/opt/antifieldcloud/releases/20261030T132040Z`；部署内 smoke 26/0/1/2。

| 用例 | 结果 |
|---|---|
| 平地直线/回家 | `pathfinder` 通过，无传送 |
| 1 级台阶 | `planner` 通过：`217,64,416 → 218,65,416 → 220,65,416`，到达 `(219.99,65,416.5)`，无传送 |
| 2 级台阶 | `planner` 通过，到达 `(221.35,66,417.5)`，无传送 |
| 3 级台阶 | `planner` 通过，到达 `(222.26,67,418.5)`，无传送 |
| 5 级台阶 | `planner` 通过，到达 `(224.21,69,419.5)`，无传送 |
| 1 格矮墙 | `pathfinder` 通过（侧面绕行），无传送 |
| 2 格墙 + 绕行 | `planner` 通过，到达 `(220.28,64,420.7)`，无传送 |
| 5 格垂直墙 | pathfinder 失败 → A* 6000 节点超时 → AI 建议无效 → **安全传送**；无卡死，符合“仅明确兜底”的失败标准 |
| 安全区外 `过来` | pathfinder 到 `x=243.5`（安全区外），`navigation.source=pathfinder`，**无传送**；只路径移动 |
| AI 无效建议 | 垂直墙测试中 AI 返回无效 → 不执行、不伪造成功 → 兜底 |

未单独执行：主动取消/死亡、`PATH_AI_ENABLED=false` 的实机重跑；由单元/集成覆盖控制清理与关闭路径。测试用垂直墙、侧墙、forceload 已移除；安全区测试平台（台阶/矮墙）保留供复测。

## 4. 门禁

- `npm run check`：app **603**（602 pass、1 skip）+ web **278**（50 文件）+ mcbot **139**；命名检查通过。
- `npm run build`、`check-version`（严格 1.0.6）、`check:docs` 通过。
- 新增回归断言：逐级台阶的每一级路点都必须保留，防止压缩回归。

## 5. 回滚

- mcbot 回退 v1.0.5 release `/opt/mcbot/releases/20261030T120449Z`；app 回退 `/opt/antifieldcloud/releases/20261030T110436Z`。
- 无需 DB 迁移；可先用 `PATH_PLANNER_ENABLED=false` / `PATH_AI_ENABLED=false` 降级。
