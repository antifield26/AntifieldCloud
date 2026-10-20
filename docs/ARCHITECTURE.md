# 架构

## 1. 总览

```text
Internet
 ├─ app.example.com ─┐
 ├─ ai.example.com  ─┼─ Cloudflare Edge ── cloudflared(tunnel `pi`, 出站) ── 127.0.0.1:3000
 └─ mc.example.com:11798 ── SakuraFRP（现状保留，不走 antifieldcloud）

Raspberry Pi 5 (Debian 13, aarch64, 8 GB)
 ├─ antifieldcloud.service (User=antifieldcloud, 127.0.0.1:3000)
 │   ├─ Host app.* → React SPA + /api（含 /api/metrics、/api/shares、/api/storage）
 │   ├─ Host ai.*  → 会话校验 + Origin 校验 + 反向代理 → 127.0.0.1:4096 (opencode)
 │   ├─ SQLite /var/lib/antifieldcloud/db.sqlite（schema v6）
 │   ├─ 文件   /var/lib/antifieldcloud/files/<xx>/<id>（files.origin=user|note|system）
 │   ├─ 应用备份 /var/lib/antifieldcloud/backups（pending/acked/imports/secrets/db-predeploy-*）
 │   ├─ 世界备份 /var/lib/antifieldcloud/world-backups（world-<UTC>.tar.gz，保留 4 份）
 │   ├─ 只读状态 world-backup/world-pull/drill-status.json（脚本写入，应用只读）
 │   ├─ SLP    → 127.0.0.1:25565
 │   ├─ RCON   → 127.0.0.1:25575（只读状态 + 白名单增删）
 │   └─ 主机指标 /proc、/sys、statfs、systemctl is-active（60s 采样）
 ├─ antifieldcloud-world.service/.timer（root，周日 04:00，flock，4h 超时，沙箱）
 ├─ antifieldcloud-health.service/.timer（root，60s 写 /run/antifieldcloud/pi-health.json）
 ├─ opencode.service / minecraft.service / cloudflared.service（现有）
 └─ nftables（默认拒绝；22/25565 限网段，22 限速；25575 仅 loopback）
```

## 2. 进程与请求路径

- 单 Node 进程；Fastify 监听 `127.0.0.1:3000`。`main.ts` 在 listen 后启动告警评估与指标采样器。
- `onRequest` 先按 `Host` 分流：
  - `ai.<域名>`：校验 `af_session` 与 `Origin`，注入 `Authorization: Basic` 后交给 `http-proxy` 反代 opencode；未登录 HTML 302 到登录页，API/WS 401，Origin 非法 403 并审计。
  - `app.<域名>` 或 loopback：进入应用路由；附加上下文（不强制登录）。
  - 其它 Host：404。
- 应用路由：`/healthz` 公开（返回 `version`，生产由 `APP_VERSION` 注入）；`/api/*` 需要会话（登录/健康检查除外）；写操作额外校验 CSRF。
- 静态资源：Vite 产物 `web/dist`，由 `@fastify/static` 提供；未匹配的 HTML 路径回退 `index.html`。
- WebSocket upgrade：`server.on('upgrade')` 只接受 ai 主机 + 有效会话 + 合法 Origin，再转交 `http-proxy`。
- 指标采样：`metrics/sampler.ts` 每 `METRICS_SAMPLE_SECONDS`（默认 60）读取 HostMonitor 与配额用量写入 `metrics_samples`；维护任务按 `METRICS_RETENTION_DAYS`（默认 30）清理。
- 公开分享：`/api/public/shares/:token/*` 不挂会话，但 POST 校验 Origin、按 IP/用户限流；内容支持 Range/HEAD/ETag，多文件走 `items/:itemId/content`。

## 3. 模块

| 模块 | 职责 |
|---|---|
| `server/src/config.ts` | 读取 env 文件/环境变量、数值校验、默认值（含 v0.4.0 指标/笔记/世界备份键） |
| `server/src/db.ts` | SQLite 打开、PRAGMA、版本化迁移（schema v6）、事务；迁移前外键一致性检查与孤儿 shares 修复 |
| `auth/` | scrypt、TOTP、恢复码、挑战、会话、CSRF、限流、审计（字段截断） |
| `files/` | 目录树、上传落库、配额、搜索、回收站、文本预览、MIME 安全分类、`origin` 可见性 |
| `uploads/` | 分片上传会话/块索引、配额预留、断点状态、拼接与过期清理 |
| `mc/` | SLP 查询、RCON 客户端、状态/metrics、白名单增删与复核 |
| `opencode/` | ai 主机认证反代；HTTP/WS Origin 校验；HTML 模式 shim/attributes/passthrough |
| `backups/` | 归档导入/校验、full+inc 链解析、文件级恢复计划与执行、`skippedMissing`、世界/拉取/演练状态只读 |
| `dashboard/` | 主机指标、服务状态、opencode 健康、备份/密钥/世界/演练状态、活动聚合、`/api/storage` 轻量用量 |
| `metrics/` | 采样器（60s）、范围聚合查询（1h/6h/24h/7d/30d，最多 240 点）、保留期清理 |
| `notes/` | 笔记/书签、标签、置顶、FTS5 搜索；附件（`origin=note`）与版本历史 |
| `shares/` | 单文件/多文件分享 token/密码/过期/次数/吊销、公开元数据与逐项内容 |
| `alerts/` | 阈值评估、状态去重/恢复、通用 webhook；世界备份/拉取/演练超期 |
| `http/` | 路由、守卫、错误处理、安全头、Host 分流、静态资源 |
| `cli/` | provisioning、两阶段备份 CLI（prepare/pending/ack/snapshot-db） |
| `util/` | 时间/路径/响应/错误；`status.ts` 只读状态文件解析 |
| `web/` | React SPA（登录、Dashboard、文件、回收站、知识库、分享、MC、活动、设置、公开分享页、PWA） |

