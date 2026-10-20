# AntifieldCloud · 个人工作台

面向 Raspberry Pi 5（8 GB，Debian 13）的自托管个人工作台：统一登录、云盘、知识库、文件分享、Minecraft 状态与白名单管理、opencode AI 工作区入口、PWA、主机告警与每日备份。

> 状态：v0.3.2（清理旧 nginx/certbot 入口与 TLS 状态；5 GiB 分片上传/断点续传；备份管理与文件级恢复、音视频播放、审计修复、OpenCode 兼容门禁）。部署与运维见 `docs/DEPLOY.md`，备份/恢复见 `docs/BACKUP.md`，当前与历史验收见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)，审计修复记录见 [docs/AUDIT.md](docs/AUDIT.md)。

## 技术栈

- 服务端：Node.js >= 26（原生 TypeScript，无编译步骤）+ Fastify + `node:sqlite`
- 前端：React 19 + TypeScript + Vite，中文暗色界面，PWA（离线壳，不缓存 API）
- 部署：Cloudflare Tunnel（`app.example.com` / `ai.example.com`）+ systemd + nftables
- 测试：`node --test`（服务端）+ Vitest/jsdom（前端纯函数与组件），ESLint，`tsc --noEmit`

## v0.3.2 功能

- **旧入口清理**：移除 nginx/certbot 包与 `/etc/nginx`、`/etc/letsencrypt`、`/var/www/html`，关闭 80 端口；服务监控从 4 项降为 minecraft/cloudflared/opencode。
- **运维清理**：workbench/piforge 残留、旧 unit/env/RCON 备份已安全删除；磁盘扫描与清理记录见 `docs/DEPLOY.md` §14。
- **安全**：旧入口/TLS 状态不再保留；严格 CSP/Cloudflare Tunnel 入口不变。

## v0.3.1 功能

- **大文件分片上传**：单文件 5 GiB、8 MiB/块、断点续传、配额预留、24h 会话过期、每用户 3 并发；不做对象存储。
- **自动选择**：>100 MiB（普通 multipart 上限）自动走分片；刷新/断线后按 uploadId 续传缺块；取消后重试可续传。
- **migration 4**：`upload_sessions` / `upload_chunks`；`/api/uploads` init/status/chunk/complete/abort。

## v0.3.0 功能

- **备份管理/恢复**：Web 归档列表、手动准备 pending、上传/校验、文件级恢复到新目录（TOTP + typed confirmation）；整库恢复仅离线 CLI；应用数据 + opencode 数据纳入备份覆盖。
- **音视频播放**：mp4/webm/mp3/m4a/ogg/flac/wav 原生 Range 播放，不转码；mkv/avi 等回退下载。
- **审计修复**：回收站分享 410、分享审计节流/密码≥8/备注私有/token 日志脱敏/GC、告警 unknown 降级与 90 天保留、备份脚本硬超时与 secrets 独立状态、孤儿/legacy 归档可观测。
- **OpenCode**：`shim|attributes|passthrough` 模式；Cloudflare 关闭 Rocket Loader/自动注入后验证无垫片；失败保留最小隐藏接管，不添加可见按钮。
- **文档/运维**：migration 3（`backup_archives` 扩展 + `restore_plans`）、备份状态字段、Cloudflare/OpenCode runbook。

## v0.2.x 功能

- 认证：密码 + TOTP；改密/重生成恢复码要求“当前密码 + TOTP”；CSRF、会话、限流、审计。
- 云盘：目录、多文件上传（可取消/超时）、预览、Range 下载、回收站、10 GiB 配额；单文件上限 100 MiB（Cloudflare 代理限制）。
- 知识库：Markdown 笔记、标签、置顶、FTS5 搜索；书签 URL/标题/描述/标签；无附件、无版本历史。
- 文件分享：单文件公开链接，可选密码、过期时间（默认 7 天/最长 30 天）、最大下载次数、吊销；独立限流与审计。
- PWA：可安装、离线壳、手机拍照上传；Service Worker 只缓存静态资源，绝不缓存 `/api`、`/s` 或文件内容。
- 门户：主机指标、存储、MC 状态/白名单、opencode 健康、服务状态、备份状态、告警历史、最近活动。
- OpenCode Web：Rocket Loader opt-out + 原生新建按钮兼容层（不添加可见按钮）；文件列表名称列可点击进入/预览。
- 监控告警：磁盘/温度/服务/备份超期/欠压等条件，通用 JSON webhook，面板可查历史并手动测试。
- 备份：两阶段归档（PC 确认后才推进游标）、未拉取归档不删除、SHA 旁文件、ACL 收紧、age 加密密钥包、恢复文档与演练。
- 工程：迁移 4、服务端 150 测试、前端 52 测试、CI 运维静态检查。

## 常用命令

```powershell
npm ci
npm run dev            # 服务端（Node 原生 TS）
npm run dev:web        # Vite 开发服务器 :5173
npm run build          # 构建前端到 web/dist（含 PWA 静态资源）
npm run check          # typecheck + lint + 服务端测试 + 前端测试
npm run test:web       # 仅前端 Vitest
npm run provision      # 初始化管理员/TOTP（在 Pi 上以 antifieldcloud 运行）
npm run backup         # 生成备份归档（在 Pi 上以 antifieldcloud 运行）
```

## 目录

```text
server/    Fastify 服务端（src + test）；notes/shares/alerts 为二期模块
web/       React 前端（Vite 根目录，含 PWA public/）
scripts/   provisioning、备份、密钥备份、部署、冒烟脚本
deploy/    systemd / nftables / cloudflared / 健康探针配置模板
docs/      架构、安全、部署、备份、API、UI、审计与验收
```

## 安全与边界

- 单管理员，密码（scrypt）+ TOTP；改密/恢复码需要再验证 TOTP；所有写操作校验 CSRF。
- 文件内容不可变，逻辑目录存 SQLite；配额 10 GiB（含回收站）；单文件 100 MiB。
- Minecraft 仅状态查询与白名单增删；RCON 已轮换强密码，仍由 nftables 限制为 loopback；不提供任意命令/启停。
- opencode 仅通过 `ai.example.com` 反代访问，端口 4096 不对外；代理覆写客户端 Authorization/Cookie。
- 分享链接 token 只存 SHA-256，密码 scrypt，过期/吊销/次数用尽返回 410，公开页 `noindex`。
- 任何密钥只存放在 `/etc/antifieldcloud/env`（0640 root:antifieldcloud）、Pi 本机或离线 age 私钥；不进仓库/日志/前端 bundle。
- 备份包含 TOTP secret 与文件内容；密钥包用 age 加密，Windows 备份目录 ACL 仅当前用户/Administrators/SYSTEM。
- 仍保留的边界：Cloudflare 终止 TLS；SSH 密码登录保留（用户选择）；无 Cloudflare Access；单 SD 卡；见 `docs/SECURITY.md`。

详细设计与验收标准见 `docs/ARCHITECTURE.md`、`docs/SECURITY.md`、`docs/DEPLOY.md`、`docs/BACKUP.md`、`docs/API.md`、`docs/UI-SPEC.md`。

## License

MIT © 2026 Antifield。详见 [LICENSE](LICENSE)。

> 仓库中的域名、IP 与备份路径均为示例值（`example.com`、`192.0.2.x`、`%USERPROFILE%`）；
> 实际部署通过 `/etc/antifieldcloud/env`、`-PiHost`、`-BackupRoot` 等参数覆盖。
