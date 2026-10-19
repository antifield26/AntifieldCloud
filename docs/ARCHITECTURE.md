# 架构

## 1. 总览

```text
Internet
 ├─ app.example.com ─┐
 ├─ ai.example.com  ─┼─ Cloudflare Edge ── cloudflared(antifieldcloud, 出站) ── 127.0.0.1:3000
 └─ mc.example.com:11798 ── SakuraFRP（现状保留，不走 antifieldcloud）

Raspberry Pi 5 (Debian 13, aarch64, 8 GB)
 ├─ antifieldcloud.service (User=antifieldcloud)
 │   ├─ Host app.* → React SPA + /api
 │   ├─ Host ai.*  → 会话校验 + 反向代理 → 127.0.0.1:4096 (opencode)
 │   ├─ SQLite /var/lib/antifieldcloud/db.sqlite
 │   ├─ 文件   /var/lib/antifieldcloud/files/<xx>/<id>
 │   ├─ SLP    → 127.0.0.1:25565
 │   ├─ RCON   → 127.0.0.1:25575（只读状态 + 白名单增删）
 │   └─ 主机指标 /proc、/sys、statfs、systemctl is-active
 ├─ opencode.service（现有）
 ├─ minecraft.service（现有）
 ├─ cloudflared.service（现有，新增 app/ai ingress）
 ├─ nginx :80（现有默认站，nftables 限 LAN）
 └─ nftables（新增）
```

## 2. 进程与请求路径

- 单 Node 进程；Fastify 监听 `127.0.0.1:3000`。
- `onRequest` 先按 `Host` 分流：
  - `ai.<域名>`：校验 `af_session`，注入 `Authorization: Basic` 后交给 `http-proxy` 反代 opencode；未登录 HTML 302 到登录页，API/WS 401。
  - `app.<域名>` 或 loopback：进入应用路由；附加上下文（不强制登录）。
  - 其它 Host：404。
- 应用路由：`/healthz` 公开；`/api/*` 需要会话（登录/健康检查除外）；写操作额外校验 CSRF。
- 静态资源：Vite 产物 `web/dist`，由 `@fastify/static` 提供；未匹配的 HTML 路径回退 `index.html`。
- WebSocket upgrade：`server.on('upgrade')` 只接受 ai 主机 + 有效会话，再转交 `http-proxy`。

## 3. 模块

| 模块 | 职责 |
|---|---|
| `server/src/config.ts` | 读取 env 文件/环境变量、数值校验、默认值 |
| `server/src/db.ts` | SQLite 打开、PRAGMA、版本化迁移、事务 |
| `auth/` | scrypt、TOTP、恢复码、挑战、会话、CSRF、限流、审计 |
| `files/` | 目录树、上传落库、配额、搜索、回收站、文本预览、MIME 安全分类 |
| `mc/` | SLP 查询、RCON 客户端、状态/metrics、白名单增删与复核 |
| `opencode/` | ai 主机的会话校验与认证反代 |
| `dashboard/` | 主机指标、服务状态、opencode 健康、备份状态、活动聚合 |
| `notes/` | 笔记/书签、标签、置顶、FTS5 搜索（v0.2.x） |
| `shares/` | 文件分享 token/密码/过期/次数/吊销、公开访问（v0.2.x） |
| `alerts/` | 阈值评估、状态去重/恢复、通用 webhook（v0.2.x） |
| `opencode/` | ai 主机认证反代；Rocket Loader opt-out 与原生新建按钮兼容垫片（v0.2.2，不添加可见 UI） |
| `http/` | 路由、守卫、错误处理、安全头、Host 分流、静态资源 |
| `cli/` | provisioning、两阶段备份 CLI |
| `web/` | React SPA（登录、Dashboard、文件、回收站、知识库、分享、MC、活动、设置、公开分享页、PWA） |

## 4. 数据模型

SQLite（WAL）核心表：

- `users`：单管理员；scrypt 哈希 + salt；TOTP secret；`totp_last_step` 防重放；恢复码哈希 JSON。
- `auth_challenges`：密码通过后的 5 分钟一次性挑战（只存 token 哈希）。
- `sessions`：会话 token 哈希、CSRF 哈希、7 天过期、IP/UA、last_seen。
- `files`：`id / parent_id / name / kind(file|dir) / size / mime / sha256 / storage_key / created_at / updated_at / deleted_at / deleted_parent_id`；`files(id)` 自引用；`deleted_parent_id=''` 表示从根目录删除。
- `audit_log`：动作、目标、IP；保留 90 天。
- `login_attempts`：登录成功/失败记录。
- `backup_state`：最近一次 PC 已确认的备份时间/归档/哈希/大小。
- `backup_archives`：pending/acked 归档（v0.2.x 两阶段协议）。
- `notes`、`bookmarks`、`tags`、`note_tags`、`bookmark_tags`、`notes_fts`、`bookmarks_fts`（v0.2.x）。
- `shares`、`share_sessions`：分享 token 哈希、密码、过期/次数、解锁会话（v0.2.x）。
- `alert_events`、`alert_state`：告警历史/去重冷却（v0.2.x）。

