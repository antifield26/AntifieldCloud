# Changelog

## [0.3.1] - 2026-10-20

### Added

- 大文件分片上传：单文件 5 GiB、8 MiB/块、断点续传、配额预留、24h 会话过期、每用户 3 并发；不做对象存储。
- `POST /api/uploads`、`PUT /api/uploads/:id/chunks/:idx`、`GET`、`complete`、`abort`；migration 4（`upload_sessions` / `upload_chunks`）。
- 前端大文件自动分片：>100 MiB 走分片，并发 2 块，localStorage 只保存 uploadId/已收块号；刷新/断线自动补缺块；取消后重试可续传。
- 审计/运维：persistent journald（log2ram 64 MiB 上限）、cloudflared 2026.10.1 + systemd 加固、nftables WiFi 源收窄到 `/21`、rpcbind 禁用、unattended-upgrades dry-run 验证。

## [0.3.0] - 2026-10-20

### Added

- 备份管理：列表、手动生成 pending、归档导入/校验、文件级恢复到新目录（TOTP + typed confirmation）；整库恢复仅离线 CLI。
- 备份覆盖：opencode DB/config 纳入 age 加密密钥包；文件备份 + 密钥包状态分离。
- 音视频播放：mp4/webm/mp3/m4a/ogg/flac/wav 原生 Range 播放，不转码；mkv/avi 回退下载。
- OpenCode `OPENCODE_HTML_MODE=shim|attributes|passthrough`，支持关闭 Cloudflare 注入后的无垫片验证。
- migration 3：`backup_archives` 扩展 + `restore_plans`；`/api/backups`、`/api/restores` 路由。

### Fixed

- 备份任务 SSH/SCP 硬超时；secrets 拉取独立状态（`secretsOk/lastSecretsError`），不再“文件成功即全部成功”。
- 回收站文件旧分享返回 410；分享下载审计节流；密码≥8；公开备注移除；token 日志脱敏；过期/吊销 GC。
- 告警 unknown 降级与恢复、事件+状态事务化、90 天保留；备份密钥包告警。
- legacy 无参备份改为显式 `--legacy`；孤儿归档可观测并计入空间预算；sidecar 清理。
- 前端分享备注/一次性 URL/PWA 缓存/审计映射；媒体与备份向导测试。
- OpenCode 无垫片尝试：Cloudflare 关闭 `ai` 的 Rocket Loader 后，passthrough HTML 的模块脚本未被改写；但无 JS 的 attributes/passthrough 仍无法触发原生新建会话（上游按钮缺陷），按约定保留最小隐藏 click 接管，无可见按钮。
- 文档与 API/UI/ARCH/SECURITY/DEPLOY/BACKUP 同步。

## [0.2.2] - 2026-10-19

### Fixed

- **移除 v0.2.1 添加的可见“＋ 新会话”浮动按钮**；兼容垫片不再注入任何 UI。
- OpenCode Web：在捕获阶段接管 opencode **原生**“新建会话”按钮（click + pointerup），
  修复 Android/宽屏移动浏览器中原生按钮点击无响应；仍调用 opencode `POST /api/session`，不改服务/数据。
- 继续为 opencode 脚本加 `data-cfasync="false"`，避免 Cloudflare Rocket Loader 改写模块脚本导致
  智能体/模型选择器不渲染。
- 文件页列表名称列点击进入文件夹/预览文件的修复保留。

## [0.2.1] - 2026-10-19

### Fixed

- 文件页列表视图的名称列现在可点击进入文件夹/预览文件（名称列改为可访问按钮，保留网格视图）。
- OpenCode Web 兼容垫片：
  - 移动端（含 Android 浏览器）常驻“＋ 新会话”按钮，调用 opencode `POST /api/session` 并跳转标准 session 路由。
  - 接管桌面端“新建会话”按钮，修复点击无响应。
  - 垫片以同源外部脚本 `/__af/oc-help.js` 注入，兼容 opencode CSP `script-src 'self'`，不修改 opencode 数据。
  - OpenCode 原生页面仍由代理透传；仅对已认证 HTML 导航注入。

## [0.2.0] - 2026-10-19

### Added

- 知识库：Markdown 笔记/书签、标签、置顶、分页与 FTS5 搜索（中文回退 LIKE）；独立审计。
- 文件分享：单文件公开链接，可选密码、过期时间（默认 168h/最长 720h）、最大下载次数、吊销；
  token 只存 SHA-256、密码 scrypt、公开页 noindex、独立限流与审计、Range/HEAD/ETag。
- PWA：manifest、Service Worker（只缓存静态壳/资源）、offline.html、本地图标、安装提示、手机拍照上传；
  CSP 增加 `manifest-src`/`worker-src`。
- 监控告警：磁盘/温度/内存/服务/备份超期/待拉取备份/MC/欠压条件；通用 JSON webhook
  （10s×3 重试、可选 HMAC）；去重/冷却/恢复通知；面板告警历史与测试按钮；root 健康探针 units。
- 备份：两阶段协议（`--prepare/--pending/--ack/--snapshot-db`），PC 确认后才推进游标；
  未 ack 归档不删除，acked 最多 2；`.part`→SHA→原子改名→`.sha256` 旁文件；Sunday 漏跑补全量；
  备份任务显式 `-PiHost/-BackupRoot`，ACL 收紧，电池供电也运行，日志轮转。
