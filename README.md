# Lofii Minecraft Bot

面向 Raspberry Pi 5（8 GB，Debian 13）的 Minecraft AI 陪伴 Bot，运行在 PaperMC 26.1.2 服务器旁边，通过 mineflayer 以离线账号 `lofii` 登录。

> 当前版本：v0.1.0（MVP）。详细计划与验收记录见 `docs/`。

## 能做什么

- **AI 陪伴聊天**：只有被 `Lofii` / `@Lofii` 点名时回复；中文、温柔助手人设；复用 Pi 本机 OpenCode 的 `opencode-go/deepseek-v4.1-flash`。
- **按玩家动态上线**：SLP 每 15 秒探测；有玩家在线时上线；最后一名玩家离开 60 秒后下线，让服务器在空服时正常 pause。
- **有限自然语言指令**：`Lofii 状态 / 过来 / 跟随我 / 停下 / 看我 / 挥手 / 帮助`，仅 `Antifield` 可执行。
- **按玩家记忆**：最近 20 轮、保留 30 天，落盘到 `/var/lib/lofii-bot/memory`，重启后仍能记住。
- **本机 HTTP 接口**：只读状态 + `/say`，供 AntifieldCloud 对接；仅监听 `127.0.0.1:3010`。
- **可靠性**：登录超时/断线/服务器重启/满员/连接节流自动退避重连；systemd 崩溃拉起；30–60 分钟 soak 验收。

## 不做什么

- 不修改 AntifieldCloud 仓库、数据库或服务；本仓库只提供接口契约。
- 不做挖矿、种田、钓鱼、战斗、建筑、踢人/封禁/备份触发。
- 不默认 24/7 保活；空服时服务器会 pause。需要常驻时把 `FORCE_ONLINE=true`。
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
玩家聊天 ─► chat router ─┬─ 授权指令 ─► command executor ─► reply queue ─► bot.chat
                         ├─ 未授权指令 ─► 固定拒绝
                         └─ 唤醒词 ─► AI queue ─► OpenCode ─► 清洗/拆行 ─► reply queue
                                                                  │
                                                             memory store

HTTP /status ─► state 快照
HTTP /say ─► reply queue（只聊天，不执行指令）
```

### 关键安全约束

- 所有外发聊天统一经过 `sanitizeOutgoing`：**首字符 `/` 会被替换为全角 `／`**，防止 AI 或 HTTP 输入变成 OP 命令。
- AI 没有任何工具/命令执行能力；指令只由确定性解析器执行，且仅 `Antifield`（`COMMAND_ALLOWLIST`）有效。
- `/say` 拒绝以 `/` 开头的消息；HTTP 仅回环、Bearer Token、8 KiB 请求体上限、10 次/分钟限流。
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
sudo systemctl status lofii-bot
sudo journalctl -u lofii-bot -f
curl -fsS http://127.0.0.1:3010/healthz
sudo grep '^HTTP_TOKEN=' /etc/lofii-bot/env   # 取对接 Token（root）
```

### 启停/回滚

```bash
sudo systemctl restart lofii-bot
sudo systemctl stop lofii-bot
# 回滚：把 current 指向上一个 release 后重启
sudo ln -sfn /opt/lofii-bot/releases/<UTC> /opt/lofii-bot/current
sudo systemctl restart lofii-bot
```

## 配置

完整变量见 `deploy/env.example`。生产 env 在 `/etc/lofii-bot/env`（root:lofiibot 0640），由 `deploy/bootstrap-env.sh` 生成；密钥不提交仓库。

常用：

| 变量 | 默认 | 说明 |
|---|---|---|
| `COMMAND_ALLOWLIST` | `Antifield` | 可执行移动/状态指令的玩家名，逗号分隔 |
| `PRESENCE_ENABLED` | `true` | 动态上下线开关 |
| `FORCE_ONLINE` | `false` | 强制常驻（不因空服下线） |
| `AI_ENABLED` | `true` | AI 总开关 |
| `AI_MODEL_PROVIDER` / `AI_MODEL_ID` | `opencode-go` / `deepseek-v4.1-flash` | OpenCode 模型 |
| `AI_COOLDOWN_MS` | `10000` | 每玩家 AI 冷却 |
| `AI_RATE_PER_HOUR` | `60` | 每玩家每小时 AI 上限 |
| `MEMORY_MAX_TURNS` | `20` | 每玩家记忆轮数 |
| `HTTP_PORT` | `3010` | 仅回环 HTTP 端口 |

## 测试

```bash
npm run check     # tsc --noEmit + node:test 单元测试
npm run smoke     # 连接真实服务器，验证 状态/挥手/AI（需先部署并让 SmokeTester 可登录）
```

`npm run smoke` 从 Windows 连接 `MC_HOST`，以 `SmokeTester` 身份发消息；生产验收请先临时把 `SmokeTester` 加入白名单，验收后移除。

## 文档

- [docs/API.md](docs/API.md) — AntifieldCloud 对接契约
- [docs/DEPLOY.md](docs/DEPLOY.md) — 部署、服务器变更、回滚、排障
- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) — 验收记录
- [docs/ROADMAP.md](docs/ROADMAP.md) — 后续路线
- [deploy/env.example](deploy/env.example) — 环境变量模板

## 已知限制

- 离线服务器按玩家名鉴权，理论上可被同白名单/内网他人冒充 `Antifield`；请保持白名单与 FRP 地址可信，后续可改为 HTTP-only 管理指令。
- 动态在线意味着空服时服务器会 pause；如要 7×24 保活，设 `FORCE_ONLINE=true`（注意功耗/发热）。
- `come` / `follow` 依赖 mineflayer-pathfinder 与当前 26.1 方块数据；跨维度、目标实体未加载或地形无路时会明确失败。
- AI 输出只用于聊天；不会触发任何游戏操作。
