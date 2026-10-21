# Changelog

## [Unreleased] - 2026-10-21

### Changed

- **Pi 定时任务统一到正午 12:00**：`antifieldcloud-world.timer` 从「周日 04:00」改为「**周日 12:00 Asia/Shanghai**」（显式时区，`Persistent=true` 保留）；Pi 无其他 cron/at/用户 timer。健康探针 `antifieldcloud-health.timer` 仍每 60s（不属于可日调节的任务，改为每日会失去监控意义）；系统维护 timer（apt/logrotate/fstrim 等）保持发行版默认。
- 文档同步：README/AGENTS/ARCHITECTURE/BACKUP/DEPLOY/PLAN 的世界备份时刻与 Windows 周任务示例统一为 12:00；本地回滚备份 `/etc/systemd/system/antifieldcloud-world.timer.bak-v042`。用户 2026-10-21 确认：系统维护 timer 不动、健康探针维持 60s。

## [0.4.2] - 2026-10-20

### Changed

- **TypeScript 7 迁移**：采用官方并排方案——`@typescript/native` 别名安装 TypeScript 7.0.2 提供 `tsc`，`typescript` 别名指向 `@typescript/typescript6@6.0.2` 供 typescript-eslint 使用（8.71.2 尚不支持 TS7 API）；`typecheck`/`lint`/`test`/`build`/`npm ci` 全部通过。
- **Android 指标趋势布局**：周期范围按钮不再被 flex 压缩、标签不换行；趋势卡头部在 ≤900px 纵向排列，范围选择器横向滚动（隐藏滚动条），修复窄屏文字标签被挤压。
- **工作区清理与文档对齐**：删除生成的 `web/coverage`、`web/node_modules` 缓存与 `.vite-temp`；重新生成 `web/dist`；README/AGENTS/PLAN/ROADMAP/UI-SPEC/API/DEPLOY/BACKUP 版本与测试基线同步；CI 增加 `check-version` 校验。

### Dependencies

- `typescript` 6.0.3 → **7.0.2**（经 `@typescript/native` 别名）；保留 `@typescript/typescript6@6.0.2` 仅供 lint 工具链使用。

## [0.4.1] - 2026-10-20

### Changed

- **OpenCode 升级**：生产从 v2.0.32 升级到 **v2.1.1**（`opencode upgrade --method curl`）；升级前把二进制、配置、数据备份到 `/var/backups/opencode/`（93 MB 二进制 + 2 MB 数据快照 + env/service 副本）。
- **兼容性复核**：Basic `/api/session`、`POST /api/session`（垫片新建会话路径）、`/api/config|agent|provider`、真实 HTML 垫片注入（`data-cfasync` + `__af/oc-help.js`）、公开 `ai.*` 401、app healthz 均正常；Web 包仍含“新建会话/New session”标记，垫片选择器继续匹配。
- **凭据卫生**：轮换 OpenCode Basic 密码，同步 `/etc/opencode/opencode.env`、`/etc/antifieldcloud/env` 与两个 `service.json`；重启 opencode/antifieldcloud 后 Basic 与代理验证通过。
- **运维清理**：删除 Pi 旧世界归档 `/home/antifield/minecraft-backups`（3×约 3 GiB，释放约 9 GiB）；新世界备份与 PC 副本保留，旧 cron 保持停用。

### Dependencies

- 合并 Dependabot：`actions/checkout` 4→7、`actions/setup-node` 4→7、`gitleaks/gitleaks-action` 2→3（CI 全绿）。

### Docs

- `docs/DEPLOY.md` 增加 OpenCode v2.1.1 升级/兼容检查/回滚；`docs/ACCEPTANCE.md` 增加 v0.4.1；`docs/SECURITY.md` 更新 OpenCode 版本行为与凭据轮换说明；版本号升至 v0.4.1。

## [0.4.0] - 2026-10-20

### Added