- 灾备：age 加密 env/cloudflared/MC/opencode 凭证包；恢复文档、真实命令与演练记录模板。
- 部署：迁移前 DB 快照；健康检查失败自动回滚；retention 保护 current/previous；发布包包含 LICENSE。
- CI：前端 Vitest、生产依赖边界、shellcheck、nftables 语法、Windows PowerShell 解析/BOM 检查。

### Fixed / Security（v0.1.0 审计）

- **C1**：未认证 WebSocket upgrade 携带畸形 Cookie 不再导致进程退出；upgrade 全 try/catch +
  `uncaughtException` 兜底；新增回归测试。
- **H1**：改密/恢复码要求 TOTP，增加 IP/全局/TOTP 限流、失败审计、恒定延迟；会话 CSRF Cookie
  丢失时自动补发。
- trustProxy 收紧：仅 loopback 对端才采信 Cloudflare 转发头；X-Forwarded-Host 不参与安全判断。
- RCON 多包响应拼接（>4096B）、1 MiB 上限、超时/关闭不挂起；白名单复核保留。
- 上传全局预留 + statfs 余量 + ENOSPC→507；启动清理 24h tmp；错误映射不回显内部 message/路径。
- HSTS、AI 302/401/502 安全头、inline PDF XFO/CSP；登录限流 Map 容量上限。
- 审计动作名与服务端对齐，Activity 服务端 action 筛选；Files/Trash 请求竞态修复；改密 12 位；
  Markdown DOMPurify 禁 style；上传取消/超时；恢复码弹窗关闭保护；429 `details.retryAfterSec`；
  a11y 焦点/键盘/aria；Minecraft 强制刷新；回收站天数/域名/上传上限由服务端下发。
- 单文件上限按 Cloudflare Free/Pro 调整为 100 MiB。
- 备份软删除文件同步吊销分享；公开分享 metadata 对齐前端契约（active/requiresPassword）。
- RCON 密码已轮换（32 位随机）；Pi 已启用 memory cgroup（`MemoryMax=512M` 实际生效）。

### Operations

- Pi：Debian 安全更新、`age`、`unattended-upgrades`；health probe timer；memory cgroup；
  RCON 密码轮换；一次重启完成 MC 重启与验证。
- Windows：备份任务重装为两阶段脚本，ACL 仅当前用户 + Administrators + SYSTEM；D 盘实际路径见本地
  `.local/DEPLOYMENT.md`（不提交）。
- 公开仓库继续脱敏；实际域名/IP/备份路径/私钥只在本地。

### Known limitations

- SSH 密码登录保留（用户选择）；无 Cloudflare Access；单 SD 卡；Cloudflare 终止 TLS。
- 分享下载次数为会话级近似限制；清 Cookie 可在 5 分钟会话内绕过一次计数（个人分享可接受）。
- FTS5 unicode61 对中文按整段分词，含中文搜索自动回退 LIKE。
- 笔记无附件/版本历史；分享不支持目录；无音视频/WebDAV/多用户。
- Cloudflare 边缘约 100 MiB 请求体与 100s 超时；大文件后续需分片/对象存储。
- `http-proxy` 在 Node 26 有 `util._extend` 弃用警告，Node 27 前需评估替换。
- scrypt 仍为 N=2^15（升级需密码哈希版本迁移）。

## [0.1.0] - 2026-10-19

### Added

- 统一登录：密码（scrypt）+ TOTP 两步验证、恢复码、限流、CSRF、会话管理、审计日志。
- 云盘：目录树、拖拽/多文件上传与进度、10 GiB 配额、文件名搜索、图片/文本/Markdown/PDF 预览、
  Range 下载、回收站（30 天自动清理）、SHA-256 元数据。
- 工作台门户：主机指标（CPU/内存/温度/磁盘）、存储用量、Minecraft 状态/玩家/TPS/白名单数、
  opencode 健康、服务状态、备份状态、最近活动。
- Minecraft：SLP + RCON 只读状态；白名单增删（校验、执行后复核、审计）；不提供启停/任意命令。
- `ai.example.com`：会话校验 + Basic 注入的 opencode 反向代理（SSE/WebSocket）。
- 部署：Cloudflare Tunnel（app/ai）、systemd 服务、nftables 默认拒绝入站、release 目录与回滚脚本。
- 前端入口脚本加入 `data-cfasync="false"`，避免 Cloudflare Rocket Loader 改写 `type="module"`。
- 备份：Pi 端一致性 SQLite 快照 + 全量/增量归档 + SHA-256；Windows 计划任务每日 12:00 拉取到
  `%USERPROFILE%\AntifieldCloudBackups`；恢复文档与演练步骤。
- 工程：AGENTS.md、架构/安全/部署/备份/API/UI 文档、`node --test` 测试、ESLint/tsc、CI。

### Security

- 应用仅监听 loopback；RCON 仅 loopback；25565/80 限直连/校园网段。
- 文件内容不可变；预览类型白名单；SVG/HTML/XML 强制下载；CSP/安全响应头。
- opencode 端口不对外；代理覆写客户端 Authorization/Cookie。
- 服务用户 `antifieldcloud` 无 shell/无 sudo；systemd 沙箱。

### License

- MIT（见 `LICENSE`）。
