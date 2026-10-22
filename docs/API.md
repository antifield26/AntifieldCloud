# AntifieldCloud 对接契约（Lofii Bot）

> 本文只描述 lofii-bot 侧的稳定接口。**本会话不修改 AntifieldCloud 仓库/服务**；Token 注入、面板展示与调用逻辑由用户自行接入。

## 1. 基础信息

| 项目 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:3010`（仅回环，不对外开放） |
| 鉴权 | `Authorization: Bearer <HTTP_TOKEN>`（`/healthz` 除外） |
| Token 位置 | Pi：`/etc/lofii-bot/env` 的 `HTTP_TOKEN`（root:lofiibot 0640） |
| 数据格式 | JSON，UTF-8 |
| 请求体上限 | 8 KiB |
| `/say` 限流 | 10 次/分钟（进程内） |

Token 获取（在 Pi 上以 root）：

```bash
sudo grep '^HTTP_TOKEN=' /etc/lofii-bot/env
```

用户可将该值写入 AntifieldCloud 的受限 env；不要提交到仓库或前端。

## 2. GET /healthz

无需鉴权，最小健康信息。进程存活即 200。

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptimeSec": 123,
  "state": "connected",
  "connected": true
}
```

`state` 取值：`idle` / `connecting` / `connected` / `backoff` / `cooldown`。动态模式下 `idle` 是正常状态（无玩家在线）。

## 3. GET /status

需要 Bearer。字段稳定，可直接映射到面板。

```json
{
  "version": "0.1.0",
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
    "position": { "x": 9.5, "y": 105, "z": -8.5 },
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
    "lastPingAt": "2026-10-22T11:42:37.603Z"
  },
  "presence": {
    "enabled": true,
    "pollMs": 15000,
    "graceMs": 60000,
    "checkMs": 5000,
    "otherPlayers": 0,
    "lastDecision": "connected: alone"
  },
  "ai": {
    "enabled": true,
    "provider": "opencode-go",
    "model": "deepseek-v4.1-flash",
    "inFlight": 0,
    "queued": 0,
    "failures": 0,
    "lastLatencyMs": 2359,
    "lastError": null
  },
  "memory": { "players": 1, "turns": 2 }
}
```

说明：

- `minecraft.connected` 是 Bot 自身是否已 spawn；`server.online` 是服务器在线人数（Bot 在线时包含 Bot）。
- `presence.otherPlayers` 不含 Lofii。
- `ai.lastError` 已截断，不含提示词或密钥。
- 该接口不暴露记忆内容、Token、OpenCode 密码。

错误：`401 {"error":"unauthorized","message":"..."}`。

## 4. POST /say

需要 Bearer + `Content-Type: application/json`。让 Lofii 在游戏公屏说一段话；**只聊天，不执行任何指令**。

请求：

```json
{ "message": "来自 AntifieldCloud 的问候" }
```

成功（Bot 在线）：

```json
{ "ok": true, "lines": 1 }
```

行为与错误码：

| 条件 | HTTP | 响应 |
|---|---|---|
| 正常发送 | 200 | `{"ok":true,"lines":N}` |
| 未带/错误 Token | 401 | `{"error":"unauthorized",...}` |
| 未在线（动态模式下空服） | 409 | `{"error":"not_connected",...}` |
| 首字符为 `/` | 400 | `{"error":"message_must_not_start_with_slash",...}` |
| 空消息/超 720 字符/JSON 错误 | 400 | `{"error":"invalid_request",...}` |
| 非 JSON Content-Type | 415 | `{"error":"unsupported_media_type",...}` |
| 超过 10 次/分钟 | 429 | `{"error":"rate_limited",...}` |
| 请求体 > 8 KiB | 413 | `{"error":"payload_too_large",...}` |
| 其他方法 | 405 | `{"error":"method_not_allowed",...}` |

```bash
TOKEN="$(sudo grep '^HTTP_TOKEN=' /etc/lofii-bot/env | cut -d= -f2-)"
curl -fsS http://127.0.0.1:3010/status -H "Authorization: Bearer $TOKEN"
curl -fsS -X POST http://127.0.0.1:3010/say \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"message":"来自面板的问候"}'
```

## 5. 游戏内行为（供面板展示参考）

- 唤醒词：`Lofii` / `@Lofii`（不区分大小写；只在被点名时回复）。
- 指令（仅 `COMMAND_ALLOWLIST` 内玩家，默认 `Antifield`）：
  - `Lofii 状态` / `status`
  - `Lofii 过来` / `come`
  - `Lofii 跟随我` / `follow [玩家]`
  - `Lofii 停下` / `stop`
  - `Lofii 看我` / `look`
  - `Lofii 挥手` / `wave`
  - `Lofii 帮助` / `help`
- 非授权玩家发指令：固定拒绝，不移动。
- AI 回复公屏发送，自动拆行（每行 ≤240 字符、最多 3 行），首字符 `/` 会被转义。

## 6. 对接建议

- 面板轮询 `/status`（例如 10–30 秒）即可展示在线状态/玩家/位置；不要高频轮询。
- `/say` 仅用于主动播报；不要把它当命令通道。
- `409 not_connected` 是动态模式的正常状态：等玩家上线后 Lofii 会自动加入。
- 如果 AntifieldCloud 需要“控制 Lofii 移动”，当前 MVP 不提供 HTTP 控制接口；需后续扩展（见 `docs/ROADMAP.md`）。
- 任何 AntifieldCloud 侧改动、Token 注入、面板 UI 均由用户自行实施；本仓库不包含这些改动。