- **可观测性**：主机指标每 60s 采样、保留 30 天（`metrics_samples`）；`GET /api/metrics?range=1h|6h|24h|7d|30d` 按桶聚合（CPU/内存/温度取平均、磁盘剩余取最小值、load1 取平均，最多 240 点）；Dashboard 四张 SVG 趋势卡；Activity 关键词 + 时间范围筛选；AlertsCard 状态/事件筛选与分页；`/api/storage` 轻量配额端点。
- **笔记附件**：每请求 1–5 个、单文件 ≤25 MiB、每笔记 ≤100 个；附件计入总配额但以 `origin='note'` 隔离，不出现在普通文件列表/搜索/回收站；`GET/POST/DELETE /api/notes/:id/attachments`，删除笔记级联硬删附件。
- **笔记版本历史**：标题/正文/标签变化时自动快照，每笔记保留最近 20 个版本；列表/详情/恢复接口，恢复前自动保存当前版本，跨笔记版本 404。
- **多文件分享**：`POST /api/shares {fileIds}` 一次分享 1–50 个活动普通文件；`ShareItem/PublicShareInfo` 增加 `itemCount/totalSizeBytes`；公开页返回 `items` 并支持逐文件 `/api/public/shares/:token/items/:itemId/content`；多文件分享的旧 `/content` 返回 409 `share_bundle`；下载次数按分享会话计；任一文件删除/回收站吊销整个分享。
- **Minecraft 世界一致性备份**：`scripts/backup-world.mjs`（root）按 `save-off → save-all flush → tar → save-on`（finally）生成 gzip 归档，校验 gzip/SHA-256，写状态 JSON，保留最新 4 份且不触碰旧 legacy 归档；`deploy/antifieldcloud-world.service/.timer`（周日 04:00、Persistent、flock、4h 超时、systemd 加固）。
- **世界备份拉取**：`scripts/world-pull.ps1` 两阶段拉取（scp `.part` → SHA 比对 → 原子改名 → 远端 ack 删除 → 本地保留 4 份）；失败保留远端不 ack；UTF-8、硬超时与杀进程树。
- **恢复演练自动化**：`scripts/drill.ps1` + `drill-verify.mjs` 校验 full+inc 链、`.sha256` 旁文件、tar 条目安全、最新 DB `integrity_check/foreign_key_check/schema_version`、manifest；输出 `report.json/report.md`、保留 180 天；可选 `-IncludeWorld` 解包验证 `world/level.dat` 并回写 `drill-status.json`。
- **灾备状态与告警**：`/var/lib/antifieldcloud/{world-backup,world-pull,drill}-status.json`（0644，应用只读）；Dashboard/Settings 与 `/api/dashboard`、`/api/backups` 展示；新增 `world_backup_stale`、`world_pull_stale`、`drill_stale` 告警。
- **部署**：APP_VERSION 从 release `package.json` 注入并校验 `/healthz.version`；部署后运行只读 smoke 子集；磁盘/tar SHA/npm 预检；备份拉取状态写失败不触发重复归档；PS 5.1 UTF-8 输出编码修复。
- **env**：`BACKUP_PREPARE_TIMEOUT_SEC`、`WORLD_BACKUP_STATUS_FILE`、`WORLD_PULL_STATUS_FILE`、`DRILL_STATUS_FILE`、`ALERT_WORLD_BACKUP_MAX_AGE_HOURS`、`ALERT_DRILL_MAX_AGE_DAYS`、`NOTE_ATTACHMENT_MAX_BYTES`、`NOTE_MAX_ATTACHMENTS`、`NOTE_VERSIONS_KEEP`、`SHARE_MAX_ITEMS`、`METRICS_ENABLED`、`METRICS_SAMPLE_SECONDS`、`METRICS_RETENTION_DAYS`；`APP_VERSION` 默认读 `package.json`。
- **CI/测试**：新增 coverage（服务端/前端覆盖率门禁，阈值不变）、audit（生产依赖）、secret-scan（gitleaks）、Dependabot；
  CI 增加 concurrency/timeout；PowerShell job 覆盖全部 `scripts/*.ps1`（UTF-8 BOM + PS 5.1 解析）；`scripts/test/` 运维脚本单元测试纳入 `npm test`；
  新增 `npm run test:coverage`、`npm run test:web:coverage`、`node scripts/check-version.mjs`。最终基线：`npm test` 234 项（服务端 218 + 脚本 16）、前端 129 项。

### Changed

