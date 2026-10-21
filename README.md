# AntifieldCloud · 个人工作台

面向 Raspberry Pi 5（8 GB，Debian 13）的自托管个人工作台：统一登录、云盘、知识库（笔记附件/版本历史）、多文件分享、Minecraft 状态与白名单、opencode AI 工作区入口、Telegram/Discord/Slack 机器人、PWA、副机指标历史与告警，以及应用归档 + 世界一致性备份 + 恢复演练的灾备链路。

> 状态：v0.5.0（Bot 平台：Telegram/Discord/Slack 适配器、签名 Webhook、只读命令、告警通知、TXT + 单个云端媒体发布与定时/重试；凭据 AES-256-GCM；schema v7；默认关闭）。部署与运维见 `docs/DEPLOY.md`，备份/恢复见 `docs/BACKUP.md`，路线见 [docs/ROADMAP.md](docs/ROADMAP.md)，当前与历史验收见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)，审计修复记录见 [docs/AUDIT.md](docs/AUDIT.md)。

## 技术栈

- 服务端：Node.js >= 26（原生 TypeScript，无编译步骤）+ Fastify + `node:sqlite`（WAL）
- 前端：React 19 + TypeScript + Vite，中文暗色界面，PWA（离线壳，不缓存 API）
- 类型工具链：TypeScript 7.0.2（`@typescript/native` 别名提供 `tsc`）；`typescript` 包别名到 `@typescript/typescript6@6.0.2`，仅供 typescript-eslint 8.x 使用（其尚不支持 TS7 API）
- Bot：Telegram Bot API、Discord Interactions（Ed25519）、Slack Events API/Slash Command（HMAC）；凭据 AES-256-GCM（`BOT_SECRET_KEY`），只出站调用平台 API
- 部署：Cloudflare Tunnel（`app.example.com` / `ai.example.com`）+ systemd + nftables；不使用 Docker
- 测试：`node --test`（服务端 229 + 运维脚本 16 = 245）+ Vitest/jsdom（前端 137），ESLint，`tsc --noEmit`，覆盖率门禁
- CI：`npm run check` + `npm run build`、服务端/前端覆盖率、运行时依赖边界、`npm audit`（生产依赖）、gitleaks 密钥扫描、shellcheck、nftables 语法、PowerShell 5.1 解析/BOM 检查、版本一致性、Dependabot 月度依赖更新

## 功能

### 认证与账号

- 密码（scrypt）+ TOTP 两步验证，10 个一次性恢复码；会话 7 天，HttpOnly + Secure + SameSite=Lax Cookie。
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

### 机器人（v0.5.0）

- Telegram、Discord、Slack 三个适配器：Telegram 用 `X-Telegram-Bot-Api-Secret-Token`，Discord 用 Ed25519 + 时间戳，Slack 用 HMAC-SHA256 + 时间戳；公开入口为 `POST /api/bot/webhook/:botId`，原始 body 验签后按事件 ID 去重。
- 管理 API `/api/bots*` 与页面 `/bots`：概览、配置、目标、投递与发布四个分区；Token/Webhook Secret/Signing Secret 只写不读，数据库只存 AES-256-GCM 密文（`BOT_SECRET_KEY`，32 字节 base64）。
- 只读命令 `/help`、`/status`、`/backup`、`/world`、`/mc`、`/files <关键词>`：必须同时命中目标的 `allow_commands` 与显式 user 白名单（`kind='user'` 且 `allow_commands=1`）；不返回文件内容或密钥。
- 告警通知：告警事件写入后按目标 `allow_notifications` 入队，按告警事件去重；通知文本清洗内部路径/URL 后外发。
- 发布：文本 + 最多 1 个云端普通文件媒体（默认 ≤10 MiB），目标必须是频道/群组；每次发布要求管理员 TOTP 再认证（`totpCode`），可定时（≤30 天）、取消 queued/draft、失败指数退避重试与手动重投。
- 默认 `BOT_ENABLED=false`：关闭时 Webhook 与写接口返回 404/503；`BOT_SECRET_KEY` 丢失后已存 Token 无法解密，只能重新录入。Bot 不可用时不影响应用主功能。

### 可观测性与告警

- 每 60s 采样 CPU/内存/温度/磁盘/负载，保留 30 天；`GET /api/metrics?range=1h|6h|24h|7d|30d` 按桶聚合（最多 240 点）。
- Dashboard 四张 SVG 趋势卡（CPU/内存/温度/磁盘），1h/6h/24h/7d/30d 切换，无第三方图表库。
- Activity 支持动作精确筛选 + 关键词 + 时间范围；Alerts 卡片支持状态/事件筛选与分页。
- 告警条件：磁盘、温度、内存、服务、备份超期、pending 备份、备份密钥包、Minecraft、欠压，以及世界备份/世界拉取/恢复演练超期；通用 JSON webhook（10s×3 重试、可选 HMAC）、Bot 通知、去重/冷却/恢复通知、90 天事件保留。

### 备份与灾备

