# mcbot（游戏内人格名 Lofii）
面向 Raspberry Pi 5（8 GB，Debian 13）的 Minecraft AI 陪伴 Bot，运行在 PaperMC 26.1.2 服务器旁边，通过 mineflayer 以离线账号 `lofii` 登录。

> 当前版本：**v1.0.5**（2026-10-30 开发中/待部署；v1.0.4 生产 release `/opt/mcbot/releases/20261030T005014Z` 与服务 `mcbot.service` 保持不变，验收后切换）。本版修复高低差寻路、增加在线模式持久化、自动生存/补货、`clearing` 安全区清怪与多步目标；自主模式仍仅主人显式启动。

## 能做什么

- **AI 陪伴聊天**：只有被 `Lofii` / `@Lofii` 点名时回复；中文、温柔助手人设；复用 Pi 本机 OpenCode 的 `opencode-go/deepseek-v4.1-flash`。
- **在线模式**：SLP 每 15 秒探测；默认 `auto` 有玩家时上线、最后一名玩家离开 60 秒后下线，让服务器在空服时正常 pause；`always` 常驻、`off` 不主动上线。模式持久化到 `/var/lib/mcbot/presence.json`，任务/自主会话运行中不能切到 `off`。
- **自动化任务**：`Lofii 去钓鱼` / `去种田` / `去砍树` / `去挖矿` / `砍天然林` / `睡觉` / `巡逻` / `守卫` / `护送` / `探索` / `清理安全区` / `收工` / `回家` / `存东西`。
  - 钓鱼/种田/固定 oak 树场保持 v0.4 行为。
  - 挖矿只找安全区内 `y≥60` 的煤/铁/铜裸露矿，不挖石头隧道。
  - 天然林只砍 oak/spruce/birch，保护盒 16 格，逐棵补种。
  - 睡觉用 Vote2Sleep（1.3.0，min 1、40%）投票；无法跳夜正常结束。
  - 巡逻沿安全区边界四角，最多 15 分钟，不主动追怪。
- **任务队列**：单 active + 最多 3 个排队；active 结束自动下一个；失败/收工清空队列；队列跨重启持久化；任务上限 60 分钟。
- **任务中被动防御**：任务中 12 格内出现僵尸/骷髅/蜘蛛才接战；HP≤12、食物≤6 或 >2 只怪时撤退回家；不攻击 creeper/enderman/witch/玩家。
- **管理只读**：`GET /admin/status` 返回 RCON `tps`/`list`/`whitelist list`/`time`；只允许这四条命令，无写权限。
- **历史与告警**：SQLite 每 60 秒采样（在线/任务/血量/TPS/内存/队列），保留 30 天；`GET /history` 查询；SSE `alert` 覆盖低血量/任务失败/断线/箱子满/防御撤退，5 分钟冷却。
- **任务期间保持在线**：Antifield 下线后任务继续；任务结束且无玩家时恢复动态下线。
- **任务恢复**：死亡/Paper 重启后自动回任务点，最多 3 次；工具/种子丢失时停止并提示。
- **跨 systemd 重启恢复**：任务状态写盘；服务重启后变为 `pending_resume`，面板 10 分钟内确认才继续；不自动执行。
- **SSE 事件流**：`GET /events` 推送 `hello/presence/task/chat/movement/alert`；内存 500 条 ring、`Last-Event-ID` 回放、心跳、最多 8 客户端。
- **只读近期事件轮询**：`GET /events/recent`（读 Token）返回 ring 最近 1–200 条事件（升序，无 `hello`）及 `bootId/lastEventId/contractVersion`，供 AntifieldCloud 低频轮询或 SSE 断线补拉；`GET /healthz` 同步返回 `contractVersion`。
- **HTTP 控制**：独立 `HTTP_CONTROL_TOKEN` 控制 `/task/start|stop|resume` 与 `/move`；读 Token 只能看状态/SSE/`/say`。
- **审计 JSONL**：任务/移动/HTTP/AI 触发元数据写 `/var/lib/mcbot/audit.jsonl`（0600、5 MB 轮转、30 天）；不含聊天正文/Token/密码。
- **移动与家**：`回家`、远距离 `过来`、`跟随` 超过 64 格或跨维度时安全传送；只允许代码生成的 `/tp`。
- **主动行为**：Antifield 加入问候；夜晚/雷雨/死亡固定短文；可关闭。
- **AI 意图兜底**：固定短语优先；Antifield 的任务类模糊语句才调用 AI 分类，AI 不能直接执行任意动作。
- **按玩家记忆**：最近 20 轮、保留 30 天；每 20 个来回后台生成 ≤1000 字聊天摘要，落盘到 `/var/lib/mcbot/memory`，重启后仍能记住。
- **本机 HTTP 接口**：只读状态/任务/SSE/近期事件 + `/say`，独立控制 Token 的任务/移动接口；v1.0.2 增加 `/autonomy` 状态/启动/急停与内部 MCP 工具端点；仅监听 `127.0.0.1:3010`。
- **可靠性**：登录超时/断线/服务器重启/满员/连接节流自动退避重连；systemd 崩溃拉起。

