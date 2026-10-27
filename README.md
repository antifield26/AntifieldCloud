# AntifieldCloud · 个人工作台

面向 Raspberry Pi 5（8 GB，Debian 13）的自托管个人工作台：统一登录、云盘、知识库（笔记附件/版本历史）、多文件分享、Minecraft 状态与白名单、Lofii Minecraft Bot 对接（只读状态/任务与移动控制/游戏内聊天/事件流与告警历史）、opencode AI 工作区入口、QQ 官方机器人、PWA、主机指标历史与告警，以及应用归档（可选整包加密 + 异地副本，默认关闭）+ 世界一致性备份 + 恢复演练的灾备链路。

> 状态：v0.8.1（**v0.8.0 的 Minor 安全补丁；本地实现与门禁完成 2026-10-27，生产仍为 v0.8.0 待部署；尚未部署/尚未 Tag/Release**），schema 保持 **v17**（无迁移），OpenCode **v2.1.4**。v0.8.0 已完成生产部署、只读/API 验收、完整 Access smoke（35/0/0/2，`-SkipLocalTaskCheck`）与 UI 视觉确认：生产应用 **v0.8.0**（release `/opt/antifieldcloud/releases/20261027T094412Z`/commit `9ae5809`，`/healthz` v0.8.0/schema17，部署内只读 smoke **26/0/0/2**），lofii-bot v0.6.0 release `20261027T092737Z` 已部署且仅 loopback，`LOFII_ENABLED=true`；**v0.8.0 与 v0.8.1 均尚未 Tag/GitHub Release**。v0.8.1 修复发现的安全/健壮性问题：`/say` 分块命令注入（P1；现在必须控制 Token、拒绝任意 ASCII `/` 与 C0 控制字符）、上游数据原型链/形状（P2）、流式 2 MiB 响应上限、Token 脱敏大小写不敏感、事件缓存 ≤512 KiB、轮询 200 条、游标失败重试、前端状态归一化/部分失败警告/防竞态；上游推荐 lofii-bot **v0.6.1**（最低 v0.6.0，契约 v1；逐行中和行首 `/`）。真实 Lofii 告警联动未触发（单元/集成覆盖）；Windows 每日备份任务安装标记仍为旧版本，需用户管理员 PowerShell 重装刷新（smoke 以 `-SkipLocalTaskCheck` 跳过，非失败）；v0.8.1 生产部署后需复验 `/say` 与 UI。备份整包加密与异地副本默认关闭，异地副本按当前运维决定保持关闭。
> 测试基线（v0.8.1 本地，2026-10-27）：`npm run check` 通过；`npm test` **572**（571 pass、1 skip）、`npm run test:web` **256**（48 文件）；服务端覆盖率 **Lines 93.04% / Branches 78.77% / Functions 88.67%**、前端 **Lines 55.83% / Branches 51.29% / Functions 48.66%**（门禁通过）；`check-version`（严格 `0.8.1`）、`build` 均通过；Node.js **v26.12.1**。生产仍为 v0.8.0（已完成部署与验收），v0.8.1 **待部署、尚未 Tag/Release**。
> 部署与运维见 [docs/DEPLOY.md](docs/DEPLOY.md)，备份/恢复见 [docs/BACKUP.md](docs/BACKUP.md)，契约见 [docs/API.md](docs/API.md)，路线与验收记录见 [docs/ROADMAP.md](docs/ROADMAP.md) 与 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。

## 技术栈

- 服务端：Node.js >= 26（生产 v26.12.1；原生 TypeScript，无编译步骤）+ Fastify + `node:sqlite`（WAL）
- 前端：React 19 + TypeScript + Vite，中文暗色界面，PWA（离线壳，不缓存 API）
- 类型工具链：TypeScript 7.0.2（`@typescript/native` 别名提供 `tsc`）；`typescript` 包别名到 `@typescript/typescript6@6.0.2`，仅供 typescript-eslint 8.x 使用；当前结论为**暂不升级、保留双 alias**
- Bot：仅 QQ 官方 Bot（AppSecret 派生 Ed25519：op=13 回调校验 + op=0 事件验签，`{opcode:12}` 确认）；普通消息 Chat 使用本地 OpenCode AI，结构化长期记忆落 DB（schema v17；legacy `DATA_DIR/bot-memory` 镜像仅迁移/fallback，孤儿镜像由维护任务清理）；v0.7.3 文档模式把角色卡与记忆写为只读文档，角色卡只在会话创建时发送，后续轮由模型按需 `read`（默认关闭；生产读范围矩阵 7/7 通过后已显式启用）；回复按 QQ 2000 字符分段、纯文本格式化；入站图片默认交给 AI（OpenCode prompt files + 支持 image 输入的模型）；凭据 AES-256-GCM（`BOT_SECRET_KEY`），只出站调用 QQ 平台 API 与本机 OpenCode
- Lofii：Minecraft 附属 Bot（独立服务，仅 loopback `127.0.0.1:3010`）的只读/控制对接：读 Token（`/status`/`/events/recent`/`/history`）与控制 Token（`/task/*`/`/move`/`/say`）分离，控制 Token 为空即只读（`/say` 也 503）；服务端每 5s 轮询 `/status` 与 `/events/recent?limit=200`（lofii-bot **v0.6.1**，最低 v0.6.0，契约 v1），事件环最多缓存 100 条且 ≤512 KiB；`/say` 拒绝任意 ASCII `/` 与 C0 控制字符；上游 `alert` 映射为本应用告警事件 `status='event'`；浏览器不直连 Lofii、不经手 Token
- 部署：Cloudflare Tunnel（`app.example.com` / `ai.example.com`）+ systemd + nftables；不使用 Docker
- 测试：`node --test`（服务端 + 运维脚本 **571**，571 pass / 1 skip）+ Vitest/jsdom（**256**，48 文件），ESLint，`tsc --noEmit`，覆盖率门禁（服务端 Lines/Functions/Branches 91/85/76；前端 50/45/42）
- CI：`npm run check` + `npm run build`、服务端/前端覆盖率、运行时依赖边界、`npm audit`（生产依赖）、gitleaks 密钥扫描、shellcheck、nftables 语法、PowerShell 5.1 解析/BOM 检查、版本一致性、Dependabot 月度依赖更新