- 应用归档两阶段：Pi `--prepare` 生成 pending → PC 拉取并校验 SHA-256 → `--ack` 才推进游标；pending 未确认不删除，已确认在 Pi 保留 2 个、PC 每天/每周保留 30 天/56 天。
- Web 备份管理：归档列表、手动 prepare、导入/校验、文件级恢复到新目录（TOTP + typed confirmation）；整库恢复只走离线 root CLI。
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
node scripts/check-version.mjs # 版本一致性（package.json / README / CHANGELOG / ACCEPTANCE / AGENTS）
npm run provision        # 初始化管理员/TOTP（在 Pi 上以 antifieldcloud 运行）
npm run backup           # 生成应用备份归档（在 Pi 上以 antifieldcloud 运行）
```

部署（PC）：`.\scripts\deploy.ps1 -PiHost <直连 IP>`；冒烟：`.\scripts\smoke.ps1 -PiHost <直连 IP> -ExpectedVersion 0.5.0 -ExpectedSchemaVersion 7`。

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
- Bot 平台 Token/签名密钥只写不读，数据库仅存 AES-256-GCM 密文；Webhook 以平台签名/时间戳鉴权并按事件 ID 去重；命令要求目标授权 + 显式用户白名单；发布要求 TOTP 再认证；通知/命令输出清洗路径与 URL。
- 备份归档校验 SHA-256 与 tar 安全（拒绝路径穿越/链接/设备/超大条目）；Web 恢复只到新目录、不覆盖，整库恢复仅离线 root 流程。
- 指标与审计只记录元数据/主机数值，不含文件内容；审计字段截断（actor≤64、target≤256、detail≤4 KiB）。
- systemd 沙箱（空 capability、只读系统、仅数据目录可写、MemoryMax 512M）+ 世界备份 unit 加固；nftables 默认拒绝入站；SSH 仅公钥（`00-` drop-in，保留 24h 回滚窗口）；`fail2ban` 以 nftables 后端启用 `sshd` jail（24h ban）。
- 任何密钥只存放在 `/etc/antifieldcloud/env`（0640 root:antifieldcloud）、Pi 本机或离线 age 私钥；不进仓库/日志/前端 bundle。
- 备份包含 TOTP secret、Bot 凭据密文（`BOT_SECRET_KEY` 在 env 内）与文件内容；密钥包用 age 加密，Windows 备份目录 ACL 仅当前用户/Administrators/SYSTEM。

## 已知限制

- SSH 密码登录已在 v0.5.0 关闭（仅公钥，`00-` drop-in，24h 回滚窗口）；`antifield` 的 `NOPASSWD ALL` sudo 属既有残留（用户选择保留）；`fail2ban` 已启用 `sshd` jail（nftables 后端，24h ban）。
- RCON 仍监听所有接口（Paper 无 bind 配置），仅由 nftables 限制为 loopback；Cloudflare Access 策略与 Webhook/健康检查/公开分享 bypass 需在 Cloudflare 后台由用户配置，应用侧无法自证。
- Cloudflare 终止 TLS，可见明文；单 SD 卡、无全盘加密；普通归档仍含 TOTP/会话明文，age 私钥丢失则密钥包不可恢复。
- 限流状态在内存中，应用重启清零；`http-proxy` 在 Node 26 有弃用警告，Node 27 前需评估替换；scrypt 仍为 N=2^15。
- 分享不支持目录打包，多文件分享不提供服务端 zip；下载次数为会话级近似限制；无公开笔记分享。
- 不支持 WebDAV、Minecraft 启停/控制台、多用户/权限分离；Cloudflare 约 100 MiB/100s 请求限制仍约束单请求上传。
- 世界备份依赖 Minecraft 运行与 RCON 可达；Windows 世界拉取/演练计划任务需用户手动安装，未装时状态为“未运行/unknown”。
- 备份无异地副本与整包加密；旧世界 cron 已停用，历史 `minecraft-backups` 归档不自动删除，需按 `docs/DEPLOY.md` 手动清理。
- Bot 已知限制：单次发布最多 1 个媒体文件；命令严格只读；不支持平台侧主动拉取/长连接；适配器测试使用进程内 mock（不依赖真实平台网络），上线前需在各平台后台完成 Webhook/命令注册。
- 备份已知残留：增量水位受系统时钟回拨/同毫秒写入影响（DR-1）；Web 导入归档无自动保留策略（DR-7）；
  告警跨周期不重复投递（DR-22）；`.backup.lock` 无心跳续租（DR-23，>1h 可按陈旧锁接管）。

详细设计与验收标准见 `docs/ARCHITECTURE.md`、`docs/SECURITY.md`、`docs/DEPLOY.md`、`docs/BACKUP.md`、`docs/BOT.md`、`docs/API.md`、`docs/UI-SPEC.md`。

## License

MIT © 2026 Antifield。详见 [LICENSE](LICENSE)。

> 仓库中的域名、IP 与备份路径均为示例值（`example.com`、`192.0.2.x`、`%USERPROFILE%`）；
> 实际部署通过 `/etc/antifieldcloud/env`、`-PiHost`、`-BackupRoot` 等参数覆盖。