## v1.0.5 修复与新特性（待部署）

- **高低差寻路**：`Movements.maxDropDown=2`；`NoPath`/停滞时先水平接近，再尝试安全中间点，最后才在安全区内传送；仍禁止挖掘、放置、跑酷、开门、跨维度。安全区外目标直接拒绝。
- **在线模式持久化**：`GET/POST /presence`（读/控制 Token 分离）；`auto/always/off` 切换写入 `presence.json`；`off` 在任务/队列/待恢复/自主会话运行时返回 409 `presence_busy`；重启保留。
- **自动生存/补货**：空闲且无任务/队列/pending 时每 5 秒检查，自动进食（饥饿 < `AUTO_EAT_BELOW`）与升级护甲；`AUTO_RESTOCK` 周期补食物/铁镐/铁斧。默认开启，可在 env 关闭。
- **安全区清怪 `clearing`**：沿安全区巡逻点移动，只对现有敌对生物白名单接战（僵尸/尸壳/溺尸/骷髅/流浪者/蜘蛛/洞穴蜘蛛）；不攻击玩家、苦力怕、末影人、女巫；不追出安全区、不破块/放置、不跨维度；低血/低食物按 Defender 撤退。
- **多步目标/长期记忆**：本地 `goals.db` 保存 goals/goal_steps；步骤类型 `task`（任务白名单）/`deposit`/`home`，最多 5 步；主人显式 start/resume；失败分类 `path/survival/supplies/interrupted/unknown`；`path` 最多安全重试一次，生存中断恢复且无威胁后最多自动恢复一次；服务重启后目标保持 paused，不自动执行。

## v1.0.3 新增能力（已部署）

- **环境感知**：`observe` 返回有界环境快照（坐标/血量/饥饿/时间/天气、玩家/敌对生物、背包/护甲、任务/阻塞）；可按可配置 allowlist、半径（默认 16）和上限（48）扫描安全区内附近方块/容器，只读已加载区块，不加载新区块。
- **只读容器**：`inspect_chest` 仅对安全区内 allowlist 容器、在无 active/queue/pending 任务时短距寻路打开，返回物品摘要后立即关闭；不取物、不传送、不破块，失败不重试。
- **生存动作**：`eat` / `equip` 仅空闲时对背包内食物/护甲/工具生效，固定冷却与审计；不接受任意物品名或槽位。
- **事件驱动决策**：任务生命周期（queued/queue_started/completed/failed/stopped/interrupted/queue_cleared/resume_required）与安全告警（low_health/low_food/inventory_full/defense_retreat/task_failed/chest_full）触发重决策；同原因 30s 去重、最多 6 次；无周期空转，无任务时结束会话。
- **任务白名单**：`fishing` / `farming` / `woodcutting` / `mining` / `forest` / `sleep` / `patrol` / `guard` / `escort` / `explore`（10 种，仍受 `AUTONOMY_TASKS` 限制）。
- **v1.0.3 生产验收**：完整 Access smoke 36/0/1/2（含 Windows 任务标记 1.0.3；WARN=drill schema17）；实机 Agentic 调用 `observe`+`task_status`+`finish`（toolCalls=3），低血告警触发事件驱动重决策，任务未启动，session/MCP 清理；`FORCE_ONLINE=false` 已恢复。inspect_chest 实机路径未单独触发，由离线测试覆盖。

