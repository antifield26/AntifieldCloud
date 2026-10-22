# 验收记录（Lofii Bot MVP）

## 1. 环境

| 项目 | 值 |
|---|---|
| 验收日期 | 2026-10-22（Asia/Shanghai） |
| Pi | Raspberry Pi 5 8GB / Debian 13 trixie |
| Minecraft | Paper 26.1.2 build 74，协议 775 |
| Node | v26.12.1（Windows 与 Pi 相同） |
| Lofii 版本 | 0.1.0 |
| 部署 release | `/opt/lofii-bot/releases/20261022T121638Z` |
| Bot 账号 | `lofii`（白名单，OP 4） |
| max-players | 6 |

## 2. 结果汇总

| # | 检查 | 结果 | 证据/备注 |
|---|---|---|---|
| 1 | 本地 `npm run check` | ✅ 40/40 通过 | `tsc --noEmit` + `node --test`（40 tests, 0 fail） |
| 2 | 服务与健康 | ✅ | `lofii-bot.service` active/enabled；`/healthz` 200，version 0.1.0 |
| 3 | mineflayer 登录 | ✅ | `root` 日志：spawn，`version=26.1`，Paper 26.1.2；持续 11 分钟无 keepalive 踢出 |
| 4 | 动态上线 | ✅ | SmokeTester 加入后 ≤15s 内 Lofii 上线；`/list` 2 人 |
| 5 | 动态下线 | ✅ | 最后一名玩家离开 60s grace + 5s check + 10s cooldown 后 Lofii 退出；`/status` = `idle` |
| 6 | 空服 pause | ⚠️ 配置确认 | `pause-when-empty-seconds=300`；验收时 0 人后观察约 5 分钟，`journalctl -u minecraft` 与 `latest.log` 未见 pause 关键字（Paper 可能不打印），Lofii 已 `idle` 且不阻止 pause |
| 7 | 状态指令 | ✅ | `Lofii 状态` → 位置/维度/血量/饥饿/在线/时间 |
| 8 | 挥手指令 | ✅ | `Lofii 挥手` → `嗨～` |
| 9 | 移动指令（come/follow/stop） | ⚠️ 部分 | 指令解析、`好，我跟着你`/`好，我过来了`/`停下了`、错误处理均验证；测试地形为浮空/洞穴，实际路径查找多次 `NoPath`/`Timeout`，未能获得稳定到达距离。v0.2 加强 |
| 10 | 未授权指令拒绝 | ✅ | `COMMAND_ALLOWLIST=Antifield` 时 SmokeTester 发 `Lofii 过来` → `抱歉，只有 Antifield 可以指挥我行动。`，无移动、无状态回复；AI 聊天仍可用 |
| 11 | AI 真实回复 | ✅ | OpenCode `opencode-go/deepseek-v4.1-flash`；示例：“你好呀，我是 Lofii，服务器里陪你聊天的温柔 AI 助手。”；延迟约 2.1–2.5s |
| 12 | 跨重启记忆 | ✅ | 记住“测试暗号是紫罗兰”；`systemctl restart lofii-bot` 后询问仍回答“紫罗兰” |
| 13 | HTTP 鉴权/错误码 | ✅ | `/healthz` 200；`/status` 无 Token 401、有 Token 200；在线 `/say` 200；空闲 `/say` 409；`/` 开头 400；405/404/413/429 单测覆盖 |
| 14 | 崩溃恢复 | ✅ | `systemctl kill -s SIGKILL lofii-bot` → systemd 5s 拉起，MainPID 变化；SmokeTester 仍在线时 Lofii 自动重连，`/list` 2 人 |
| 15 | 服务器重启恢复 | ✅ | 重启 Paper 后 Lofii 进入 `idle`；玩家重新上线后自动重连；`lastDisconnect.reason = "Server closed"`（字符串） |
| 16 | 11 分钟 soak | ✅ | 2 人在线 11 分钟：`reconnects` 未新增；RSS 131.3 MB / peak 137.1 MB；TPS 20.0/20.0/20.0 |
| 17 | 发布回滚 | ✅ | 切到上一 release `20261022T115540Z` → 重启 → `/healthz` 200；切回 `20261022T121638Z` → 200 |
| 18 | 运行用户/权限 | ✅ | 进程用户 `lofiibot`；env `0640 root:lofiibot`；memory 目录 `0700`，文件 `0600`；服务 `MemoryMax=512M` |
| 19 | 白名单/OP 收尾 | ✅ | 最终白名单 6 人：`lofii, SFZ, Jay, Antifield, GAY, shoayu`；lofii OP 4；SmokeTester 已移除 |
| 20 | AntifieldCloud 边界 | ✅ | 未修改 AntifieldCloud 仓库/`/opt/antifieldcloud`/服务；仅提供 `docs/API.md` |

## 3. 关键证据

### 3.1 健康/状态

```json
{"status":"ok","version":"0.1.0","uptimeSec":9,"state":"idle","connected":false}
```

`/status`（空闲时）：`state=idle`、`server.reachable=true`、`server.online=0`、`max=6`、`presence.lastDecision=idle: no players`、`memory.players=0`。

### 3.2 动态在线（经验）

- 玩家加入 → Lofii 15 秒内加入，`/status` 显示 `connected`、`presence.otherPlayers=1`。
- 最后一名玩家退出 → 约 70–90 秒后 Lofii 退出并回到 `idle`；`/list` 0 人。
- 服务器重启期间：`server.reachable=false`；重启完成后自动恢复探测。

### 3.3 AI 与记忆

- 真实模型：`opencode-go/deepseek-v4.1-flash`，Basic Auth 校验通过。
- 示例回复：“好的，我记住了，你的测试暗号是紫罗兰。”
- 服务重启后：“你的测试暗号是紫罗兰呀。”
- 记忆文件：`/var/lib/lofii-bot/memory/<uuid>.json`，`0600`，验收后已清空测试数据。

### 3.4 崩溃/重启

- `MainPID=44076` → SIGKILL → systemd 拉起 `MainPID=44221`；`/healthz` 200、`/list` 2 人。
- Paper 重启：Lofii 断开 → `state=idle`、`lastDisconnect.reason="Server closed"`；玩家重新上线后 Lofii 自动重连。

## 4. 待观察/说明

- 空服 5 分钟 pause：`pause-when-empty-seconds=300` 已配置；验收时 0 人后观察约 5 分钟，未在 `journalctl -u minecraft`/`latest.log` 看到 pause 关键字。Lofii 在空服时保持 `idle`，不会阻止 Paper pause。
- 移动类指令的实际路径查找受测试地形（出生平台浮空/洞穴）影响；指令链路与失败话术已验证，v0.2 将加强跨地形/跨维度处理。
- OpenCode 不可用降级已由单元测试覆盖（超时/5xx/空响应 → 固定降级文案）；未做生产环境断网演练。
- 离线模式名称冒用风险仍存在（见 README「已知限制」）。
- 最终运行态：release `20261022T121638Z`，MainPID 46072，idle RSS 约 54–106 MB，peak 137 MB（2 人在线 soak）；白名单 6 人；`/list` 0 人。

## 5. 结论

**MVP 通过**（核心：登录/动态上下线/聊天/记忆/AI/HTTP/崩溃与服务器重启恢复/回滚）。移动路径成功率与 30–60 分钟长时间 soak 作为 v0.2 改进项；本次已做 11 分钟 2 人在线 soak，无新增重连、内存与 TPS 稳定。
