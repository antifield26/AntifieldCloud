# 架构

## 1. 总览

```text
Internet
 ├─ app.example.com ─┐
 ├─ ai.example.com  ─┼─ Cloudflare Edge ── cloudflared(tunnel `pi`, 出站) ── 127.0.0.1:3000
 └─ mc.example.com:11798 ── SakuraFRP（现状保留，不走 antifieldcloud）

Raspberry Pi 5 (Debian 13, aarch64, 8 GB)
 ├─ antifieldcloud.service (User=antifieldcloud, 127.0.0.1:3000)
 │   ├─ Host app.* → React SPA + /api（含 /api/metrics、/api/shares、/api/storage、/api/bots、/api/lofii）
 │   ├─ Host ai.*  → 会话校验 + Origin 校验 + 反向代理 → 127.0.0.1:4096 (opencode)
 │   ├─ 公开 Bot Webhook /api/bot/webhook/:botId → QQ Ed25519 验签 + 去重 + 命令/Chat（只读/AI）/入队
 │   ├─ Lofii 对接 v0.8.0（v0.8.1 安全加固）→ 127.0.0.1:3010（lofii-bot v0.6.1，最低 v0.6.0，仅 loopback）：每 5s 轮询 /status + /events/recent?limit=200；
 │   │   快照/最近 100 条（≤512 KiB）事件仅内存；任务/移动/聊天控制代理（聊天需控制 Token）；上游 alert → 本应用告警 status='event'
 │   ├─ QQ 入站图片（默认开启）→ 固定域名后缀下载（.qpic.cn/.qq.com/.qq.com.cn/.gtimg.cn，实际图床如 multimedia.nt.qq.com.cn）→ OpenCode prompt files → 模型 provider（不落盘）
 │   ├─ Bot 出站 → bots.qq.com / api.sgroup.qq.com（固定上游，15s 超时）
 │   ├─ Bot AI → 127.0.0.1:4096 OpenCode 本地 API（仅普通消息 Chat，默认关闭；无 /ask）
 │   ├─ Bot 记忆 → SQLite bot_memory_items/bot_memory_state（7 类结构化条目）；legacy bot_ai_memories + DATA_DIR/bot-memory/memory-<uuid>.md（0700/0600）
 │   ├─ SQLite /var/lib/antifieldcloud/db.sqlite（schema v17）
 │   ├─ 文件   /var/lib/antifieldcloud/files/<xx>/<id>（files.origin=user|note|system）
 │   ├─ 应用备份 /var/lib/antifieldcloud/backups（pending/acked/imports/secrets/db-predeploy-*）
 │   ├─ 世界备份 /var/lib/antifieldcloud/world-backups（world-<UTC>.tar.gz，保留 4 份）
 │   ├─ 只读状态 world-backup/world-pull/drill-status.json（脚本写入，应用只读）
 │   ├─ SLP    → 127.0.0.1:25565
 │   ├─ RCON   → 127.0.0.1:25575（只读状态 + 白名单增删）
 │   └─ 主机指标 /proc、/sys、statfs、systemctl is-active（60s 采样）
 ├─ Cloudflare Access（app.* 策略；bypass：/api/bot/webhook/*、/healthz、/s/*、/api/public/shares/*）
 ├─ antifieldcloud-world.service/.timer（root，周日 12:00，flock，4h 超时，沙箱）
 ├─ antifieldcloud-health.service/.timer（root，60s 写 /run/antifieldcloud/pi-health.json）
 ├─ lofii-bot.service（独立附属服务，仅 127.0.0.1:3010，契约 v1；不对外、不进入 Cloudflare ingress）
 ├─ opencode.service / minecraft.service / cloudflared.service（现有）
 └─ nftables（默认拒绝；22/25565 限网段，22 限速；25575 仅 loopback）
```

## 2. 进程与请求路径

- 单 Node 进程；Fastify 监听 `127.0.0.1:3000`。`main.ts` 在 listen 后启动告警评估与指标采样器，并依次 `context.alerts.start()` → `startMetrics()` → `startBots()` → `startLofii()`；Lofii 未启用时为空操作、无定时器/网络请求。关闭时 `lofii.stop()` 先于 `app.close()`，`onClose` 也会再次调用（幂等）。
- `onRequest` 先按 `Host` 分流：
  - `ai.<域名>`：校验 `af_session` 与 `Origin`，注入 `Authorization: Basic` 后交给 `http-proxy` 反代 opencode；未登录 HTML 302 到登录页，API/WS 401，Origin 非法 403 并审计。
  - `app.<域名>` 或 loopback：进入应用路由；附加上下文（不强制登录）。
  - 其它 Host：404。
- 应用路由：`/healthz` 公开（返回 `version`，生产由 `APP_VERSION` 注入）；`/api/*` 需要会话（登录/健康检查除外）；写操作额外校验 CSRF。
- 静态资源：Vite 产物 `web/dist`，由 `@fastify/static` 提供；未匹配的 HTML 路径回退 `index.html`。
- WebSocket upgrade：`server.on('upgrade')` 只接受 ai 主机 + 有效会话 + 合法 Origin，再转交 `http-proxy`。
- 指标采样：`metrics/sampler.ts` 每 `METRICS_SAMPLE_SECONDS`（默认 60）读取 HostMonitor 与配额用量写入 `metrics_samples`；维护任务按 `METRICS_RETENTION_DAYS`（默认 30）清理。
- 公开分享：`/api/public/shares/:token/*` 不挂会话，但 POST 校验 Origin、按 IP/用户限流；内容支持 Range/HEAD/ETag，多文件走 `items/:itemId/content`。

### 2.1 Bot 请求与队列路径

- 平台收敛：Bot 仅支持 QQ 官方 Bot；Telegram/Discord/Slack 适配器、`discord-gateway.ts`、按钮、媒体/多附件发布、`chatTrigger` 与 Telegram HTML/引用/线程移除。
  schema v13（迁移 13）`DELETE FROM bots WHERE platform <> 'qq'`，按外键级联删除非 QQ Bot 的目标/队列/事件/会话/记忆/角色卡；生产 Discord 数据迁移前已备份。
- 入站：`POST /api/bot/webhook/:botId` 在独立 Fastify scope 中以 raw body 解析（JSON 或 form，≤256 KiB），
  按统一 `requestMeta` 信任模型取客户端 IP（仅 loopback 对端采信 Cloudflare 头）做 120 次/分钟 IP 限流 → `BotInboundHandler` 校验 `BOT_ENABLED`/密钥/Bot 启用（否则 404）
  → 未验签请求走每 Bot 120 次/分钟桶、已验签事件走 300 次/分钟桶（验签后才扣减，分桶避免无效流量饿死合法事件）→ QQ 适配器验签
  （`op=13` 回调地址校验返回签名体；`op=0` 校验 `X-Signature-Ed25519` + 时间戳 ±300 秒）
  → `bot_events` 去重并记录诊断元数据（`received`，重复直接 200）→ `bot_inbound_targets` 记录目标/用户（不存正文）→ 按事件类型分发：
  斜杠命令仅 C2C 私聊处理：需目标 `allow_commands` + 用户白名单（自助命令 `/role` 仅私聊、`/reset`、`/forget confirm` 除外）；群聊/频道命令直接忽略并审计 `bot.command.disabled`；
  普通消息需目标 `allow_chat` 且 AI 启用（C2C 私聊直接进入，群/频道默认只有 @Bot 事件；`groupReplyMode=all` 时处理 `GROUP_MESSAGE_CREATE`，模型调用 `send_message` 才发言，未启用工具时按 @/名字或模型 `NO_REPLY` 决策）；命令/Chat 异步执行并用 QQ API 回复；
  处理结果回写 `bot_events.outcome`（ok/denied/rate_limited/ignored/error）与短码 detail；成功/忽略/重复事件统一返回 `{opcode:12}`。