## v1.0.2 新增能力

- **AI 自主会话（代码默认关闭，生产 v1.0.2/v1.0.3 已启用）**：主人通过游戏聊天 `Lofii 自主行动 [目标]` 或面板显式启动一次；OpenCode 通过运行时注册的原生 MCP 工具循环驱动现有任务/回家/存箱，不能执行任意命令。
- **原生 MCP 工具**：v1.0.2 提供 `start_task` / `stop_task` / `go_home` / `deposit` / `task_status` / `finish`；v1.0.3 增加 `observe` / `inspect_chest` / `eat` / `equip`（共 10 个）；OpenCode session 使用 deny-all + `mcbot_autonomy_*` 权限；每次会话随机 run_id + Bearer token。
- **预算/安全**：`AUTONOMY_MAX_MINUTES`、`AUTONOMY_MAX_TOOL_CALLS`、`AUTONOMY_MAX_FAILURES`、任务白名单、手动指令抢占、聊天/面板急停；会话结束停止任务并清理 OpenCode session/MCP。
- **应用面板**：自主状态、目标、时间、工具调用数、最近决策/原因/错误，启动/急停二次确认；任务下拉同步 10 种任务（含 guard/escort/explore）。
- **Agentic 验收**：`test/agentic` 离线 scenario harness（CI），`scripts/agentic-acceptance.mjs` 可选实机 conductor；流程见 [AGENTIC-ACCEPTANCE.md](AGENTIC-ACCEPTANCE.md)。
- **运维残余**：mcbot 纳入应用 `service_down` 监控；应用轮询停止时中止/等待在途请求，停止后不写告警游标；`/api/mcbot/status|history` GET 限流。
### v1.0.2 生产验收

- app/mcbot v1.0.2 已部署；完整 Access smoke 36/0/1/2（含 Windows 任务标记 1.0.2；WARN=drill schema17）。
- 实机 Agentic：真实模型通过 MCP 调用 `task_status` + `finish`（toolCalls=2），任务保持 idle，session/MCP 清理；验收后曾恢复关闭，2026-10-28 按用户要求启用 `AUTONOMY_ENABLED=true`。
- 原生 MCP 的运行时工具发现存在异步窗口，`AUTONOMY_MCP_WARMUP_MS=3000` 用于等待工具列表刷新；提示词使用原始工具名。

## v1.0.0 新增能力

- **运行稳定性**：systemd `Type=notify` 看门狗（`WATCHDOG_ENABLED`/`WATCHDOG_HEARTBEAT_MS`）、RSS 内存治理告警（`RSS_LIMIT_MB`）、断线重连恢复不消耗任务重试次数。
- **任务**：基地守卫 `guard`、玩家护送 `escort`、航点探索 `explore`；深层裸露矿（`MINE_DEEP_ENABLED`，安全区内 y<60、有空气面、无液体邻接）；分类存箱（`CHEST_ORES/FOOD/SAPLINGS/MISC`，缺失回退主箱）。
- **库存/补货**：背包剩余格/食物告警；v1.0.5 起 `AUTO_RESTOCK=true` 默认开启，空闲自动从分类箱补食物与铁镐/铁斧；`AUTO_SURVIVAL` 默认开启空闲进食/换装。
- **AI**：`AI_TOOLS_ENABLED` 控制的是**提示词只读上下文段** `status/inventory/task_status`（默认关闭；未知名称启动失败），不是 OpenCode 可执行工具；普通聊天不触发游戏操作，只有主人显式启动的自主会话可通过受控工具执行动作。
- **运维**：`migrate-v1.0.0.ps1` 覆盖 mcbot 服务/路径/env 迁移；故障注入/soak 单测覆盖 SLP 抖动、连续断线、EventBus ring。
## 不做什么

