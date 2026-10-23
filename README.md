# AntifieldCloud · 个人工作台

面向 Raspberry Pi 5（8 GB，Debian 13）的自托管个人工作台：统一登录、云盘、知识库（笔记附件/版本历史）、多文件分享、Minecraft 状态与白名单、opencode AI 工作区入口、QQ 官方机器人（v0.5.8 起单平台）、PWA、副机指标历史与告警，以及应用归档 + 世界一致性备份 + 恢复演练的灾备链路。

> 状态：v0.6.0（**本地修复与门禁完成，待部署/用户验收**；schema 保持 **v14**，无迁移；OpenCode 已先升级 **v2.1.3**）。本版为质量/安全加固：修复 QQ op=13 签名预言机（P1）、app/ai 改 host-only Cookie + 一次性 AI SSO ticket、公开端点大 body 收敛、密钥包快照硬失败、备份 ack/恢复预算/legacy 迁移修复、Bot wait 旧回答/记忆过滤/工具隔离可见性/发布超长 400、世界备份与演练状态契约修复；所有 P0–P2 闭环，P3 已记录。上一版 v0.5.11（已部署验收通过，release `20261023T022831Z`/commit `931b10d`/schema v14）作为历史保留。
> 发布：待部署与用户验收后填写 release/commit/Tag/GitHub Release。
> 测试基线（Lead 实测 2026-10-23，v0.6.0）：`npm test` **383**（server+scripts，含新增回归）、`npm run test:web` **176**（32 文件）、`npm run typecheck`/`npm run lint` 通过；服务端覆盖率 Lines **92.39%** / Branches **77.83%** / Functions **87.14%**（`npm run test:coverage` exit 0）、`npm run test:web:coverage` exit 0、`npm run build` 通过（bundle `index-D9PlQHRh.js` 680.45 kB）。Node.js 运行时 **v26.12.1**；OpenCode **v2.1.3**。
> 部署与运维见 `docs/DEPLOY.md`，备份/恢复见 `docs/BACKUP.md`，路线见 [docs/ROADMAP.md](docs/ROADMAP.md)，当前与历史验收见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)，审计修复记录见 [docs/AUDIT.md](docs/AUDIT.md)。

## 技术栈

- 服务端：Node.js >= 26（生产安全更新至 v26.12.1；原生 TypeScript，无编译步骤）+ Fastify + `node:sqlite`（WAL）
- 前端：React 19 + TypeScript + Vite，中文暗色界面，PWA（离线壳，不缓存 API）
- 类型工具链：TypeScript 7.0.2（`@typescript/native` 别名提供 `tsc`）；`typescript` 包别名到 `@typescript/typescript6@6.0.2`，仅供 typescript-eslint 8.x 使用（其尚不支持 TS7 API）；v0.5.1 评估结论（v0.5.2 未变）为**暂不升级、保留双 alias**
- Bot：仅 QQ 官方 Bot（AppSecret 派生 Ed25519：op=13 回调校验 + op=0 事件验签，`{opcode:12}` 确认）；普通消息 Chat 使用本地 OpenCode AI（v0.5.9 起 AI 仅 Chat 模式），结构化长期记忆落 DB（v0.5.11 schema v14；legacy `DATA_DIR/bot-memory` 镜像仅迁移/fallback）；回复按 QQ 2000 字符分段、纯文本格式化；入站图片默认交给 AI（OpenCode prompt files + 支持 image 输入的模型）；凭据 AES-256-GCM（`BOT_SECRET_KEY`），只出站调用 QQ 平台 API 与本机 OpenCode
- 部署：Cloudflare Tunnel（`app.example.com` / `ai.example.com`）+ systemd + nftables；不使用 Docker
- 测试：`node --test`（服务端 + 运维脚本 **383**）+ Vitest/jsdom（**176**，32 文件），ESLint，`tsc --noEmit`，覆盖率门禁（Lines **92.39%** / Branches **77.83%** / Functions **87.14%**）
- CI：`npm run check` + `npm run build`、服务端/前端覆盖率、运行时依赖边界、`npm audit`（生产依赖）、gitleaks 密钥扫描、shellcheck、nftables 语法、PowerShell 5.1 解析/BOM 检查、版本一致性、Dependabot 月度依赖更新

