# 部署与运维（Lofii Bot）

> 目标 Pi：`antifield@169.254.77.10`（Raspberry Pi 5，Debian 13，Node `/usr/local/bin/node` v26.12.1）。
> 服务器：Paper 26.1.2，`~/minecraft-server`，RCON 已启用。
> 所有操作从 Windows 工作区通过 SSH/SCP 执行；不使用 Docker。

## 0. 前置条件

- 本机：Node 26、npm、`ssh.exe`/`scp.exe`/`tar.exe`；已能把密钥登录到 Pi（`ssh antifield@169.254.77.10 true`）。
- Pi：免密 sudo；Node v26.12.1；`~/minecraft-server` 正在运行；OpenCode 服务 `127.0.0.1:4096` 可用。
- 首次部署会修改服务器 `max-players`、白名单、OP 并重启 Paper；请确认没有玩家在线。

## 1. 首次部署

```powershell
cd C:\Users\25371\projects\lofii-bot
npm install
npm run check

# 首次：安装用户/目录/systemd、写 env、max-players=6、加白名单/OP、重启服务器
.\scripts\deploy.ps1 -Provision -ServerConfig -AllowDirty
```

脚本流程：

1. 本地 `npm run check`（可 `-SkipChecks`）。
2. 打包（排除 `node_modules`、`.git`、`data*`）→ SSH/SCP 到 `/tmp` → 校验 SHA-256。
3. 远端解包到 `/opt/lofii-bot/releases/<UTC>` → `npm ci --omit=dev --ignore-scripts`。
4. 首次 `deploy/provision.sh`：
   - 创建系统用户 `lofiibot`、`/var/lib/lofii-bot`、`/etc/lofii-bot`；
   - `bootstrap-env.sh` 从 `/etc/opencode/opencode.env` 读密码、生成 64 位 `HTTP_TOKEN`，写 `/etc/lofii-bot/env`（root:lofiibot 0640）；
   - 安装并 enable `lofii-bot.service`；
   - `--server-config`：备份 `server.properties`/`whitelist.json`/`ops.json`，`max-players=6`，重启 Paper，RCON `whitelist add lofii` + `op lofii`。
5. 原子切换 `/opt/lofii-bot/current`，重启服务，轮询 `/healthz` 校验版本；失败回滚上一 release。

## 2. 后续部署/回滚

```powershell
.\scripts\deploy.ps1
```

- 部署失败会自动切回上一 release 并重启，输出 `journalctl -u lofii-bot -n 80`。
- 手工回滚：

```bash
sudo ln -sfn /opt/lofii-bot/releases/<上一个UTC> /opt/lofii-bot/current
sudo systemctl restart lofii-bot
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
/opt/lofii-bot/releases/<UTC>/    # 每次部署一个 release（root:root 只读）
/opt/lofii-bot/current -> ...     # 原子切换
/etc/lofii-bot/env                # root:lofiibot 0640（含 Token/OpenCode 密码）
/var/lib/lofii-bot/               # lofiibot:lofiibot 0700
/var/lib/lofii-bot/memory/        # 0600，按玩家 UUID
/etc/systemd/system/lofii-bot.service
```

- 服务用户：`lofiibot`（nologin，非 root）。
- 资源限制：`MemoryHigh=384M`、`MemoryMax=512M`、`Nice=5`；`Restart=always`。
- HTTP 仅监听 `127.0.0.1:3010`；nftables 未改动。

## 5. 环境变量

见 `deploy/env.example`。生产修改后：

```bash
sudo nano /etc/lofii-bot/env
sudo systemctl restart lofii-bot
```

安全注意：

- `HTTP_TOKEN` 轮换：`sudo bash /opt/lofii-bot/current/deploy/bootstrap-env.sh --rotate-token`，然后把新 Token 同步给 AntifieldCloud。
- `OPENCODE_PASSWORD` 由 `bootstrap-env.sh` 从 `/etc/opencode/opencode.env` 读取；重跑默认保留旧值。
- 不要把 `/etc/lofii-bot/env` 放进仓库或日志。

