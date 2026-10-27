# AntifieldCloud 对接契约（Lofii Bot v0.5.0）

> 本文只描述 `lofii-bot` 侧的稳定接口。**本会话不修改 AntifieldCloud 仓库/服务**；Token 注入、面板展示与调用逻辑由用户自行接入。面板后端建议使用 Fastify 的 `fetch` 消费 SSE，不要把读 Token 放到浏览器 URL。

## 1. 基础信息

| 项目 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:3010`（仅回环，不对外） |
| 读 Token | `HTTP_TOKEN`，用于 `/status`、`/task`、`/events`、`/say` |
| 控制 Token | `HTTP_CONTROL_TOKEN`，仅用于 `/task/*` 与 `POST /move` |
| Token 位置 | Pi：`/etc/lofii-bot/env`（root:lofiibot 0640） |
| 数据格式 | JSON / SSE，UTF-8 |
| 请求体上限 | 8 KiB |
| `/say` 限流 | 10 次/分钟（进程内） |
| 控制接口限流 | 30 次/分钟（`CONTROL_RATE_LIMIT`） |
| 鉴权头 | `Authorization: Bearer <token>`；不支持 URL query token |

读/控制 Token 必须分离。用读 Token 调控制接口返回 401；用控制 Token 调读接口返回 401。控制 Token 为空时，控制接口返回 503 `control_disabled`，读接口不受影响。

```bash
READ="$(sudo grep '^HTTP_TOKEN=' /etc/lofii-bot/env | cut -d= -f2-)"
CTRL="$(sudo grep '^HTTP_CONTROL_TOKEN=' /etc/lofii-bot/env | cut -d= -f2-)"
```

## 2. GET /healthz

无需鉴权。

```json
{
  "status": "ok",
  "version": "0.3.0",
  "uptimeSec": 123,
  "state": "connected",
  "connected": true
}
```

`state`：`idle` / `connecting` / `connected` / `backoff` / `cooldown`。动态模式下 `idle` 是正常状态（无玩家在线）。

## 3. GET /status

需要读 Token。返回完整快照；v0.2 字段保持兼容，`task` 增加 `pendingResume`。

```json
{
  "version": "0.3.0",
  "uptimeSec": 123,
  "state": "connected",
  "minecraft": {
    "connected": true,
    "username": "lofii",
    "host": "127.0.0.1",
    "port": 25565,
    "version": "26.1",
    "reconnects": 0,
    "lastDisconnect": null
  },
  "player": {
    "dimension": "主世界",
    "position": { "x": 204.5, "y": 63, "z": 469.5 },
    "health": 20,
    "food": 20
  },
  "server": {
    "reachable": true,
    "online": 1,
    "max": 6,
    "versionName": "Paper 26.1.2",
    "motd": "Raspberry Pi 5 | Minecraft LAN",
    "latencyMs": 5,
    "lastPingAt": "2026-10-26T13:25:01.000Z"
  },
  "presence": {
    "enabled": true,
    "pollMs": 15000,
    "graceMs": 60000,
    "checkMs": 5000,
    "otherPlayers": 0,
    "lastDecision": "connected"
  },
  "ai": { "enabled": true, "provider": "opencode-go", "model": "deepseek-v4.1-flash", "inFlight": 0, "queued": 0, "failures": 0, "lastLatencyMs": 2359, "lastError": null },
  "memory": { "players": 1, "turns": 2 },
  "task": {
    "enabled": true,
    "active": true,
    "name": "fishing",
    "state": "running",
    "startedAt": "2026-10-26T13:22:43.689Z",
    "elapsedSec": 170,
    "progress": {
      "fishCaught": 5, "wheatHarvested": 0, "planted": 0, "deposited": 0,
      "treesChopped": 0, "logsChopped": 0, "saplingsPlanted": 0, "mobsKilled": 0,
      "oresMined": 0, "coalMined": 0, "ironMined": 0, "copperMined": 0,
      "forestTreesChopped": 0, "naturalLogsChopped": 0, "naturalSaplingsPlanted": 0,
      "sleepVotes": 0, "nightSkipped": 0, "patrolWaypoints": 0, "patrolDistance": 0
    },
    "failures": 0,
    "lastError": null,
    "pendingResume": null,
    "queue": []
  }
}
```

`task.state`：`idle` / `starting` / `running` / `depositing` / `recovering` / `stopping` / `defending` / `pending_resume`。

有待恢复任务时：

```json
"task": {
  "enabled": true,
  "active": false,
  "name": "fishing",
  "state": "pending_resume",
  "startedAt": "2026-10-26T13:22:43.689Z",
  "elapsedSec": 137,
  "progress": {
    "fishCaught": 4, "wheatHarvested": 0, "planted": 0, "deposited": 0,
    "treesChopped": 0, "logsChopped": 0, "saplingsPlanted": 0, "mobsKilled": 0
  },
  "failures": 0,
  "lastError": null,
  "pendingResume": {
    "taskId": "46451943-eae1-41c0-8df3-beef3c7b60f4",
    "name": "fishing",
    "startedAt": "2026-10-26T13:22:43.689Z",
    "elapsedSec": 137,
    "progress": { "fishCaught": 4, "wheatHarvested": 0, "planted": 0, "deposited": 0, "treesChopped": 0, "logsChopped": 0, "saplingsPlanted": 0, "mobsKilled": 0 },
    "expiresAt": "2026-10-26T13:35:00.619Z"
  },
  "queue": [
    { "taskId": "...", "name": "farming", "requestedBy": "panel", "requestedAt": "2026-10-26T13:25:00.000Z" }
  ]
}
```

- `minecraft.connected` 是 Bot 自身是否已 spawn；`server.online` 是服务器在线人数（Bot 在线时包含 Bot）。
- `presence.otherPlayers` 不含 Lofii。
- `ai.lastError` 已截断，不含提示词或密钥。
- 不暴露记忆内容、Token、OpenCode 密码。
- 401：`{"error":"unauthorized","message":"..."}`。

## 4. GET /task

需要读 Token。返回当前任务（与 `/status.task` 一致，含 `pendingResume` 与 `queue`）。

```json
{ "task": { "...": "..." } }
```

## 5. GET /events（SSE）

需要读 Token；仅支持 `GET`。

```http
GET /events HTTP/1.1
Authorization: Bearer <HTTP_TOKEN>
Accept: text/event-stream
Last-Event-ID: <bootId>-<seq>   # 可选
```

响应头：

```text
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

连接后先发 `retry: 5000`，再发 `hello`；每 15 秒发 `: ping` 注释。最多 8 个并发客户端（`SSE_MAX_CLIENTS`），超过返回 503。

### 5.1 事件 envelope

```json
{
  "id": "036e732d-10",
  "type": "task",
  "ts": "2026-10-26T13:24:14.828Z",
  "data": {}
}
```

SSE 帧的 `id` 字段即 envelope `id`；`event` 字段为 `hello` / `task` / `chat` / `presence` / `movement`。

### 5.2 hello

`hello` 的 `data` 直接是快照：

```json
{
  "version": "0.3.0",
  "bootId": "036e732d",
  "lastEventId": "036e732d-10",
  "resync": false,
  "snapshot": { "...StatusSnapshot..." }
}
```

- `Last-Event-ID` 属于当前 `bootId` 且在 ring（500 条）内：回放该 ID 之后的事件。
- `bootId` 不同、ID 过旧、非法：`resync: true`；面板应重新拉 `/status` 与 `/task`。
- SSE 是内存 ring，进程重启后清空；不要把 SSE 当持久消息队列。

### 5.3 task

```json
{
  "action": "started|progress|depositing|recovering|stopping|stopped|completed|failed|resume_required|resumed|interrupted|queued|queue_started|queue_cleared|defending|alert",
  "task": { "...TaskSnapshot..." }
}
```

### 5.4 chat

只发 Lofii 对话：

```json
{ "direction": "in", "username": "Antifield", "message": "Lofii 去钓鱼", "source": "chat" }
{ "direction": "out", "source": "ai|command|task|proactive|movement|http", "text": "好，我去钓鱼啦。", "lines": ["好，我去钓鱼啦。"] }
```

- `in` 仅被点名/唤醒的消息；无关公屏不发。
- `out` 是 Lofii 的回复/任务/主动消息；`source` 用于面板筛选。
- 不包含记忆全文、Token、密码。

### 5.5 presence

```json
{
  "state": "connected",
  "connected": true,
  "otherPlayers": 0,
  "lastDecision": "connected",
  "taskActive": true,
  "taskName": "fishing",
  "taskState": "running"
}
```

状态变化时最多约 2 秒内推送。

### 5.6 movement

```json
{ "action": "home|come|follow|stop", "target": "Antifield", "status": "started|completed|failed", "error": null, "requestId": "..." }
```

`follow` 只发 `started`；`/move stop` 时发 `stop` 的完成事件。

## 6. 控制接口

### 6.1 POST /task/start

需要控制 Token + `Content-Type: application/json`。

```json
{ "name": "fishing|farming|woodcutting|mining|forest|sleep|patrol" }
```

- 空闲：202 `{"ok":true,"queued":false,"position":null,"task":{...}}`，任务立即 active。
- 已有 active：入队，202 `{"ok":true,"queued":true,"position":1..3,"task":{...}}`。
- 队列最多 3 个（`QUEUE_MAX`，不含 active）；同任务允许重复。
- 任务上限默认 60 分钟（`TASK_MAX_MINUTES`）；mining 内部 30 分钟上限。
- 有 pending：409 `resume_pending`（必须先 resume 或 stop/清空）。
- 队列满：409 `queue_full`。
- 任务开关关闭：503 `task_disabled`。
- 不需要 Bot 已在线：任务会先进入 active，由动态存在逻辑自动连接 Lofii。

### 6.2 POST /task/stop

```json
{ "reason": "panel" }
```

- active：202，任务进入 `stopping`，并**清空队列**。
- 只有 pending：202，取消 pending 与队列（审计 `task.discard_pending`）。
- 都没有：409 `no_active_task`。

### 6.2.1 队列语义

- active 正常完成 → 自动启动队首，SSE `task.queue_started`。
- active 失败、防御撤退、恢复超时、`/task/stop` → 清空队列。
- `GET /task.queue` 与 `/status.task.queue` 可见当前队列。
- 队列与 active 一起写入 `task-state.json` v2；服务重启后 pending + queue 保留，resume 后继续。
- v0.3 的 v1 task-state 文件自动迁移，新进度字段补 0。

### 6.3 POST /task/resume

需要控制 Token。body 可为空，或：

```json
{ "taskId": "46451943-eae1-41c0-8df3-beef3c7b60f4" }
```

- pending 未过期：202，恢复原进度与剩余时间。
- 无 pending：409 `no_pending_task`。
- 过期/taskId 不匹配：409 `resume_failed`。
- 10 分钟（`TASK_PENDING_TTL_MS`）未确认：自动 `interrupted`，清空 pending。

### 6.4 POST /move

需要控制 Token + JSON。

```json
{ "action": "home|come|follow|stop", "target": "Antifield" }
```

- `home`：回家；忽略 `target`。
- `come` / `follow`：`target` 可省略，默认 `COMMAND_ALLOWLIST[0]`（Antifield）；必须在线，否则 409 `target_not_online`。
- `stop`：只停移动，不停止任务。
- 任务 active：409 `task_active`（先 `/task/stop`）。
- Bot 未连接：409 `not_connected`。
- 202 只表示已接受；结果通过 SSE `movement` 事件返回。

### 6.4.1 砍树 / 被动防御 / 记忆摘要

- `woodcutting` 只处理固定 oak 树场 `x180–193, z455–464`；实际地面块 y=63、原木从 y=64 起；只砍 `oak_log`、逐棵补种 `oak_sapling`，原木存箱。
- 任务中被动防御：12 格内 zombie/husk/drowned/skeleton/stray/spider/cave_spider 才接战；排除 creeper/enderman/witch/玩家；HP≤12、food≤6 或 >2 只怪时撤退回家并让当前任务失败（清队列）。
- 记忆摘要不新增 HTTP 接口；每 40 turns（20 来回）后台生成 ≤1000 字聊天摘要，注入后续 prompt。

### 6.5 错误码汇总

| 条件 | HTTP | error |
|---|---|---|
| 缺失/错误 Token | 401 | `unauthorized` |
| 控制 Token 未配置 | 503 | `control_disabled` |
| 任务开关关闭 | 503 | `task_disabled` |
| 请求体非 JSON | 415 | `unsupported_media_type` |
| 请求体过大 | 413 | `payload_too_large` |
| 非法 JSON/字段 | 400 | `invalid_request` |
| 有 pending 时启动 | 409 | `resume_pending` |
| 队列满 | 409 | `queue_full` |
| 无任务 | 409 | `no_active_task` / `no_pending_task` |
| 移动目标离线 | 409 | `target_not_online` |
| 任务 active 时移动 | 409 | `task_active` |
| Bot 未连接 | 409 | `not_connected` |
| 限流 | 429 | `rate_limited` |

## 7. POST /say

需要读 Token + JSON。只聊天，不执行命令。

```json
{ "message": "来自 AntifieldCloud 的问候" }
```

成功：`{"ok":true,"lines":1}`。错误：

| 条件 | HTTP | error |
|---|---|---|
| 未连接 | 409 | `not_connected` |
| 首字符 `/` | 400 | `message_must_not_start_with_slash` |
| 空消息/超 720 字符/非法 JSON | 400 | `invalid_request` |
| 非 JSON | 415 | `unsupported_media_type` |
| 超 8 KiB | 413 | `payload_too_large` |
| 超过 10 次/分钟 | 429 | `rate_limited` |

## 8. v0.5 管理、历史与告警

### 8.1 GET /admin/status

需要读 Token。只读 RCON 白名单：`tps`、`list`、`whitelist list`、`time`。

```json
{
  "admin": {
    "enabled": true,
    "rcon": true,
    "updatedAt": "2026-10-27T07:31:08.071Z",
    "lastError": null,
    "tps": { "one": 19.1, "five": 19.4, "fifteen": 19.8 },
    "online": { "count": 2, "max": 6, "players": ["Antifield", "lofii"] },
    "whitelist": { "count": 6, "names": ["lofii", "SFZ", "Jay", "Antifield", "GAY", "shoayu"] },
    "time": { "ticks": 21461, "label": "03:27" },
    "backup": { "status": "unknown" }
  }
}
```

- `/status` 也包含同一 `admin` 对象。
- RCON 失败时 `rcon=false`，`lastError` 截断；不影响任务/HTTP。
- 没有写管理接口、没有任意命令执行；备份目录不存在，`backup.status` 固定 `unknown`。

### 8.2 GET /history

需要读 Token。

```text
GET /history?kind=samples&from=<ISO>&to=<ISO>&limit=100
GET /history?kind=alerts&from=<ISO>&to=<ISO>&limit=100
```

- `kind` 默认 `samples`；`limit` 1–1000（默认 100）；ISO 时间非法 → 400。
- `samples` 每 60 秒一条；保留 30 天；字段：`ts/connected/state/taskName/taskState/health/food/memoryMb/tps/queueLen/rssMb`。
- `alerts` 字段：`id/ts/type/severity/message/details`。
- 响应：`{kind, from, to, count, samples|alerts}`。
- 不含聊天正文/Token/密码。

### 8.3 SSE alert

```json
{
  "type": "alert",
  "data": {
    "type": "low_health|task_failed|disconnected|chest_full|defense_retreat",
    "severity": "warning|error",
    "message": "Lofii 血量偏低：8/20",
    "details": {},
    "ts": "2026-10-27T07:31:17.802Z"
  }
}
```

- 5 分钟同类型冷却；启动后 10 秒内不报低血量。
- 告警写入 SQLite `alerts` 表。

## 9. v0.5 游戏内行为

- 唤醒词：`Lofii` / `@Lofii`（不区分大小写；只回应被点名的消息）。
- 仅 `COMMAND_ALLOWLIST` 内玩家可下命令，默认 `Antifield`。
- 命令：状态、钓鱼、种田、砍树、挖矿、砍天然林、睡觉、巡逻、收工、回家、存东西、过来、跟随、停下、看我、挥手、帮助。
- 安全区扩至 `x111–239, z410–474`；挖矿/天然林只在安全区、保护盒外操作；天然林只 oak/spruce/birch 并补种；挖矿只煤/铁/铜裸露矿、不挖隧道。
- 睡觉用 Vote2Sleep（min 1、40%）；非夜晚/无床/vote 失败正常结束。
- 巡逻四角安全区边界（内缩 4 格），最多 15 分钟，不主动追怪。
- v0.5 仍默认保留游戏内/AI 意图直接触发；`HTTP_ONLY_HIGH_RISK=true` 可关闭高风险触发。
- 任务期间即使 Antifield 下线，Lofii 保持在线；任务结束恢复动态下线。

## 10. 对接建议

- 面板后端用 `fetch` + `Authorization` 消费 `/events`，不要用浏览器 EventSource 直连。
- 初始展示先拉 `/status` 与 `/task`，再用 SSE 增量更新；断线按 `Last-Event-ID` 重连，`resync:true` 时重新拉快照。
- 控制调用只从面板后端发出，控制 Token 放后端 env；不要下发到浏览器。
- `/admin/status`、`/history` 使用读 Token；不可写。
- 告警建议后端按 `type` 去重/展示，并自行决定是否通知；本版没有 webhook。
- 任何 AntifieldCloud 侧改动、Token 注入、面板 UI 均由用户自行实施；本仓库不包含这些改动。
- 本版不提供 `/metrics`、webhook、审计查询接口、跨维度/多 Bot/语音/桥接。