## 功能

### 认证与账号

- 密码（scrypt）+ TOTP 两步验证，10 个一次性恢复码；会话 7 天，app 主机 host-only `af_session`（HttpOnly）+ `af_csrf`，Secure + SameSite=Lax；AI 工作区通过 60s 一次性 ticket 获得自己的 host-only 会话，不再共享父域 Cookie。
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
- 公开内容支持 Range/HEAD/ETag/304/416；多文件分享的旧单文件 `/content` 返回 409 `share_bundle`。

### Minecraft

- SLP + RCON 只读状态（版本/MOTD/在线玩家/TPS/白名单数/服务状态）；白名单增删并执行后复核。
- 应用 API 不提供任意 RCON 命令、启停、封禁、OP；仅白名单增删 + 只读状态。
- 世界一致性备份由 root 脚本 `scripts/backup-world.mjs` 通过固定 `save-off` → `save-all flush` → `save-on`（finally）完成，应用 API 不可触达。

### opencode AI 工作区

- `ai.example.com` 只经会话校验后反代到固定上游 `127.0.0.1:4096`；客户端 `Authorization`/Cookie 被覆盖/移除。
- HTTP 与 WebSocket 均校验 `Origin`（仅 app/ai 正式 origin；WS 必须带合法 Origin），拒绝时 403 + 审计。
- `OPENCODE_HTML_MODE=shim|attributes|passthrough` 兼容 Rocket Loader/自动注入差异，不添加可见 UI。

### 机器人（v0.5.11，QQ 官方 Bot 单平台）

- **平台收敛**：v0.5.8 起仅支持 QQ 官方 Bot：QQ 用 AppSecret 派生 Ed25519（`op=13` 回调地址校验、`op=0` 事件验签，回复 `{opcode:12}`）；公开入口为 `POST /api/bot/webhook/:botId`，原始 body 验签后按事件 ID 去重。
  Telegram/Discord/Slack 适配器、Discord Gateway、只读按钮、媒体/多附件发布、群聊触发方式与 Telegram HTML/引用/线程已移除；schema v13 删除非 QQ Bot 及其级联数据（生产 Discord Bot 数据迁移前已备份）。
