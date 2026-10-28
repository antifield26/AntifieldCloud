# 验收记录（mcbot v0.2.0 / v0.3.0 / v0.4.0 / v0.5.0 / v0.6.0 本地）

## 1. 环境

| 项目 | 值 |
|---|---|
| 验收日期 | 2026-10-26（Asia/Shanghai） |
| Pi | Raspberry Pi 5 8GB / Debian 13 trixie |
| Minecraft | Paper 26.1.2，协议 775 |
| Node | v26.12.1 |
| Lofii 版本 | 0.2.0 |
| 部署 release | `/opt/mcbot/releases/20261026T121621Z`（soak 在 `20261026T114957Z` 完成，之后仅新增敌对生物保护） |
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
| 15 | AntifieldCloud | ✅ | 未修改 AntifieldCloud 仓库/`/opt/antifieldcloud`/服务；只更新本仓库 `docs/mcbot/API.md` |
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

- 任务状态只在进程内：Paper 重启可恢复，`systemctl restart mcbot` 会丢失。
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
| 部署 release | `/opt/mcbot/releases/20261026T135428Z`（最终 docs）；代码/soak release `20261026T132859Z` |
| 读/控制 Token | 分离；`/etc/mcbot/env` 0640 root:lofiibot |
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
| 9 | 审计 JSONL | ✅ | `/var/lib/mcbot/audit.jsonl` 0600；task/move/auth 元数据；无 Token/聊天正文 |
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

- active 钓鱼任务（4 条鱼）时 `sudo systemctl restart mcbot`。
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

- 最终 release：`/opt/mcbot/releases/20261026T135428Z`（docs 提交；运行时代码与 `20261026T132859Z` 相同）。
- `/healthz` 200，version 0.3.0；验收结束时 0 玩家、`state=idle`、任务 idle。
- 代码与 `docs/` 同仓库提交；v0.3.0 验收通过；v0.2.0 的钓鱼/种田/恢复功能回归由 58 个测试与 soak 覆盖。

## 7. v0.4.0 验收（队列 / 砍树 / 被动防御 / 记忆摘要）

### 7.1 环境

| 项目 | 值 |
|---|---|
| 验收日期 | 2026-10-27（Asia/Shanghai） |
| Lofii 版本 | 0.4.0 |
| Pi | Raspberry Pi 5 8GB / Debian 13；Node v26.12.1 |
| Minecraft | Paper 26.1.2，协议 775 |
| 代码/soak release | `/opt/mcbot/releases/20261027T024631Z`；最终 docs release `/opt/mcbot/releases/20261027T033756Z` |
| 树场 | `x180–193, z455–464`；实际地面块 y=63、原木从 y=64 起 |
| 玩家 | Antifield 在线/离线混合；最终 0 玩家 |

### 7.2 结果汇总

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| 1 | 本地 `npm run check` | ✅ 65/65 | `tsc --noEmit` + 65 个 `node:test` |
| 2 | 0.4.0 部署/健康 | ✅ | `/healthz` 200，version 0.4.0 |
| 3 | 任务队列 | ✅ | active + 3 排队；第 4 个拒绝；正常完成自动下一个；stop/失败清队列 |
| 4 | 队列跨重启 | ✅ | active fishing + 2 queue → restart → pending + queue 2 → resume → active；stop 清空 |
| 5 | 砍树 | ✅ | 累计 **47 原木、14 树苗补种**（跨 4 次任务；首次因树场 Y 配置错误未补种，修正后逐棵补种）；原木存箱 |
| 6 | 被动防御 | ✅ | 现场 **5 次 zombie 击杀、0 死亡**（farming 4 + fishing 1）；未攻击 creeper/enderman/玩家 |
| 7 | 20 分钟 soak | ✅ | fishing `elapsedSec=1241`（20 分 41 秒），43 鱼，deposited=51，0 失败/0 重连 |
| 8 | 动态下线 | ✅ | 任务结束无玩家，约 70 秒后 `state=idle`、`players=0`、`connected=false` |
| 9 | 内存 | ✅ | `MemoryCurrent=150.4 MB`、`MemoryPeak=154.1 MB`；采样 RSS 峰值约 193.6 MB |
| 10 | 记忆摘要 | ✅（单测） | 40 turns 触发、≤1000 字、prompt 注入、AI 失败回退、v1 memory 迁移 |
| 11 | 审计 | ✅ | task/queue/combat/movement 元数据；无 Token/聊天正文 |
| 12 | AntifieldCloud | ✅ | 未修改仓库/`/opt/antifieldcloud`/服务 |
| 13 | 管理/指标 | ✅ | 未引入 RCON 管理、`/metrics`、告警、webhook |