关键约束：
- 文件内容是**不可变**的：上传后不再改写；重命名/移动只更新元数据。增量备份因此只需新增文件。
- 配额 = 所有 `kind='file'` 的 `size` 之和（含回收站）；上传先在 `tmp/` 写完并校验，再原子 rename。
- 同一父目录下名称唯一（大小写不敏感），冲突自动追加 ` (n)`。
- 删除目录递归软删除；恢复时若原父目录不在则回到根目录。

## 5. 认证流程

1. `POST /api/auth/password`：限流 → scrypt 校验 → 生成 5 分钟挑战（DB 存哈希）→ 返回 challenge。
2. `POST /api/auth/totp`：校验 TOTP（±1 步，且 step > 上次使用）或恢复码 → 创建会话与 CSRF token → 设 Cookie。
3. 会话 Cookie：`af_session`（HttpOnly）+ `af_csrf`（可读）；HTTPS 下 `Secure; SameSite=Lax; Domain=.example.com`；loopback HTTP 例外。
4. 写操作：`X-CSRF-Token` 与 DB 内 CSRF 哈希比对；若带 Origin，还必须在 app/ai/loopback 白名单。
5. 改密/重置 TOTP 使其它会话失效；恢复码一次性。
6. v0.2.x：改密/重生成恢复码要求当前密码 + TOTP，并受限流/审计；CSRF Cookie 丢失时 `/api/auth/me` 自动补发。
7. 信任模型：`trustProxy:false`；仅 socket 为 loopback 时采信 `CF-Connecting-IP`/`X-Forwarded-Proto`，
   Host 只取原始 Host；`X-Forwarded-Host` 不参与安全判断。

## 6. 云盘数据流

- 上传：浏览器 XHR（进度）→ multipart → 逐文件流式写入 `tmp/`，同时计算 SHA-256、累计大小、检查配额 → 事务内再次校验配额并插入行 → rename 到 `files/<xx>/<id>`；失败清理临时文件。
- 列表/搜索/面包屑：全部按 DB 查询；搜索 `LIKE ... ESCAPE` 限 100 条。
- 预览：图片/PDF 通过 `/content?inline=1`（支持 Range、ETag）；文本/Markdown 通过 `/text` 返回 JSON（≤1 MiB）；SVG/HTML/XML 强制附件。
- 回收站：递归软删除；列表只显示顶层项；恢复递归；彻底删除删除物理文件。

## 7. Minecraft

- 状态：SLP（协议 775）拿版本/MOTD/在线数/样例玩家；RCON `list`/`tps`/`whitelist list` 补齐在线名/TPS/白名单数。
- 白名单：校验 `^[A-Za-z0-9_]{3,16}$` → 执行 `whitelist add|remove` → 重新查询确认 → 审计；不提供任意命令/启停。
- 降级：SLP 失败显示离线；RCON 失败时 TPS/白名单为 null，并在 `error` 字段说明；不影响文件功能。
- 反向代理：只允许固定上游 `http://127.0.0.1:4096`；注入 Basic，移除客户端 Cookie/Authorization。

## 8. 备份

- CLI 用 `node:sqlite` 的 `backup()` 生成一致性 DB 快照；从快照读 `backup_state` 与文件列表。
- 全量：所有文件；增量：`created_at > 上次成功备份` 的文件 + DB 快照 + manifest。
- `tar -czf` 归档，SHA-256；保留 2 份；空间不足拒绝。
- Windows 计划任务通过 SSH 触发 CLI、`scp` 拉取、校验、删除远端归档、写回状态 JSON。

## 9. 部署与运行

- `/opt/antifieldcloud/releases/<UTC>` + `current` 符号链接；systemd `antifieldcloud`（只读系统、仅数据目录可写、MemoryMax 512M）。
- 前端在 PC 构建；Pi 只安装生产依赖（`npm ci --omit=dev --ignore-scripts`）。
- nftables 默认拒绝入站；RCON 仅 loopback；25565/80 限直连/校园网段；SSH 全放行。

## 10. 信任边界与失败隔离

- Cloudflare 终止 TLS，Cloudflare 可见明文；TOTP 是应用层第二道门。
- opencode 自身 Basic 密码由服务端注入，不下发前端；opencode 端口不对外。
- Minecraft RCON 弱密码仍存在，但仅 loopback 可达；后续可轮换并加 fail2ban。
- 文件预览按类型白名单；HTML/SVG 不内联；文本预览由 React 转义。
- 应用故障不影响 Minecraft/opencode/桌面；cloudflared 故障只影响公网入口。
