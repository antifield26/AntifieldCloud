# 部署与运维（mcbot）

> 目标 Pi：`antifield@169.254.77.10`（Raspberry Pi 5，Debian 13，Node `/usr/local/bin/node` v26.12.1）。v1.0.6 已部署 release `/opt/mcbot/releases/20261030T143538Z`，核心实机矩阵通过；回滚目标为 v1.0.5 release `/opt/mcbot/releases/20261030T120449Z`，并可关闭 `PATH_PLANNER_ENABLED`/`PATH_AI_ENABLED` 恢复旧路径。
> 服务器：Paper 26.1.2，`~/minecraft-server`，RCON 已启用。
> 所有操作从 Windows 工作区通过 SSH/SCP 执行；不使用 Docker。

## 0. 前置条件

- 本机：Node 26、npm、`ssh.exe`/`scp.exe`/`tar.exe`；已能把密钥登录到 Pi（`ssh antifield@169.254.77.10 true`）。
- Pi：免密 sudo；Node v26.12.1；`~/minecraft-server` 正在运行；OpenCode 服务 `127.0.0.1:4096` 可用。
- 首次部署会修改服务器 `max-players`、白名单、OP 并重启 Paper；请确认没有玩家在线。

## 1. 首次部署

```powershell
cd C:\Users\25371\projects\mcbot
npm install
npm run check

# 首次：安装用户/目录/systemd、写 env、max-players=6、加白名单/OP、重启服务器
.\scripts\deploy.ps1 -Provision -ServerConfig -AllowDirty
```

脚本流程：

1. 本地 `npm run check`（可 `-SkipChecks`）。
2. 打包（排除 `node_modules`、`.git`、`data*`）→ SSH/SCP 到 `/tmp` → 校验 SHA-256。
3. 远端解包到 `/opt/mcbot/releases/<UTC>` → `npm ci --omit=dev --ignore-scripts`。
4. 首次 `deploy/provision.sh`：
   - 创建系统用户 `lofiibot`、`/var/lib/mcbot`、`/etc/mcbot`；
   - `bootstrap-env.sh` 从 `/etc/opencode/opencode.env` 读密码、生成 64 位 `HTTP_TOKEN` 与独立的 `HTTP_CONTROL_TOKEN`，写 `/etc/mcbot/env`（root:lofiibot 0640）；
   - 安装并 enable `mcbot.service`；
   - `--server-config`：备份 `server.properties`/`whitelist.json`/`ops.json`，`max-players=6`，重启 Paper，RCON `whitelist add lofii` + `op lofii`。
5. 原子切换 `/opt/mcbot/current`，重启服务，轮询 `/healthz` 校验版本；失败回滚上一 release。

## 2. 后续部署/回滚

> `deploy.ps1` 成功部署后默认只保留最新 3 个 release（`-KeepReleases` 可调），并始终保护 `current` 与刚部署前的 `previous`；每个 release 含完整 `node_modules`，约 0.5 GiB。SD 卡低磁盘根因与 2026-10-31 清理记录见 [AUDIT 附录 B](../app/AUDIT.md)。

```powershell
.\scripts\deploy.ps1
```

- 部署失败会自动切回上一 release 并重启，输出 `journalctl -u mcbot -n 80`。
- 手工回滚：

```bash
sudo ln -sfn /opt/mcbot/releases/<上一个UTC> /opt/mcbot/current
sudo systemctl restart mcbot
curl -fsS http://127.0.0.1:3010/healthz
```

- 服务器配置回滚：恢复 `~/minecraft-server/server.properties.bak-lofii-<TS>` 后 `sudo systemctl restart minecraft`；白名单/OP 用 `.bak-lofii-<TS>` 或 RCON 撤销。

## 3. 服务器变更清单（仅首次 `-ServerConfig`）

| 文件/配置 | 变更 | 备份 |
|---|---|---|
| `server.properties` | `max-players=6` | `server.properties.bak-lofii-<TS>` |
| `whitelist.json` | 追加 `lofii` | `whitelist.json.bak-lofii-<TS>` |
| `ops.json` | `lofii` OP 4 | `ops.json.bak-lofii-<TS>` |
| Paper | 重启一次使 max-players 生效 | — |

不改：`online-mode`、`white-list`、`enforce-whitelist`、`pause-when-empty-seconds`、RCON、插件、世界、FRP/Cloudflare。

### v0.2.0 任务前置条件（只在基地，不涉及服务器配置）

- 家/重生点：`/spawnpoint lofii 175 64 410`（已设置）。
- 安全区：`x175–239, z410–474`；农田 `x177–183, z432–439`（6 列 × 8 行 = 48 格，中间 `x180` 水渠）。
- 混放箱：`(184,64,435)`；建议常备：
  - 2–3 根鱼竿、2–3 把铁锄、至少 128 个小麦种子、16+ 熟食；
  - 鱼/小麦自动存入同一个箱子。