- 回复管线：模型文本 → `sanitizeAiText`（去路径/URL/控制字符）→ `format.ts` QQ 纯文本（去 Markdown 标记，仅 http(s) 链接保留为文字）
  → `text.ts` 按 QQ 单条 2000 字符分段（最多 4 段、续段前缀、截断标记）→ 适配器发送；无引用/线程/HTML/按钮；
  第二段起失败时已发送 ID 挂到错误对象，队列记录 `partial_text_sent` 且不自动重试。适配器按 Bot/AppID 对实际消息请求串行并保持 **1000ms 最小间隔**。
- 图片管线（默认开启）：QQ 事件 `d.attachments` → 首个 `image/*` 附件（`content_type`/`filename`/`size`/`url`）→ `BOT_AI_VISION_ENABLED` 且适配器实现 `loadImage` 时，
  仅从域名后缀 `.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（QQ 实际图床如 `multimedia.nt.qq.com.cn`） 下载（image mime 白名单、≤`BOT_AI_IMAGE_MAX_BYTES`、内存不落盘）→ base64 → OpenCode prompt files `data:` URL 随本轮 prompt 发送；
  关闭/失败/mime 非法时降级为纯文字回答；仅图片无文字时也可进入 Chat。
- Chat：普通消息在目标 `allow_chat=1` 时进入 `chatWithAi`；C2C 私聊直接进入，群/频道仅 @Bot 事件；Chat 每 Bot×用户 30 次/分钟、AI 每小时 120 次，
  与每小时 AI 配额约束；Chat 不执行命令或写操作。
- 结构化记忆：`server/src/bot/memory.ts` 的 `BotMemoryStore` 以 `bot_memory_items`（7 类条目，唯一 `(bot,user,kind,key)`，key/value/confidence/importance/source/时间/`expires_at`）与 `bot_memory_state`（启停/legacy 标记）为权威；旧 `bot_ai_memories` 仅 legacy 来源与未迁移 fallback；
  抽取：`service.ts` 按 Bot×用户串行队列，累计 3 条或空闲 120s 触发，`ai.ts` 用一次性 OpenCode 会话输出严格 JSON ops（upsert/delete），服务端校验、敏感过滤（密钥/URL/内部路径跳过）、容量清理（默认 200）与 TTL；
  召回：核心 profile/preference/task 优先 + 关键词相关层，预算 3000 字/12 条，命中更新 `last_used_at`；`/memory off` 无抽取/注入；`/forget confirm` 清空 items/state/legacy 与会话（含远端）。
- 提示词/角色：`server/src/bot/prompts.ts` 内联模式固定生成「角色卡（私聊个人卡、群聊共享卡或 lofii）+ 固定只读安全边界 + 长期记忆 + 用户」；文档模式（`BOT_AI_CONTEXT_READ_ENABLED=true`，默认关闭）首轮发送角色卡正文，后续轮只给角色名/记忆条数/`role.md`/`memory.md` 路径，模型按需 `read`；`BotAiMode`/task 提示词与 env 覆盖不存在；私聊个人 `/role` 卡可覆盖默认角色，群聊使用管理员配置的 `bot_group_roles` 共享卡，固定安全边界不可覆盖；启用发送工具时追加一次性 `turn_id`/`turn_token` 的 `[消息发送工具]` 段，Chat 会话标题为「目标名称 Chat」、记忆会话为「目标名称 Memory」；未启用工具时全量群消息保留 `NO_REPLY` 兼容段；Chat 使用 `bot_ai_sessions.mode=chat`（列保留），共享 `bot_memory_items`；`/reset`、私聊/群聊角色变更与目标类型变更清理对应会话映射与上下文文档。
- 诊断/自检：入站事件按 `(bot_id, platform_event_id)` 写 `bot_events`（event_kind/outcome/detail/target_external_id/user_id/updated_at），
  `GET /api/bots/:id/events` 按时间窗口/outcome/分页查询元数据；`POST /api/bots/:id/check` 调 QQ 适配器换取 `access_token` 做只读自检，
  结果脱敏并刷新 `last_checked_at`；`errors.ts` 把队列 last_error（含适配器包装消息中的平台错误码）映射为 `lastErrorHint`。
- 管理 API：目标创建/更新不再有旧 `chatTrigger` 字段；`roles` 只返回私聊元数据，`group-roles` 允许管理员读写群聊卡正文；`memories` 只返回元数据并支持启停/删除，私聊角色正文与记忆正文不进入 Web/API。
- 连通性：`BotConnectivityMonitor` 每 60s 探测外网与 QQ 平台 API（只读、无凭据），不再探测代理端口；
快照 `{checkedAt,checking,internet,platforms}` 经 `GET /api/bots/connectivity` 读取、`POST /api/bots/connectivity/check` 手动复检；外网恢复时触发队列扫描。
Bot 出站为 Pi 直连；PC 无代理隧道脚本/计划任务，生产 env 不包含 `HTTPS_PROXY`/`HTTP_PROXY`/`NODE_USE_ENV_PROXY`/`NO_PROXY`。
- 告警通知：`AlertService` 事件落库后调用 `BotService.notifyAlert`，按启用 Bot × `allow_notifications` 目标写 `bot_deliveries`
  （`dedupe_key=alert:<event>:<bot>:<target>`）；目标有静默时段且当前命中时，`next_attempt_at` 设为窗口结束；通知失败只记日志，不影响告警状态机。
- 队列：`startBots()` 在 listen 后按 `BOT_DELIVERY_INTERVAL_SECONDS`（30s）`tick`：恢复 >10 分钟卡在 `sending` 的记录 →
  处理 `queued/failed` 投递（每次 ≤20，`next_attempt_at` 未到期的跳过）→ 处理到期的 `bot_publish_jobs`（每次 ≤10）→ 清理过期事件/入站目标/已发送记录/AI 会话与记忆。
  失败按 `30s × 2^n`（≤1h）退避，达到 `BOT_DELIVERY_MAX_ATTEMPTS`（5）标记死信；进程退出时 `stop()` 停表。
- 发布（仅文本）：`POST /api/bots/:id/publish` 先做管理员 TOTP 再认证、`confirmText='PUBLISH'` 校验与 20 次/小时限流，再写 `bot_publish_jobs`（`draft→queued`）；
  队列发送纯文本（≤2000，超长分段；不支持媒体）；长文本 partial 失败标记 `failed`/`partial_text_sent` 且不自动重试；支持 `DELETE` 取消 `draft/queued`。
- 指标：`GET /api/bots/:id/metrics?hours=24` 聚合 `bot_deliveries`/`bot_publish_jobs`/`bot_events` 的窗口统计（含 `lastErrorHint`），供 `/bots` 指标卡使用；不返回 AppSecret。
- AI：仅普通消息 Chat 在 `BOT_AI_ENABLED=true` 时调用 `OpenCodeBotAi`；私聊按 `(bot,target,user,mode)` 复用 `bot_ai_sessions.session_id`，群聊按 `(bot,target,__group__,mode)` 复用唯一共享会话（模型可见群内多用户历史），群内 Chat 按目标串行；新建会话传 deny-all Permission.Ruleset；v0.7.3 文档模式（默认关闭）把角色卡/记忆写入作用域哈希目录的 `role.md`/`memory.md`，仅放行当前作用域 `external_directory` 与精确 `read`，首轮发角色卡、后续轮只给路径/条数；
  只读取 assistant text，按 `BOT_AI_MAX_REPLY_CHARS` 截断后交给回复管线；图片以 prompt files data URL 交给模型 provider；超时/HTTP 错误只返回短码，不泄漏 OpenCode 密码/URL。
- 配置/密钥：Bot 配置只存公开字段（QQ `appId`）；AppSecret 经 `crypto.ts` AES-256-GCM 加密后存 `bots` 三个密文字段；任何读取都只在服务端短生命周期解密。

### 2.2 Lofii 请求与轮询路径（v0.8.0 引入，v0.8.1 安全加固；默认关闭）

- 组件：`server/src/lofii/client.ts`（HTTP 客户端）、`server/src/lofii/service.ts`（轮询/缓存/游标/告警映射/控制代理）、`server/src/http/routes/lofii.ts`（HTTP 路由）；`app.ts` 构造 `LofiiService` 并挂到 `AppContext.lofii`，`main.ts` 在 listen 后 `startLofii()`、退出时 `lofii.stop()`（`onClose` 同样 stop，幂等）。
- 上游：独立附属服务 lofii-bot v0.6.1（最低兼容 v0.6.0），仅 `127.0.0.1:3010`，契约 `contractVersion=1`；v0.6.1 的 `splitOutgoing` 逐行把行首 `/` 中和为全角 `／`（防御纵深）；应用是纯 HTTP 客户端，不消费 SSE、不访问其 RCON/OpenCode/记忆数据。
- 轮询：`setInterval(LOFII_POLL_MS 默认 5000)` + 启动立即一轮；单飞 `inFlight` Promise，上一轮未结束复用同一 Promise（不并发/不堆积）；每轮 `Promise.allSettled([GET /status, GET /events/recent?limit=200])`（覆盖一次突发）。成功后更新 `statusSnapshot/version/contractVersion/lastPollAt/lastSuccessAt/failedPolls`；失败只更新 `reachable/stale/error` 并保留旧快照。`stale`：未连通且（从未成功时连续 3 轮失败，或距上次成功 > 3×轮询间隔）。`reachable=true` 但 `/events/recent` 或游标失败时 `error≠null`，前端必须展示可见警告。
- 客户端安全/边界：读 Token 用于 `/status`、`/events/recent`、`/history`；控制 Token 用于 `/task/*`、`/move`、`/say`；`LOFII_URL` 启动校验 loopback + http(s) 且仅根地址（拒绝 userinfo/路径/查询/片段）；`redirect:'error'`、`AbortSignal.timeout(LOFII_TIMEOUT_MS 默认 2500)`、响应体**流式** ≤2 MiB（`readCappedBody` 边读边计数，Content-Length 超限直接拒绝）；错误统一 `LofiiError(code/statusCode/upstreamCode)`，message 大小写不敏感地移除上游 URL 与两枚 Token；上游 4xx 稳定码归一化为 `lofii_<code>`，401/403 → `lofii_auth_failed`，5xx 的 `task_disabled`/`control_disabled`/`history_disabled` 保留稳定码，其它 5xx/非 JSON → `lofii_upstream_error`，网络/超时/重定向 → `lofii_unavailable`；`/history` 校验 `kind` 与数组形状并只透传对象行。
- 事件缓存：合并 `/events/recent` 与现有缓存，按 `id` 去重、按时间 newest-first、最多 `LOFII_EVENT_CACHE_LIMIT=100` 条且序列化总字节 ≤`LOFII_EVENT_CACHE_MAX_BYTES=512 KiB`；只存内存，不落库/不写日志（聊天事件正文也只存在这里）。
- 告警游标：`meta.lofii.event_cursor={bootId,lastEventId,lastTs}`；每轮 `advanceCursor`：`eventsSupported=false` 直接返回；首次/无游标/`bootId` 变化 → 只写基线、返回 0（不重放 ring 旧告警）；否则 `eventsAfterCursor`（优先按 ring 位置，窗口外按 `<bootId>-<seq>` 序号或时间比较，无法判断宁可不重复）过滤 `type='alert'` 的事件 → `mapLofiiAlert`（own-property 已知 5 类映射 event/severity/title，未知 → `lofii_alert`，`severity==='error'` → critical）→ `AlertService.recordExternal`；`LOFII_ALERTS_ENABLED=false` 仍推进游标不写告警；**告警写入失败时游标停在上一条已完整处理事件并返回，下一轮重试失败事件**（v0.8.1，避免静默丢告警）；游标写库失败只 warn 并置本轮 `error=lofii_cursor_failed`，不回滚缓存。
- 告警落库：`AlertService.recordExternal(status='event')` 写 `alert_events`（event 截断 64、title 200、message 1000、details 清洗），不写 `alert_state`；`void deliverExternal(event)` 异步复用 webhook 与 Bot 通知，失败只记脱敏日志；`ALERTS_ENABLED=false` 时不写库/不投递。
- 控制代理：`/tasks`、`/tasks/stop`、`/tasks/resume`、`/move`、`/say` 均使用控制 Token（v0.8.1 起 `/say` 必须控制 Token，只读模式 503），成功后 `refresh()`（若已有在途轮询先等待再拉一轮）返回上游 `{ok:true,...}`；控制 Token 为空时客户端直接抛 `lofii_control_disabled`（不发请求）。
- HTTP 路由：全部 `requireAuth`；写操作加 `csrfGuard`；控制 limiter 20/min/IP、say limiter 10/min/IP；任务名/移动动作/`taskId`（trim、无内部空白/控制字符）/消息长度由服务端白名单校验；`/say` **拒绝任意 ASCII `/` 与 C0 控制字符/DEL**（防上游按 240 字符切行后的命令注入）；审计记动作与元数据（say 只记 chars）；`GET /api/lofii/status` 返回聚合快照（禁用时 `enabled:false` 空壳），`GET /api/lofii/history` 校验形状后透传只读对象行。
- 前端：`/minecraft` 由 `meta.lofiiEnabled` 决定是否显示 Lofii 标签；`LofiiPanel` 每 5s 轮询 `/api/lofii/status`（页面隐藏时暂停，请求序号 + AbortController 防旧响应覆盖），状态经 `safeLofiiStatus` 归一化、缺失段显示“—”；写操作走 `/api/lofii/*` 并在成功后刷新；浏览器不接触 Token/上游地址。

## 3. 模块

| 模块 | 职责 |
|---|---|
| `server/src/config.ts` | 读取 env 文件/环境变量、数值与安全组合校验 |
| `server/src/db.ts` | SQLite 打开、PRAGMA、版本化迁移（schema **v17**，本版无迁移）、事务；迁移 13 删除非 QQ Bot 及级联数据；迁移 14 结构化记忆两表；迁移 16 群聊角色卡；迁移 17 `audit_write_failures`（均不可逆） |
| `auth/` | scrypt、TOTP、恢复码、挑战、会话、CSRF、限流、审计（字段截断 + 失败诊断 `getAuditDiagnostics`） |
| `files/` | 目录树、上传落库、配额、搜索、回收站、文本预览、MIME 安全分类、`origin` 可见性、物理孤儿回收 |
| `uploads/` | 分片上传会话/块索引、配额预留、断点状态、原子拼接、过期/终态清理 |
| `mc/` | SLP 查询、RCON 客户端、状态/metrics、白名单增删与复核 |
| `opencode/` | ai 主机认证反代；HTTP/WS Origin 校验（loopback 例外要求 Host 也是 loopback）；AI 主机未认证限流与审计去重；HTML 模式 shim/attributes/passthrough |
| `backups/` | 归档导入/校验、full+inc 链解析、文件级恢复计划与执行、`skippedMissing`、加密归档 Web 409 边界、陈旧恢复锁清理、世界/拉取/演练/异地状态只读 |
| `dashboard/` | 主机指标、服务状态、opencode 健康、备份/加密/世界/演练/异地状态、活动聚合、`/api/storage` 轻量用量 |
| `metrics/` | 采样器（60s）、范围聚合查询（1h/6h/24h/7d/30d，最多 240 点）、保留期清理 |
| `notes/` | 笔记/书签、标签、置顶、FTS5 搜索；附件（`origin=note`）与版本历史 |
| `shares/` | 单文件/多文件分享 token/密码/过期/原子次数/吊销、公开元数据与逐项内容 |
| `bot/` | QQ 官方 Bot 适配器、Chat AI、结构化长期记忆（群 scope key 用稳定 `member_openid`）、私聊角色卡、群聊目标共享角色卡、上下文文档（`context.ts`：作用域哈希、原子写、清理/sweep）、群消息模式过滤与 `GROUP_MESSAGE_CREATE`、出站连通性、AES-256-GCM 凭据、Webhook 验签/去重、命令（仅 C2C；含自助 `/reset`/`/forget confirm`）、回复管线、QQ 入站图片下载、连接自检、事件诊断、角色/记忆元数据管理、指标/静默、告警通知与文本发布队列/重试。行为保持拆分：`inbound.ts`（入站验签/限流/命令与 Chat 分发）、`diagnostics.ts`（事件/入站目标/指标/最近错误）、`queue.ts`（投递/发布状态机），`service.ts` 保留 facade/依赖装配 |
| `lofii/` | v0.8.0 引入、v0.8.1 加固的 Lofii Minecraft Bot 对接（仅 loopback）：`client.ts`（读/控制 Token、redirect:error、超时、流式 2 MiB 上限、稳定错误映射、大小写不敏感 URL/Token 脱敏）、`service.ts`（单飞轮询 status/recent?limit=200、快照与 100 条且 ≤512 KiB 事件内存缓存、stale、告警游标 `meta.lofii.event_cursor`、alert→`status='event'` 映射、告警写失败停游标重试、控制代理成功后刷新）；不持久化聊天/事件，不改 schema |
| `alerts/` | 阈值评估、状态去重/恢复、通用 webhook；世界备份/拉取/演练超期与异地副本超期；`recordExternal`（Lofii 等外部事件 `status='event'`，不写 `alert_state`，异步 webhook/Bot 通知）；Bot 通知入队 |
| `http/` | 路由、守卫、错误处理、安全头、Host 分流、静态资源、`requestMeta` 统一信任模型；`bots.ts` 管理 API、`bot-webhook.ts` 公开入口、`lofii.ts` Lofii 只读/控制路由 |
| `cli/` | provisioning、两阶段备份 CLI（prepare/pending/ack/snapshot-db）、backup-encryption.ts（age 加密/公钥校验/sidecar/孤儿正则） |
| `util/` | 时间/路径/响应/错误；`status.ts` 只读状态文件解析 |
| `web/` | React SPA（登录、Dashboard、文件、回收站、知识库、分享、MC + Lofii 面板、活动、设置、公开分享页、PWA） |

脚本与部署侧：`scripts/backup-world.mjs`（root 世界一致性备份）、`scripts/world-pull.ps1`（Windows 周度拉取/ack）、
`scripts/drill.ps1` + `scripts/drill-verify.mjs`（恢复演练）、`scripts/check-version.mjs`（版本一致性）；
`deploy/` 提供应用/健康探针/世界备份 systemd unit、nftables 与 env 模板。

## 4. 数据模型

SQLite（WAL）核心表（schema v17）：

- `users`：单管理员；scrypt 哈希 + salt；TOTP secret；`totp_last_step` 防重放；恢复码哈希 JSON。
- `auth_challenges`：密码通过后的 5 分钟一次性挑战（只存 token 哈希）。
- `sessions`：会话 token 哈希、CSRF 哈希、7 天过期、IP/UA、last_seen。
- `files`：`id / parent_id / name / kind(file|dir) / size / mime / sha256 / storage_key / created_at / updated_at / deleted_at / deleted_parent_id / origin`；`origin ∈ user|note|system`，唯一索引为 `(COALESCE(parent_id,''), name COLLATE NOCASE, origin) WHERE deleted_at IS NULL`；`files(id)` 自引用。
- `audit_log`：动作、目标、IP；保留 90 天；写入时 actor≤64、target≤256、detail≤4 KiB。
- `login_attempts`：登录成功/失败记录。
- `backup_state`：最近一次 PC 已确认的备份时间/归档/哈希/大小。
- `backup_archives`：pending/acked/imported 归档；`origin` 区分 `pi`/`import`，含 `verified_at/manifest_json/last_error`；`meta.backup_missing_files` 记录待补入的缺失文件 id。
- `restore_plans`：文件级恢复计划（归档链、选择、目标名、状态、操作者、过期）。
- `upload_sessions` / `upload_chunks`：分片会话（大小/块数/已收/状态/过期/操作者）与块索引；临时块只在 `tmp/chunks/<uploadId>/`。
- `notes`、`bookmarks`、`tags`、`note_tags`、`bookmark_tags`、`notes_fts`、`bookmarks_fts`。
- `note_attachments`：笔记 ↔ 附件文件（`file_id` 指向 `files` 且 `origin='note'`）；删除笔记/附件硬删文件并释放配额。
- `note_versions`：标题/正文/标签快照 + 操作者 + 时间；每笔记保留最近 `NOTE_VERSIONS_KEEP`（20）。
- `shares`、`share_items`、`share_sessions`：分享 token 哈希、密码、过期/次数；`share_items` 保存多文件条目（旧行为回退到 `shares.file_id`）；解锁会话。
- `alert_events`、`alert_state`：告警历史/去重冷却；`alert_events` 保留 90 天。
- `metrics_samples`：60s 主机指标样本（`ts/ts_epoch/cpu/mem/temp/disk/load`），按 `ts_epoch` 索引，30 天保留。
- `bots`：平台/名称/启用/公开配置 + `secret_ciphertext/secret_iv/secret_tag/key_version`（AES-256-GCM）；`last_error/last_checked_at`。
  当前 schema v17；`bots` 仅 QQ Bot，`bot_memory_items`/`bot_memory_state` 为结构化记忆权威，`bot_group_roles` 保存群聊共享角色卡，`audit_write_failures` 保存审计失败诊断。
- `bot_targets`：每 Bot 的频道/用户/群组目标，`(bot_id, external_id)` 唯一；`allow_commands` 默认 0、`allow_notifications` 默认 1、`allow_chat` 默认 0；
  `quiet_start_minute`/`quiet_end_minute`（0–1439，可空）。`chat_trigger` 列保留但 API/逻辑不读写。
- `bot_deliveries`：通知/回复/发布/测试投递队列，状态 `queued|sending|sent|failed|dead`；`dedupe_key` 唯一（通知按告警事件去重）；`next_attempt_at` 承载静默延后。
- `bot_publish_jobs`：发布任务（纯文本 + `scheduled_at`；`media_file_ids_json` 列保留但写空、不再外发媒体），状态 `draft|queued|sending|sent|failed|canceled`。
- `bot_events`：`(bot_id, platform_event_id)` 主键，用于 Webhook 重放去重；诊断列 `event_kind/outcome/detail/target_external_id/user_id/updated_at` 与 `(bot_id, outcome, received_at)` 索引；
  只存事件元数据（不存正文），按 `received_at` 保留 7 天。
- `bot_ai_sessions`：`(bot_id, target_external_id, user_id, mode)` 主键（mode=chat/task；只写 `chat`，列保留），映射 OpenCode `session_id`、模型标签与更新时间；群聊目标固定用合成 `user_id=__group__`，同一群只有一条 Chat 映射（旧分用户映射在首次群 Chat 时清理并尽力删除远端会话）；私聊仍用真实 user_id；按保留期清理，不删除远端会话。
- `bot_chat_roles`：`(bot_id,user_id)` 主键，保存私聊个人角色卡名字/设定/启用状态与时间戳；仅私聊 Chat 读取，启用时覆盖默认 lofii；角色变更删除对应 chat 会话映射；
- `bot_group_roles`：`target_id` 主键 FK 到 `bot_targets`（级联），保存群聊目标共享角色卡名字/设定/启用状态与时间戳；群聊 Chat 读取，覆盖成员私聊个人卡；停用/删除回退默认 lofii；
  正文不通过 API/UI 暴露（管理接口只返回元数据）。
- `bot_ai_memories`：legacy 滚动摘要（`(bot_id,user_id)` 主键、`memory_id` 唯一、`summary`、`summary_session_id`、时间戳；仅作迁移来源/fallback）；镜像 `DATA_DIR/bot-memory/memory-<uuid>.md`（0700/0600）。
- `bot_memory_items`：`id` 主键、`(bot_id,user_id,kind,mem_key)` 唯一、value/confidence/importance/source/created_at/updated_at/last_used_at/expires_at；`bot_memory_state`：`(bot_id,user_id)` 主键、`memory_enabled`、`legacy_migrated_at`；不通过 API/UI 暴露 key/value，按 TTL/容量清理。
  不通过 API/UI 暴露正文，按 AI 会话保留期清理；`/forget confirm` 与管理删除会同时清 DB 行与镜像。
- `bot_inbound_targets`：`(bot_id, target_external_id, user_id)` 主键，记录最近入站目标/用户/类型/`is_direct`/`last_seen_at`；不存消息正文，每 Bot 最多 500 条、按事件保留期清理。
- v0.7.3 上下文文档不在 SQLite：`BotContextStore` 在 `BOT_CONTEXT_DIR` 下按哈希作用域写 `role.md`/`memory.md`（派生数据，不进入备份；`/reset`/`/forget`/删除清理，维护任务回收超期孤儿）；OpenCode 仅按会话 permissions 读取当前作用域两份文档。
- v0.8.0 Lofii 对接不新增表/列（schema 保持 v17）：告警游标只写入既有 `meta` 表的 `lofii.event_cursor` 键（JSON `{bootId,lastEventId,lastTs}`）；Lofii 事件/聊天缓存只在服务端内存，不落库；Lofii 告警事件复用 `alert_events`（`status='event'`），不写 `alert_state`。

世界备份/拉取/演练状态不在 SQLite：由 root/PC 脚本写 `/var/lib/antifieldcloud/{world-backup,world-pull,drill}-status.json`（0644，应用只读解析）。

关键约束：
- 文件内容是**不可变**的：上传后不再改写；重命名/移动只更新元数据。增量备份因此只需新增文件。
- 配额 = 所有 `kind='file'` 的 `size` 之和（含回收站与笔记附件），上限 10 GiB；上传先在 `tmp/` 写完并校验，再原子 rename。
- 同一父目录下同一 `origin` 名称唯一（大小写不敏感），冲突自动追加 ` (n)`；笔记附件与普通文件可同名。
- 删除目录递归软删除；恢复时若原父目录不在则回到根目录；`origin='note'` 行不进入回收站/用户目录树。

## 5. 认证流程

1. `POST /api/auth/password`：限流 → scrypt 校验 → 生成 5 分钟挑战（DB 存哈希）→ 返回 challenge；用户名超过 64 字符直接 400。
2. `POST /api/auth/totp`：校验 TOTP（±1 步，且 step > 上次使用）或恢复码 → 创建会话与 CSRF token → 在 app 主机设 Cookie。
3. 会话 Cookie：app 主机 host-only `af_session`（HttpOnly）+ `af_csrf`（可读），HTTPS 下 `Secure; SameSite=Lax`，不设 `Domain`；loopback HTTP 例外。AI 主机通过 app 签发的 60s 一次性 ticket（`GET /api/auth/ai-ticket` → `GET /__af/sso/<ticket>`）获得自己的 host-only `af_session`，不共享父域 Cookie；登录/退出响应会清理旧父域 Cookie。
4. 写操作：`X-CSRF-Token` 与 DB 内 CSRF 哈希比对；若带 Origin，还必须在 app/loopback 白名单（ai 源不再作为 app 写请求受信 Origin）。
5. 改密/重置 TOTP 使其它会话失效；恢复码一次性；再认证要求“当前密码 + TOTP”。
6. 限流：每 IP 5 次失败/15 分钟、全局 60 次/小时（loopback 不占全局桶）、TOTP 全局 120 次/小时；再认证独立限流并恒定延迟。
7. 信任模型：`trustProxy:false`；仅 socket 为 loopback 时采信 `CF-Connecting-IP`/`X-Forwarded-Proto`，
   Host 只取原始 Host；`X-Forwarded-Host` 不参与安全判断。
8. 审计：所有登录/关键操作写 `audit_log`，字段截断；不记录密码/TOTP/Cookie/Authorization。

## 6. 云盘数据流

- 上传：小于 100 MiB 走浏览器 XHR（进度）→ multipart → 逐文件流式写入 `tmp/`，同时计算 SHA-256、累计大小、检查配额 → 物理文件先原子落盘 → 事务内再次校验配额并插入行；DB 失败回滚物理文件（避免不可见占用）。
- 大文件：浏览器按 8 MiB `PUT /api/uploads/:id/chunks/:idx`（可乱序/重试）→ 服务端写 `tmp/chunks` 并记录块哈希 → `complete` 顺序拼接、校验 SHA 后调用同一 `FileService.registerUpload` 原子落库；24h 会话过期/取消清理临时块并释放预留。
- 列表/搜索/面包屑/回收站：只查询 `origin='user'`；搜索 `LIKE ... ESCAPE` 限 100 条。
- 预览：图片/PDF/白名单音视频通过 `/content?inline=1`（支持 Range、ETag；不转码）；文本/Markdown 通过 `/text` 返回 JSON（≤1 MiB）；SVG/HTML/XML 强制附件；mkv/avi 等回退下载。
- 笔记附件：`registerUpload(origin='note', parentId=null)` 计入配额但父目录为空；仅笔记接口列出/删除，内容经同一鉴权内容路由访问；维护任务清理无关联孤儿附件。
- 回收站：递归软删除；列表只显示顶层项；恢复递归；彻底删除删除物理文件并释放配额。

## 7. Minecraft

- 状态：SLP（协议 775）拿版本/MOTD/在线数/样例玩家；RCON `list`/`tps`/`whitelist list` 补齐在线名/TPS/白名单数。
- 白名单：校验 `^[A-Za-z0-9_]{3,16}$` → 执行 `whitelist add|remove` → 重新查询确认 → 审计；不提供任意命令/启停。
- 降级：SLP 失败显示离线；RCON 失败时 TPS/白名单为 null，并在 `error` 字段说明；不影响文件功能。
- 世界备份：`scripts/backup-world.mjs` 以 root 由 `antifieldcloud-world.timer` 调用，只通过 RCON 执行固定
  `save-off` / `save-all flush` / `save-on`（`save-on` 在 finally 重试），应用 API 不提供该能力。
- 反向代理：只允许固定上游 `http://127.0.0.1:4096`；注入 Basic，移除客户端 Cookie/Authorization；校验 Origin。

## 8. 备份与灾备

- **应用归档**：CLI 用 `node:sqlite` 的 `backup()` 生成一致性 DB 快照；从快照读 `backup_state` 与文件列表。
  全量=所有文件；增量=`created_at > 上次成功备份` 的文件 + DB 快照 + manifest；manifest 增 `skippedMissing/warnings`。
  归档先写 `.part`，tar 成功后原子改名；SHA-256 旁文件；pending 未确认不删除，`--ack` 事务推进游标。
- **PC 拉取**：Windows 计划任务每日 `--pending` → 无 pending 才 `--prepare` → `.part` 下载 → SHA-256 校验 →
  原子改名 → 写旁文件 → `--ack` → 删除 Pi 归档；失败保留 pending 重试同一归档；状态 JSON 在重试循环外一次写入。
  保留：Pi pending 直到确认、已确认 2 个；PC daily 30 天、weekly 56 天、secrets 90 天。
- **整包加密**：`cli/backup-encryption.ts` 只读独立 age 公钥（root、组/其他不可写、格式/大小校验），
  `--prepare` 流程 tar → `*.plain.tmp` → 计算 plain sha/size → `age -r` 加密到 `*.part.age` → rename `.age` → 写外部 sidecar
  `<name>.meta.json`（schema 2）→ 写 DB `manifest_json`（含 `encrypted/plainSha256/plainSize/cipherSha256/cipherSize/recipient`）→ 删除明文。
  归档内 manifest `schema:2` 不含明文哈希（避免自引用）；失败关闭（age/公钥/加密/空间失败即 prepare 失败，不降级明文）；
  空间按 2× 明文预算；崩溃只允许可清理 `*.plain.tmp`/`.part` 或“有密文无 DB 行”孤儿（只报告不自动删）。
  应用不持私钥：`backups/service.ts` 对 `.age` 的 verify/import/entries/restore-plan/execute 返回 409 `archive_encrypted`，
  恢复目标自动跳过加密归档；状态/UI 只展示加密开关、公钥是否就绪与密文计数。
- **异地副本**：PC 端 `backup-offsite.mjs` 规划“最新 full + 其后全部 inc + 最近 N 天”链，
  只上传 `.age`（明文拒绝并计 `plaintextSkipped`），`rclone copyto --checksum` + 远端大小校验，链感知删除且绝不删最新 full；
  `backup-offsite.ps1` 硬超时调用并把状态 JSON 写回 Pi `/var/lib/antifieldcloud/backup-offsite-status.json`；
  应用 `util/status.ts` 只读解析（64 KiB 上限），Dashboard 展示、`AlertService.offsiteCondition` 在状态缺失/未配置时返回 null（不误报）。
- **密钥包**：age 加密 env/cloudflared/Minecraft/opencode 配置与 opencode DB 一致性快照；明文只在 tmpfs 0700 临时目录；
  opencode 快照失败硬失败（不生成半成品）；`--include-host-config` 可选打包主机配置；Pi `KEEP=2`，PC 拉取后不立即删除远端。
- **世界备份**：root 脚本读取 env/server.properties 的 RCON 与路径；预检世界目录/备份目录/磁盘余量（1.5× 世界体积）；
  `save-off → save-all flush（超时重试）→ tar -czf .part → gzip 完整性校验 → SHA-256 → 原子改名`；`save-on` 必执行；
  保留最新 4 份且只删匹配命名的文件；写 `world-backup-status.json`（0644）。
- **世界拉取**：`world-pull.ps1` 查询远端归档与状态 → scp 到 `.part` → 与远端 `.sha256` 比对 → 原子改名 → 删远端归档/旁文件（ack）
  → 本地保留 4 份；失败不 ack；所有 ssh/scp 有硬超时并杀进程树；写 `world-pull-status.json`。
- **恢复演练**：`drill.ps1` 定位最新 full 与其后全部 inc，校验旁文件 SHA、tar 条目类型/路径、manifest 与最新 DB
  （`PRAGMA integrity_check`/`foreign_key_check`/`meta.schema_version`），输出 `report.json/report.md`（保留 180 天）；
  可选 `-IncludeWorld`（先查临时盘 ≥3× 归档空间再解包验证 `world/level.dat`）并回写 `drill-status.json`。
- **Web 恢复**：只做归档导入/校验/文件级恢复到新目录（TOTP + typed confirmation）；恢复链按来源隔离；
  归档内 `origin!='user'` 的文件不进入用户目录；`skippedMissing` 文件从选择中剔除并报告；解包/落盘按选择字节 ×2 预检空间，
  staging 上限 2 GiB 且不超过可用空间 20%；归档内容浏览按 IP 限流（30 次/分钟）；整库恢复走离线 root 手工流程（停服 + pre-restore 快照 + 回滚，见 `docs/BACKUP.md` §8.1）。
- **旧世界 cron**：验收后已从 `crontab` 移除 `minecraft-backups` 行；旧归档不自动删除，按 `docs/BACKUP.md`/`docs/DEPLOY.md` 手动清理。

## 9. 部署与运行

- `/opt/antifieldcloud/releases/<UTC>` + `current` 符号链接；systemd `antifieldcloud`（只读系统、仅数据目录可写、MemoryMax 512M、空 capability、设备/时钟/主机名/内核日志收紧）。
- 前端在 PC 构建；Pi 只安装生产依赖（`npm ci --omit=dev --ignore-scripts`）。
- 部署脚本：构建 → 打包 → 上传并校验 tar SHA-256 → 解包/npm ci → 迁移前 DB 快照 → 注入 `APP_VERSION` → 切换 current/重启
  → `/healthz` 断言版本；失败先停服、还原迁移前 DB 快照、切回 previous、启动、复检（无快照则拒绝自动回滚）。
- nftables 默认拒绝入站；22 仅直连/校园网段（新建连接限速 20/min），25565 仅同网段，25575 仅 loopback，DHCP 仅 eth0/wlan0；
  出站不限制。改动前确认当前 SSH 来源在允许网段内。SSH 为仅公钥（`00-` drop-in），旧回滚备份归档在 `/var/backups/antifieldcloud/`。
- Bot 部署：`bootstrap-env.sh` 生成/复用 `BOT_SECRET_KEY` 并纳管 `BOT_AI_*`、Chat/记忆键、连通性键、回答/图片键、`BOT_MEMORY_*`；
  `BOT_AI_VISION_ENABLED` 默认 true；`BOT_ENABLED` 默认 false。当前 schema v17；回滚需迁移前 DB 快照；QQ 入站图片需 OpenCode prompt files + 支持 image 的模型；平台仅 QQ 官方 Bot，无 Gateway/平台前置配置。
  Cloudflare Access 需对 Bot Webhook/health/公开分享路径 bypass（边缘配置，不在仓库内）；`smoke.ps1` 可选用 Access service token。
- Lofii 部署（v0.8.0 引入，v0.8.1 安全加固；默认关闭）：lofii-bot v0.6.1（最低 v0.6.0，契约 v1）作为独立服务仅监听 `127.0.0.1:3010`（不经 Cloudflare/nftables 对外）；应用 env 由 `bootstrap-env.sh` 纳管 `LOFII_*`，Token 由 root 执行 `scripts/sync-lofii-tokens.sh` 从 `/etc/lofii-bot/env` 同步（`--check` 只比较；同目录临时文件 + `mv` 原子替换）；启用顺序为 lofii-bot 就绪 → 同步 Token → `LOFII_ENABLED=true` → 重启应用；回滚设 false + 重启，无 schema/DB 变更；`smoke.ps1 -ExpectedLofiiVersion 0.6.1`（最低 0.6.0）/`-SkipLofii` 覆盖只读检查。**v0.8.1 已于 2026-10-27 部署生产并完成验收**（release `20261027T113055Z`/commit `5405a8d`，lofii-bot v0.6.1 release `20261027T111640Z`/commit `a0a28da`，Token `--check` match）；v0.8.0 保留为回滚点。
- fail2ban：dbfile 持久化封禁；`deploy/systemd/nftables.service.d/10-fail2ban-restore.conf` 在 nftables 启动后以 `systemd-run --collect --on-active=3` 异步重启 fail2ban，从数据库恢复 set；手工 `systemctl reload nftables` 不触发 `ExecStartPost`，仍需 `systemctl restart fail2ban`。
- 世界备份/健康探针 timer 由 root 运行；世界备份 unit 只读整机、仅 `/var/lib/antifieldcloud` 可写、flock 串行、4h 超时。

## 10. 信任边界与失败隔离

- Cloudflare 终止 TLS，Cloudflare 可见明文；TOTP 是应用层第二道门。
- opencode 自身 Basic 密码由服务端注入，不下发前端；opencode 端口不对外；HTTP/WS Origin 校验防跨站借用 Cookie。
- Minecraft RCON 已轮换强密码但仍监听所有接口，仅 nftables 限制为 loopback；世界备份脚本是唯一可发固定保存命令的组件，以 root 运行且沙箱化。
- 文件预览按类型白名单；HTML/SVG 不内联；音视频只播放白名单容器；文本预览由 React 转义。
- 笔记附件与普通文件用 `origin` 隔离；分享只接受活动普通文件，跨分享 itemId 一律 404。
- Bot 是外部平台的信任边界：Webhook 只凭 QQ Ed25519 签名/时间戳（含 op=13 回调校验），命令必须目标+用户双白名单，发布必须管理员 TOTP + `PUBLISH`；
  AppSecret 只以密文落库，出站只允许固定 QQ 平台 API，输出文本清洗路径/URL；Bot 关闭时入口 404，不向调用方泄露 Bot 是否存在。
- Chat 与命令权限分离：`allow_chat` 只授权普通消息 AI 对话，不授予斜杠命令；群聊/频道不执行任何斜杠命令，非管理员只能 Chat；QQ C2C 私聊直接进入；群/频道默认只有 @Bot 事件进入，群目标设为 `all` 且平台开启全量消息后进入 `GROUP_MESSAGE_CREATE`（仅 @/名字模式过滤，模型未调用 `send_message` 即静默）；
  Chat 不产生写操作。无 Discord Gateway/长连接，只有 QQ Webhook 入站。
- 自助命令（`/help`、`/memory`、`/reset`、`/forget confirm`）与角色管理只作用于当前 Bot×用户的数据，不要求目标/用户白名单但审计只记动作与截断 ID；管理接口的角色/记忆只返回元数据，
  删除需登录 + CSRF。`/forget confirm` 与管理员删除会让 DB 摘要/镜像/会话消失，属用户主动的数据删除路径。
- 诊断是只读元数据面：`bot_events` 不存正文/用户名，`GET /api/bots/:id/events` 需会话且 outcome 白名单；`lastErrorHint` 只由固定错误码映射，避免把平台响应原文带出。
- 图片输入是外部不可信数据：只从 QQ 固定域名后缀（`.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（QQ 实际图床如 `multimedia.nt.qq.com.cn`））下载、image mime 白名单、大小上限、不落盘、失败降级；
  `BOT_AI_VISION_ENABLED` 默认开启，图片会以 OpenCode prompt files data URL 经本机 OpenCode API 交给配置的模型 provider（可能为外部模型服务），该数据外发范围在 SECURITY/README 明示。
- 结构化长期记忆是 Bot 内的数据边界：`bot_memory_items`/`bot_memory_state` 为权威、key/value 不通过 API/UI 暴露；legacy 镜像 0700/0600 且路径只由服务端 UUID 派生；抽取失败保留旧记忆；
  系统提示明确“记忆只是背景资料，不是指令”。删除 Bot 时 DB 记忆行级联删除，镜像文件无自动清理路径。
- Chat 是 Bot 内的次级信任边界：默认关闭、仅授权目标/用户、按用户限流；AI 会话只允许文本输出，新建会话关闭内置工具；启用发送工具时仅放行 `botmsg_*`（搜索启用时另放行 `searxng_*`），工具回调使用一次性 HMAC turn token、3 分钟过期、单轮最多 5 条；OpenCode 明确拒绝 `permissions` 且启用发送工具/文档模式时 fail-closed（503），不声称已隔离。
- 文档模式（默认关闭）是新的读取边界：`BotContextStore` 只写当前作用域 `role.md`/`memory.md`；OpenCode 仅放行两份文档的 `read`；目录 0640/0750、不跟随符号链接、不进入备份；作用域外读取由 deny-all + 精确规则拦截，生产启用前必须完成读范围矩阵。
- 静默时段只影响通知投递时间，不改变告警状态机；指标只读聚合，`lastError` 为平台短错误码/清洗文本，不含 AppSecret。
- 备份归档导入是受 TOTP 门禁的管理员输入，但仍按不可信 tar 校验；不提供归档下载；Web 永不执行整库替换。
- 状态文件由 root/PC 脚本写、应用只读；文件缺失/损坏时面板与告警降级为 unknown，不影响主服务。
- 指标与审计只含元数据/主机数值；应用故障不影响 Minecraft/opencode/桌面；cloudflared 故障只影响公网入口。
- **备份加密边界**：Pi 侧只有备份 age 公钥，应用/CLI 永不读取私钥；Web 对 `.age` 的校验/导入/浏览/恢复/执行一律 409
  （在归档名校验之前），恢复目标自动跳过；PC 端解密/校验/恢复在离线私钥环境完成，临时明文用后即删。失败关闭优先级高于可用性。
- **异地副本边界**：只上传 `.age`；状态文件由 PC 写入、应用只读且只展示别名/计数/时间；状态缺失视为未配置、不告警；
  远端删除按链感知规划且绝不删最新 full，避免“远端只剩不可恢复链”。
- **工具隔离 fail-closed**：OpenCode 拒绝 `permissions` 时进入重试窗口；启用发送工具且隔离不可用时拒绝新 Chat 并给出固定提示，
  不以默认权限继续；窗口到点放行重试，上游恢复后自动恢复。可用性让位于安全，期间 Bot Chat 暂停属预期。
- **审计策略**：非安全审计事务外 best-effort（失败计数/最近错误经 `/api/version.audit`），安全关键审计逐条记录、
  失败不阻断已完成的业务状态；公开下载计数仍在事务内，避免审计故障改变业务结果。

## 11. 明确残余与长期限制

以下为明确保留、不强行改造的架构性/已接受项（逐条理由见 `docs/AUDIT.md` 与 `docs/SECURITY.md` §4）：

1. **单进程单点**：服务端与 Bot 队列、限流、诊断计数均在单进程内存态；进程重启会清零限流计数，无多实例/高可用。审计失败计数已持久化，限流仍为内存态。
2. **同步维护与 SQLite 模式**：小时维护任务同步执行可能短暂阻塞请求；`synchronous=NORMAL` 不抗突然断电最后若干毫秒写入。
3. **平台/模型路径 mock-only**：QQ 适配器、OpenCode 模型、Cloudflare 边缘的负路径以进程内夹具为主；已补 429/5xx/超时/permissions 夹具，真实平台限流/签名漂移/故障仍需部署后联调。
4. **read 作用域依赖 OpenCode 语义**：session `permissions` 的 `read`/`external_directory` 实际匹配需生产矩阵验证；失败则保持 `BOT_AI_CONTEXT_READ_ENABLED=false`。首轮角色卡仍存在于会话历史，OpenCode 进程仍是信任边界。
4. **物理孤儿/导入异常路径**：孤儿文件回收仅限“超期 + DB 无行 + id 形状”；导入归档按 90 天保留并清理无 DB 记录导入文件，恢复锁/临时目录的极端残留仍需人工核对。
5. **备份加密残余**：SIGKILL/断电/ENOSPC 的 `*.plain.tmp` 窗口（>24h 清理）、2× 空间峰值、孤儿密文只报告；私钥丢失不可恢复；
   预部署 DB 快照继续明文 0600（自动回滚需要）。
6. **异地副本残余**：默认关闭、单远端、依赖 PC/rclone/凭据；状态文件可信度取决于管理员 PC 边界。
7. **BotService 拆分（ARCH-01）**：`targets.ts`（目标 CRUD）、`roles-admin.ts`（用户/群角色卡）、`memory-admin.ts`（记忆管理）已抽出，`service.ts` 保留 facade/依赖装配；后续可继续拆状态机与投递编排。
8. **既有环境限制**：单管理员、`antifield` NOPASSWD sudo、RCON 监听 0.0.0.0、单 SD/无 LUKS、Cloudflare 明文、`http-proxy` 弃用警告、
   内存态限流、`Intl` 开销、迁移无校验和、健康检查为轻量就绪（非全量依赖探测）等按 `docs/SECURITY.md` §4 管理。
9. **已收口项**：审计失败计数持久化、Bot 镜像孤儿清理、导入归档保留、告警 24h 重通知、备份锁心跳、DR-1 `clockSkew` 状态。
10. **Lofii 事件告警语义（v0.8.0，v0.8.1 仍保持）**：外部 `alert` 仅以 `status='event'` 记录，不进入 firing/resolved 状态机，无恢复通知/冷却/去重（由上游负责）；告警只在轮询时发现，最多滞后一个 `LOFII_POLL_MS` 周期；告警写入失败停游标重试但**无事件幂等键**（DB 恢复/多实例可能重复通知，计划 schema v18 下一 minor）。
11. **Lofii 聊天/事件不持久化（v0.8.0）**：事件与聊天只存在服务端内存（≤100 条且 ≤512 KiB），应用/Lofii 重启即丢失；不提供历史查询、导出或搜索。
12. **Lofii 单实例与轮询延迟（v0.8.0）**：单进程内存缓存、单 Lofii 上游；控制结果最终一致，状态/事件最多滞后一个轮询周期；Lofii 不可达时仅展示缓存并降级；`stop()` 不取消在途轮询、Lofii 进程未纳入 `service_down` 监控（v0.8.1 残余）。
13. **v0.8.0 生产验收边界**：生产部署与只读/API 验收已完成（release `20261027T094412Z`/commit `9ae5809`，部署内只读 smoke 26/0/0/2、完整 Access smoke **35/0/0/2**（`-SkipLocalTaskCheck`，当时任务标记未重装），Lofii token 匹配、`meta.lofii.event_cursor` 已建立、patrol start/stop 已验证）；生产 UI 视觉确认已完成（Edge headless 经 SSH 隧道截图、Lofii 面板正常渲染、临时会话已清理；用户仍可自行复核）；真实 Lofii 告警联动未触发（单元/集成覆盖）；**已发布：annotated Tag `v0.8.0`（commit `c5ec851`）+ GitHub Release `AntifieldComplexx v0.8.0：Lofii Minecraft Bot 对接`（publishedAt `2026-10-27T12:02:45Z`）**。
14. **v0.8.1 安全补丁与生产验收（2026-10-27）**：本地实现与门禁完成（`npm run check` 通过；`npm test` 572、`test:web` 256；服务端覆盖率 93.04/78.77/88.67、前端 55.83/51.29/48.66；build 通过）；**生产已于 2026-10-27 部署 v0.8.1 并完成只读/API/安全回归验收**（release `20261027T113055Z`/commit `5405a8d`，smoke 26/0/0/2 + 完整 Access **36/0/0/2**（含任务标记检查），`/say` 任意 `/` 与 C0 均 400，lofii-bot v0.6.1 已部署且 Token match）；**v0.8.1 已发布：annotated Tag `v0.8.1` + GitHub Release `AntifieldComplexx v0.8.1：Lofii 安全补丁与稳定性修复`（2026-10-27）**；Windows 备份任务已重装并验证（appVersion=0.8.1、installedAt 2026-10-27T12:11:23Z、scriptSha256 一致、任务 Ready）；v0.8.1 未重新做生产 UI 截图（v0.8.0 视觉确认仍有效），只读 `/say` 503 仅单测/集成覆盖；残余见 `docs/AUDIT.md` v0.8.0 Minor 补审计节。