### 7.3 砍树证据

- 实际树场与计划值差一层：地面块 y=63，原木从 y=64 起；首次按 y=64/65 配置扫描时把第二层当树基，导致“没有土壤/不补种”。
- 修正 `TREE_FARM_GROUND_Y=63`、`TREE_FARM_LOG_MIN_Y=64` 后，日志确认逐棵补种。
- 四次任务累计：`logsChopped=24+15+3+5=47`，`saplingsPlanted=0+12+1+1=14`；首次 0 补种是 Y 配置错误，修正后正常。
- 代表日志：`task finished {"name":"woodcutting","progress":{"treesChopped":12,"logsChopped":15,"saplingsPlanted":12...}}`；`task: deposited items {"count":28}`。
- 箱子曾因 creeper 爆炸被摧毁；已用一次性 RCON `setblock` 恢复空箱，后续任务正常存箱。补给/清理是一次性验收操作，未引入 Bot 管理接口。

### 7.4 队列证据

- active fishing + 排队 farming/woodcutting；`/task` 显示 `queue` 2。
- `systemctl restart` 后 `/task`：`state=pending_resume`，`pendingResume` 与 `queue` 2 均保留。
- `POST /task/resume` → 202；active fishing 恢复，queue 仍为 2。
- `POST /task/stop` → 202；active 停止，queue 清空。
- 独立测试：empty woodcutting 完成 → 自动启动排队的 fishing（`task.queue_started` 日志）。
- 单元测试覆盖 queue max 3、pending 409、失败/stop 清队列、v1 task-state 迁移。

### 7.5 防御/战斗证据

- 最终 farming 任务中 4 次 `combat.kill` zombie；fishing soak 中 1 次；合计 5 次，0 死亡。
- 审计样例：

```json
{"event":"combat.kill","source":"combat","actor":"lofii","action":"zombie","result":"completed","details":{"kills":1,"radius":12}}
```

- 防御日志：`defense: engaging {"target":"zombie","threats":1,"health":20,"food":20}` → `defense: threats cleared {"kills":1}`。
- 低血量/多怪时按设计撤退；skeleton 曾把血量打到 12.2，任务撤退并失败（清队列），未死亡。
- 早期（10:31–10:35）Lofii 在未完成任务/装备丢失状态下被 skeleton/creeper 击杀多次；这是测试环境敌对怪与补给问题，不是最终防御路径。之后清理怪物、恢复箱子/装备并修正 farming 检查点后，最终 5 杀/0 死。
- 未使用 `/summon`；只依赖自然怪。5 杀达到原目标。

### 7.6 最终 soak

- 版本：`20261027T024631Z`；任务：fishing；Antifield 在线过、后离线；Lofii 任务保活。
- 时长：`elapsedSec=1241`（20 分 41 秒）。
- 鱼获：`fishCaught=43`；最终 `deposited=51`；`failures=0`；`reconnects=0`。
- 战斗：soak 内 1 次 zombie 击杀；0 死亡。
- 内存：`MemoryCurrent=150.4 MB`、`MemoryPeak=154.1 MB`；RSS 采样峰值 193.6 MB。
- SSE：152 行事件，无错误；任务结束约 70 秒后动态下线，`players=0`。
- TPS 未采集：未引入只读 RCON/TPS 管理通道。

### 7.7 边界与未测项

- **HTTP-only 非强制**：默认保留游戏内 Antifield/AI 直接触发；未开启 `HTTP_ONLY_HIGH_RISK`。
- 生产 Token 轮换未演练（按用户要求不轮换）。
- 记忆摘要只做单测；未在生产制造 20 来回聊天（避免额外 AI 成本）。
- 无 RCON 管理助手、TPS/白名单/备份状态、`/metrics`、告警、webhook、审计查询接口。
- 未修改 AntifieldCloud；面板侧 SSE/控制接入由用户实施。
- 树场/战斗装备/补给依赖基地箱子与一次性验收补给；长期运行需保持备货。
- 盾牌 best-effort；本轮击杀以铁剑+铁甲完成。

### 7.8 最终 release