- 钓点：站在 `(204.5,63,469.5)`，面向 `(204.5,62.5,470.5)` 水面。
- 世界修改边界：只允许农田作物/耕地；箱子只存/取物品；不修改安全区其他方块。
- `spawn-monsters` 以实际 gamerule/服务器设置为准；任务在夜间/附近有敌对生物时会暂停回家。

## 4. 目录与权限

```text
/opt/mcbot/releases/<UTC>/    # 每次部署一个 release（root:root 只读）
/opt/mcbot/current -> ...     # 原子切换
/etc/mcbot/env                # root:lofiibot 0640（含读/控制 Token、OpenCode 密码）
/var/lib/mcbot/               # lofiibot:lofiibot 0700
/var/lib/mcbot/memory/        # 0600，按玩家 UUID
/var/lib/mcbot/task-state.json # 0600，v2 active+queue+pending
/var/lib/mcbot/audit.jsonl     # 0600，审计元数据，5 MB 轮转
/var/lib/mcbot/history.db      # 0600，SQLite 60s 采样/告警，30 天
/etc/systemd/system/mcbot.service
```

- 服务用户：`lofiibot`（nologin，非 root）。
- 资源限制：`MemoryHigh=384M`、`MemoryMax=512M`、`Nice=5`；`Restart=always`。
- HTTP 仅监听 `127.0.0.1:3010`；nftables 未改动。

## 5. 环境变量

见 `deploy/env.example`。生产修改后：

```bash
sudo nano /etc/mcbot/env
sudo systemctl restart mcbot
```

安全注意：

- `HTTP_TOKEN` 轮换：`sudo bash /opt/mcbot/current/deploy/bootstrap-env.sh --rotate-token`，然后把新读 Token 同步给 AntifieldCloud。
- `HTTP_CONTROL_TOKEN` 轮换：`sudo bash /opt/mcbot/current/deploy/bootstrap-env.sh --rotate-control-token`；只同步给面板后端，不下发浏览器。
- 控制 Token 未配置或为空时，`/task/*` 与 `/move` 返回 503 `control_disabled`，读接口仍可用。
- `OPENCODE_PASSWORD` 由 `bootstrap-env.sh` 从 `/etc/opencode/opencode.env` 读取；重跑默认保留旧值。
- v0.3 新增变量：`HTTP_CONTROL_ENABLED`、`HTTP_ONLY_HIGH_RISK`、`SSE_MAX_CLIENTS`、`SSE_HEARTBEAT_MS`、`SSE_BUFFER_EVENTS`、`CONTROL_RATE_LIMIT`、`TASK_PENDING_TTL_MS`、`TASK_STATE_FILE`、`AUDIT_FILE`、`AUDIT_MAX_BYTES`、`AUDIT_RETENTION_DAYS`。
- v0.4 新增变量：`QUEUE_MAX`、`TREE_FARM_MIN_X/MAX_X/MIN_Z/MAX_Z`、`TREE_FARM_GROUND_Y=63`、`TREE_FARM_LOG_MIN_Y=64`、`TREE_FARM_MAX_Y`、`TREE_LOG_TYPE`、`TREE_SAPLING_TYPE`、`TREE_MAX_LOGS`、`TREE_DEPOSIT_EVERY_MS`、`DEFENSE_ENABLED/RADIUS/HEALTH_THRESHOLD/FOOD_THRESHOLD/MAX_HOSTILES/TARGETS`、`CHUNK_WAIT_MS`、`MEMORY_SUMMARY_ENABLED/TURNS/MAX_CHARS`。
- v0.5 新增变量：`SAFE_MIN_X=111`、`SAFE_MAX_X=239`、`SAFE_MIN_Z=410`、`SAFE_MAX_Z=474`、`TASK_MAX_MINUTES=60`、`RCON_ENABLED/HOST/PORT/PASSWORD/TIMEOUT_MS`、`ADMIN_POLL_MS`、`HISTORY_ENABLED/DB/SAMPLE_MS/RETENTION_DAYS`、`ALERTS_ENABLED/COOLDOWN_MS/HEALTH_THRESHOLD`、`MINE_MIN_Y/MAX_Y/MAX_ORES/MAX_MINUTES/PROTECT_RADIUS/ORES`、`FOREST_SPECIES/PROTECT_RADIUS/MAX_LOGS/DEPOSIT_EVERY_MS`、`BED_SEARCH_RADIUS`、`SLEEP_VOTE_WAIT_MS`、`PATROL_MAX_MINUTES`。
- RCON 只有一个密码，所谓“只读”是 Bot 端命令白名单；生产 `/etc/mcbot/env` 需要 `RCON_PASSWORD`（从 `server.properties` 读取，不打印）。
- 树场实际布局：地面块 y=63，原木从 y=64 起；`TREE_FARM_GROUND_Y=63`、`TREE_FARM_LOG_MIN_Y=64`。
- 不要把 `/etc/mcbot/env` 放进仓库或日志。