- 不修改 AntifieldCloud 仓库、数据库或服务；本仓库只提供接口契约。
- 不做 PvP、建筑、踢人/封禁/备份触发；挖矿/天然林/睡觉/巡逻只做固定安全区内的被动/资源行为。
- 不做无边界 PvP 主动攻击；`clearing` 只在安全区内按既有敌对生物白名单清怪，不攻击玩家/苦力怕/末影人/女巫，不追出安全区。
- 不做跨维度、多 Bot/多人设、语音、Discord/QQ、Prometheus `/metrics`、webhook。
- 默认 `auto`：空服时服务器会 pause；需要常驻时切换 `always`（面板/`POST /presence`）或显式设置 `FORCE_ONLINE=true`；`off` 不主动上线。
- 不把 HTTP 接口暴露到内网/公网；不改 nftables、FRP、Cloudflare。

## 架构

```text
             SLP 探测 15s
   ┌────────┐ ─────────────► ┌────────────┐
   │  IDLE  │                │ CONNECTING │
   └────────┘ ◄───────────── └────────────┘
       ▲        登录失败/断线        │ spawn
       │        ┌──────────┐        ▼
       └────────│ BACKOFF  │   ┌───────────┐
                └──────────┘   │ CONNECTED │
                               └───────────┘
                                     │ 60s 无其他玩家
                                     ▼
                               ┌───────────┐
                               │ COOLDOWN  │
                               └───────────┘
```