- 运行时代码/soak release：`20261027T024631Z`；最终 docs release：`20261027T033756Z`。
- v0.4.0 验收通过：队列、砍树、被动防御、20 分钟 soak、动态下线、审计；65 个测试全绿。

## 8. v0.5.0 验收（只读 RCON / 历史告警 / 表层矿 / 天然林 / 睡觉 / 巡逻）

### 8.1 环境

| 项目 | 值 |
|---|---|
| 验收日期 | 2026-10-27（Asia/Shanghai） |
| Lofii 版本 | 0.5.0 |
| Pi | Raspberry Pi 5 8GB / Debian 13；Node v26.12.1 |
| Minecraft | Paper 26.1.2，协议 775 |
| 安全区 | `x111–239, z410–474` |
| 任务上限 | 60 分钟；队列 3；待恢复 10 分钟 |
| 状态 | RCON 只读、SQLite 历史、SSE 告警开启 |

### 8.2 结果汇总

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| 1 | 本地测试 | ✅ 75/75 | `tsc --noEmit` + 75 个 `node:test` |
| 2 | 0.5.0 部署/健康 | ✅ | `/healthz` 200，version 0.5.0 |
| 3 | 只读 RCON | ✅ | `/admin/status` 返回 TPS/在线/白名单/时间；只允许 `tps/list/whitelist list/time` |
| 4 | SQLite 历史 | ✅ | `/history?kind=samples` 47+ 条；60s 采样/30 天；文件 0600 |
| 5 | SSE 告警 | ✅ | 现场 `low_health`、`task_failed`；5 分钟冷却；SQLite alerts 落库 |
| 6 | 表层矿 | ✅ | 单次 23+ 矿（累计 35+）；煤/铜；target 16；deposited 9；0 死亡 |
| 7 | 天然林 | ✅ | 18 棵树、31 原木、18 补种；deposit 21；target 16/8 |
| 8 | 睡觉 | ✅ | `sleepVotes=1`、`nightSkipped=1`；服务器 23:46 → 07:49；Vote2Sleep |
| 9 | 巡逻 | ✅ | 4/4 边界点；约 89 秒；0 死亡；不主动追怪 |
| 10 | 队列跨重启 | ✅ | active mining + queue 2 → pending + queue 2 → resume → stop 清空 |
| 11 | 60 分钟 | ✅ | `/status.task` 配置生效；mining 自身 30 分钟上限 |
| 12 | 20 分钟 soak | ✅ | 见 8.6；mining/forest/fishing 合计约 28.6 分钟 |
| 13 | 动态下线 | ✅（v0.4 回归） | 空服后 `idle`/`connected=false` |
| 14 | 管理/指标边界 | ✅ | 无写 RCON、`/metrics`、webhook；AntifieldCloud 未改动 |

### 8.3 挖矿证据

- 安全区 `x111–239, z410–447`，y≥60；只挖煤/铁/铜裸露矿；保护盒 16；无石头隧道。
- 首次验收 35 矿（煤 25、铜 10）；后续 23 矿（煤 14、铜 9），`deposited=9`；最终 soak 23 矿/5 铜、`deposited` 正常；达到 ≥16 目标。
- 失败路径：点击箱子偶尔 `windowOpen` 超时；已加入安全传送/重试，最终存箱成功。
- 不挖保护盒内方块；不挖水/岩浆邻接矿；玩家 8 格内跳过。

### 8.4 天然林证据

- 安全区扫描 oak/spruce/birch；保护盒 16；叶子/土壤/玩家距离过滤。
- 首轮 18 棵树、31 原木、18 个补种；`deposit=21`；后续一轮 37 棵树、120 原木、8 补种；达到 ≥16 原木/≥4 补种目标。
- 日志：`forest: tree chopped {"species":"oak"...}` / `{"species":"birch","logs":5,...}`。
- 树场固定 oak 保护盒内不处理；未发现保护盒内建筑被砍。后续发现 `equip` 偶发仍持食物导致补种失败，已加 held-item 校验；最终补种代码已修复。

### 8.5 睡觉/巡逻证据

- 床：spawnpoint `175,64,410`（foot）+ `175,64,411`（head）；`BED_SEARCH_RADIUS=16` 以 home 为中心。
- Vote2Sleep：min 1 / 40%；`sleepVotes=1`，`nightSkipped=1`；服务器时间 23:46 → 07:49。
- 非夜晚/无床/投票失败路径正常结束（不失败）。
- 巡逻四角内缩 4：`(115,414)/(235,414)/(235,470)/(115,470)`；4/4 到点，约 89 秒；0 死亡。