## 6. 日常运维

```bash
sudo systemctl status mcbot
sudo systemctl restart mcbot
sudo journalctl -u mcbot -f
curl -fsS http://127.0.0.1:3010/healthz
TOKEN="$(sudo grep '^HTTP_TOKEN=' /etc/mcbot/env | cut -d= -f2-)"
CTRL="$(sudo grep '^HTTP_CONTROL_TOKEN=' /etc/mcbot/env | cut -d= -f2-)"
curl -fsS http://127.0.0.1:3010/status -H "Authorization: Bearer $TOKEN"
curl -fsS http://127.0.0.1:3010/task -H "Authorization: Bearer $TOKEN"
# SSE（15 秒后自动断开；面板后端用同样 header）
timeout 15 curl -sS -N http://127.0.0.1:3010/events -H "Authorization: Bearer $TOKEN"
# 控制：启动/停止/恢复/移动（示例；面板后端使用）
curl -fsS -X POST http://127.0.0.1:3010/task/start \
  -H "Authorization: Bearer $CTRL" -H 'Content-Type: application/json' \
  -d '{"name":"fishing"}'
curl -fsS -X POST http://127.0.0.1:3010/task/stop \
  -H "Authorization: Bearer $CTRL" -H 'Content-Type: application/json' -d '{}'
curl -fsS -X POST http://127.0.0.1:3010/move \
  -H "Authorization: Bearer $CTRL" -H 'Content-Type: application/json' \
  -d '{"action":"home"}'
```

- 动态模式：无玩家时状态 `idle`、`/say` 返回 409，这是正常的；玩家上线后 15 秒内自动加入。
- 任务模式：任务 active 时即使 Antifield 下线也保持在线，`/status.presence.lastDecision = connected: task active`；任务结束且无玩家时恢复 60 秒 grace 后下线。
- 任务队列：active 之外最多 3 个；`/task/stop` 停止 active 并清空队列；active 正常结束自动下一个，失败/恢复超时清空队列。
- 砍树：固定 oak 树场 `180–193 / 455–464`，地面 y=63、原木 y=64；只砍 oak_log、逐棵补种 oak_sapling，原木存箱。
- 被动防御：任务中 12 格内 zombie/husk/drowned/skeleton/stray/spider/cave_spider 才接战；HP≤12、food≤6 或 >2 只怪撤退回家并让当前任务失败；不攻击 creeper/enderman/witch/玩家。
- 记忆摘要：每 40 turns（20 来回）后台生成 ≤1000 字聊天摘要；失败回退，不影响聊天。
- 任务恢复：死亡/Paper 重启后回到任务点，最多 3 次；工具/种子丢失会停止并提示，需从箱子补货。
- 管理只读：`GET /admin/status` 返回 RCON `tps`/`list`/`whitelist list`/`time`；只允许这四条，无写操作；备份状态固定 `unknown`。
- 历史/告警：`GET /history?kind=samples|alerts`（读 Token）；SQLite 60s/30 天；SSE `alert` 覆盖低血量/任务失败/断线/箱子满/防御撤退，5 分钟冷却。
- systemd 重启：任务会写盘并在启动后进入 `pending_resume`；10 分钟内 `POST /task/resume` 继续，否则标记 `interrupted`。pending 期间 Lofii 按动态在线策略（通常离线）。
- SSE：最多 8 个客户端；断线用 `Last-Event-ID` 重连；进程重启后 ring 清空，面板重新拉 `/status`/`/task`。
- 审计：`/var/lib/mcbot/audit.jsonl` 只记元数据；轮转 `audit.1.jsonl`…`audit.5.jsonl`，保留 30 天；无查询接口。
- 需要临时常驻：`FORCE_ONLINE=true` 后重启；验证完记得改回。
- 服务器重启：Bot 不退出；任务 active 时会重连并恢复；无任务时等玩家上线后重连。
- Bot 崩溃：systemd 5 秒后拉起；若反复崩溃看 journal 与 `/status.ai.lastError`。

## 7. 排障