- **普通消息 Chat**：非斜杠消息在目标 `allow_chat=1` 时进入 AI 对话；C2C 私聊直接进入，QQ 群/频道只有 @Bot 事件进入（平台限制，无“全部消息”）；非管理员只能 Chat，管理员斜杠命令仍由目标 `allow_commands` + user 白名单双校验；Chat 只读。v0.5.9 起限速放宽：每 Bot×用户 Chat 每分钟默认 **30** 次、AI 每小时默认 **120** 次（`BOT_CHAT_RATE_PER_MINUTE`/`BOT_AI_RATE_PER_HOUR`）。
- **回复形态（QQ 纯文本）**：AI 回答经清洗、去 Markdown 标记后按 QQ 单条 2000 字符分段（最多 4 段，续段前缀“（续 n/m）”，超限截断）；partial 失败 `partial_text_sent` 不自动重试；QQ 不支持媒体/附件/按钮/引用回复。
- **图片理解（默认开启）**：`BOT_AI_VISION_ENABLED=true` 时 QQ `d.attachments` 的 image/* 附件经 `.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（QQ 实际图床如 `multimedia.nt.qq.com.cn`） 域名后缀白名单下载（image mime 白名单、≤`BOT_AI_IMAGE_MAX_BYTES`、不落盘）交给 AI；
  失败/关闭/非法图片时降级为纯文字回答；图片会经 OpenCode 交给模型 provider（见 `docs/SECURITY.md`）。需模型支持 image 输入（`opencode-go/deepseek-v4.1-flash` 已完成生产只读验证）。
- **结构化长期记忆（v0.5.11）**：`bot_memory_items` 7 类（资料/偏好/事实/项目/任务/关系/事件），key/value/confidence/importance/source/时间/`expires_at`，唯一 `(bot,user,kind,key)`；`bot_memory_state` 保存启停与 legacy 迁移标记；旧 `bot_ai_memories` 仅作 legacy 来源/fallback（验收后 CLI 清理）。
  抽取沿用累计 **3** 条或空闲 **120s**（`BOT_AI_MEMORY_BATCH_MESSAGES`/`BOT_AI_MEMORY_IDLE_FLUSH_SECONDS`）+ 同用户串行，一次性 OpenCode 会话（用后删除）；模型 JSON ops 经服务端校验/敏感过滤（密钥/URL/内部路径跳过）/容量清理（默认 **200** 条）；
  TTL：资料/偏好不过期，事实/项目/关系 **365 天**、事件 **90 天**、任务 **30 天**（更新续期）；召回核心层优先 + 关键词相关层，预算 **3000 字/12 条**（`BOT_MEMORY_PROMPT_MAX_CHARS`/`BOT_MEMORY_PROMPT_MAX_ITEMS`），`/memory off` 时无注入；审计 `bot.memory.extract` 只记计数。
- **AI 仅普通消息 Chat（v0.5.9）**：提示词固定为「角色卡（个人卡或默认 lofii）+ 固定只读安全边界 + 结构化记忆召回 + 用户消息」，`BOT_AI_TASK_PROMPT`/`BOT_AI_CHAT_PROMPT` 已删除；AI 仅在 `allow_chat=1` 的目标/C2C 私聊中调用；`bot_ai_sessions.mode` 列保留但只写 `chat`（旧 task 行为历史遗留）；`/reset` 与角色卡变更清理该范围全部会话映射；审计 `bot.ai.chat` 不再记录 mode。QQ C2C 私聊对任意用户开放 Chat（平台侧限制 Bot 可添加性），群/频道仍按目标登记。
- **默认角色与私聊角色卡**：内置默认角色 `lofii` 只保留名字与简短对话风格（不注入详细人设/背景，避免影响用户通过对话调整出的个性）；私聊和群聊普通对话都用它；`/role` 对 QQ 私聊用户开放（其他命令仍按白名单），每 Bot×用户一张“名字+角色设定”卡，`set/show/off/on/delete` 管理；个人卡只覆盖私聊，`off` 后回到默认 lofii；群聊固定默认角色。角色卡变更会清理该范围全部会话映射（不再区分 task/chat）。
- **自助命令**：`/help`（按身份动态帮助）、`/memory`（查看记忆计数/类型/启停与最近更新，不含 key/value；`/memory off|on` 暂停/恢复）、`/role`（仅私聊）、`/reset`（重置当前目标全部对话，保留长期记忆）、`/forget confirm`（清除结构化条目、状态、legacy 旧摘要与该 Bot×用户全部会话，含远端）；对全部用户开放；`/reset` 与角色卡变更会尽力删除对应远端会话。
- **出站连通性（v0.5.10，Pi 直连）**：`server/src/bot/connectivity.ts` 每 60 秒探测外网与 QQ 平台只读 API；`GET /api/bots/connectivity` 仅返回 `{checkedAt,checking,internet,platforms}`（无 `deviceOnline`/`proxy`），`POST /api/bots/connectivity/check` 手动复检；网络恢复后触发队列扫描；`/bots` 概览展示外网/QQ 平台状态。
- **代理隧道已移除（v0.5.10）**：删除 `scripts/discord-tunnel.ps1`/`discord-tunnel.vbs`/`install-tunnel-task.ps1` 与 PC 计划任务 `AntifieldCloudDiscordTunnel`；生产 env 删除 `HTTPS_PROXY`/`HTTP_PROXY`/`NODE_USE_ENV_PROXY`/`BOT_PROXY_URL`/`NO_PROXY`，Bot 出站改为 Pi 直连。
- **平台连接自检**：`POST /api/bots/:id/check`（需登录 + CSRF）调用 QQ `access_token` 换取接口，返回脱敏的通过/异常项并刷新 `last_checked_at`；`/bots` 配置页“检查连接”展示结果。
- **诊断与管理**：`GET /api/bots/:id/events?hours&limit&offset&outcome` 返回入站事件元数据（不含正文；结果 received/ok/denied/rate_limited/ignored/error）；投递/发布/指标含 `lastErrorHint` 中文提示；`GET/PATCH/DELETE /api/bots/:id/roles…` 与记忆管理（`GET /api/bots/:id/memories` 用户级计数/类型/状态、`GET .../memories/:userId/items` 条目元数据、`DELETE` 单条/整用户）只返回/操作元数据（key/value 正文绝不进入 Web/API）。
- 管理 API `/api/bots*` 与页面 `/bots`：概览、配置、目标、投递与发布、角色与记忆、诊断六个分区；目标支持 `allowChat` 与“最近入站目标”登记；发布仅纯文本；AppSecret 只写不读，数据库只存 AES-256-GCM 密文（`BOT_SECRET_KEY`，32 字节 base64）。
- 命令：`/help`（自助，按身份动态）、`/memory`（自助，查看/`off|on`）、`/role`（仅私聊，自助）、`/reset`（自助）、`/forget confirm`（自助）；只读命令 `/status`、`/backup`、`/world`、`/mc`、`/files <关键词>` 需目标 `allow_commands=1` + user 白名单（`kind='user'` 且 `allow_commands=1`）。非管理员 `/help` 仅显示 `/help /role /reset /forget confirm` 与 Chat 说明；管理员显示全量帮助；未知命令对管理员回全量帮助、对非管理员被拒（无回复）；v0.5.9 起 `/ask` 已移除，斜杠命令不调用 AI；不返回文件内容或密钥。
- 告警通知：告警事件写入后按目标 `allow_notifications` 入队，按告警事件去重；目标可配置 `quietStartMinute`/`quietEndMinute`（Asia/Shanghai 本地分钟，0–1439），静默窗口内的通知延后到结束时刻；通知文本清洗内部路径/URL 后外发。
- 发布：仅纯文本（≤2000，超长服务端分段），目标必须是频道/群组；每次发布要求管理员 TOTP 再认证（`totpCode`）且请求体必须带 `confirmText: 'PUBLISH'`，缺失返回 `publish_confirm_required`；可定时（≤30 天）、取消 queued/draft、失败指数退避重试与手动重投；不支持媒体附件。
- 运维：`GET /api/bots/status`、`GET /api/bots/connectivity`、`GET /api/bots/:id/metrics?hours=24`、`GET /api/bots/:id/inbound-targets`、`GET /api/bots/:id/events`、`POST /api/bots/:id/check` 返回运行/连通性/投递/发布/事件诊断与最近入站目标；`/bots` 展示近 24 小时指标卡与出站网络状态。
- 默认 `BOT_ENABLED=false`：关闭时 Webhook 与写接口返回 404/503；`BOT_SECRET_KEY` 丢失后已存 AppSecret 无法解密，只能重新录入。Bot 不可用时不影响应用主功能。

### 可观测性与告警

- 每 60s 采样 CPU/内存/温度/磁盘/负载，保留 30 天；`GET /api/metrics?range=1h|6h|24h|7d|30d` 按桶聚合（最多 240 点）。
- Dashboard 四张 SVG 趋势卡（CPU/内存/温度/磁盘），1h/6h/24h/7d/30d 切换，无第三方图表库。
- Activity 支持动作精确筛选 + 关键词 + 时间范围；Alerts 卡片支持状态/事件筛选与分页。
- 告警条件：磁盘、温度、内存、服务、备份超期、pending 备份、备份密钥包、Minecraft、欠压，以及世界备份/世界拉取/恢复演练超期；通用 JSON webhook（10s×3 重试、可选 HMAC）、Bot 通知、去重/冷却/恢复通知、90 天事件保留。

### 备份与灾备

- 应用归档两阶段：Pi `--prepare` 生成 pending → PC 拉取并校验 SHA-256 → `--ack` 才推进游标；pending 未确认不删除，已确认在 Pi 保留 2 个、PC 每天/每周保留 30 天/56 天。
- Web 备份管理：归档列表、手动 prepare、导入/校验、文件级恢复到新目录（TOTP + typed confirmation）；整库恢复只走离线 root 手工流程（`docs/BACKUP.md` §8.1）。
- 世界备份：`antifieldcloud-world.timer` 每周日 12:00（Asia/Shanghai，Persistent）以 root 生成 gzip 归档（`/var/lib/antifieldcloud/world-backups`），SHA-256 旁文件，保留 4 份；PC 周度 `world-pull.ps1` 校验后 ack 并保留 4 份。
- 恢复演练：`drill.ps1` 自动校验 full+inc 链、旁文件 SHA、tar 安全、最新 DB integrity/FK/schema、manifest，报告保留 180 天；可选 `-IncludeWorld` 解包验证 `level.dat`。
- 密钥包：age 加密 env/cloudflared/Minecraft/opencode 配置与 opencode DB 快照；明文临时目录优先用 `/run/antifieldcloud/secrets-tmp`（tmpfs），Pi 保留 2 份、PC 90 天。
- 备份/世界/拉取/演练状态由脚本写入只读 JSON（`/var/lib/antifieldcloud/*-status.json`，0644），Dashboard/Settings 与告警读取。

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
node scripts/check-version.mjs # 版本一致性（package.json / README / CHANGELOG / ACCEPTANCE / AGENTS / env.example / DEPLOY 标题 / lock）
npm run provision        # 初始化管理员/TOTP（在 Pi 上以 antifieldcloud 运行）
npm run backup           # 生成应用备份归档（在 Pi 上以 antifieldcloud 运行）
```

部署（PC）：`.\scripts\deploy.ps1 -PiHost <直连 IP>`；冒烟：`.\scripts\smoke.ps1 -PiHost <直连 IP> -ExpectedVersion 0.6.0 -ExpectedSchemaVersion 14`（配置 Cloudflare Access 后可加 `-AccessClientId/-AccessClientSecret`）。

## 目录

```text
server/    Fastify 服务端（src + test：认证/文件/分片/笔记/分享/告警/备份/指标/Bot）
web/       React 前端（Vite 根目录，含 PWA public/ 与 /bots 管理页）
scripts/   provisioning、备份 CLI、世界备份（backup-world.mjs）、恢复演练（drill.ps1/drill-verify.mjs）、
           Windows 拉取与部署/冒烟脚本、bootstrap-env.sh、check-version.mjs；scripts/test 为运维脚本单元测试
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
- Chat 目标级 `allow_chat` 与命令 `allow_commands` 分离：非管理员只能 Chat，QQ C2C 私聊直接进入、群/频道仅 @Bot 事件（平台限制，无“全部消息”）；结构化记忆条目与 key/value 不经 API/UI 暴露（仅计数/类型/元数据），legacy 旧摘要为 fallback；v0.5.8 起无 Discord Gateway/长连接，只有 QQ Webhook 入站。
- 诊断只存事件元数据（类型/结果/短码/目标与用户 ID），不存消息正文；角色/记忆管理 API 只返回元数据，正文不进入 Web/API；图片输入不可信：固定平台域名、image mime 白名单、大小上限、不落盘，失败降级为纯文字；长回复/附件 partial 失败不自动重试。
- Chat 仅对已授权目标/C2C 开放，默认关闭且按用户每分钟/每小时限流；AI 会话新建时使用 deny-all 工具权限，若 OpenCode 明确拒绝该字段才降级并在日志标注“未隔离”；AI 仅把文本回复交给 Bot，不上传文件、不返回 OpenCode 凭据。
- 备份归档校验 SHA-256 与 tar 安全（拒绝路径穿越/链接/设备/超大条目）；Web 恢复只到新目录、不覆盖，整库恢复仅离线 root 流程。
- 指标与审计只记录元数据/主机数值，不含文件内容；审计字段截断（actor≤64、target≤256、detail≤4 KiB）。
- systemd 沙箱（空 capability、只读系统、仅数据目录可写、MemoryMax 512M）+ 世界备份 unit 加固；nftables 默认拒绝入站；SSH 仅公钥（`00-` drop-in，保留 24h 回滚窗口）；`fail2ban` 以 nftables 后端启用 `sshd` jail（24h ban），dbfile 持久化封禁，`nftables.service` 的 drop-in 在启动后异步重启 fail2ban 恢复封禁 set。
- 任何密钥只存放在 `/etc/antifieldcloud/env`（0640 root:antifieldcloud）、Pi 本机或离线 age 私钥；不进仓库/日志/前端 bundle。
- 备份包含 TOTP secret、Bot 凭据密文（`BOT_SECRET_KEY` 在 env 内）与文件内容；密钥包用 age 加密，Windows 备份目录 ACL 仅当前用户/Administrators/SYSTEM。

## 已知限制

- SSH 密码登录已在 v0.5.0 关闭（仅公钥，`00-` drop-in，24h 回滚窗口）；`antifield` 的 `NOPASSWD ALL` sudo 属既有残留（用户选择保留）；`fail2ban` 已启用 `sshd` jail（nftables 后端，24h ban），dbfile 持久化与 nftables 启动后恢复 drop-in 已安装。
- RCON 仍监听所有接口（Paper 无 bind 配置），仅由 nftables 限制为 loopback；Cloudflare Access 主应用 + 4 个 bypass + service token 已配置并验证，service token 只保存在 PC gitignored `.local/cf-access.env`，应定期轮换。
- Cloudflare 终止 TLS，可见明文；单 SD 卡、无全盘加密；普通归档仍含 TOTP/会话明文，age 私钥丢失则密钥包不可恢复。
- 限流状态在内存中，应用重启清零；`http-proxy` 在 Node 26 有弃用警告，Node 27 前需评估替换；scrypt 仍为 N=2^15。
- 分享不支持目录打包，多文件分享不提供服务端 zip；下载次数为会话级近似限制；无公开笔记分享。
- 不支持 WebDAV、Minecraft 启停/控制台、多用户/权限分离；Cloudflare 约 100 MiB/100s 请求限制仍约束单请求上传。
- 世界备份依赖 Minecraft 运行与 RCON 可达；Windows 世界拉取/演练计划任务需用户手动安装，未装时状态为“未运行/unknown”。
- 备份无异地副本与整包加密；旧世界 cron 已停用，历史 `minecraft-backups` 归档不自动删除，需按 `docs/DEPLOY.md` 手动清理。
- Bot 已知限制：v0.5.8 起仅 QQ 官方 Bot（单平台）；QQ 仅文本、不支持出站媒体/附件/按钮/引用；群/频道只有 @Bot 事件，无“全部消息”；C2C 私聊开放 Chat；命令严格只读；企业微信/钉钉/飞书与多管理员审批留待下一版。
- v0.5.8（已部署 2026-10-22）：平台收敛为 QQ 单平台、schema v13（迁移 13 删除非 QQ Bot 及级联数据，迁移前已备份生产 Discord Bot 数据，回滚只能还原快照）、QQ 入站图片理解默认开启、`/bots` 去 Gateway/媒体/触发方式；
  `/healthz` v0.5.8/schema 13，smoke 16/16 与 24/24；真实 QQ 消息/图片识别/自助命令已由用户实发验收通过（2026-10-22 21:59–22:08 CST，图片 148563 B jpeg 端到端成功）；诊断/角色记忆面板与文本发布按用户确认整体通过（服务端未单独留存 UI/发布证据）。
- 图片理解默认开启：`BOT_AI_VISION_ENABLED=true`；QQ `d.attachments` 图片仅从 `.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（QQ 实际图床如 `multimedia.nt.qq.com.cn`） 后缀、image mime 白名单、≤`BOT_AI_IMAGE_MAX_BYTES` 下载，不落盘；图片会经 OpenCode 交给模型 provider（见 `docs/SECURITY.md`）。
- QQ 群/频道触发限制：只有 @Bot 事件进入 Bot，普通群消息不推送（平台限制）；C2C 私聊直接进入 Chat。若需要群内全量对话，QQ 官方 Bot 当前不提供该能力。
- v0.5.11（已部署并验收通过，用户实发 2026-10-23 10:39 CST）：结构化记忆系统 + **schema v14**（迁移 14 新增 `bot_memory_items`/`bot_memory_state`，不可逆；v0.5.10 不支持 v14，回滚必须恢复迁移前快照）；旧 `bot_ai_memories` 保留为 legacy，验收后需执行 `node scripts/cleanup-legacy-memory.mjs --confirm` 清理；生产 env 需新增 5 个 `BOT_MEMORY_*`；测试基线 360/162（30 文件），覆盖率 Lines **92.05%** / Branches **77.43%** / Functions **86.39%**、`npm run build` 通过。
- v0.5.10（已部署并验收通过，用户实发 2026-10-22 23:26–23:29 CST）：记忆/会话修复（摘要会话一次性并删除远端、记忆更新串行、合并策略=3 条或空闲 120s、记忆保留 365 天与会话 7 天分离、`/reset`/`/forget confirm`/角色变更清理远端会话）；移除代理隧道依赖（删除隧道脚本/PC 计划任务、`BOT_PROXY_URL` 与生产代理变量，连通性仅外网+QQ 平台，Pi 直连）；schema v13 无迁移；测试基线 341/157（30 文件），覆盖率 Lines **91.98%** / Branches **76.92%** / Functions **85.99%**、`npm run build` 通过。
- v0.5.9 起 `/ask` 已移除（AI 全部由普通消息 Chat 承担）；v0.5.3 已实发确认 QQ C2C 与 QQ 群 @Bot Chat；v0.5.8 的真实消息/图片能力/自助命令已由用户实发验收通过（2026-10-22 21:59–22:08 CST，图片端到端成功）。
- Cloudflare Access 与 QQ 回调已配置并验收；后续仅需轮换 service token/高权限 API Token，并持续复跑带 token 的 smoke。
- 备份已知残留：增量水位受系统时钟回拨/同毫秒写入影响（DR-1）；Web 导入归档无自动保留策略（DR-7）；
  告警跨周期不重复投递（DR-22）；`.backup.lock` 无心跳续租（DR-23，>1h 可按陈旧锁接管）。

详细设计与验收标准见 `docs/ARCHITECTURE.md`、`docs/SECURITY.md`、`docs/DEPLOY.md`、`docs/BACKUP.md`、`docs/BOT.md`、`docs/API.md`、`docs/UI-SPEC.md`。

## License

MIT © 2026 Antifield。详见 [LICENSE](LICENSE)。

> 仓库中的域名、IP 与备份路径均为示例值（`example.com`、`192.0.2.x`、`%USERPROFILE%`）；
> 实际部署通过 `/etc/antifieldcloud/env`、`-PiHost`、`-BackupRoot` 等参数覆盖。