### 8.6 最终 soak

- 任务：mining → forest → forest → fishing 混合；RCON 只读/历史/告警/SSE 同时运行。
- 活跃任务时长合计约 **28.6 分钟**：
  - mining 102 秒（08:02:23–08:04:05）
  - forest 549 秒（08:04:05–08:13:14）
  - forest 128 秒（08:13:24–08:15:32，防御撤退）
  - fishing 627 秒（08:23:55–08:34:23）
  - fishing 312 秒（08:34:53–08:40:05）
- 最终 fishing 段 26 鱼、deposited=30、0 失败/0 死亡；总计 0 重连。
- 1 次森林防御撤退（`没有铁剑`）失败，按预期清空队列；之后补装并继续。
- 16:19 左右任务失败后的 idle 补给窗口出现多次 zombie 死亡；不属于最终 active soak 段，记录为补给/清理问题。
- 历史：95 条 samples；16 条 alerts（含 low_health/task_failed/defense_retreat）。
- 内存：`MemoryCurrent=177.6 MB`、`MemoryPeak=200.7 MB`；采样 RSS 峰值约 221 MB。
- 0 次断线重连；管理 RCON/历史/告警持续可用。

### 8.7 边界与未测项

- RCON 只有一个密码；“只读”是 Bot 端白名单，密码泄露仍可执行任意 RCON 命令。
- 备份目录不存在，`backup.status=unknown`；未实现备份触发。
- 世界天然林/裸露矿受地形影响；找不到时正常结束，不用 `/summon`/隧道/RCON 写命令凑数。
- 天然林扫描可能误判玩家建筑，已用保护盒/树种/叶子/土壤/玩家距离降低风险，不能 100% 保证。
- 未做跨维度、多 Bot/语音/Discord/QQ、Prometheus `/metrics`、webhook、AntifieldCloud 改动。
- 记忆摘要仍只做单测；未制造额外 AI 聊天。
- 生产 Token 未轮换。

### 8.8 最终 release

- 最终 release：`/opt/mcbot/releases/20261027T084117Z`。
- 运行时代码/soak release：`20261027T080045Z`（最终 docs release `20261027T084117Z`）。
- v0.5.0 验收通过：只读管理、SQLite 历史、SSE 告警、安全区表层矿/天然林、Vote2Sleep、四角巡逻、60 分钟队列、约 28.6 分钟混合 soak；75 个测试全绿。

## 9. v0.6.0 本地验证（只读 recent events / 契约版本）

### 9.1 环境

| 项目 | 值 |
|---|---|
| 验证日期 | 2026-10-27（Asia/Shanghai） |
| Lofii 版本 | 0.6.0（`package.json`） |
| Node | v26.12.1 |
| 范围 | 本地 `npm run check`（typecheck + 单元测试）；未部署 Pi，未修改 AntifieldCloud |

### 9.2 结果汇总

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| 1 | 本地 `npm run check` | ✅ | 77/77 单元测试通过（`tsc --noEmit` + `node --test test/unit`） |
| 2 | `EventBus.recent` | ✅ | 升序、limit 截断、空 ring、超容量淘汰语义不变（`test/unit/v06.test.ts`） |
| 3 | `/events/recent` 鉴权 | ✅ | 无 Token/控制 Token → 401；读 Token → 200 |
| 4 | `/events/recent` 参数 | ✅ | 默认 50；`limit=1`/`200` 合法；`0`/`201`/非整数/空值 → 400 `invalid_request` |
| 5 | 响应契约 | ✅ | `{contractVersion:1, bootId, lastEventId, events}`；事件按 `id/type/ts/data` 升序且无 `hello` |
| 6 | `/healthz` | ✅ | 新增 `contractVersion:1`；`status/version/uptimeSec/state/connected` 保持兼容 |
| 7 | 方法限制 | ✅ | `POST /events/recent` → 405 + `Allow: GET` |
| 8 | 回归 | ✅ | 既有 75 个测试全部保留通过；SSE/控制/任务/管理/历史行为未改 |

### 9.3 说明与边界