| 现象 | 检查 |
|---|---|
| 服务起不来 | `journalctl -u mcbot -n 100`；`/etc/mcbot/env` 是否 0640 且包含 `HTTP_TOKEN`/`OPENCODE_PASSWORD` |
| 登录被拒 | `whitelist list` 是否含 `lofii`；`ops.json`；`/status.minecraft.lastDisconnect` |
| 连接节流 | Paper 的 *Connection throttled* 属正常；退避会自动重试，避免短时间反复重启 |
| AI 不回复 | `curl -u opencode:<pw> http://127.0.0.1:4096/api/info`；`/status.ai.lastError`；OpenCode 服务状态 |
| `/say` 409 | Bot 不在线（动态模式空服）；让玩家上线或临时 `FORCE_ONLINE=true` |
| 移动失败 | 目标实体未加载/跨维度/无路；`Lofii 状态` 看位置；需要时先 `/tp` |
| 任务不启动 | 箱子/背包是否有鱼竿/锄/种子/铁斧/铁镐/树苗/食物；`/status.task.lastError`；`Lofii 状态` 看位置 |
| 管理 503/空 | `RCON_ENABLED`、`RCON_PASSWORD`、`RCON_PORT`；`/admin/status` 的 `rcon/lastError`；服务器 RCON 是否开启 |
| 历史 503/空 | `HISTORY_ENABLED`、`HISTORY_DB` 权限；`/history?kind=samples`；journal `history` |
| 告警不出现 | `ALERTS_ENABLED`；5 分钟冷却；低血量阈值 12；任务是否失败/断线/箱子满/防御撤退 |
| 砍树不砍/不补种 | `/status.task.progress.treesChopped/logsChopped/saplingsPlanted`；树场实际地面 y=63/原木 y=64；树苗/铁斧是否够 |
| 防御不接战 | `/status` 的 health/food；`DEFENSE_ENABLED`；目标怪种；任务 active；没有剑时只会撤退 |
| 队列不继续 | `/task.task.queue`；active 是否失败/stop；失败会清队列 |
| 记忆摘要不生成 | `MEMORY_SUMMARY_ENABLED`；AI 是否可用；`/status.memory`；日志 `memory summary` |
| 任务停在任务点外 | 恢复次数是否到 3；死亡是否掉工具；箱内备用工具/种子是否足够 |
| 种田不收割 | 作物是否成熟（`age=7`）；任务是否在 30 分钟上限/收工；`/status.task.progress` |
| 钓鱼不捡鱼 | 掉落物是否落在深水/安全区外；日志 `fishing: item pickup skipped`；必要时调整钓点/加小平台（需确认） |
| 任务后不下线 | `/status.task.active` 是否为 false；Antifield 是否仍在线；`PRESENCE_GRACE_MS` |
| 任务重启后不继续 | `/task.task.state` 是否 `pending_resume`；`POST /task/resume` 是否 409；`pendingResume.expiresAt` 是否已过 |
| 控制接口 503 | `HTTP_CONTROL_TOKEN` 是否为空；`HTTP_CONTROL_ENABLED` 是否为 true |
| 控制接口 401 | 是否误用读 Token；`Authorization: Bearer <HTTP_CONTROL_TOKEN>` |
| SSE 401/断流 | 是否用读 Token；是否超过 `SSE_MAX_CLIENTS`；反向代理是否关闭 buffering |
| SSE 重连丢事件 | `Last-Event-ID` 是否属于当前 bootId；`resync:true` 时重新拉 `/status`/`/task` |
| 移动 409 | 任务是否 active（先 `/task/stop`）；目标玩家是否在线；Bot 是否连接 |
| 审计为空/过大 | 检查 `/var/lib/mcbot/audit.jsonl` 权限；轮转大小/保留天数 |
| 端口占用 | `ss -tlnp | grep 3010`；改 `HTTP_PORT` 并同步对接方 |

## 8. 卸载

```bash
sudo systemctl disable --now mcbot
sudo rm -f /etc/systemd/system/mcbot.service
sudo systemctl daemon-reload
# 按需删除（会丢失记忆）：
sudo rm -rf /opt/mcbot /etc/mcbot /var/lib/mcbot
# Minecraft：RCON 撤销
node /opt/mcbot/scripts/rcon.mjs "deop lofii" "whitelist remove lofii" 2>/dev/null || true
```

## 9. 与 AntifieldCloud 的边界

- 本仓库不修改 AntifieldCloud；只提供 `docs/mcbot/API.md` 契约。
- Token 注入、面板展示、调用逻辑由用户自行接入；面板后端消费 SSE，使用读 Token header。
- 控制 Token 只放面板后端 env，不下发浏览器。
- **HTTP-only 不是强制边界**：默认保留游戏内 `Antifield` 与 AI 意图直接触发，同名冒用风险仍在；严格模式设 `HTTP_ONLY_HIGH_RISK=true`。
- 不要为了对接改动 nftables/FRP/Cloudflare；HTTP 只在本机回环。