## 功能

### 认证与账号

- 密码（scrypt）+ TOTP 两步验证，10 个一次性恢复码；会话 7 天，app 主机 host-only `af_session`（HttpOnly）+ `af_csrf`，Secure + SameSite=Lax；AI 工作区通过 60s 一次性 ticket 获得自己的 host-only 会话，不共享父域 Cookie。
- 所有非 GET `/api` 校验 CSRF 与 Origin；改密/重生成恢复码需“当前密码 + TOTP”，并受限流与审计。
- 登录限流：每 IP 5 次失败/15 分钟、全局 60 次/小时（loopback 不占全局桶）、TOTP 全局 120 次/小时；再认证另有独立限流与恒定延迟。

### 云盘

- 目录树、多文件上传（可取消/重试/放弃并清理）、搜索、预览、Range 下载、回收站（30 天自动清理）；配额 10 GiB（含回收站）。
- 普通 multipart 单文件上限 100 MiB（匹配 Cloudflare 代理）；更大的文件自动走 8 MiB 分片上传，单文件上限 5 GiB，支持断点续传、配额预留、24h 会话过期与每用户 3 并发。
- `/api/storage` 轻量返回配额用量；文件列表/搜索/回收站只展示 `origin='user'` 的普通文件。

### 知识库

- Markdown 笔记 + 书签、标签、置顶、FTS5 搜索（中文回退 LIKE）、分页。
- 笔记附件：每请求 1–5 个、单文件 ≤25 MiB、每笔记 ≤100 个，计入总配额，但不出现在普通文件列表/搜索/回收站；只能经笔记接口管理，内容仍走鉴权的文件内容路由。
- 版本历史：标题/正文/标签变化时自动快照，每笔记保留最近 20 个版本；可查看/恢复（恢复前自动保存当前版本），跨笔记版本一律 404。

### 文件分享

- 单文件兼容入口 + 多文件分享：`POST /api/shares` 一次 1–50 个活动普通文件；逐文件下载，不生成 zip。
- 可选密码（新建至少 8 位）、有效期（默认 7 天，最长 30 天）、最大下载次数、备注；token 只存 SHA-256，密码 scrypt。
- 下载次数按“分享会话”计一次；任一文件被删除/移入回收站会吊销整个分享；公开页 `/s/<token>` 带 `noindex`，多文件分享解锁后展示文件清单。
- 公开内容支持 Range/HEAD/ETag/304/416；多文件分享的单文件 `/content` 返回 409 `share_bundle`。

### Minecraft

- SLP + RCON 只读状态（版本/MOTD/在线玩家/TPS/白名单数/服务状态）；白名单增删并执行后复核。
- 应用 API 不提供任意 RCON 命令、启停、封禁、OP；仅白名单增删 + 只读状态。
- 世界一致性备份由 root 脚本 `scripts/backup-world.mjs` 通过固定 `save-off` → `save-all flush` → `save-on`（finally）完成，应用 API 不可触达。
- `/minecraft` 页为「服务器 / Lofii」两个可键盘操作标签页（`role=tab`、左右方向键/Home/End，`?tab=lofii` 或 `#lofii` 深链）；`/api/version.lofiiEnabled=false` 时不展示 Lofii 标签，页面行为与旧版一致。

### Lofii Minecraft Bot（v0.8.0 引入，v0.8.1 安全加固；默认关闭）

- 独立附属服务 `lofii-bot`（推荐 **v0.6.1**，最低 v0.6.0，契约 `contractVersion=1`，仅监听 `127.0.0.1:3010`）；应用通过服务端轮询 `GET /status` 与 `GET /events/recent?limit=200`（默认 5s）获取状态与最近事件，**浏览器不直连 Lofii**。
- 只读状态：运行状态、Minecraft 连接、服务器在线/TPS、Lofii 血量/饥饿、AI 队列、记忆、版本/契约、白名单数量、运行时长、断线记录；不可达/数据过期/部分轮询失败/旧版无事件流时显示缓存与可见降级说明。
- 任务控制：7 种任务（钓鱼/种田/砍树/挖矿/砍天然林/睡觉/巡逻）、开始（已有任务时入队，最多 3 个）、停止（中断并清空队列）、恢复待恢复任务（过期自动中断）；开始/停止/恢复均需二次确认。
- 移动控制：回家/过来/跟随/停下；目标玩家来自 Lofii 在线列表；任务进行中不可手动移动。
- 游戏内聊天：以 Lofii 身份发送纯文本（trim 后 1–720 字符，**任意位置禁止 ASCII `/`**、禁止 C0 控制字符；发送前二次确认；需要控制 Token）；不执行任何命令，聊天内容不落库。
- 事件流：`/events/recent` 内存环最近 100 条且 ≤512 KiB（聊天/任务/状态/移动/告警），按类型筛选、纯文本渲染；Lofii 重启后清空，本应用不保存事件历史。
- 历史记录：`GET /api/lofii/history?kind=samples|alerts` 校验形状后透传上游只读对象行（默认最近 24h、最多 100 条），只读表格，不展开 details。
- 告警：Lofii `alert` 事件映射为本应用告警事件（`status='event'`，仅记录，不参与活跃/恢复状态机），可复用 webhook 与 Bot 通知；`LOFII_ALERTS_ENABLED=false` 时只推进游标不写告警；告警写入失败时游标停在上一条已处理事件并重试。
- 安全：读/控制 Token 分离且仅 loopback（`LOFII_URL` 仅根地址）；控制 Token 为空时任务/移动/聊天均 503（只读）；`/say` 拒绝任意 `/` 与 C0 控制字符；响应流式 2 MiB 上限；Token/上游地址不进入前端/API 响应/日志/审计正文，`/say` 审计只记字符数。

