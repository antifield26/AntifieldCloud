# Roadmap

## v0.1.0（已完成）

- 动态上下线、稳定重连、AI 聊天、按玩家记忆、状态/移动指令、本机 HTTP。
- 验收：`docs/ACCEPTANCE.md`。

## v0.2.0（已完成：钓鱼 / 种田 / 自动存箱）

- 任务框架：单任务状态机、任务进度 `/status.task`、任务中保持在线、结束后恢复动态下线。
- 钓鱼：`(204,64,469)` 面向水面，自动抛竿/收竿/捡鱼/存箱；30 分钟/背包满/收工/工具损坏/低血量停止。
- 种田：`x177–183, z432–439` 首次播种、成熟收割、补种、存箱；只允许农田内修改。
- 自动存箱：`(184,64,435)` 混放箱；保留工具/种子/食物，存入鱼/小麦/杂物；箱满停止。
- 移动与家：`回家`、远距离 `过来`、`follow` >64 格/跨维度安全传送；只允许代码生成 `/tp`。
- 任务恢复：死亡/Paper 重启自动回任务点，最多 3 次；工具/种子丢失停止并提示。
- AI 意图：固定短语优先，Antifield 的任务类模糊语句走 AI 枚举分类；AI 不能直接执行任意动作。
- 主动行为：Antifield 加入问候、夜晚/雷雨/死亡固定文案、冷却。
- 验收：`docs/ACCEPTANCE.md`（8+ 条鱼、8 格小麦收割/补种、死亡/服务器重启恢复、0 玩家任务在线、动态下线）。

## v0.3.0（已完成：SSE / HTTP 控制 / 审计 / 任务跨重启）

- SSE `GET /events`：`hello/presence/task/chat/movement`；内存 ring 500、`Last-Event-ID`、心跳、最多 8 客户端。
- HTTP 控制：独立 `HTTP_CONTROL_TOKEN`；`POST /task/start|stop|resume`、`POST /move`（home/come/follow/stop）。
- 任务跨 systemd 重启：`task-state.json` 原子写盘；重启后 `pending_resume`，10 分钟内面板确认；不自动恢复。
- 审计 JSONL：`/var/lib/lofii-bot/audit.jsonl`，0600、5 MB 轮转、30 天；仅元数据，不含聊天正文/Token/密码。
- 读/控制 Token 分离；SSE 只读 Token，控制 Token 不下发浏览器。
- 验收：mock SSE/控制 + 服务重启 pending/resume + 20–30 分钟 soak；详见 `docs/ACCEPTANCE.md`。
- 边界：默认保留游戏内 Antifield/AI 直接触发，HTTP-only 非强制；严格模式 `HTTP_ONLY_HIGH_RISK=true`。

## v0.4.0（已完成：队列 / 砍树 / 被动防御 / 记忆摘要）

- 任务队列：单 active + 最多 3 个排队；正常完成自动下一个；stop/失败/恢复超时清空；跨重启持久化。
- 砍树：固定 oak 树场 `180–193/455–464`，地面块 y=63/原木 y=64；只砍 oak_log、逐棵补种 oak_sapling、原木存箱。
- 任务中被动防御：12 格内 zombie/husk/drowned/skeleton/stray/spider/cave_spider 才接战；HP≤12、food≤6、>2 怪撤退；排除 creeper/enderman/witch/玩家。
- 可靠性：主世界安全区内 chunk 等待/路径重试；`come/follow` 实体未加载回退，跨维度拒绝。
- 记忆摘要：每 40 turns（20 来回）后台 ≤1000 字聊天摘要，注入 prompt；v1 memory 自动迁移。
- 验收：65 单元测试、砍树累计 ≥32 原木/≥8 补种、队列跨重启、farm soak；详见 `docs/ACCEPTANCE.md`。
- 边界：不做 RCON/管理只读、`/metrics`、告警、多 Bot、语音、Discord/QQ。

## v0.5 运维与自动化扩展（待定）

- 管理助手只读（RCON TPS/白名单/备份状态）、指标历史与告警。
- 定点挖矿、天然林/更多树种、睡觉跳夜（Vote2Sleep）、巡逻。
- 更稳的跨维度移动；多次 pending 任务链/长期任务。
- 多角色人设、语音、聊天与 Discord/QQ 互通（复用 AntifieldCloud Bot 能力，用户主导）。
