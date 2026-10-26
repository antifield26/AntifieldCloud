# 验收记录（Lofii Bot v0.2.0）

## 1. 环境

| 项目 | 值 |
|---|---|
| 验收日期 | 2026-10-26（Asia/Shanghai） |
| Pi | Raspberry Pi 5 8GB / Debian 13 trixie |
| Minecraft | Paper 26.1.2，协议 775 |
| Node | v26.12.1 |
| Lofii 版本 | 0.2.0 |
| 部署 release | `/opt/lofii-bot/releases/20261026T121621Z`（soak 在 `20261026T114957Z` 完成，之后仅新增敌对生物保护） |
| 家/重生点 | `(175,64,410)`（`/spawnpoint`） |
| 安全区 | `x175–239, z410–474` |
| 农田 | `x177–183, z432–439`，6×8=48 格，中间 `x180` 水渠 |
| 混放箱 | `(184,64,435)` |
| 钓点 | 站 `(204.5,63,469.5)`，水 `(204.5,62.5,470.5)` |

## 2. 结果汇总

| # | 检查 | 结果 | 证据/备注 |
|---|---|---|---|
| 1 | 本地 `npm run check` | ✅ 52/52 | `tsc --noEmit` + 52 个 `node:test` |
| 2 | 0.2.0 部署/健康 | ✅ | release `20261026T121621Z`；`/healthz` 200，version 0.2.0 |
| 3 | 钓鱼 | ✅ | 实际钓到 9 条鱼并自动存箱；箱子含 cod 6、pufferfish 2、tropical_fish 1；task progress `fishCaught=9, deposited=9` |
| 4 | 种田 | ✅ | 首次播种 48 格；`/setblock` 8 格成熟小麦；收割 8、补种 8；箱子含 wheat 8；任务 summary “收了 8 格小麦，补种 56 格”（累计） |
| 5 | 自动存箱 | ✅ | 鱼/小麦进入 `(184,64,435)`；保留工具/种子/食物；手动 `存东西` 后 task 保持 idle |
| 6 | AI 意图 | ✅ | `Lofii 帮我弄点鱼` → “好，我去钓鱼啦”；随后钓到 1 条并正常收工 |
| 7 | 任务中 0 玩家保持在线 | ✅ | Paper 重启后 `otherPlayers=0`、`presence.lastDecision=connected: task active`；`/list` 仅 lofii；任务继续并钓到鱼 |
| 8 | Paper 重启恢复 | ✅ | 任务 active 时重启 Paper；Lofii 重连（`reconnects=1`）并恢复钓鱼；`lastDisconnect.reason="Server closed"` |
| 9 | 死亡恢复 | ✅ | 备好备用鱼竿/食物后，任务中 `/kill lofii`；自动回任务点并继续钓到 1 条；无备用工具时会在 3 次内停止并提示 |
| 10 | 家/远距离移动 | ✅ | `Lofii 回家` → `(175.5,64,410.5)`；`Lofii 过来` → 传送到测试玩家附近 `(8.5,300,3.5)` |
| 11 | 动态下线 | ✅ | 任务结束后无玩家，约 60–80 秒后 `state=idle`、`/list` 0 人 |
| 12 | 主动行为 | ✅（单测） | 问候/夜晚文案、问候去重通过单测；现场测试期间 Antifield 离线，未触发加入问候 |
| 13 | HTTP `/status.task` | ✅ | `active/name/state/progress/failures/lastError` 正常；v0.1 字段兼容 |
| 14 | 权限边界 | ✅ | 测试用 `SmokeTester` 临时加入 allowlist/whitelist；验收后恢复 `COMMAND_ALLOWLIST=Antifield`、白名单 6 人 |
| 15 | AntifieldCloud | ✅ | 未修改 AntifieldCloud 仓库/`/opt/antifieldcloud`/服务；只更新本仓库 `docs/API.md` |
| 16 | 20 分钟任务 soak | ✅ | 0 玩家钓鱼 20 分 52 秒，49 条鱼，0 失败/0 重连；TPS 20.0；RSS 137.8 MB / peak 139.2 MB；见 §4 |