- 本轮只做本地验证与提交：未部署到 Pi，未触发 AntifieldCloud 改动，生产接入由用户按 `docs/mcbot/API.md` 实施。
- `/events/recent` 读内存 ring（`SSE_BUFFER_EVENTS`，默认 500），进程重启后清空；`bootId` 变化时面板应重新拉 `/status` 与 `/task`。
- `limit` 只接受十进制整数（重复参数取第一个值）；非法值统一 400，不影响 SSE `/events`。
- 未新增依赖/schema/DB/环境变量；不改任务/AI/控制行为；无 Token 写入日志或响应。

## 10. v1.0.0 安全修复（聊天切行命令注入）

### 10.1 环境

| 项目 | 值 |
|---|---|
| 验证日期 | 2026-10-27（Asia/Shanghai） |
| Lofii 版本 | 0.6.1（`package.json`） |
| 范围 | `splitOutgoing` 逐行中和 + 本地 `npm run check`；未在真实游戏内发送命令 |

### 10.2 修复与证据

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| 1 | 切分边界 | ✅ | `splitOutgoing('a'.repeat(240)+'/op Lofii', 240, 3)` 第二行输出全角 `／op Lofii`，不以 ASCII `/` 开头 |
| 2 | 多边界回归 | ✅ | padding 239/240/255/480 均无任何行以 `/` 开头（`test/unit/chat.test.ts`） |
| 3 | 整段行为 | ✅ | `sanitizeOutgoing` 原有整段首字中和保留；SSE/控制/任务/近期事件契约不变 |
| 4 | 本地门禁 | ✅ | `npm run check` 78/78 测试通过（新增 1 个边界测试） |

### 10.3 残余边界

- AntifieldCloud 应用侧同时拒绝任意 ASCII `/`、控制字符，并要求控制 Token 才能调用 `/say`；上游逐行中和作为独立第二道防线。
- 未对真实 Minecraft 执行 `/op` 等验证（审计/修复均避免生产命令注入）；以单元级切分函数和 mineflayer `isCommand` 语义为证据。



## 11. v1.0.2 生产部署与验收（2026-10-28，已执行）

### 11.1 范围

AI 自主会话（OpenCode 原生 MCP 工具循环、10 种任务白名单、run_id/Bearer、预算/失败/急停/审计、任务清理）；应用面板自主控制与 10 任务同步；mcbot 服务监控/轮询停止收口/GET 限流；Agentic 离线 scenario harness + 可选实机 conductor。

### 11.2 结果

| 检查 | 结果 |
|---|---|
| `npm run check` | 通过 |
| app server | 591（590 pass、1 skip） |
| app web | 273（49 文件） |
| mcbot | 107（含 5 个 agentic scenarios） |
| 覆盖率 | 服务端 93.10/78.89/88.86；前端 Lines/Branches/Functions 56.27/51.88/49.16 |
| OpenCode 2.2.0 原生 MCP Phase 0 | 运行时注册 204；initialize/tools/list/tools/call 正常；deny-all + `<server>_*` allow；Authorization 头透传；session/MCP 清理成功 |
| 生产 | **已部署 v1.0.2**：app release `/opt/antifieldcloud/releases/20261028T085429Z`、mcbot release `/opt/mcbot/releases/20261028T091246Z`；schema18/OpenCode 2.2.0；自主模式已启用（仅主人显式启动） |
| 实机 Agentic | `task_status` + `finish` 真实调用（toolCalls=2），任务 idle，session/MCP 清理；kill switch 503 |
| 部署 smoke | 部署内 26/0/1/2；完整 Access 36/0/1/2（含 Windows 任务标记 1.0.2；WARN=drill schema17） |

### 11.3 证据边界

- 离线 harness 证明策略/协议/状态机；实机 Agentic 已执行只读 `task_status`+`finish`，未在生产演练实际任务启动；模型行为仍按 fail-closed/人工复核。
- 未向生产玩家/外部通知通道发送测试消息；实机验收临时恢复 FORCE_ONLINE 并已恢复 false；未执行 DB 迁移。
- 验收后按用户要求启用 `AUTONOMY_ENABLED=true`；Windows 备份任务重装到 1.0.2 并重跑完整 smoke 36/0/1/2（无跳过）。
- 原生 MCP 工具发现需要 warmup；首次无等待会话表现为空回复/无工具调用，已由 `AUTONOMY_MCP_WARMUP_MS=3000` 修复并复验。
过程与命令见 [AGENTIC-ACCEPTANCE.md](AGENTIC-ACCEPTANCE.md)。