## 6. 日常运维

```bash
sudo systemctl status lofii-bot
sudo systemctl restart lofii-bot
sudo journalctl -u lofii-bot -f
curl -fsS http://127.0.0.1:3010/healthz
TOKEN="$(sudo grep '^HTTP_TOKEN=' /etc/lofii-bot/env | cut -d= -f2-)"
curl -fsS http://127.0.0.1:3010/status -H "Authorization: Bearer $TOKEN"
curl -fsS -X POST http://127.0.0.1:3010/say \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"message":"来自运维的问候"}'
```

- 动态模式：无玩家时状态 `idle`、`/say` 返回 409，这是正常的；玩家上线后 15 秒内自动加入。
- 任务模式：任务 active 时即使 Antifield 下线也保持在线，`/status.presence.lastDecision = connected: task active`；任务结束且无玩家时恢复 60 秒 grace 后下线。
- 任务恢复：死亡/Paper 重启后回到任务点，最多 3 次；工具/种子丢失会停止并提示，需从箱子补货。
- 需要临时常驻：`FORCE_ONLINE=true` 后重启；验证完记得改回。
- 服务器重启：Bot 不退出；任务 active 时会重连并恢复；无任务时等玩家上线后重连。
- Bot 崩溃：systemd 5 秒后拉起；若反复崩溃看 journal 与 `/status.ai.lastError`。

## 7. 排障

| 现象 | 检查 |
|---|---|
| 服务起不来 | `journalctl -u lofii-bot -n 100`；`/etc/lofii-bot/env` 是否 0640 且包含 `HTTP_TOKEN`/`OPENCODE_PASSWORD` |
| 登录被拒 | `whitelist list` 是否含 `lofii`；`ops.json`；`/status.minecraft.lastDisconnect` |
| 连接节流 | Paper 的 *Connection throttled* 属正常；退避会自动重试，避免短时间反复重启 |
| AI 不回复 | `curl -u opencode:<pw> http://127.0.0.1:4096/api/info`；`/status.ai.lastError`；OpenCode 服务状态 |
| `/say` 409 | Bot 不在线（动态模式空服）；让玩家上线或临时 `FORCE_ONLINE=true` |
| 移动失败 | 目标实体未加载/跨维度/无路；`Lofii 状态` 看位置；需要时先 `/tp` |
| 任务不启动 | 箱子是否有鱼竿/锄/种子/食物；`/status.task.lastError`；`Lofii 状态` 看位置 |
| 任务停在任务点外 | 恢复次数是否到 3；死亡是否掉工具；箱内备用工具/种子是否足够 |
| 种田不收割 | 作物是否成熟（`age=7`）；任务是否在 30 分钟上限/收工；`/status.task.progress` |
| 钓鱼不捡鱼 | 掉落物是否落在深水/安全区外；日志 `fishing: item pickup skipped`；必要时调整钓点/加小平台（需确认） |
| 任务后不下线 | `/status.task.active` 是否为 false；Antifield 是否仍在线；`PRESENCE_GRACE_MS` |
| 端口占用 | `ss -tlnp | grep 3010`；改 `HTTP_PORT` 并同步对接方 |

## 8. 卸载

```bash
sudo systemctl disable --now lofii-bot
sudo rm -f /etc/systemd/system/lofii-bot.service
sudo systemctl daemon-reload
# 按需删除（会丢失记忆）：
sudo rm -rf /opt/lofii-bot /etc/lofii-bot /var/lib/lofii-bot
# Minecraft：RCON 撤销
node /opt/lofii-bot/scripts/rcon.mjs "deop lofii" "whitelist remove lofii" 2>/dev/null || true
```

## 9. 与 AntifieldCloud 的边界

- 本仓库不修改 AntifieldCloud；只提供 `docs/API.md` 契约。
- Token 注入、面板展示、调用逻辑由用户自行接入。
- 不要为了对接改动 nftables/FRP/Cloudflare；HTTP 只在本机回环。