### opencode AI 工作区

- `ai.example.com` 只经会话校验后反代到固定上游 `127.0.0.1:4096`；客户端 `Authorization`/Cookie 被覆盖/移除。
- HTTP 与 WebSocket 均校验 `Origin`（仅 app/ai 正式 origin；WS 必须带合法 Origin），拒绝时 403 + 审计。
- `OPENCODE_HTML_MODE=shim|attributes|passthrough` 兼容 Rocket Loader/自动注入差异，不添加可见 UI。

### 机器人（QQ 官方 Bot）

- **平台接入**：仅 QQ 官方 Bot；QQ 用 AppSecret 派生 Ed25519（`op=13` 回调地址校验、`op=0` 事件验签，回复 `{opcode:12}`）；公开入口为 `POST /api/bot/webhook/:botId`，原始 body 验签后按事件 ID 去重。
- **普通消息 Chat**：非斜杠消息在目标 `allow_chat=1` 时进入 AI 对话；C2C 私聊直接进入；QQ 群/频道默认只有 @Bot 事件进入，群目标可设为 `groupReplyMode=all` 并在 QQ 后台开启“接收所有消息”；模型通过 `botmsg_send_message` 工具发送（私聊/@ 至少 1 条、可连续 1–5 条，全量群聊不调用即静默）；群聊/频道不执行斜杠命令，命令仅在 C2C 私聊可用；C2C 管理员命令由目标 `allow_commands` + user 白名单双校验；Chat 只读。限速：每 Bot×用户 Chat 每分钟默认 **30** 次、AI 每小时默认 **120** 次（`BOT_CHAT_RATE_PER_MINUTE`/`BOT_AI_RATE_PER_HOUR`）。
- **回复形态（QQ 纯文本）**：AI 回答经清洗、去 Markdown 标记后按 QQ 单条 2000 字符分段（最多 4 段，续段前缀“（续 n/m）”，超限截断）；partial 失败 `partial_text_sent` 不自动重试；QQ 不支持媒体/附件/按钮/引用回复。
- **图片理解（默认开启）**：`BOT_AI_VISION_ENABLED=true` 时 QQ `d.attachments` 的 image/* 附件经 `.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（QQ 实际图床如 `multimedia.nt.qq.com.cn`）域名后缀白名单下载（image mime 白名单、≤`BOT_AI_IMAGE_MAX_BYTES`、不落盘）交给 AI；失败/关闭/非法图片时降级为纯文字回答；图片会经 OpenCode 交给模型 provider（见 `docs/SECURITY.md`）。需模型支持 image 输入（`opencode-go/deepseek-v4.1-flash` 已完成生产只读验证）。
- **结构化长期记忆**：`bot_memory_items` 7 类（资料/偏好/事实/项目/任务/关系/事件），key/value/confidence/importance/source/时间/`expires_at`，唯一 `(bot,user,kind,key)`；`bot_memory_state` 保存启停与 legacy 迁移标记；`bot_ai_memories` 仅作 legacy 来源/fallback。`/bots`「角色与记忆」将长期记忆分为**用户记忆/群聊记忆**左右两栏；群聊记忆按群目标聚合，群共享记忆按群目标归属。
  抽取沿用累计 **3** 条或空闲 **120s**（`BOT_AI_MEMORY_BATCH_MESSAGES`/`BOT_AI_MEMORY_IDLE_FLUSH_SECONDS`）+ 同用户串行，一次性 OpenCode 会话（用后删除）；模型 JSON ops 经服务端校验/敏感过滤（密钥/URL/内部路径跳过）/容量清理（默认 **200** 条）；TTL：资料/偏好不过期，事实/项目/关系 **365 天**、事件 **90 天**、任务 **30 天**（更新续期）；召回核心层优先 + 关键词相关层，预算 **3000 字/12 条**（`BOT_MEMORY_PROMPT_MAX_CHARS`/`BOT_MEMORY_PROMPT_MAX_ITEMS`），`/memory off` 时无注入；审计 `bot.memory.extract` 只记计数。
- **AI 仅普通消息 Chat**：默认（`BOT_AI_CONTEXT_READ_ENABLED=false`）提示词为「角色卡（私聊个人卡、群聊共享卡或默认 lofii）+ 固定只读安全边界 + 结构化记忆召回 + 用户消息」；开启文档模式后首轮发送角色卡正文，后续轮只给角色名/记忆条数/只读文档路径，模型通过 OpenCode `read` 按需读取，记忆正文不再每轮进入 prompt；安全边界始终追加；全量群消息追加 `NO_REPLY` 决策段；不存在 `BOT_AI_TASK_PROMPT`/`BOT_AI_CHAT_PROMPT`；AI 仅在 `allow_chat=1` 的目标/C2C 私聊中调用；`bot_ai_sessions.mode` 只写 `chat`；`/reset`、私聊/群聊角色变更清理对应会话映射；审计 `bot.ai.chat` 不记录正文/路径。QQ C2C 私聊对任意用户开放 Chat（平台侧限制 Bot 可添加性），群/频道仍按目标登记。
- **默认角色、私聊角色卡与群聊角色卡**：内置默认角色 `lofii` 只保留名字与简短对话风格；群聊使用管理员在“角色与记忆”配置的共享角色卡（每个群目标一张，覆盖成员私聊卡，停用/删除回退 lofii）；C2C `/role` 对 QQ 私聊用户开放，每 Bot×用户一张“名字+角色设定”卡，`set/show/off/on/delete` 管理；`/role show` 对用户自定义卡返回完整详细文本，默认角色卡只返回名称、不展示内置详情；个人卡只覆盖私聊；群聊不执行 `/role`，也不接受任何斜杠命令。私聊角色卡变更会清理该范围会话映射。
- **群聊共享会话**：同一群聊目标的所有成员复用唯一 OpenCode Chat 会话，模型可见群内不同成员的历史消息；群内 Chat 按目标串行，私聊仍每用户独立会话；真实用户仍分别用于限流、记忆归属、审计与发送工具令牌。
- **群聊用户名与共享记忆**：群聊用户消息在提示词中带 `<用户名>：` head；群聊使用独立共享记忆 scope，条目按 `<用户名>：<记忆>` 保存/注入；成员用户级记忆不进入群聊会话；Web「角色与记忆」按用户记忆/群聊记忆左右两栏展示元数据并支持清空群共享记忆。群条目归属键使用稳定 `member_openid`（显示名只存 value），无法映射的旧键标 `legacy:` 保留；`/forget confirm` 同时清除本人在各群贡献的条目并取消在途抽取。
- **自助命令（仅 C2C 私聊）**：`/help`（按身份动态帮助）、`/memory`（查看记忆计数/类型/启停与最近更新，不含 key/value；`/memory off|on` 暂停/恢复）、`/role`（仅私聊）、`/reset`（重置当前目标全部对话，保留长期记忆）、`/forget confirm`（清除结构化条目、状态、legacy 旧摘要与该 Bot×用户全部会话，含远端）；对 C2C 用户开放；`/reset` 与私聊角色卡变更会尽力删除对应远端会话。
- **出站连通性（Pi 直连）**：`server/src/bot/connectivity.ts` 每 60 秒探测外网与 QQ 平台只读 API；`GET /api/bots/connectivity` 仅返回 `{checkedAt,checking,internet,platforms}`（无 `deviceOnline`/`proxy`），`POST /api/bots/connectivity/check` 手动复检；网络恢复后触发队列扫描；`/bots` 概览展示外网/QQ 平台状态。
- **平台连接自检**：`POST /api/bots/:id/check`（需登录 + CSRF）调用 QQ `access_token` 换取接口，返回脱敏的通过/异常项并刷新 `last_checked_at`；`/bots` 配置页“检查连接”展示结果。
- **诊断与管理**：`GET /api/bots/:id/events?hours&limit&offset&outcome` 返回入站事件元数据（不含正文；结果 received/ok/denied/rate_limited/ignored/error）；投递/发布/指标含 `lastErrorHint` 中文提示；`GET/PATCH/DELETE /api/bots/:id/roles…` 与记忆管理（`GET /api/bots/:id/memories` 用户级计数/类型/状态、`GET .../memories/:userId/items` 条目元数据、`DELETE` 单条/整用户）只返回/操作元数据（key/value 正文绝不进入 Web/API）。
- 管理 API `/api/bots*` 与页面 `/bots`：概览、配置、目标、投递与发布、角色与记忆、诊断六个分区；目标支持 `allowChat` 与“最近入站目标”登记；发布仅纯文本；AppSecret 只写不读，数据库只存 AES-256-GCM 密文（`BOT_SECRET_KEY`，32 字节 base64）。
- 命令（仅 C2C 私聊；群聊/频道禁用）：`/help`（自助，按身份动态）、`/memory`（自助，查看/`off|on`）、`/role`（仅私聊，自助）、`/reset`（自助）、`/forget confirm`（自助）；只读命令 `/status`、`/backup`、`/world`、`/mc`、`/files <关键词>` 需 C2C 目标 `allow_commands=1` + user 白名单（`kind='user'` 且 `allow_commands=1`）。非管理员 `/help` 仅显示公开命令列表（`/help /role /reset /forget /memory /search`），管理员显示全量命令列表；未知命令对管理员回全量帮助、对非管理员被拒（无回复）；斜杠命令不调用 AI；不返回文件内容或密钥。
- 告警通知：告警事件写入后按目标 `allow_notifications` 入队，按告警事件去重；目标可配置 `quietStartMinute`/`quietEndMinute`（Asia/Shanghai 本地分钟，0–1439），静默窗口内的通知延后到结束时刻；通知文本清洗内部路径/URL 后外发。
- 发布：仅纯文本（≤2000，超长服务端分段），目标必须是频道/群组；每次发布要求管理员 TOTP 再认证（`totpCode`）且请求体必须带 `confirmText: 'PUBLISH'`，缺失返回 `publish_confirm_required`；可定时（≤30 天）、取消 queued/draft、失败指数退避重试与手动重投；不支持媒体附件。
- 运维：`GET /api/bots/status`、`GET /api/bots/connectivity`、`GET /api/bots/:id/metrics?hours=24`、`GET /api/bots/:id/inbound-targets`、`GET /api/bots/:id/events`、`POST /api/bots/:id/check` 返回运行/连通性/投递/发布/事件诊断与最近入站目标；`/bots` 展示近 24 小时指标卡与出站网络状态。
- 默认 `BOT_ENABLED=false`：关闭时 Webhook 与写接口返回 404/503；`BOT_SECRET_KEY` 丢失后已存 AppSecret 无法解密，只能重新录入。Bot 不可用时不影响应用主功能。

### 可观测性与告警

- 每 60s 采样 CPU/内存/温度/磁盘/负载，保留 30 天；`GET /api/metrics?range=1h|6h|24h|7d|30d` 按桶聚合（最多 240 点）。
- Dashboard 四张 SVG 趋势卡（CPU/内存/温度/磁盘），1h/6h/24h/7d/30d 切换，无第三方图表库。
- Activity 支持动作精确筛选 + 关键词 + 时间范围；Alerts 卡片支持状态/事件筛选与分页。
- 告警条件：磁盘、温度、内存、服务、备份超期、pending 备份、备份密钥包、Minecraft、欠压，以及世界备份/世界拉取/恢复演练超期与异地副本超期（`offsite_overdue`，`ALERT_OFFSITE_MAX_AGE_HOURS` 默认 48；未配置异地副本时不产生条件、不误报）；通用 JSON webhook（10s×3 重试、可选 HMAC）、Bot 通知、去重/冷却/恢复通知、90 天事件保留；持续 firing 按 `ALERT_REPEAT_HOURS`（默认 24）重通知。Lofii 上游 `alert` 事件以 `status='event'` 写入同一历史（仅记录，不参与 firing/resolved 状态机、不写 `alert_state`），可复用 webhook 与 Bot 通知；`LOFII_ALERTS_ENABLED=false` 时只推进游标不写告警。

### 备份与灾备

- 应用归档两阶段：Pi `--prepare` 生成 pending → PC 拉取并校验 SHA-256 → `--ack` 才推进游标；pending 未确认不删除，已确认在 Pi 保留 2 个、PC 每天/每周保留 30 天/56 天。
- 备份整包加密（默认关闭）：`BACKUP_ARCHIVE_ENCRYPTION=true` 时用独立备份 age 公钥生成 `*.tar.gz.age`，明文 tar 只在 `*.plain.tmp` 短暂存在；明文 SHA-256/大小写在归档外 `<archive>.meta.json` 与 DB `manifest_json`；失败关闭（age/公钥/加密失败即 prepare 失败，不回退明文），空间按 2× 明文预算。Pi 只存公钥，私钥离线 ≥2 份；启用前必须用私钥完成一次解密演练。
- 异地副本（默认关闭，PC 端）：`backup-offsite.mjs/.ps1` 只上传 `.age`（拒绝明文），链感知保留（最新 full + 其后全部 inc + 最近 N 天，绝不删最新 full），`rclone copyto --checksum` 上传并校验，状态写 Pi `backup-offsite-status.json`；Dashboard 只读展示，超期触发告警。当前未配置 remote，任务未安装。
- Web 备份管理：归档列表、手动 prepare（长任务 3300s 超时）、导入/校验、文件级恢复到新目录（TOTP + typed confirmation）；加密归档在 Web 不可校验/恢复（`409 archive_encrypted`），恢复目标自动跳过；整库恢复只走离线 root 手工流程（`docs/BACKUP.md` §8.1）。
- 世界备份：`antifieldcloud-world.timer` 每周日 12:00（Asia/Shanghai，Persistent）以 root 生成 gzip 归档（`/var/lib/antifieldcloud/world-backups`），SHA-256 旁文件，保留 4 份；PC 周度 `world-pull.ps1` 校验后 ack 并保留 4 份。
- 恢复演练：`drill.ps1` 自动校验 full+inc 链（含 `since` 连续性与 1–9 位小数秒时间戳）、旁文件 SHA、tar 安全、最新 DB integrity/FK/schema、manifest，报告保留 180 天；加密归档需 `-AgeIdentityPath` 先解密再校验；可选 `-IncludeWorld` 解包验证 `level.dat`。
- 密钥包：age 加密 env/cloudflared/Minecraft/opencode 配置与 opencode DB 快照；明文临时目录优先用 `/run/antifieldcloud/secrets-tmp`（tmpfs），Pi 保留 2 份、PC 90 天；`--include-host-config` 可把 sshd/fail2ban/cloudflared/journald 等主机配置一并打包。
- 备份/世界/拉取/演练/异地状态由脚本写入只读 JSON（`/var/lib/antifieldcloud/*-status.json`，0644），Dashboard/Settings 与告警读取；应用只读且对状态文件设 64 KiB 上限。
- 导入归档：Web 导入的 `origin='import'` 归档按 `BACKUP_IMPORT_RETENTION_DAYS`（默认 90，0=永久）保留；维护任务清理超期记录，跳过活动恢复计划引用，并清理无 DB 记录的超期导入文件。

### PWA / 手机

- manifest + Service Worker：只缓存静态壳/资源，绝不缓存 `/api`、`/s` 或文件内容；支持安装提示与手机拍照上传。
- 390 px 无横向滚动；多文件分享、笔记附件、备份状态卡在移动端纵向堆叠。

## 常用命令

```powershell
npm ci
npm run dev              # 服务端（Node 原生 TS，默认 127.0.0.1:3000）
npm run dev:web          # Vite 开发服务器 :5173
npm run build            # 构建前端到 web/dist（含 PWA 静态资源）
npm run test             # node --test：服务端 + 运维脚本
npm run test:coverage    # 服务端/脚本测试 + 覆盖率门禁
npm run test:web         # 前端 Vitest
npm run test:web:coverage # 前端 + 覆盖率门禁
npm run check            # typecheck + lint + 服务端测试 + 前端测试
node scripts/check-version.mjs # 版本一致性（package.json / README / CHANGELOG / ACCEPTANCE / AGENTS / env.example / DEPLOY 标题 / lock / tool-versions）
npm run provision        # 初始化管理员/TOTP（在 Pi 上以 antifieldcloud 运行）
npm run backup           # 生成应用备份归档（在 Pi 上以 antifieldcloud 运行）
```

部署（PC，v0.8.1 目标）：`.\scripts\deploy.ps1 -PiHost <直连 IP>`；冒烟：`.\scripts\smoke.ps1 -PiHost <直连 IP> -ExpectedVersion 0.8.1 -ExpectedSchemaVersion 17 -ExpectedOpenCodeVersion 2.1.4 -ExpectedLofiiVersion 0.6.1`（最低兼容 v0.6.0；配置 Cloudflare Access 后可加 `-AccessClientId/-AccessClientSecret`；未启用 Lofii 时用 `-SkipLofii`）。
Pi 上同步/校验 Lofii Token（root，需先部署 lofii-bot v0.6.1，最低 v0.6.0）：`sudo bash scripts/sync-lofii-tokens.sh`、`sudo bash scripts/sync-lofii-tokens.sh --check`（只比较不写盘，不回显 Token；失败会原子替换 env）。

## 目录

```text
server/    Fastify 服务端（src + test：认证/文件/分片/笔记/分享/告警/备份/指标/Bot/Lofii 对接）
web/       React 前端（Vite 根目录，含 PWA public/、/bots 管理页与 /minecraft 的 Lofii 面板）
scripts/   provisioning、备份 CLI、世界备份（backup-world.mjs）、恢复演练（drill.ps1/drill-verify.mjs）、
           Windows 拉取与部署/冒烟脚本、bootstrap-env.sh、sync-lofii-tokens.sh、check-version.mjs；
           scripts/test 为运维脚本单元测试
deploy/    systemd（应用/健康探针/世界备份 timer）、nftables、cloudflared、env 模板
docs/      架构、安全、部署、备份、Bot 集成、API、UI、审计与验收
```

## 安全与边界

- 单管理员，密码（scrypt）+ TOTP；所有写操作校验 CSRF；会话 Cookie HttpOnly/Secure/SameSite=Lax。
- 文件内容不可变，逻辑目录存 SQLite；配额 10 GiB（含回收站与笔记附件）；单文件 100 MiB，分片上限 5 GiB。
- `files.origin` 隔离可见性：笔记附件只能经笔记接口管理，不出现在文件列表/搜索/回收站；分享只允许活动普通文件。
- Minecraft 应用 API 仅状态查询与白名单增删；RCON 强密码仍由 nftables 限制为 loopback；世界备份脚本以 root 仅执行固定保存命令。
- opencode 仅通过 `ai.example.com` 反代访问，端口 4096 不对外；代理覆写客户端 Authorization/Cookie，并校验 HTTP/WS Origin。
- 分享 token 只存 SHA-256，密码 scrypt；过期/吊销/次数用尽返回 410；公开页 `noindex`；公开写请求校验 Origin 并限流。
- Bot 平台 Token/签名密钥/QQ AppSecret 只写不读，数据库仅存 AES-256-GCM 密文；Webhook 以平台签名/时间戳鉴权并按事件 ID 去重；QQ 额外校验 op=13 Ed25519 回调地址；命令要求目标授权 + 显式用户白名单；发布要求 TOTP + `PUBLISH` 双确认；通知/命令输出清洗路径与 URL。
- Chat 目标级 `allow_chat` 与命令 `allow_commands` 分离：非管理员只能 Chat，QQ C2C 私聊直接进入、群/频道仅 @Bot 事件（平台限制，无“全部消息”）；结构化记忆条目与 key/value 不经 API/UI 暴露（仅计数/类型/元数据），legacy 旧摘要为 fallback；仅 QQ Webhook 入站。
- 诊断只存事件元数据（类型/结果/短码/目标与用户 ID），不存消息正文；角色/记忆管理 API 只返回元数据，正文不进入 Web/API；图片输入不可信：固定平台域名、image mime 白名单、大小上限、不落盘，失败降级为纯文字；长回复/附件 partial 失败不自动重试。
- Chat 仅对已授权目标/C2C 开放，默认关闭且按用户每分钟/每小时限流；AI 会话新建时使用 deny-all 工具权限，若 OpenCode 明确拒绝该字段则进入 10 分钟重试窗口；启用消息发送工具时 fail-closed（新 Chat 返回 503 `bot_ai_tool_isolation_unavailable`，不以默认权限继续），上游恢复后自动恢复隔离。AI 仅把文本回复交给 Bot，不上传文件、不返回 OpenCode 凭据。
- Lofii 对接只走 loopback：`LOFII_URL` 启用时必须为 loopback + http(s)，客户端 `redirect: 'error'`、每次请求带超时、响应体上限 2 MiB；读 Token 与控制 Token 分离，控制 Token 为空即只读；Token 不进入浏览器/bundle/API 响应/日志，错误文本移除上游地址与 Token。
- Lofii 写操作（任务/移动/聊天）全部要求登录 + CSRF，并按 IP 限流（控制 20/min、`/say` 10/min）；服务端路由强制参数白名单（7 种任务/4 种移动/`/` 前缀拒绝/720 字符上限），UI 对开始/停止/恢复/发送二次确认；审计只记动作元数据，`/say` 只记字符数、不记录聊天正文。
- Lofii 聊天与事件只进内存缓存（最多 100 条），不落库、不写日志；历史接口只读透传；上游告警只作为 `status='event'` 事件记录，不改变本应用主动告警状态。
- 备份归档校验 SHA-256 与 tar 安全（拒绝路径穿越/链接/设备/超大条目）；Web 恢复只到新目录、不覆盖，整库恢复仅离线 root 流程；加密归档在 Web 一律 409，Web/应用进程不持 age 私钥。
- 备份加密失败关闭：加密开启时 age 缺失、公钥非法、加密失败或空间不足都让 prepare 失败，不产生 pending、不降级明文；明文临时文件崩溃残留由下次 prepare/维护清理（>24h）。
- 审计与状态可见：审计写入失败不阻断业务但计数+最近错误可见（`/api/version.audit`，失败诊断持久化在 `audit_write_failures`）；备份加密/异地状态只含开关、公钥是否就绪、别名与计数，不含私钥/远端路径/凭据。
- 指标与审计只记录元数据/主机数值，不含文件内容；审计字段截断（actor≤64、target≤256、detail≤4 KiB）。
- systemd 沙箱（空 capability、只读系统、仅数据目录可写、MemoryMax 512M）+ 世界备份 unit 加固；nftables 默认拒绝入站（模板使用 TEST-NET 占位，安装前按实际网段替换）；SSH 仅公钥（`00-` drop-in），旧回滚备份归档在 `/var/backups/antifieldcloud/`；`fail2ban` 以 nftables 后端启用 `sshd` jail（24h ban），dbfile 持久化封禁，`nftables.service` 的 drop-in 在启动后异步重启 fail2ban 恢复封禁 set；主机级配置模板见 `deploy/host/`。
- 任何密钥只存放在 `/etc/antifieldcloud/env`（0640 root:antifieldcloud）、Pi 本机或离线 age 私钥；不进仓库/日志/前端 bundle。备份 age 密钥对独立于 `secrets-age`。
- 备份包含 TOTP secret、Bot 凭据密文（`BOT_SECRET_KEY` 在 env 内）与文件内容；密钥包用 age 加密，Windows 备份目录 ACL 仅当前用户/Administrators/SYSTEM。

## 已知限制

- SSH 密码登录已关闭（仅公钥，`00-` drop-in；旧回滚备份已归档）；`antifield` 的 `NOPASSWD ALL` sudo 属既有残留（用户选择保留）；`fail2ban` 已启用 `sshd` jail（nftables 后端，24h ban），dbfile 持久化与 nftables 启动后恢复 drop-in 已安装。
- RCON 仍监听所有接口（Paper 无 bind 配置），仅由 nftables 限制为 loopback；Cloudflare Access 主应用 + 4 个 bypass + service token 已配置并验证，`ai` 主机另有 Access 应用（Owner allow + Smoke service token），Free 套餐无自定义 WAF 规则集，保留应用侧限流；service token 只保存在 PC gitignored `.local/cf-access.env`，应定期轮换。
- Cloudflare 终止 TLS，可见明文；单 SD 卡、无全盘加密。
- 限流状态在内存中，应用重启清零；`http-proxy` 在 Node 26 有弃用警告，Node 27 前需评估替换；scrypt 仍为 N=2^15；单进程单点，`synchronous=NORMAL` 不抗突然断电最后若干毫秒写入。
- 分享不支持目录打包，多文件分享不提供服务端 zip；下载次数为会话级近似限制；无公开笔记分享。
- 不支持 WebDAV、Minecraft 启停/控制台、多用户/权限分离；Cloudflare 约 100 MiB/100s 请求限制仍约束单请求上传。
- 世界备份依赖 Minecraft 运行与 RCON 可达；Windows 世界拉取周任务（周日 12:00）已安装并手动验证成功；恢复演练保持手动/季度，异地副本保持关闭。
- **备份整包加密默认关闭且 Web 不可恢复**：加密归档（`.age`）只能在 PC 用离线私钥解密/校验/恢复；私钥丢失即无法恢复明文，Pi 不持私钥也无法代解密。预部署 DB 快照继续明文（0600、保留 2 份，供自动回滚），属威胁模型明确豁免项。
- **加密失败关闭的残余窗口**：SIGKILL/断电/ENOSPC 可能残留 `*.plain.tmp`（正常路径立即删除，>24h 由下次 prepare 清理）；崩溃只允许产生可清理临时文件或“有密文无 DB 行”孤儿（只报告、不自动删除），后者需人工核对。
- **异地副本默认关闭**：需用户在 PC 配置 rclone remote/凭据（脚本不创建），只上传 `.age`；状态由 PC 写回 Pi，缺失视为未配置、不告警；远端保留策略按链感知（最新 full + 其后 inc + 最近 N 天），不做跨远端多副本。当前 rclone 已安装，用户确认保持关闭、不配置 remote。
- **明确残余**：服务端单进程/同步维护任务；平台适配与模型路径仍需 mock + 部署后真实验收；物理孤儿文件只回收 id 形状且超期者；`/api/version` 诊断不含历史；预部署快照与旧归档保留策略见 `docs/BACKUP.md` §11。
- Bot 已知限制：仅 QQ 官方 Bot（单平台）；QQ 仅文本、不支持出站媒体/附件/按钮/引用；群/频道只有 @Bot 事件（或显式开启全量消息后由模型决定是否回复）；C2C 私聊开放 Chat；命令严格只读；企业微信/钉钉/飞书与多管理员审批未支持。
- **v0.7.3 文档模式默认关闭**：需先完成 OpenCode 读范围矩阵（作用域内/外负路径）再启用；首轮角色卡仍存在于 OpenCode 会话历史，后续请求不再发送正文；read 范围依赖 OpenCode `permissions` 语义，失败即保持关闭；上下文目录为派生数据、不进入备份。
- 图片理解默认开启：`BOT_AI_VISION_ENABLED=true`；QQ `d.attachments` 图片仅从 `.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（QQ 实际图床如 `multimedia.nt.qq.com.cn`）后缀、image mime 白名单、≤`BOT_AI_IMAGE_MAX_BYTES` 下载，不落盘；图片会经 OpenCode 交给模型 provider（见 `docs/SECURITY.md`）。
- QQ 群/频道触发限制：只有 @Bot 事件进入 Bot，普通群消息不推送（平台限制）；C2C 私聊直接进入 Chat。若需要群内全量对话，需 QQ 后台开启接收所有消息并由群主授权获取全部消息。
- Cloudflare Access 与 QQ 回调已配置并验收；后续仅需轮换 service token/高权限 API Token，并持续复跑带 token 的 smoke。
- 备份已知残留：增量水位受系统时钟回拨/同毫秒写入影响（DR-1，`clockSkew` 状态可见，不自动修正）；Web 导入归档按 90 天保留；告警持续 firing 每 24h 重通知；`.backup.lock` 有 30s 心跳续租。
- **发布收尾待办**：v0.8.0 生产部署、只读/API 验收、完整 Access smoke（35/0/0/2，`-SkipLocalTaskCheck`）与生产 UI 视觉确认（Edge headless 经 SSH 隧道截图）已完成（2026-10-27）；**v0.8.1 本地实现/门禁完成、生产待部署**；两者均待 Tag/GitHub Release、真实 Lofii 告警联动与 v0.8.1 生产 `/say`/UI 复验；**Windows 每日应用归档任务安装标记仍为旧版本**，需用户管理员 PowerShell 重装 `install-backup-task.ps1` 刷新到当前版本（用户手动步骤，非失败）。
- **Lofii 告警只有事件语义**：上游 `alert` 映射为 `status='event'` 历史事件，不参与 firing/resolved 状态机，也没有恢复通知/冷却；上游告警状态需在 Lofii 侧查看（本应用只记录与转发）。
- **Lofii 聊天/事件不持久化**：事件流与聊天只存在进程内存（最多 100 条且序列化 ≤512 KiB），应用或 Lofii 重启即丢失；历史接口只返回 Lofii 自己的 samples/alerts，不保存聊天正文。
- **Lofii 轮询延迟与单实例**：状态/事件最多滞后一个轮询周期（默认 5s），控制结果最终一致；单进程内存缓存，不支持多实例/多副本；Lofii 不可达/数据过期/部分轮询失败时展示缓存与可见警告并降级。
- **Lofii 依赖独立服务**：需先部署 lofii-bot **v0.6.1**（最低 v0.6.0，仅 loopback、契约 v1）并同步 Token；应用不管理 Lofii 生命周期、不读取其 RCON/OpenCode 密钥；旧版无 `/events/recent` 时事件流显示升级提示。
- **Lofii 控制面可写**：启用控制 Token 后本应用可让 Lofii 开始/停止任务、移动与游戏内发言（`/say` 自 v0.8.1 起同样需要控制 Token；真实 Minecraft 操作，仍受 Lofii 自身安全区/权限限制）；误操作需人工在游戏内纠正，控制 Token 应按需配置/轮换。

详细设计与验收标准见 `docs/ARCHITECTURE.md`、`docs/SECURITY.md`、`docs/DEPLOY.md`、`docs/BACKUP.md`、`docs/BOT.md`、`docs/API.md`、`docs/UI-SPEC.md`。

## License

MIT © 2026 Antifield。详见 [LICENSE](LICENSE)。

> 仓库中的域名、IP、网段与备份路径均为示例/占位值（`app.<domain>`/`ai.<domain>`/`mc.<domain>`、`example.com`、`192.0.2.x`、`198.51.100.x`、`%USERPROFILE%`）；
> 安装/部署前按 `.local/DEPLOYMENT.md`（gitignored）替换为实际值，实际部署通过 `/etc/antifieldcloud/env`、`-PiHost`、`-BackupRoot` 等参数覆盖。