## 3. 关键证据

### 3.1 钓鱼/存箱

- 任务启动：`Lofii 去钓鱼` → `好，我去钓鱼啦。`
- 钓鱼日志：`fishing: caught {"gained":1,"total":9}`。
- 收工：`收工啦，钓了 9 条鱼，已经存好了。`
- 箱子：cod 6、pufferfish 2、tropical_fish 1；`/status.task.progress = {fishCaught:9, deposited:9}`。
- 第二轮 AI 意图测试：`Lofii 帮我弄点鱼` → 开始钓鱼；收工 `钓了 1 条鱼，已经存好了`。

### 3.2 种田

- 首次任务自动播种 48 格（农田实际 6×8=48；此前计划文案的 56 是笔误）。
- 用 `/setblock 177/178/179 64 432-434 minecraft:wheat[age=7]` 放 8 格成熟小麦。
- 任务日志：`farming: harvested` 8 次，`planted` 累计到 56（48 首播 + 8 补种）；箱子 `wheat 8`。
- 观察到 1 格作物被临时踩空；已修复该格，并新增 `safeSpotNear` 作物避让，避免传送落点踩作物。后续钓鱼 soak 不涉及农田。

### 3.3 恢复

- 任务中 `/kill lofii` 后，Lofii 回到任务点继续；`/status.task` 为 `running`，`failures` 在成功后归零。
- 第一次死亡测试因箱内没有备用鱼竿而停止（符合预期）；补入备用鱼竿/锄/种子/食物后重测成功。
- Paper 重启时任务 active：Lofii 自动重连，状态 `connected: task active`，0 其他玩家仍在线并继续钓鱼。

### 3.4 主动行为（单测）

- Antifield 加入只问候一次（10 分钟冷却）。
- 夜晚只发一次“天黑了，要睡觉吗？”；雷雨事件同理。
- 现场测试期间 Antifield 离线，因此没有可观察的加入问候；逻辑由 `test/unit/proactive.test.ts` 覆盖。

## 4. 20 分钟任务 soak

- 环境：Antifield 离线，0 其他玩家；Lofii 任务 active，服务器未 pause。
- 版本：`20261026T114957Z`（soak 后新增敌对生物保护，最终 release `20261026T121621Z`；正常钓鱼路径未变）。
- 时长：`elapsedSec=1252`（20 分 52 秒）。
- 鱼获：`fishCaught=49`，`failures=0`，`reconnects=0`。
- TPS：`20.0 / 20.0 / 20.0`（1m/5m/15m）。
- 内存：`MemoryCurrent=137.8 MB`，`MemoryPeak=139.2 MB`。
- 收工：`钓了 49 条鱼，已经存好了。`；`deposited=54`（含此前 5 个）。
- 箱子（抽样）：cod 30、pufferfish 7、tropical_fish 1、wheat 8、lily_pad 2、leather_boots 1；工具/种子/食物保留。
- 收工后无玩家：约 60–80 秒后 `state=idle`，`/list` 0 人，服务器可正常 pause。
- 结论：20 分钟自动化 soak 通过。

## 5. 验收结论

**v0.2.0 通过**：钓鱼、种田、自动存箱、任务中保持在线、Paper 重启/死亡恢复、回家/远距离传送、AI 意图、20 分钟 0 玩家 soak 均已现场验证；52 个单元测试通过。最终 release `20261026T121621Z` 额外加入敌对生物近身保护。

已知限制：

- 任务状态只在进程内：Paper 重启可恢复，`systemctl restart lofii-bot` 会丢失。
- 死亡会掉当前背包；箱内必须常备备用鱼竿/锄/种子/食物（本次已备）。
- 农田实际 48 格；`setblock` 催熟仅用于验收。
- 钓鱼掉落物可能落在浅水，拾取会走到岸边；深水/危险区域会放弃。
- `spawn-monsters` 的 `server.properties` 仍显示 true，实际以 gamerule/世界行为为准；任务在夜间/附近有敌对生物时会暂停回家。
- 主动问候/事件的现场触发需 Antifield 在线后观察；单测已覆盖。