- **数据库 schema v6**：迁移 5 为结构变更（`files.origin`、唯一索引含 origin、`note_attachments`、`note_versions`、`share_items` 回填、`metrics_samples`）；迁移 6 为数据修复（删除指向不存在文件的孤儿 shares、`INSERT OR IGNORE` 回填 `share_items`，不改变表结构）；数据库 schema 高于程序支持版本时拒绝启动。
- 文件/分享/恢复路径统一按 `files.origin` 隔离：普通云盘只操作 `origin='user'`，笔记附件仅经笔记接口管理；配额仍统计全部 `kind='file'`。
- 备份 CLI：`--pending` 只统计 `origin='pi'` 的归档；新增 `warnings/skippedMissing/missingFiles/missingFileCount/partials` 输出；manifest 增加 `skippedMissing/warnings`；
  `--prepare` 超时对齐 3300s（env `BACKUP_PREPARE_TIMEOUT_SEC`，60–7200 秒）；`--ack` 在同一事务内提交归档行、游标、`meta.backup_missing_files` 与审计；
  物理文件缺失记录到 `skippedMissing`/meta，恢复后强制纳入下一次增量；陈旧锁（>1h）可接管并 warn；归档先写 `.part` 后原子改名；恢复链按来源（Pi/导入）隔离；
  归档快照行数/staging 字节上限；归档内容浏览按 IP 限流（30 次/分钟）。
- 密钥包：明文临时目录优先 `/run/antifieldcloud/secrets-tmp`（tmpfs，退出清理）；opencode 快照失败降级为 warning 并继续打包其它密钥文件；Pi 端 `KEEP=2` 滚动保留，PC 拉取后不再立即删除远端。
- 旧世界备份 cron 在验收后停用（`crontab` 移除 `minecraft-backups` 行）；旧 9 GiB 归档不自动删除，`docs/DEPLOY.md`/`docs/BACKUP.md` 给出手动清理命令。
- 部署回滚顺序改为 stop → 还原迁移前 DB 快照 → 切换 release → start → 健康检查；无迁移前快照时拒绝自动回滚并打印手工步骤。
- 登录/TOTP 全局限流调整（全局 60 次/小时、TOTP 全局 120 次/小时，loopback 不占全局桶）；未认证用户名超长直接拒绝；审计 actor/target/detail 截断。
- opencode 代理对 HTTP 与 WebSocket 均校验 `Origin`（仅 app/ai 正式 origin，loopback 开发例外），拒绝时 403 + `opencode_origin_rejected` 审计。
- 分享下载计数改为内容流完整读完后 +1（客户端中断不计次）；多文件分享只暴露首文件名用于审计。

### Fixed

- 孤儿分享行会导致迁移 5 回填失败：迁移前清理 + 迁移 6 数据修复；迁移前执行 `PRAGMA foreign_key_check`，其它外键损坏拒绝启动（避免迁移中写入更混乱数据）。
- 笔记附件上传失败回滚、删除笔记后附件清理、无关联附件孤儿维护对账；列表接口批量读取附件避免 N+1。
- 备份生成超时/失败后清理本次锁与 `.part` 残片；物理文件缺失时跳过并记录 `skippedMissing`，避免每日备份永久失败。
- opencode 代理未登录 HTML/WS 与 Origin 拒绝路径的安全头/审计一致性；回收站/目录删除吊销包含该文件的多文件分享。
- 前端：笔记附件与版本抽屉、多文件选择与分享、公开页文件清单、Dashboard 趋势/备份状态卡、告警筛选分页、Activity 筛选、上传“放弃并清理”（显式 DELETE 分片会话）等交互修复。
- Windows 脚本：ACL 逐项校验、icacls 退出码检查、安装标记、任务参数回读校验、状态写入幂等、`Start-Process` 硬超时杀进程树。

### Security

