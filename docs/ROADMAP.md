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

## v0.5.0（已完成：只读 RCON / SQLite 历史 / SSE 告警 / 表层矿 / 天然林 / 睡觉 / 巡逻）

- 管理只读：现有 RCON 密码 + Bot 端命令白名单 `tps`/`list`/`whitelist list`/`time`；`GET /admin/status`；无写管理接口。
- 历史/告警：SQLite 60 秒采样/30 天；`GET /history`；SSE `alert`（低血量/任务失败/断线/箱子满/防御撤退，5 分钟冷却）。
- 安全区扩至 `x111–239, z410–474`；任务上限 60 分钟；队列仍 3。
- 表层矿：煤/铁/铜、y≥60、裸露矿、保护盒 16、不挖隧道。
- 天然林：安全区扫描 oak/spruce/birch、保护盒 16、逐棵补种。
- 睡觉：home 附近床 + Vote2Sleep；无法跳夜正常结束。
- 巡逻：安全区边界四角（内缩 4）、最多 15 分钟、不主动追怪。
- 验收：75 单元测试、挖矿 ≥16、天然林 ≥16、巡逻 4/4、20 分钟 soak、历史/告警；详见 `docs/ACCEPTANCE.md`。
- 边界：不做跨维度、多 Bot/语音/Discord/QQ、Prometheus `/metrics`、webhook、AntifieldCloud 改动。

## v0.6.1（已完成：聊天切行命令注入安全修复）

- `splitOutgoing` 在按行宽切分后逐行检查：任何行首 ASCII `/` 替换为全角 `／`，确保 mineflayer 不会把切分后的第二行当作命令执行。
- 回归覆盖 239/240/255/480 字符边界；AntifieldCloud 应用侧同时拒绝任意 ASCII `/` 并要求控制 Token。
- 契约与接口不变（`CONTRACT_VERSION=1`）。

## v0.6.0（已完成：只读近期事件轮询 / 契约版本）

- 事件只读轮询：`EventBus.recent(limit)` 返回内存 ring 最近事件（旧 → 新）；`GET /events/recent` 使用读 Token，`limit` 默认 50、范围 1–200，返回 `{contractVersion, bootId, lastEventId, events}`，不含 `hello`。
- 契约版本：新增 `CONTRACT_VERSION=1`；`GET /healthz` 与 `GET /events/recent` 均返回 `contractVersion`，供 AntifieldCloud 判断字段兼容性。
- 用途：面板后端低频轮询或 SSE 断线后补拉；`bootId` 变化/事件过旧时重新拉 `/status` 与 `/task`。不替代 SSE，不持久化。
- 验收：本地 `npm run check` 全绿（typecheck + 77 个单元测试）；仅本地契约验证，未部署 Pi、未修改 AntifieldCloud。
- 边界：不新增依赖/schema/DB/环境变量；不改任务/AI/控制行为与既有响应字段；ring 仍为内存、进程重启清空。

## v0.7 待定

- 更稳的跨维度移动/多次 pending 任务链/长期任务。
- 多角色人设、语音、聊天与 Discord/QQ 互通（复用 AntifieldCloud Bot 能力，用户主导）。
- 更细的指标导出/外部通知（用户确认后再做）。