```text
玩家聊天 ─► chat router ─┬─ 固定指令（状态/移动/任务）─► command executor ─► reply queue
                         ├─ 任务类模糊语句（仅 Antifield）─► AI 意图分类 ─► 固定任务
                         ├─ 未授权指令 ─► 固定拒绝
                         └─ 聊天 ─► AI queue ─► OpenCode ─► 清洗/拆行 ─► reply queue

任务管理器 ─► 队列（≤3, 60min）─► 导航/安全区/传送 ─► 钓鱼/种田/树场/挖矿/天然林/睡觉/巡逻
      │                              └─ 被动防御（12 格内 zombie/skeleton/spider）
      ├─ 任务 active/queue 时 presence 保持在线
      └─ 死亡/Paper 重启 ─► 回家/回任务点 ─► 最多 3 次恢复

RCON 25575 ──只读命令白名单──► AdminService ──► /admin/status
                                  └──► HistoryService ──► SQLite history.db
                                  └──► AlertManager ──► SSE alert

记忆 ─► 每 40 turns（20 来回）后台摘要 ─► memory v2 ─► prompt 注入
```
HTTP /status ─► state 快照（含 task）
HTTP /task ─► 当前任务 / pending
GET /events ─► SSE（hello/presence/task/chat/movement，ring 500）
GET /events/recent ─► 读 Token ─► ring 最近 1–200 条事件（升序，无 hello）
HTTP /admin/status ─► 读 Token ─► RCON TPS/在线/白名单/时间
HTTP /history ─► 读 Token ─► SQLite samples/alerts
HTTP /task/* + /move ─► 控制 Token ─► 任务/移动 ─► 审计 JSONL
HTTP /say ─► reply queue（只聊天，不执行指令）
systemd restart ─► task-state.json ─► pending_resume ─► 面板确认
```

### 关键安全约束

- 所有外发聊天统一经过 `sanitizeOutgoing`：**首字符 `/` 会被替换为全角 `／`**，防止 AI 或 HTTP 输入变成 OP 命令。
- 普通聊天 AI 不执行游戏动作；只有主人显式启动的 v1.0.2/v1.0.3 自主会话可通过 MCP 工具执行受控任务/移动/存箱/观察/只读容器/进食/装备；指令仍只由确定性解析器执行，且仅 `Antifield`（`COMMAND_ALLOWLIST`）有效。
- 内部 `/tp` 只由移动/任务代码用固定坐标或在线玩家名生成，AI/HTTP 无法触发；传送目标必须在安全区内。
- 自动化只修改农田 `x177–183, z432–439`、固定 oak 树场 `x180–193, z455–464`、安全区 `x111–239, z410–474` 内的天然林/裸露矿；保护盒 16 格；越界即停止。
- 挖矿只挖煤/铁/铜裸露矿，不挖石头隧道；天然林只砍 oak/spruce/birch，逐棵补种；睡觉只右键已有床，不放置新床。
- 被动防御只攻击任务点 12 格内、安全区内的 zombie/husk/drowned/skeleton/stray/spider/cave_spider；排除 creeper/enderman/witch/玩家；HP/food 低或怪太多撤退。
- `/say` 拒绝以 `/` 开头的消息；HTTP 仅回环、Bearer Token、8 KiB 请求体上限、10 次/分钟限流。
- 读 Token（`HTTP_TOKEN`）与控制 Token（`HTTP_CONTROL_TOKEN`）分离；控制 Token 只用于任务/移动，不写日志/URL。
- 任务状态 `/var/lib/mcbot/task-state.json`、审计 `/var/lib/mcbot/audit.jsonl`、历史 `/var/lib/mcbot/history.db` 均 `0600`；不含聊天正文/Token/密码。
- RCON 只有一个密码；“只读”是 Bot 端白名单（`tps`/`list`/`whitelist list`/`time`），密码泄露仍可执行任意 RCON 命令。密码只在 env/内存，不写日志/URL。
- 管理/历史接口只用读 Token；没有写管理接口、任意命令执行、`/metrics`、webhook。
- **HTTP-only 不是强制边界**：v0.3 默认保留游戏内 `Antifield` 与 AI 意图直接触发，同名冒用风险仍在；要严格 HTTP-only 设 `HTTP_ONLY_HIGH_RISK=true`（会关闭游戏内/AI 高风险触发）。
- 服务以 `lofiibot` 非 root 用户运行；env `0640 root:lofiibot`；记忆文件 `0600`。

## 快速开始

### 首次部署（在 Windows 工作区）

```powershell
# 需要：Node 26、npm、ssh/scp/tar、到 Pi 的密钥登录
npm install
npm run check

# 首次：创建用户/目录/systemd、写 env、加白名单/OP、max-players=6 并重启服务器
.\scripts\deploy.ps1 -Provision -ServerConfig -AllowDirty
```

### 后续部署

```powershell
.\scripts\deploy.ps1
```

`deploy.ps1` 会打包 → scp → 远端 release → `npm ci` → 切换 `current` → 重启 → `/healthz` 版本校验；失败自动回滚上一 release。

### 服务器上的日常操作

```bash
sudo systemctl status mcbot
sudo journalctl -u mcbot -f
curl -fsS http://127.0.0.1:3010/healthz
sudo grep '^HTTP_TOKEN=' /etc/mcbot/env          # 读 Token（root）
sudo grep '^HTTP_CONTROL_TOKEN=' /etc/mcbot/env  # 控制 Token（root）
sudo tail -n 5 /var/lib/mcbot/audit.jsonl         # 审计（元数据）
```

### 启停/回滚

```bash
sudo systemctl restart mcbot
sudo systemctl stop mcbot
# 回滚：把 current 指向上一个 release 后重启
sudo ln -sfn /opt/mcbot/releases/<UTC> /opt/mcbot/current
sudo systemctl restart mcbot
```

## 配置

完整变量见 `deploy/env.example`。生产 env 在 `/etc/mcbot/env`（root:lofiibot 0640），由 `deploy/bootstrap-env.sh` 生成；密钥不提交仓库。

常用：

| 变量 | 默认 | 说明 |
|---|---|---|
| `COMMAND_ALLOWLIST` | `Antifield` | 可执行指令/任务的玩家名，逗号分隔 |
| `PRESENCE_ENABLED` | `true` | 动态上下线开关（旧兼容） |
| `FORCE_ONLINE` | `false` | 旧兼容强制常驻；`presence.json` 优先 |
| `PRESENCE_MODE` | `auto` | `auto`/`always`/`off` 默认模式；文件优先 |
| `PRESENCE_FILE` | `/var/lib/mcbot/presence.json` | 在线模式持久化文件（原子写、0640） |
| `AUTO_SURVIVAL` | `true` | 空闲自动进食/换装 |
| `AUTO_SURVIVAL_INTERVAL_MS` | `5000` | 自动生存检查间隔 |
| `AUTO_EAT_BELOW` | `16` | 自动进食饥饿阈值 |
| `AUTO_RESTOCK` | `true` | 空闲自动补食物/铁镐/铁斧 |
| `AUTO_RESTOCK_INTERVAL_MS` | `300000` | 自动补货间隔 |
| `GOALS_FILE` | `/var/lib/mcbot/goals.db` | 多步目标 SQLite |
| `GOALS_MAX_STEPS` | `5` | 单目标最大步骤数 |
| `TASK_ENABLED` | `true` | 自动化任务总开关 |
| `TASK_MAX_MINUTES` | `60` | 单任务时长上限 |
| `TASK_RECOVERY_MAX` | `3` | 死亡/重启连续恢复上限 |
| `TELEPORT_DISTANCE` | `64` | 超过该距离使用安全传送 |
| `PROACTIVE_ENABLED` | `true` | 主动问候/事件总开关 |
| `AI_INTENT_ENABLED` | `true` | AI 意图兜底 |
| `AI_ENABLED` | `true` | AI 总开关 |
| `AI_MODEL_PROVIDER` / `AI_MODEL_ID` | `opencode-go` / `deepseek-v4.1-flash` | OpenCode 模型 |
| `AI_COOLDOWN_MS` | `10000` | 每玩家 AI 冷却 |
| `AI_RATE_PER_HOUR` | `60` | 每玩家每小时 AI 上限 |
| `MEMORY_MAX_TURNS` | `20` | 每玩家记忆轮数 |
| `HTTP_PORT` | `3010` | 仅回环 HTTP 端口 |
| `HTTP_CONTROL_TOKEN` | 必填（64 hex） | 控制 Token；为空时控制接口 503 |
| `HTTP_CONTROL_ENABLED` | `true` | 控制接口开关 |
| `HTTP_ONLY_HIGH_RISK` | `false` | true 时关闭游戏内/AI 高风险触发 |
| `SSE_MAX_CLIENTS` / `SSE_BUFFER_EVENTS` | `8` / `500` | SSE 客户端上限/回放 ring |
| `TASK_PENDING_TTL_MS` | `600000` | 重启任务确认窗口（10 分钟） |
| `QUEUE_MAX` | `3` | active 之外排队上限 |
| `SAFE_MIN_X/MAX_X/MIN_Z/MAX_Z` | `111/239/410/474` | 主世界安全区 |
| `RCON_ENABLED` / `RCON_PASSWORD` | `false` / 空 | 只读管理；生产显式开启 |
| `HISTORY_ENABLED` / `HISTORY_DB` | `true` / `.../history.db` | SQLite 历史 |
| `ALERTS_ENABLED` / `ALERT_COOLDOWN_MS` | `true` / `300000` | SSE 告警/冷却 |
| `MINE_*` | 见 env | 表层矿 y 范围/数量/保护盒/矿种 |
| `FOREST_*` | 见 env | 天然林树种/保护盒/上限 |
| `BED_SEARCH_RADIUS` / `SLEEP_VOTE_WAIT_MS` | `16` / `45000` | 床搜索/Vote2Sleep 等待 |
| `PATROL_MAX_MINUTES` | `15` | 巡逻上限 |
| `TREE_FARM_*` | 见 env | oak 树场范围/地面/原木 Y |
| `TREE_MAX_LOGS` | `128` | 单次砍树上限 |
| `DEFENSE_ENABLED` / `DEFENSE_RADIUS` | `true` / `12` | 被动防御开关/半径 |
| `DEFENSE_HEALTH_THRESHOLD` / `DEFENSE_FOOD_THRESHOLD` | `12` / `6` | 撤退阈值 |
| `MEMORY_SUMMARY_TURNS` / `MEMORY_SUMMARY_MAX_CHARS` | `40` / `1000` | 摘要窗口/长度 |
| `AUDIT_FILE` / `AUDIT_MAX_BYTES` | `.../audit.jsonl` / `5242880` | 审计路径/轮转大小 |

任务坐标默认值见 `deploy/env.example`（家 `175.5/64/410.5`、安全区 `111–239/410–474`、农田 `177–183/432–439`、箱子 `184/64/435`、钓点 `204.5/63/469.5`、oak 树场 `180–193/455–464`，实际地面块 y=63、原木从 y=64 起）。

## 测试

```bash
npm run check     # tsc --noEmit + node:test 单元测试
npm run smoke     # 连接真实服务器，验证 状态/挥手/AI（需先部署并让 SmokeTester 可登录）
```

`npm run smoke` 从 Windows 连接 `MC_HOST`，以 `SmokeTester` 身份发消息；生产验收请先临时把 `SmokeTester` 加入白名单，验收后移除。

## 文档

- [API.md](API.md) — AntifieldCloud 对接契约
- [DEPLOY.md](DEPLOY.md) — 部署、服务器变更、回滚、排障
- [ACCEPTANCE.md](ACCEPTANCE.md) — 验收记录
- [ROADMAP.md](ROADMAP.md) — 后续路线
- [deploy/env.example](deploy/env.example) — 环境变量模板

## 已知限制

- 离线服务器按玩家名鉴权，理论上可被同白名单/内网他人冒充 `Antifield`；请保持白名单与 FRP 地址可信，后续可改为 HTTP-only 管理指令。
- 动态在线意味着空服时服务器会 pause；如要 7×24 保活，设 `FORCE_ONLINE=true`（注意功耗/发热）。
- `come` / `follow` 依赖 mineflayer-pathfinder 与当前 26.1 方块数据；跨维度/目标实体未加载时会走安全传送，找不到落点则明确失败。
- 任务死亡恢复依赖箱子里的备用工具/种子/食物；死亡会掉落当前背包，建议箱内常备 2–3 套鱼竿/锄头与至少 128 个种子。
- 任务队列在 active 之外最多 3 个；同任务可重复排队；`收工`/失败/恢复超时会清空队列。
- 砍树只处理固定 oak 树场；树苗/铁斧需常备。树场实际地面块 y=63、原木 y=64；配置见 `TREE_FARM_*`。
- 被动防御是任务内行为，不是独立 combat 任务；低血量/多怪时撤退并让当前任务失败（按失败语义清队列）。
- 战斗装备需在背包/箱子备好；盾牌为 best-effort，协议不支持时仍用剑+甲。
- 自然怪不足以稳定验收 5 杀；v0.4 现场只要求 ≥1 杀、0 死亡，5 杀由单测/机会性覆盖。
- 挖矿只处理已加载区块的裸露矿；找不到时正常结束，不挖隧道/不探索。安全区天然林扫描可能包含玩家建筑，使用 16 格保护盒 + 树种/叶子/土壤启发式，不能 100% 保证不误判。
- 睡觉依赖已有床和 Vote2Sleep；非夜晚/无床/vote 失败正常结束，不算任务失败。`BED_SEARCH_RADIUS` 内没有床时不会放置新床。
- RCON 管理数据不含备份状态（当前无备份目录），`backup.status=unknown`。历史/告警不记录聊天正文。
- 记忆摘要额外调用一次 AI；失败保留旧摘要并退避，不阻塞聊天。
- 任务状态跨 `systemctl restart mcbot` 保存为 `pending_resume`；10 分钟内不确认会标记 `interrupted` 并清空。Paper 重启仍走原有自动恢复。
- HTTP 控制依赖独立 `HTTP_CONTROL_TOKEN`；`/task/start` 可以在 Lofii 离线时启动，后台按动态在线逻辑连接。`/move` 需要 Bot 已在线。
- SSE 回放只在内存（500 条）；进程重启后客户端应重新拉 `/status`/`/task`。浏览器 EventSource 不能带 Bearer，面板应由后端消费。
- `/events/recent` 同样只读内存 ring（`SSE_BUFFER_EVENTS`，默认 500），进程重启后清空；`bootId` 变化时应重新拉 `/status`/`/task`，不能当作持久消息队列。
- 审计只记录动作元数据，不记录聊天正文；没有审计查询 HTTP 接口，需 SSH 查看。
- 本仓库未修改 AntifieldCloud；面板侧 SSE/近期事件/控制接入由用户实施。
- 农田实际为 48 格（6 列 × 8 行，中间水渠）；首次任务会自动播种，验收用 `/setblock` 催熟。
- 钓鱼掉落物可能落在浅水；拾取会走向岸边/浅水，深水或危险区域会放弃。
- 普通聊天 AI 输出只用于对话；自主会话的工具动作仅在主人显式启动、预算/急停/权限约束内执行。

## License

本项目采用 [MIT License](LICENSE)，Copyright (c) 2026 Antifield。
