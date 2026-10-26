# 验收记录（Lofii Bot v0.2.0 / v0.3.0）

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

## 6. v0.3.0 验收（SSE / HTTP 控制 / 审计 / 任务跨重启）

### 6.1 环境

| 项目 | 值 |
|---|---|
| 验收日期 | 2026-10-26（Asia/Shanghai） |
| Lofii 版本 | 0.3.0 |
| 部署 release | `/opt/lofii-bot/releases/20261026T135428Z`（最终 docs）；代码/soak release `20261026T132859Z` |
| 读/控制 Token | 分离；`/etc/lofii-bot/env` 0640 root:lofiibot |
| 控制 Token | 独立 64 hex；验收期间不轮换生产 Token |
| 旧版本对照 | v0.2.0 release `20261026T121621Z` |

### 6.2 结果汇总

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| 1 | 本地 `npm run check` | ✅ 58/58 | `tsc --noEmit` + 58 个 `node:test` |
| 2 | 0.3.0 部署/健康 | ✅ | `/healthz` 200，`version=0.3.0`，`controlEnabled=true` |
| 3 | 读/控制 Token 分离 | ✅ | 读 Token 调 `/task/start` → 401；控制 Token 调 `/task` → 401 |
| 4 | HTTP 启动任务（离线） | ✅ | 0 玩家、Bot 离线时 `POST /task/start` → 202 `starting`；Lofii 自动上线并任务 `running` |
| 5 | SSE | ✅ | `hello`、`task` 进度、`chat.out`、`movement`；`Last-Event-ID` 回放 2 条事件；30 分钟客户端保持 |
| 6 | HTTP 移动 | ✅ | 任务 active 时 `/move` → 409 `task_active`；停止后 `/move home` → 202，位置 `(175.5,64,410.5)`；`/move stop` → 202 |
| 7 | 任务跨 systemd 重启 | ✅ | active 任务重启后 `pending_resume`、`pendingResume.taskId/progress/expiresAt`；`POST /task/resume` → 202 并继续 |
| 8 | 10 分钟确认窗口 | ✅（单测） | `TASK_PENDING_TTL_MS` 过期路径由 `test/unit/v03.test.ts` 覆盖；生产不等待 10 分钟 |
| 9 | 审计 JSONL | ✅ | `/var/lib/lofii-bot/audit.jsonl` 0600；task/move/auth 元数据；无 Token/聊天正文 |
| 10 | 动态在线 | ✅ | 任务结束后约 60–80 秒 `state=idle`、`players=0`、`connected=false` |
| 11 | 21 分 46 秒 soak | ✅ | `fishCaught=57`、`deposited=60`、`failures=0`、`reconnects=0`；见 §6.4 |
| 12 | 内存 | ✅ | `MemoryCurrent=145.0 MB`、`MemoryPeak=147.0 MB`；低于 384/512MB |
| 13 | AntifieldCloud | ✅ | 未修改仓库/`/opt/antifieldcloud`/服务；仅本仓库契约与代码 |

### 6.3 关键证据

- 控制启动（离线）：`POST /task/start {"name":"fishing"}` → `202`，返回 `active=true,state=starting`；随后 Lofii 自动连接。
- SSE：连接返回 `200 text/event-stream`；`hello` 含 `bootId=3ee7f391` 与完整快照；任务进度事件 `type=task, action=progress`；`/say` 产生 `chat.out`；`Last-Event-ID=036e732d-8` 重连回放 `...-9`、`...-10` 两条任务事件。
- 控制分离：读 Token 请求 `/task/start` → 401；控制 Token 请求 `/task` → 401；控制 Token 请求 `/task/start` → 202。
- 任务 active 时 `/move home` → 409 `{"error":"task_active"}`。
- 任务停止后 `/move home` → 202；审计 `movement.start/completed`；位置回到 `(175.5,64,410.5)`；`/move stop` → 202。
- 审计样例（无敏感内容）：

```json
{"ts":"2026-10-26T13:52:20.299Z","event":"movement.start","source":"http_control","actor":"panel","action":"home","result":"accepted","requestId":"344c...","details":{"target":null}}
{"ts":"2026-10-26T13:52:20.399Z","event":"movement.finish","source":"http_control","actor":"panel","action":"home","result":"completed","requestId":"344c...","details":{"target":null}}
```

- 文件权限：`audit.jsonl` 0600 lofiibot:lofiibot；任务停止/完成后 `task-state.json` 被删除。

### 6.4 21 分 46 秒 soak

- 版本：`20261026T132859Z`；Antifield 离线，0 其他玩家；任务由 HTTP 控制启动。
- 时长：`elapsedSec=1306`（21 分 46 秒）；按控制请求停止。
- 鱼获：`fishCaught=57`；最终 `deposited=60`（含此前背包鱼）；`failures=0`；`reconnects=0`。
- 内存：`MemoryCurrent=145.0 MB`，`MemoryPeak=147.0 MB`；采样 RSS 峰值约 182.9 MB（进程 RSS，含 mineflayer 缓冲）。
- SSE 客户端全程保持；日志 157 行；`Last-Event-ID` 回放验证通过；任务/chat/movement 事件正常。
- 收工：`task stop requested` → 最终存箱 `count=60` → `task finished result=stopped`；`task-state.json` 删除。
- TPS 未采集：本次没有可用的只读 RCON/TPS 通道（用户选择不引入 RCON 管理接口）；不以 TPS 作为本轮结论依据。
- 结论：21 分 46 秒 0 玩家钓鱼 soak 通过，无异构失败/重连。

### 6.5 跨重启 pending/resume

- active 钓鱼任务（4 条鱼）时 `sudo systemctl restart lofii-bot`。
- 重启后 `/task`：`state=pending_resume`，`active=false`，`pendingResume={taskId, name, progress.fishCaught=4, expiresAt}`；Lofii 按动态策略离线。
- `POST /task/resume` → 202；任务从原进度继续，Lofii 自动连接；随后钓到第 5 条鱼。
- 审计：`task.shutdown_pending`、`task.resume`；`task-state.json` 0600。
- 10 分钟过期路径由单测覆盖（生产不等待）。

### 6.6 边界与未测项

- **HTTP-only 非强制**：默认保留游戏内 Antifield 与 AI 意图直接触发；同名冒用风险仍在。严格模式 `HTTP_ONLY_HIGH_RISK=true` 未在本轮生产开启。
- 生产 Token 轮换未演练（按用户要求不轮换）。
- 没有新增 AntifieldCloud 代码/服务改动；面板后端 SSE 消费由用户实现。
- 没有管理助手/RCON/`/metrics`/告警 webhook/审计查询接口。
- 钓鱼杆低耐久时现会自动从箱子换新杆；本轮 soak 未出现杆耗尽失败。

### 6.7 最终 release

- 最终 release：`/opt/lofii-bot/releases/20261026T135428Z`（docs 提交；运行时代码与 `20261026T132859Z` 相同）。
- `/healthz` 200，version 0.3.0；验收结束时 0 玩家、`state=idle`、任务 idle。
- 代码与 `docs/` 同仓库提交；v0.3.0 验收通过；v0.2.0 的钓鱼/种田/恢复功能回归由 58 个测试与 soak 覆盖。