- `antifieldcloud.service` 加固：`CapabilityBoundingSet=`（空）、`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`、`PrivateDevices`、`ProtectClock/Hostname/KernelLogs`、`RestrictNamespaces/SUIDSGID/Realtime`、`LockPersonality`、`StartLimitIntervalSec/Burst`；世界备份 unit 同样加固并限制可写路径。
- nftables：默认拒绝入站；22 仅允许 `169.254.77.0/24` + `172.23.88.0/21` 且新建连接限速 5/min；25565 仅同网段；25575 仅 loopback；DHCP 仅 `eth0`/`wlan0`；80 不再放行。
- 世界备份脚本 root-only、RCON 仅执行固定 `save-off/save-all flush/save-on`；应用 API 仍不提供任意 RCON。
- 笔记附件 origin 隔离、多文件分享条目归属校验（跨分享 itemId 404）、公开逐项下载计数与会话绑定；metrics 端点需登录；备份归档浏览限流、tar/staging 上限；审计字段截断。
- 残留风险明确披露：SSH 密码登录与 `antifield` 用户 `NOPASSWD ALL` sudo 未改（用户选择）、RCON 监听 0.0.0.0、单 SD、Cloudflare 明文、限流内存态等（见 `docs/SECURITY.md`）。

### Docs

- 同步 README/AGENTS/ARCHITECTURE/SECURITY/DEPLOY/BACKUP/ROADMAP/PLAN/UI-SPEC；修正测试数字、服务监控 3 项、nftables 网段、隧道名 `pi`、备份保留语义（30 天/56 天/90 天）、分享密码规则（≥8）、上传总进度等文档漂移（审计 OP-19/WE-24）。
- 新增世界备份/PC 拉取/恢复演练安装与回滚、nftables/systemd 加固应用与回滚、v0.4.0 部署步骤、迁移前快照/回滚与常见问题；更新备份覆盖范围与旧 cron/旧归档迁移说明。

### Known limitations（v0.4.0 明确不修）

- DR-1：增量依赖 `created_at` 水位，系统时钟回拨或同毫秒写入仍可能漏备；prepare 写 warnings，依赖 NTP + 每周全量兜底。
- DR-7：Web 导入归档（`origin='import'`）无删除/保留策略，会持续占用磁盘，需人工核对清理。
- DR-22：告警只在状态变化时投递，持续故障跨周期不重复提醒。
- DR-23：`.backup.lock` 无心跳续租，超过 1 小时按陈旧锁接管，长任务与并发运行可能竞争。
- 其余残留（SSH/sudo、RCON 监听、单 SD、Cloudflare 明文、限流内存态等）见 `docs/SECURITY.md` §4。

## [0.3.2] - 2026-10-20

### Changed

- 移除旧入口：`nginx`/`nginx-common`/`certbot`/`python3-certbot*` 及 `/etc/nginx`、`/etc/letsencrypt`、`/var/www/html`、nginx 日志/状态；80 端口关闭。
- 服务监控与告警从 4 项降为 `minecraft/cloudflared/opencode`；前端服务状态卡同步为 3 项，避免误报 nginx 离线。
- nftables 移除 80 端口放行，仅保留 Minecraft 25565（直连/校园网段）。
- 清理 workbench/piforge 残留、旧 `antifieldcloud.service.pre-*`、`cloudflared-update.*`、旧 env/RCON 备份；`.local` 冗余记录清理。

### Docs

- 更新 DEPLOY/API/UI/ARCH/SECURITY/ACCEPTANCE/AGENTS；补充旧入口与残留清理记录。

## [0.3.1] - 2026-10-20

### Added

- 大文件分片上传：单文件 5 GiB、8 MiB/块、断点续传、配额预留、24h 会话过期、每用户 3 并发；不做对象存储。
- `POST /api/uploads`、`PUT /api/uploads/:id/chunks/:idx`、`GET`、`complete`、`abort`；migration 4（`upload_sessions` / `upload_chunks`）。
- 前端大文件自动分片：>100 MiB 走分片，并发 2 块，localStorage 只保存 uploadId/已收块号；刷新/断线自动补缺块；取消后重试可续传。
- 审计/运维：persistent journald（log2ram 64 MiB 上限）、cloudflared 2026.10.1 + systemd 加固、nftables WiFi 源收窄到 `/21`、rpcbind 禁用、unattended-upgrades dry-run 验证。

### Docs

- 补档第二轮审计记录 `docs/AUDIT.md`（A2-01～A2-10、执行边界、回归证据与残留）；工作区临时测试产物清理。

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