脚本与部署侧：`scripts/backup-world.mjs`（root 世界一致性备份）、`scripts/world-pull.ps1`（Windows 周度拉取/ack）、
`scripts/drill.ps1` + `scripts/drill-verify.mjs`（恢复演练）、`scripts/check-version.mjs`（版本一致性）；
`deploy/` 提供应用/健康探针/世界备份 systemd unit、nftables 与 env 模板。

## 4. 数据模型

SQLite（WAL）核心表（schema v6）：

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

世界备份/拉取/演练状态不在 SQLite：由 root/PC 脚本写 `/var/lib/antifieldcloud/{world-backup,world-pull,drill}-status.json`（0644，应用只读解析）。

关键约束：
- 文件内容是**不可变**的：上传后不再改写；重命名/移动只更新元数据。增量备份因此只需新增文件。
- 配额 = 所有 `kind='file'` 的 `size` 之和（含回收站与笔记附件），上限 10 GiB；上传先在 `tmp/` 写完并校验，再原子 rename。
- 同一父目录下同一 `origin` 名称唯一（大小写不敏感），冲突自动追加 ` (n)`；笔记附件与普通文件可同名。
- 删除目录递归软删除；恢复时若原父目录不在则回到根目录；`origin='note'` 行不进入回收站/用户目录树。

## 5. 认证流程

1. `POST /api/auth/password`：限流 → scrypt 校验 → 生成 5 分钟挑战（DB 存哈希）→ 返回 challenge；用户名超过 64 字符直接 400。
2. `POST /api/auth/totp`：校验 TOTP（±1 步，且 step > 上次使用）或恢复码 → 创建会话与 CSRF token → 设 Cookie。
3. 会话 Cookie：`af_session`（HttpOnly）+ `af_csrf`（可读）；HTTPS 下 `Secure; SameSite=Lax; Domain=.example.com`；loopback HTTP 例外。
4. 写操作：`X-CSRF-Token` 与 DB 内 CSRF 哈希比对；若带 Origin，还必须在 app/ai/loopback 白名单。
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
- **密钥包**：age 加密 env/cloudflared/Minecraft/opencode 配置与 opencode DB 一致性快照；明文只在 tmpfs 0700 临时目录；
  opencode 快照失败降级为 warning 仍打包其它文件；Pi `KEEP=2`，PC 拉取后不立即删除远端。
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
  staging 上限 2 GiB 且不超过可用空间 20%；归档内容浏览按 IP 限流（30 次/分钟）；整库恢复走 root CLI（停服 + pre-restore 快照 + 回滚）。
- **旧世界 cron**：验收后已从 `crontab` 移除 `minecraft-backups` 行；旧归档不自动删除，按 `docs/BACKUP.md`/`docs/DEPLOY.md` 手动清理。

## 9. 部署与运行

- `/opt/antifieldcloud/releases/<UTC>` + `current` 符号链接；systemd `antifieldcloud`（只读系统、仅数据目录可写、MemoryMax 512M、空 capability、设备/时钟/主机名/内核日志收紧）。
- 前端在 PC 构建；Pi 只安装生产依赖（`npm ci --omit=dev --ignore-scripts`）。
- 部署脚本：构建 → 打包 → 上传并校验 tar SHA-256 → 解包/npm ci → 迁移前 DB 快照 → 注入 `APP_VERSION` → 切换 current/重启
  → `/healthz` 断言版本；失败先停服、还原迁移前 DB 快照、切回 previous、启动、复检（无快照则拒绝自动回滚）。
- nftables 默认拒绝入站；22 仅直连/校园网段（新建连接限速 20/min），25565 仅同网段，25575 仅 loopback，DHCP 仅 eth0/wlan0；
  出站不限制。改动前确认当前 SSH 来源在允许网段内。
- 世界备份/健康探针 timer 由 root 运行；世界备份 unit 只读整机、仅 `/var/lib/antifieldcloud` 可写、flock 串行、4h 超时。

## 10. 信任边界与失败隔离

- Cloudflare 终止 TLS，Cloudflare 可见明文；TOTP 是应用层第二道门。
- opencode 自身 Basic 密码由服务端注入，不下发前端；opencode 端口不对外；HTTP/WS Origin 校验防跨站借用 Cookie。
- Minecraft RCON 已轮换强密码但仍监听所有接口，仅 nftables 限制为 loopback；世界备份脚本是唯一可发固定保存命令的组件，以 root 运行且沙箱化。
- 文件预览按类型白名单；HTML/SVG 不内联；音视频只播放白名单容器；文本预览由 React 转义。
- 笔记附件与普通文件用 `origin` 隔离；分享只接受活动普通文件，跨分享 itemId 一律 404。
- 备份归档导入是受 TOTP 门禁的管理员输入，但仍按不可信 tar 校验；不提供归档下载；Web 永不执行整库替换。
- 状态文件由 root/PC 脚本写、应用只读；文件缺失/损坏时面板与告警降级为 unknown，不影响主服务。
- 指标与审计只含元数据/主机数值；应用故障不影响 Minecraft/opencode/桌面；cloudflared 故障只影响公网入口。
