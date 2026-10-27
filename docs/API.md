# AntifieldCloud HTTP API 契约

服务端与前端共同遵守本文件。所有路径除特别说明外均以 `https://app.example.com` 为源（占位域名；实际见 `.local/DEPLOYMENT.md`）。

## 0. 约定

- JSON 请求/响应：`Content-Type: application/json; charset=utf-8`。
- 时间：ISO 8601 UTC 字符串（如 `2026-10-19T09:00:00.000Z`）；前端按 `Asia/Shanghai` 展示。
- 文件 ID：不透明字符串（UUID），前端不得解析其含义。
- 分页：`page` 从 1 开始；文件默认 200、最大 500；笔记/书签默认 20、最大 100；响应含 `page/pageSize/total`。
- 统一错误体：

```json
{ "error": { "code": "invalid_credentials", "message": "用户名或密码错误", "details": { } } }
```

- 常见状态码：`400 invalid_request`、`401 unauthenticated/invalid_password`、`403 csrf_failed`、`404 not_found`、`410 share_expired/share_revoked/share_exhausted`、`409 conflict/quota_exceeded/archive_encrypted/chunk_conflict/backup_busy/restore_busy/plan_expired/archive_exists`、`413 file_too_large`、`415 unsupported_media_type`、`429 rate_limited`、`500 internal_error`、`502 lofii_auth_failed/lofii_upstream_error`、`503 bot_disabled/bot_key_missing/bot_ai_tool_isolation_unavailable/bot_ai_context_unavailable/lofii_disabled/lofii_control_disabled/lofii_unavailable`、`507 insufficient_storage`。`429` 同时带 `Retry-After` 响应头与 `error.details.retryAfterSec`。
- 认证：登录成功后服务端在 **app 主机**下发 host-only `af_session`（HttpOnly）与 `af_csrf`（可读）Cookie（均不设 `Domain`；`ai` 主机使用独立 host-only 会话 Cookie）。除 `GET/HEAD` 外的所有 `/api` 请求必须带 `X-CSRF-Token: <af_csrf>`，并满足 `Origin` 为 `https://app.example.com` / 本机；`ai` 源不再作为 app 写请求的受信 Origin。例外：公开 Bot Webhook `POST /api/bot/webhook/:botId` 不挂会话/CSRF，只按平台签名（及时间戳/去重）鉴权（见 §14）；既有公开分享 `POST /api/public/shares/:token/unlock` 也只校验 Origin 与限流。
- AI 主机 SSO：app 登录/已登录后访问 `GET /api/auth/ai-ticket?next=<ai 完整 URL>`，服务端校验 `next` 必须属于配置的 `AI_ORIGIN`，签发 60 秒一次性 ticket 并 302 到 `https://ai.example.com/__af/sso/<ticket>?next=<ai 相对路径>`；代理校验/消费 ticket 后设置 ai 主机 host-only `af_session` 并 302 到目标路径。ticket 一次性、绑定 aiOrigin、不落库。
- Bot 功能开关：`BOT_ENABLED=false` 或缺少 `BOT_SECRET_KEY` 时，Webhook 一律 `404 not_found`，`/api/bots*` 写操作返回 `503 bot_disabled`/`bot_key_missing`；`GET /api/bots/status` 仍可读。
- Lofii 功能开关（v0.8.0）：`LOFII_ENABLED=false` 时 `/api/lofii/status` 仍返回 `enabled:false` 的空壳快照，其余 `/api/lofii/*` 返回 `503 lofii_disabled`；`LOFII_CONTROL_TOKEN` 为空时 `/tasks*`、`/move` 返回 `503 lofii_control_disabled`（`/status`、`/history`、`/say` 仍可用）。上游未启用/网络不可达返回 `503 lofii_unavailable`，鉴权失败/上游异常返回 `502 lofii_auth_failed`/`lofii_upstream_error`。响应与错误文本不包含 Lofii URL/Token。
- 安全响应头：`Cache-Control: no-store`（静态 hash 资源除外）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、CSP（见 docs/SECURITY.md）。
- 登录限制：每 IP 5 次失败/15 分钟；全局 60 次/小时（密码）、120 次/小时（TOTP），loopback 来源不占全局桶。`429` 响应包含 `retryAfterSec`。
- 单文件上限：普通 multipart **100 MiB**（`MAX_UPLOAD_BYTES=104857600`，匹配 Cloudflare 代理）；更大文件走分片上传。超过返回 `413 file_too_large`，磁盘不足返回 `507 insufficient_storage`。
- 未登录访问 `ai.example.com` 的 HTML 请求：`302` 到 `https://app.example.com/login?next=https%3A%2F%2Fai.example.com%2F`；app 登录页对 ai 外部 `next` 先走 `/api/auth/ai-ticket` → ai `/__af/sso/<ticket>`，再由代理设置 ai host-only 会话 Cookie；API/WebSocket 未认证返回 `401`。
- 未知 Host 返回 `404`（应用只接受 app/ai 与 loopback）。
- 再认证：`POST /api/account/password` 与 `/api/account/recovery-codes` 需要当前密码 + `totpCode`；每 IP 5 次/15 分钟 + 再认证全局 30/h + TOTP 全局 120/h（与登录共享），失败审计，恒定延迟。

## 1. 健康检查

`GET /healthz`（无需认证）

```json
{ "ok": true, "version": "0.8.0", "schemaVersion": 17, "uptimeSec": 1234, "db": "ok", "pendingBackups": 0 }
```

- `db`：轻量就绪标记（DB 可读为 `ok`）；`pendingBackups`：未 ack 且未删除的备份归档数（只读聚合，不含敏感信息）。
- 失败时返回 503/错误体；`/healthz` 仍为 Cloudflare Access bypass（见 `docs/DEPLOY.md` §5.2）。

## 2. 认证与账号

### POST /api/auth/password

```json
{ "username": "antifield", "password": "********" }
```

成功 `200`：

```json
{ "challenge": "opaque-token", "expiresIn": 300 }
```

失败：`401 invalid_credentials`（不区分用户不存在/密码错误）；`429 rate_limited`。

### POST /api/auth/totp

```json
{ "challenge": "opaque-token", "code": "123456" }
```

或恢复码：

```json
{ "challenge": "opaque-token", "recoveryCode": "ABCDE-12345" }
```

成功 `200`：设置会话 Cookie，返回：

```json
{ "user": { "username": "antifield" }, "csrfToken": "csrf-value" }
```

失败：`401 invalid_code`、`410 challenge_expired`、`429 rate_limited`。

### GET /api/auth/ai-ticket?next=\<ai 完整 URL\>

需要 app 主机会话。`next` 必须与配置的 `AI_ORIGIN` 完全同源（`https://ai.example.com/...`），否则 `400 invalid_request`。
成功返回 `302` 到 `https://ai.example.com/__af/sso/<ticket>?next=<ai 相对路径>`；ticket 一次性、60 秒有效、绑定 aiOrigin，用于给 ai 主机设置 host-only `af_session`。未登录 `401 unauthenticated`。

### POST /api/auth/logout

需要会话 + CSRF。成功 `200 { "ok": true }`。

### GET /api/auth/me

需要会话。成功：

```json
{
  "user": { "username": "antifield" },
  "csrfToken": "csrf-value",
  "session": { "createdAt": "…", "expiresAt": "…", "ip": "…", "userAgent": "…" }
}
```

未登录 `401 unauthenticated`。

### POST /api/account/password

```json
{ "currentPassword": "old", "newPassword": "new" }
```

成功 `200 { "ok": true }`，除当前会话外的其它会话失效。

### POST /api/account/recovery-codes

```json
{ "password": "current" }
```

成功 `200 { "codes": ["…", "…"] }`（一次性展示，仅返回一次）。

### POST /api/account/logout-all

成功 `200 { "ok": true }`，注销全部会话（含当前）。

## 3. 仪表盘与审计

### GET /api/dashboard

```json
{
  "host": {
    "hostname": "RPI5",
    "uptimeSec": 1234,
    "load": [0.1, 0.2, 0.3],
    "cpuPercent": 12.3,
    "mem": { "totalBytes": 1, "usedBytes": 1, "availableBytes": 1 },
    "tempC": 48.2,
    "root": { "totalBytes": 1, "usedBytes": 1, "freeBytes": 1 }
  },
  "storage": {
    "quotaBytes": 10737418240,
    "usedBytes": 1234,
    "trashBytes": 0,
    "fileCount": 3,
    "freeBytes": 1
  },
  "minecraft": {
    "online": true,
    "version": "Paper 26.1.2",
    "motd": "Raspberry Pi 5 | Minecraft LAN",
    "players": { "online": 0, "max": 5, "names": [] },
    "tps": { "m1": 20.0, "m5": 20.0, "m15": 20.0 },
    "whitelistCount": 7,
    "serviceActive": "active",
    "publicAddress": "mc.example.com:11798",
    "checkedAt": "…",
    "error": null
  },
  "opencode": { "reachable": true, "url": "https://ai.example.com", "sessions": 3 },
  "services": { "minecraft": "active", "cloudflared": "active", "opencode": "active" },
  "backup": { "lastPullAt": "…", "ageHours": 12.3, "sizeBytes": 123456, "ok": true, "overdue": false, "encryptedPendingCount": 1, "encryptedAckedCount": 0, "encryption": { "enabled": true, "keyConfigured": true }, "offsite": { "lastRunAt": "…", "ok": true, "remoteLabel": "myremote", "uploaded": 1, "skipped": 0, "failed": 0, "bytes": 123456, "keptRemote": 12, "plaintextSkipped": 0, "error": null } },
  "activity": [
    { "id": 1, "ts": "…", "action": "login", "target": null, "detail": null, "ip": "…" }
  ],
  "generatedAt": "…"
}
```

`minecraft.error` 可为 `null`；`backup` 恒为对象，但 `lastPullAt/ageHours/sizeBytes` 等字段可为 `null`；`services.*` 取值 `active|inactive|unknown`。`opencode.sessions` 不可得时为 `null`。
`backup` 另含 `encryptedPendingCount/encryptedAckedCount/encryption{enabled,keyConfigured}/offsite`：
`encryption` 只表示开关与 Pi 端 age 公钥文件是否存在（不读取私钥）；`offsite` 为 PC 写入的只读状态对象（缺失为 `null`，视为未配置），
只含别名/计数/时间，不含远端真实路径/URL/凭据。

### GET /api/audit?limit=50&offset=0&action=login

`limit` 1–200，默认 50；`action` 可选，精确匹配动作名（如 `login`/`whitelist_add`）。响应：

```json
{ "items": [ { "id": 1, "ts": "…", "action": "whitelist_add", "target": "Steve", "detail": null, "ip": "…" } ], "total": 1 }
```

## 4. 文件与目录

### FileItem

```json
{
  "id": "uuid",
  "parentId": "uuid|null",
  "name": "报告.pdf",
  "kind": "file|dir",
  "size": 12345,
  "mime": "application/pdf",
  "sha256": "…|null",
  "createdAt": "…",
  "updatedAt": "…",
  "previewKind": "image|text|markdown|pdf|none",
  "inlineAllowed": true,
  "deletedAt": null,
  "originalParentId": null,
  "originalPath": null
}
```

`previewKind` 仅对文件有意义；`inlineAllowed` 表示是否允许 `?inline=1` 内联（仅栅格图片/PDF）；
`deletedAt/originalParentId/originalPath` 仅在回收站接口返回。

### GET /api/files

查询参数：`parentId`（省略=根）、`page`、`pageSize`、`sort=name|updated|size`、`dir=asc|desc`。

```json
{
  "items": [ FileItem ],
  "page": 1,
  "pageSize": 200,
  "total": 3,
  "breadcrumb": [ { "id": null, "name": "全部文件" }, { "id": "uuid", "name": "文档" } ]
}
```

### GET /api/files/search?q=xxx

文件名搜索（活动文件，最多 100 条）：

```json
{ "items": [ FileItem ], "total": 2 }
```

`q` 为空返回空列表。

### GET /api/files/:id

返回 `FileItem`，附加 `path`：

```json
{ "item": FileItem, "path": [ { "id": null, "name": "全部文件" }, { "id": "uuid", "name": "文档" } ] }
```

### POST /api/files/folder

```json
{ "parentId": "uuid|null", "name": "新文件夹" }
```

成功 `201 FileItem`。同名自动追加 ` (2)`。失败 `400 invalid_name`、`409 already_exists`（目录超过深度）、`507`。

### POST /api/files/upload

`multipart/form-data`：

- 字段 `parentId`（可选，空=根；也可用查询参数 `?parentId=`）
- 文件字段名 `files`（可多个；普通单请求单文件 ≤ 100 MiB；单请求 ≤ 20 个文件；更大文件走分片上传）

成功 `200`（允许部分失败）：

```json
{
  "items": [ FileItem ],
  "errors": [ { "name": "x.bin", "code": "quota_exceeded", "message": "空间不足" } ]
}
```

全部失败时返回对应错误状态（`409 quota_exceeded` / `413 file_too_large` / `507 insufficient_storage`）。文件名自动清洗/去重。

### PATCH /api/files/:id

```json
{ "name": "新名字", "parentId": "uuid|null" }
```

字段均可选，至少一个。成功 `200 FileItem`。失败 `404`、`409 already_exists/cycle_detected`、`400 invalid_name`。

### DELETE /api/files/:id

软删除（目录递归）。成功 `200 { "ok": true, "id": "uuid", "count": 1 }`（count 为递归删除的条目数）。

### GET /api/files/:id/content

查询参数：
- `inline=1`：栅格图片、PDF、白名单音视频（mp4/webm/mp3/m4a/ogg/flac/wav）返回 `Content-Disposition: inline`；其它类型忽略该参数。
- `download=1`：强制附件。

默认按 `previewKind` 决定 inline/attachment。支持 `Range: bytes=…`（单区间，206；不可满足 416）。响应头包含 `Content-Type`、`Content-Length`、`Content-Disposition`（RFC 5987）、`Accept-Ranges: bytes`、`ETag`。禁止内联 SVG/HTML/XML；音视频不转码。`GET` 路由自动提供 `HEAD`。

### GET /api/files/:id/text

仅文本类（`previewKind=text|markdown`）。成功：

```json
{ "name": "a.md", "mime": "text/markdown", "size": 123, "truncated": false, "content": "…" }
```

非文本 `415 unsupported_media_type`；超过 1 MiB 时 `truncated: true` 并只返回前 1 MiB。

### 分片上传

大文件（`/api/version` 的 `chunkedUploadEnabled=true` 且大于 `maxUploadBytes`）走分片；每块 `application/octet-stream`，默认 8 MiB，单文件上限 5 GiB。所有写操作要求登录 + `X-CSRF-Token`；会话仅创建者可见。

#### POST /api/uploads

```json
{ "name": "movie.mp4", "parentId": "uuid-or-null", "size": 5242880000, "sha256": "optional-hex" }
```

成功 `201`：

```json
{ "uploadId": "uuid", "chunkSize": 8388608, "totalChunks": 626, "expiresAt": "ISO", "received": [] }
```

`400 invalid_size/invalid_sha256`、`409 too_many_uploads/quota_exceeded`、`413 file_too_large`、`507 insufficient_storage`。

#### PUT /api/uploads/:id/chunks/:index

Header：`Content-Type: application/octet-stream`；body 必须是该块的精确字节数（尾块为剩余大小，其它块为 `chunkSize`）。可乱序、可重试；同索引同内容幂等，不同内容 `409 chunk_conflict`。成功 `200 { "index": 0, "received": 1 }`。越界 `400 invalid_chunk_index`，大小不符 `400 invalid_chunk_size`。

#### GET /api/uploads/:id

成功 `200`：

```json
{ "uploadId":"uuid","fileName":"movie.mp4","size":5242880000,"chunkSize":8388608,"totalChunks":626,"received":[0,1],"missing":[2],"status":"uploading","expiresAt":"ISO" }
```

`status='completed'` 时额外返回 `fileId`（已登记文件），前端可据此在响应丢失后直接结束而不重传。

#### POST /api/uploads/:id/complete

body 可带 `{ "sha256": "hex" }`；服务端校验缺块、拼接、SHA 后调用文件登记，返回 `200 { "ok": true, "file": FileItem }`。缺块 `400 chunks_missing`；SHA 不匹配 `400 checksum_mismatch`；重复 complete 幂等返回已登记文件。

#### DELETE /api/uploads/:id

取消会话并清理临时块；成功 `200 { "ok": true }`。已完成的会话不能取消（`409 upload_completed`）。

限制：24h 会话过期、每用户最多 3 个活跃会话；过期/取消释放配额预留；维护任务清理过期块目录。

## 5. 回收站

### GET /api/trash?page=1&pageSize=200

```json
{ "items": [ FileItem ], "page": 1, "pageSize": 200, "total": 1, "trashBytes": 1234 }
```

### POST /api/trash/:id/restore

成功 `200 FileItem`（`deletedAt=null`）。原父目录不存在时恢复到根目录。重名自动追加后缀。

### DELETE /api/trash/:id

彻底删除（目录递归），成功 `200 { "ok": true, "count": 2, "freedBytes": 1234 }`。

### DELETE /api/trash

清空回收站，成功 `200 { "ok": true, "count": 3, "freedBytes": 5678 }`。

## 6. Minecraft

### GET /api/mc/status

可选 `?force=1` 跳过 10 秒缓存。

```json
{
  "online": true,
  "version": "Paper 26.1.2",
  "motd": "Raspberry Pi 5 | Minecraft LAN",
  "players": { "online": 0, "max": 5, "names": [] },
  "tps": { "m1": 20.0, "m5": 20.0, "m15": 20.0 },
  "whitelistCount": 7,
  "serviceActive": "active",
  "publicAddress": "mc.example.com:11798",
  "checkedAt": "…",
  "error": null
}
```

SLP 失败时 `online:false`，`error` 为简短原因；RCON 不可用时 `tps=null`、`whitelistCount=null`，并在 `error` 中说明。

### GET /api/mc/whitelist

```json
{ "names": ["Antifield", "Steve"], "checkedAt": "…", "error": null }
```

RCON 不可用：`502 rcon_unavailable`。

### POST /api/mc/whitelist

```json
{ "name": "Steve" }
```

成功 `200 { "ok": true, "name": "Steve", "names": ["…"], "checkedAt": "…", "error": null }`。名字规则 `^[A-Za-z0-9_]{3,16}$`；已存在 `409 already_whitelisted`；RCON 失败 `502`。

### DELETE /api/mc/whitelist/:name

成功 `200 { "ok": true, "name": "Steve", "names": ["…"], "checkedAt": "…", "error": null }`；不存在 `404 not_whitelisted`；RCON 失败 `502`。

## 7. 其它

- `GET /api/version`（需要会话）：`{ "version": "0.8.0", "schemaVersion": 17, "appOrigin": "https://app.example.com", "aiOrigin": "https://ai.example.com", "trashRetentionDays": 30, "maxUploadBytes": 104857600, "sharesEnabled": true, "alertsEnabled": true, "backupRestoreEnabled": false, "backupImportMaxBytes": 104857600, "backupRestoreMaxEntries": 5000, "backupArchiveEncryption": false, "backupAgeRecipientConfigured": false, "backupOffsiteStatusConfigured": false, "chunkedUploadEnabled": true, "chunkSizeBytes": 8388608, "chunkMaxFileBytes": 5368709120, "noteAttachmentMaxBytes": 26214400, "noteMaxAttachments": 100, "noteVersionsKeep": 20, "shareMaxItems": 50, "metricsEnabled": true, "metricsSampleSeconds": 60, "metricsRetentionDays": 30, "botsEnabled": false, "botPlatforms": ["qq"], "lofiiEnabled": false, "lofiiControlEnabled": false, "audit": { "failureCount": 0, "lastError": null, "lastFailureAt": null, "persisted": true } }`。
  - `schemaVersion`（程序支持的 schema，前端用于演练一致性提示）、`backupArchiveEncryption`/`backupAgeRecipientConfigured`/`backupOffsiteStatusConfigured`（只读状态，不含密钥/路径）、`audit`（审计写入失败计数/最近错误/时间，不含明细）。旧服务端不下发时前端按关闭/未配置/null 降级。
  - `lofiiEnabled`/`lofiiControlEnabled`（v0.8.0）：Lofii 集成是否启用、控制接口是否可用（`LOFII_ENABLED=true` 且 `LOFII_CONTROL_TOKEN` 非空）；前端据此决定 `/minecraft` 是否显示 Lofii 标签与控制操作。两者都不含 Lofii 地址/Token。
  - schema **17**；`audit.persisted` 表示诊断是否来自 DB 持久化行（DB 不可用时 false，回退内存计数）。
  - `backupRestoreEnabled` 与 `deploy/env.example` 默认一致（默认 `false`；Web 文件级恢复需显式开启）。
- `GET /api/storage`（需要会话；轻量端点，供文件页取配额，避免触发 Dashboard 的 MC/opencode/systemctl 聚合）：`{ "quotaBytes": 10737418240, "usedBytes": 1234, "trashBytes": 0, "fileCount": 3, "freeBytes": 1 }`。字段与 `/api/dashboard.storage` 一致；`usedBytes` 含笔记附件与回收站，`fileCount` 只统计普通文件（`origin='user'`）。
- 静态资源：`/`、`/files`、`/trash`、`/knowledge`、`/shares`、`/minecraft`、`/settings`、`/s/:token` 等 SPA 路径返回 `index.html`；`/assets/*` 长缓存；`/sw.js` 带 `Service-Worker-Allowed: /`；`/manifest.webmanifest` 为 `application/manifest+json`。
- `ai.example.com/*`：不是本应用 API，全部经会话校验后反代到 opencode；未登录 HTML 302，API 401。

## 8. 知识库（笔记/书签）

所有端点需要会话；写操作需 CSRF。Note 形状：

```json
{ "id": "uuid", "title": "标题", "bodyMd": "# Markdown", "tags": ["工作"], "pinned": true, "createdAt": "…", "updatedAt": "…" }
```

- `GET /api/notes?q=&tag=&pinned=true|false&page=1&pageSize=20` → `{items,page,pageSize,total}`。
- `POST /api/notes` body `{title,bodyMd,tags?,pinned?}` → 201 Note。
- `GET/PATCH/DELETE /api/notes/:id`；PATCH 字段可选；DELETE → `{ok:true}`。
- `GET /api/notes/tags` → `{items:[{name,count}]}`。
- Bookmark 形状：`{id,url,title,description,tags,pinned,createdAt,updatedAt}`；端点 `/api/bookmarks`、`/:id`、`/tags`，查询/分页同上。
- 限制：标题 ≤200、正文 ≤200KB、标签 ≤20 个且单个 ≤32；书签 URL 仅 http/https；FTS5 中文自动回退 LIKE。
- 笔记列表与详情均附带 `attachments`；列表项中的附件为增量字段，旧前端可忽略。

## 9. 文件分享

登录端点（会话 + CSRF）：

- `POST /api/files/:id/shares` body `{password?, expiresInHours?, maxDownloads?, note?}` → 201（单文件兼容入口，等价于 `fileIds:[id]`）：

```json
{ "share": { "id":"uuid","fileId":"uuid","fileName":"a.txt","fileSize":12,"fileMime":"text/plain","itemCount":1,"totalSizeBytes":12,"hasPassword":true,"expiresAt":"…","maxDownloads":3,"downloadCount":0,"createdAt":"…","revokedAt":null,"note":"…","status":"active" }, "url": "https://app.example.com/s/<token>" }
```

- `POST /api/shares`body `{fileIds:[], password?, expiresInHours?, maxDownloads?, note?}` → 201，结构同上；`fileIds` 1–50 个、去重，必须全部是活动普通文件（不得为目录/回收站/笔记附件）。`share.fileId/fileName` 为首个文件（兼容字段），`itemCount` 为实际条目数。`maxDownloads=0/null` 表示不限；URL 仅创建响应返回一次。新建密码分享最少 8 位；旧短密码分享仍可解锁。
- `GET /api/shares?page=1&pageSize=100` → `{items:[Share],total,page,pageSize}`（不含 token/URL；pageSize 最大 500；条目含 `itemCount`）。
- `DELETE /api/shares/:id` → `{ok:true,share}`（吊销）。
- `DELETE /api/files/:id`：先吊销包含该文件/子树的所有分享，再软删除；吊销失败返回 500 且文件不删除。

公开端点（无需会话；POST 校验 Origin；限流）：

- `GET /api/public/shares/:token` → 200 `{share:{fileName,size,mime,itemCount,totalSizeBytes,expiresAt,hasPassword,maxDownloads,downloadCount,items?}, state:"active", requiresPassword:boolean}`；未知 404；失效 410（`share_expired/share_revoked/share_exhausted`）；文件已删除 410 `share_gone`。公开信息不含 `note`。`items:[{id,name,size,mime}]` 仅在无需密码或已解锁时返回；`totalSizeBytes` 在未解锁时也返回。
- `POST /api/public/shares/:token/unlock` body `{password?}` → 200 `{ok:true,state,share,requiresPassword:false,expiresAt}`（`share` 含 `items`）并 Set-Cookie `af_share`（HttpOnly/SameSite=Lax/Secure，Path 限定该 token，5 分钟）；错误密码 401 `invalid_password`；限流 429。
- `GET /api/public/shares/:token/items/:itemId/content`（密码分享需 `af_share` Cookie）→ 单个文件流，`content-disposition: attachment`；支持 `Range`/`HEAD`/`ETag`/`304`/`416`；`itemId` 必须属于该分享，否则 404 `share_item_not_found`；文件已删除 410 `share_gone`；会话首次成功取内容计一次下载（按分享会话计数，不按文件累加）。
- `GET /api/public/shares/:token/content`：仅单文件分享可用；多文件分享返回 409 `share_bundle`，客户端改用 `items/:itemId/content`。
- 公开页 `/s/:token` 带 `X-Robots-Tag: noindex, nofollow`。

## 10. 告警

- `GET /api/alerts?limit=20`（会话）→：

```json
{ "items": [{ "id":1,"event":"disk_low","severity":"critical","status":"firing","title":"…","message":"…","createdAt":"…","deliveredAt":null,"deliveryError":null }], "state": [{ "event":"disk_low","status":"firing","lastFiredAt":"…","lastOkAt":null }], "config": { "enabled":true,"webhookConfigured":false,"webhookType":"generic","diskFreePct":15,"tempC":80,"memoryUsedPct":90,"backupMaxAgeHours":48,"cooldownMinutes":360,"repeatHours":24,"checkIntervalSeconds":300,"lastEvaluatedAt":null } }
```

- `POST /api/alerts/test`（会话 + CSRF，10 次/小时）→ `{ok:true,delivered:boolean,message?}`；未配置 webhook 返回 200 `{ok:false,delivered:false,message:"未配置 webhook URL"}`。
- Webhook 请求体 `{source,version,event,severity,status,title,message,details,at}`；可选 HMAC 头 `x-antifieldcloud-signature: sha256=<hex>`；10s 超时、最多 3 次尝试。
- 告警条件：磁盘、温度、内存（默认 90%）、服务、备份超期、pending 备份、备份密钥包、MC、欠压（health probe JSON）、世界备份/世界拉取/恢复演练超期与异地副本超期（`offsite_overdue`）；同状态去重/冷却，恢复时发 resolved。`status` 可能为 `unknown`（连续 3 次数据源不可用后降级并产生一次事件）；`alert_events` 保留 90 天。
  `config` 含 `offsiteMaxAgeHours`（小时，0 表示关闭；状态文件缺失/未配置时该条件不进入列表，不误报）；`status` 字段另含世界备份/拉取/演练阈值。
- 外部事件告警（v0.8.0，Lofii）：上游 `alert` 事件由服务端映射为 `status='event'` 写入 `alert_events`，**不写 `alert_state`、不参与 firing/resolved 状态机、不产生恢复通知**；`severity`：已知类型（low_health/chest_full/defense_retreat → warning，task_failed/disconnected → critical），未知类型上游 `severity='error'` 为 critical，否则 warning；`event` 名为 `lofii_low_health`/`lofii_task_failed`/`lofii_disconnected`/`lofii_chest_full`/`lofii_defense_retreat`/`lofii_alert`（未知），`details` 含 `source:"lofii"`、`lofiiEventId`、`lofiiType` 与清洗后的上游 details（深度≤2、键≤20、数组≤20、字符串≤300）。写入后异步复用 webhook 投递与 Bot 通知，不阻塞请求；`ALERTS_ENABLED=false` 时不写库/不投递。

## 11. 备份管理 / 文件级恢复

全部需要会话；写操作需 CSRF；危险操作另需 TOTP（body `totpCode` 或请求头 `X-TOTP-Code`）和 typed confirmation。整库恢复不通过 Web 执行。

- `GET /api/backups` → `{items:[Archive],inbox,orphans,state,world,worldPull,drill}`。Archive 含 `name/mode/createdAt/sizeBytes/sha256/status/origin/available/verifiedAt/pulledAt/ackedAt/lastError/manifest/encrypted`；`available=false` 表示服务端文件已被 PC ack 清理（acked 后正常），此状态不可用于恢复；`encrypted=true` 表示 age 加密归档（Web 不可校验/恢复）；不返回归档路径或下载 URL。`world`/`worldPull`/`drill` 为只读状态对象（见 §12），`state` 可含 `pendingBytes/ackedBytes/encryptedPendingCount/encryptedAckedCount` 统计（缺失时前端按 0 降级）。
- `POST /api/backups/prepare` body `{totpCode,full?,confirmText:"PREPARE"}`（3 次/小时）→ 只生成 Pi pending 归档，不 ack、不推进游标；输出可带 `warnings`/`skippedMissing`/`missingFiles`/`missingFileCount`/`partials`，加密开启时另带 `encrypted:true/archiveFormat:"tar.gz.age"/metaName/plainSha256/plainSize`（明文哈希只在 sidecar/DB，不在加密归档内）。超时由 `BACKUP_PREPARE_TIMEOUT_SEC`（默认 3300s）控制；加密开启时 age/公钥/空间任一不满足即失败关闭（不产生 pending、不降级明文）。TOTP 失败写审计 `backup_reauth_failed`。
- `POST /api/backups/import`（multipart 字段 `file`，TOTP 走 `X-TOTP-Code`；10 次/小时）→ 201 `{archive,verify,warnings?}`。归档名必须匹配 `^snapshot-[0-9TZ]+(?:-[0-9]+)?-(full|inc)\.tar\.gz$`（明文）或 `…\.tar\.gz\.age$`（加密，**导入返回 409 `archive_encrypted`**）；落盘 `DATA_DIR/backups/imports` 0700，拒绝覆盖；单请求 ≤ min(MAX_UPLOAD_BYTES, 100 MiB)。导入归档（origin=import）不计入 pending，也不影响 Pi 增量水位。
- `POST /api/backups/verify` body `{name}` → 流式 SHA-256 + tar 安全解析；**加密归档（`.age`）在名称校验之前返回 `409 archive_encrypted`**（Pi 无私钥）；明文归档错误：409 checksum_mismatch、422 invalid_archive/unsafe_archive、404 archive_not_found；校验失败会清除 `verified_at/manifest_json` 并记录 `last_error`。
- `GET /api/backups/archives/:name/entries?path=/` → `{path,items,truncated}`，用于恢复选择；仅已校验明文归档；`.age` 返回 `409 archive_encrypted`；30 次/分钟/IP，超出 429；只返回 `origin='user'` 的普通文件（笔记附件/系统文件不参与恢复）。
- `POST /api/backups/restore-plan` body `{archive?,paths?,targetName?,totpCode,confirmText:"RESTORE"}` → `{plan}`；校验 full+inc 链、空间/配额、文件数上限；计划 30 分钟过期。不指定归档时**自动恢复目标跳过 `.age`**；指定 `.age` 或链中含 `.age` 返回 `409 archive_encrypted`。计划会剔除链 manifest 中 `skippedMissing` 的文件并返回 `plan.skippedMissing: string[]`；选择全部缺失时 `400 invalid_selection`。
- `POST /api/restores/:planId/execute` body `{totpCode,confirmText:"RESTORE"}` → `{plan,result}`；只恢复文件内容到**新文件夹**（新 ID，不覆盖），单并发/锁；`410 plan_expired`、`409 restore_busy/plan_completed`；`result.filesRestored/bytesRestored/durationMs/skippedMissing`，其中 `result.skippedMissing` 列出执行时仍缺失、已跳过未恢复的文件 ID，非空时不能视为完整恢复。启动/维护会清理崩溃遗留的陈旧 `restore.lock`。
- `GET /api/restores/:planId` → `{plan}`（用于恢复向导刷新/断网后继续轮询）。
- 错误码：`archive_encrypted` 409（加密归档 Web 不可操作）、`restore_disabled` 403、`archive_not_verified`/`archive_chain_invalid` 409、`invalid_selection`/`confirmation_failed` 400、`invalid_totp` 401、`restore_too_many_files` 400。
- 归档导入的信任边界：归档来自管理员（TOTP 门禁），但 tar 仍按不可信输入校验路径穿越/链接/设备/超大条目；不提供归档下载。schema v16 启动时会拒绝高于支持版本的数据库（迁移 5–16 保留；本版无新迁移）。
- 整库恢复：不在 Web API 内，按 `docs/BACKUP.md` §8.1 的离线 root 手工流程执行（停服、解包校验、替换数据、pre-restore 备份与失败回滚）；加密归档必须先在 PC 用离线私钥解密，再按同流程恢复。

## 12. 可观测性与备份状态

### GET /api/metrics

需要会话。查询参数 `range`：`1h|6h|24h|7d|30d`（默认 `24h`）；非法值 `400 invalid_range`。

```json
{
  "range": "24h",
  "from": "2026-10-19T00:00:00.000Z",
  "to": "2026-10-20T00:00:00.000Z",
  "bucketSeconds": 360,
  "sampleCount": 240,
  "series": [
    {
      "ts": "2026-10-19T00:06:00.000Z",
      "cpuPercent": 12.3,
      "memUsedBytes": 123456,
      "memTotalBytes": 8000000000,
      "memUsedPct": 42.1,
      "tempC": 48.2,
      "diskFreeBytes": 30000000000,
      "diskTotalBytes": 62000000000,
      "diskFreePct": 48.4,
      "load1": 0.21
    }
  ]
}
```

- 服务端按桶聚合：CPU/内存/温度取平均、磁盘剩余取最小值、load1 取平均；最多 240 点；`bucketSeconds = ceil(范围秒 / 240)`（1h=15、24h=360、7d=2520、30d=10800）；`tempC` 不可得时为 `null`。
- 采样周期由 `METRICS_SAMPLE_SECONDS` 控制（默认 60），保留 `METRICS_RETENTION_DAYS` 天（默认 30）；关闭采样时历史查询仍可用。

### 告警与审计筛选

- `GET /api/alerts?limit=20&offset=0&event=&status=&severity=` → `{items,total,state,config}`；`status` 取值 `firing|resolved|unknown|event`（`event` 为 Lofii 等外部服务的事件记录），`event` 为条件名，全部参数可选。
- `GET /api/audit?limit=50&offset=0&action=&q=&from=&to=` → `{items,total}`；`q` 对 action/target/ip 做转义 LIKE 搜索；`from/to` 为 ISO 时间；参数可选。

### 备份状态对象

`GET /api/dashboard` 的 `backup` 与 `GET /api/backups` 的 `world`/`drill` 使用只读状态文件，文件缺失时字段为 `null`：

```json
{
  "world": {
    "lastRunAt": "2026-10-20T20:00:00.000Z",
    "ok": true,
    "archiveName": "world-20261020T200000Z.tar.gz",
    "sizeBytes": 3200000000,
    "sha256": "…",
    "durationMs": 240000,
    "kept": ["world-20261020T200000Z.tar.gz"],
    "keptCount": 1,
    "error": null,
    "message": null
  },
  "worldPull": {
    "lastPullAt": "2026-10-20T21:00:00.000Z",
    "ok": true,
    "archiveName": "world-20261020T200000Z.tar.gz",
    "archiveNames": ["world-20261020T200000Z.tar.gz"],
    "pulledCount": 1,
    "kept": ["world-20261020T200000Z.tar.gz"],
    "keptCount": 1,
    "pendingRemaining": 0,
    "error": null,
    "message": null
  },
  "drill": {
    "lastRunAt": "2026-10-20T12:00:00.000Z",
    "ok": true,
    "report": "20261020T120000Z",
    "latestDb": "db-20261020T120000Z.sqlite",
    "schemaVersion": 16,
    "worldChecked": true,
    "error": null,
    "message": null
  },
  "offsite": {
    "lastRunAt": "2026-10-24T05:00:00.000Z",
    "ok": true,
    "remoteLabel": "myremote",
    "uploaded": 1,
    "skipped": 0,
    "failed": 0,
    "bytes": 123456,
    "keptRemote": 12,
    "plaintextSkipped": 0,
    "error": null
  }
}
```

字段说明：`world.kept`/`worldPull.kept` 是归档名数组，份数看 `keptCount`；`world.kept` 是“上次运行保留”，PC 拉取校验并 ack 后远端归档会被删除，不代表 Pi 当前仍有该数量；`drill.reportPath`/`dbIntegrity` 仅为旧状态文件兼容字段，当前脚本写 `report/latestDb/schemaVersion/worldChecked`。
`offsite`：缺失为 `null`（未配置，不告警）；只含远端别名 `remoteLabel` 与计数/时间/错误，不含远端真实路径/URL/凭据；`plaintextSkipped>0` 表示有明文归档被拒绝上传（安全信号）。

`GET /api/dashboard` 的 `backup` 始终返回对象（部分字段可为 `null`）：`lastPullAt/ageHours/sizeBytes/ok/overdue/lastError`，另含 `pendingCount/pendingBytes/orphanCount/ackedBytes`、`encryptedPendingCount/encryptedAckedCount`、`encryption{enabled,keyConfigured}`、`world/worldPull/drill/offsite`。状态文件由 root 世界备份脚本与 PC 拉取/演练/异地脚本写入，应用只读；不含密钥。

## 13. 笔记附件与版本历史

附件计入总配额，但不出现在普通文件列表/搜索/回收站；只能通过笔记接口管理与访问。

- `GET /api/notes/:id` → Note 增加 `attachments:[{fileId,name,size,mime,url}]`；`url` 为 `/api/files/<fileId>/content?inline=1`（栅格图片可内联，其它类型浏览器按下载处理）。
- `POST /api/notes/:id/attachments`（multipart，字段 `files`，1–5 个文件）→ `200 {items:[Attachment]}`；单文件 ≤ `NOTE_ATTACHMENT_MAX_BYTES`（默认 25 MiB），每笔记 ≤ `NOTE_MAX_ATTACHMENTS`（默认 100）；超限 `413 file_too_large`、配额不足 `409 quota_exceeded`、磁盘不足 `507 insufficient_storage`、非法名 `400 invalid_name`。
- `GET /api/notes/:id/attachments` → `{items:[Attachment]}`。
- `DELETE /api/notes/:id/attachments/:fileId` → `{ok:true}`（硬删除并释放配额；不进入回收站）。
- `GET /api/notes/:id/versions?limit=20&offset=0` → `{items:[{id,title,createdAt}],total}`。
- `GET /api/notes/:id/versions/:versionId` → `{version:{id,noteId,title,bodyMd,tags,createdAt}}`；跨笔记版本 `404 not_found`。
- `POST /api/notes/:id/versions/:versionId/restore` → 200 Note（恢复前自动保存当前版本快照）。
- 版本在标题/正文/标签变化时自动生成，每笔记保留最近 `NOTE_VERSIONS_KEEP`（默认 20）条；删除笔记级联删除版本与附件。

## 14. Bot 平台

Bot 功能默认关闭：`BOT_ENABLED=false` 或缺少有效 `BOT_SECRET_KEY` 时，Webhook 与写接口不可用（见 §0），`GET /api/bots/status` 仍可读并返回 `enabled=false/keyConfigured=false`。所有管理端点需要会话；写操作需要 CSRF；凭据字段只写不读。Cloudflare Access 必须对 `/api/bot/webhook/*` 做 bypass，否则平台回调会被边缘拦截（见 `docs/DEPLOY.md` §5.2）。

平台：仅 `qq`（QQ 官方 Bot）。API 不接受其它平台值，`BotSummary` 无 `gateway`，目标无 `chatTrigger`，发布无 `mediaFileIds`。QQ 仅支持文本（单条 ≤2000 字符），入站图片默认交给 AI 理解；AI 仅普通消息 Chat，需 `BOT_AI_ENABLED=true`。

普通消息 Chat：非斜杠消息在目标 `allow_chat=1` 时进入 AI Chat；C2C 私聊直接进入，QQ 群/频道只有 @Bot 事件进入（平台限制，无“全部消息”触发）；非管理员只能 Chat，不能执行斜杠命令。限速：Chat 每 Bot×用户每分钟 `BOT_CHAT_RATE_PER_MINUTE`（默认 **30**）次、每小时 `BOT_AI_RATE_PER_HOUR`（默认 **120**）次；Chat 是只读 AI 对话，不产生写操作。

出站连通性：服务端每 `BOT_CONNECTIVITY_INTERVAL_SECONDS`（默认 60）探测外网与 QQ 平台 API；`GET /api/bots/connectivity` 返回 `{checkedAt,checking,internet,platforms}`（无 `deviceOnline`/`proxy`），`POST /api/bots/connectivity/check` 手动复检（需 CSRF，30 次/分钟）。探测只发无凭据只读 GET，不返回 AppSecret 或平台响应正文；网络恢复后触发投递/发布队列扫描。

角色卡：`/role` 仅私聊，个人卡可覆盖默认 lofii，群聊使用管理员配置的共享卡；角色设定不通过 HTTP API/UI 暴露。`/role show` 对用户自定义卡返回完整设定文本，默认角色卡只返回名称、不展示内置详情。默认内联提示词为「角色卡 + 固定安全边界 + 长期记忆 + 用户」；v0.7.3 文档模式（`BOT_AI_CONTEXT_READ_ENABLED=true`，默认关闭）首轮发送角色卡、后续轮只发送角色名/记忆条数/文档路径，模型按需 `read`；`bot_ai_sessions.mode` 只写 `chat`；`/reset` 与角色卡变更清理该范围全部会话映射；审计 `bot.ai.chat` 不记录 `mode`/正文/路径。

群聊目标共享唯一 OpenCode Chat 会话（`bot_ai_sessions.user_id=__group__`），群内 Chat 按目标串行，模型可见多用户历史；私聊仍按真实用户独立会话。真实用户仍用于限流/记忆/审计/发送工具 turn token；群聊/频道不执行 `/reset` 等斜杠命令，`/reset` 仅私聊生效。

平台连接自检 `POST /api/bots/:id/check`；诊断事件 `GET /api/bots/:id/events`（无正文）；投递/发布/指标 `lastErrorHint`；角色/记忆元数据管理；自助命令 `/help`（按身份动态）、`/reset`、`/forget confirm`（全用户）。
`BOT_AI_VISION_ENABLED` 默认 `true`，QQ 入站图片（`d.attachments` 中 `image/*`）经固定域名后缀白名单（`.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（QQ 实际图床如 `multimedia.nt.qq.com.cn`））下载后交给 AI。

记忆摘要会话一次性（每次新建远端 OpenCode 会话并在 `finally` 删除；响应 `BotMemorySummary` 不含会话 id）；记忆更新按 Bot×用户串行队列；合并策略=累计 `BOT_AI_MEMORY_BATCH_MESSAGES`（默认 3）轮或用户空闲 `BOT_AI_MEMORY_IDLE_FLUSH_SECONDS`（默认 120s，0 关闭）触发，`bot.ai.memory` 审计增加 `rounds`。保留期分离：会话 `BOT_AI_SESSION_RETENTION_DAYS`（默认 7 天）与记忆 `BOT_AI_MEMORY_RETENTION_DAYS`（默认 365 天，30–3650）独立；`/reset`、`/forget confirm`、角色卡变更（含管理员删除）清理本地映射时尽力删除远端会话与旧摘要会话。

### 对象

```json
BotStatus:  { "enabled": true, "keyConfigured": true, "bots": 1, "enabledBots": 1, "targets": 2, "queuedDeliveries": 0, "queuedPublishes": 0, "lastError": null, "aiToolIsolation": { "supported": true, "fallbackCount": 0, "fallbackAt": null, "retryAt": null } }
BotSummary: { "id": "uuid", "platform": "qq", "name": "运维通知", "enabled": true, "config": { "appId": "1029…" }, "webhookUrl": "https://app.example.com/api/bot/webhook/<id>", "setupSteps": ["…"], "targetsCount": 2, "lastError": null, "lastCheckedAt": null, "createdAt": "…", "updatedAt": "…", "keyVersion": 1 }
BotTarget:  { "id": "uuid", "botId": "uuid", "externalId": "user_openid/group_openid/channel_id", "label": "运维告警群", "kind": "channel|user|group", "allowCommands": false, "allowNotifications": true, "allowChat": false, "groupReplyMode": "mention|all", "quietStartMinute": null, "quietEndMinute": null, "createdAt": "…" }
BotInboundTarget: { "botId": "uuid", "targetExternalId": "QQ 目标 ID", "targetKind": "channel|user|group", "userId": "QQ 用户 openid", "userName": "…|null", "isDirect": false, "lastSeenAt": "…" }
BotDelivery:{ "id": "uuid", "botId": "uuid", "targetId": "uuid|null", "kind": "notification|command_reply|publish|test", "status": "queued|sending|sent|failed|dead", "attempts": 0, "nextAttemptAt": null, "lastError": null, "lastErrorHint": "中文提示|null", "externalId": null, "createdAt": "…", "sentAt": null }
BotPublishJob: { "id": "uuid", "botId": "uuid", "targetId": "uuid", "text": "…", "scheduledAt": null, "status": "draft|queued|sending|sent|failed|canceled", "attempts": 0, "lastError": null, "lastErrorHint": "中文提示|null", "createdAt": "…", "sentAt": null }
BotMetrics: { "hours": 24, "deliveries": { "total": 10, "sent": 8, "failed": 1, "dead": 1, "successRate": 88.9 }, "publishes": { "total": 2, "sent": 2, "failed": 0 }, "events": 5, "lastError": null, "lastErrorHint": "中文提示|null", "lastSentAt": "…" }
BotHealthCheck: { "ok": true, "items": [{ "name": "access_token", "ok": true, "detail": "access_token 已获取" }], "checkedAt": "…" }
BotEventItem: { "eventId": "qq:message_id", "kind": "command|chat|ignored", "outcome": "received|ok|denied|rate_limited|ignored|error", "detail": "短码|null（如 command_denied/chat_rate_limited）", "targetExternalId": "…|null", "userId": "…|null", "receivedAt": "…", "updatedAt": "…|null" }
BotRoleSummary: { "userId": "…", "userName": "…|null", "name": "角色名", "enabled": true, "promptLength": 320, "createdAt": "…", "updatedAt": "…" }
BotGroupRoleSummary: { "targetId": "uuid", "targetLabel": "测试群", "targetExternalId": "group_openid", "name": "群助手|null", "enabled": true, "promptLength": 120, "updatedAt": "…|null" }
BotMemoryGroupSummary: { "scope": "group:<group_openid>", "targetExternalId": "group_openid", "targetName": "测试群", "itemCount": 3, "kinds": { "fact": 2, "preference": 1 }, "updatedAt": "…|null" }
BotGroupRoleDetail: { "targetId": "uuid", "targetLabel": "测试群", "targetExternalId": "group_openid", "name": "群助手", "prompt": "管理员可编辑正文", "enabled": true, "createdAt": "…", "updatedAt": "…" }
BotMemoryUserSummary: { "userId": "…", "userName": "…|null", "itemCount": 7, "kinds": { "profile": 2, "preference": 3, "task": 2 }, "memoryEnabled": true, "updatedAt": "…|null" }
BotMemoryItemSummary: { "id": "uuid", "kind": "profile|preference|fact|project|task|relationship|episode", "importance": 3, "confidence": 0.8, "updatedAt": "…", "expiresAt": "…|null" }
```

`BotSummary.config` 只含公开配置（QQ `appId`）；QQ AppSecret 永不返回，也不出现在审计/日志中。`webhookUrl` 与 `setupSteps` 由服务端按 `APP_ORIGIN` 和 QQ 平台模板生成。
`BotMetrics.deliveries.successRate = sent / (sent + failed) × 100`（保留 1 位小数，无尝试时为 0）；`lastError`/`lastErrorHint`/`lastSentAt` 取投递与发布的最近值。
`BotSummary` 无 `gateway`、`BotTarget` 无旧 `chatTrigger` 字段、`BotPublishJob` 无 `mediaFileIds`；`BotDelivery` 的 `partial` 语义仅针对长文本分段。
`BotTarget.groupReplyMode` 仅群聊目标可设为 `all`（实验性全量消息），其余目标固定 `mention`；群聊/频道不再执行斜杠命令。
普通消息 Chat 可启用模型消息发送工具：OpenCode 通过 `botmsg` MCP 调用 `botmsg_send_message`，每轮由提示词携带一次性 `turn_id`/`turn_token`；
应用内部回调 `POST /api/bot/ai/tool/send`（无 session/CSRF，`turn_token` 由 `BOT_SECRET_KEY` HMAC，只写本轮缓冲）接收文本，回合结束由服务端统一发送。
私聊与 @ 提及必须至少发送一条，模型漏调用时服务端兜底发送最终文本并审计 `bot.ai.send_fallback`；全量群聊未调用工具即静默（替代旧 `NO_REPLY` 文本哨兵）。
全量群聊非 @ 消息使用 `BOT_CHAT_BURST_GROUP_ALL_WINDOW_MS`（默认 8000）与 `BOT_CHAT_BURST_GROUP_ALL_MAX_WAIT_MS`（默认 20000）延长合并窗口。
新创建的 OpenCode Chat/Memory 会话标题为「目标名称 + Chat/Memory」。

（审计修复）：
- `BotStatus.aiToolIsolation` 增加 `retryAt`（下一次允许重试 `permissions` 的时间；未降级为 null）；`BotStatus.lastError`/`BotSummary.lastError` 改为从 `bot_deliveries`/`bot_publish_jobs` 失败派生（不再依赖 `bots.last_error` 死字段）。工具隔离 fail-closed：启用 `BOT_AI_SEND_TOOL_ENABLED` 且隔离不可用时，新 Chat 返回固定提示并写 `bot_events`（忽略/拒绝），OpenCode 层返回 `503 bot_ai_tool_isolation_unavailable`；10 分钟窗口到点后放行一次重试，上游恢复后自动恢复隔离。
- 群共享记忆归属：条目 key 前缀为稳定 `<member_openid>:`（显示名只存 value）；启动一次性迁移 `bot_group_memory_owner_migrated_v1`，无法映射的旧键加 `legacy:` 保留；`/forget confirm` 清除本人在各群共享记忆中的条目并取消在途抽取，审计 `bot.memory.forget` 增加 `groupItems/groupScopes`。
- Webhook 限流：未通过验签的请求使用独立每 Bot 每分钟 120 次桶，已验签业务事件 300 次/分钟（验签后才扣减），无效流量不能饿死合法事件；拒绝/限流审计按「每 Bot×动作×分钟」聚合（首条 + 每 50 条），降低未认证写放大。
- 其它：孤儿 OpenCode 会话清理只针对旧默认标题（不误删新命名/前缀相似会话）；全量群混批中任一 @ 即整批按被点名处理；发送工具已缓冲消息在回合异常时先补发并审计 `partialTurn`；`/search` 与普通 Chat 共用会话串行锁；群聊名称匹配按词边界；`burst.clear` 取消运行中批次的后续排队。

### 管理端点

- `POST /api/bot/ai/tool/send`（内部工具回调，无 session/CSRF）：body `{turn_id,turn_token,text}`；只接受当前活跃回合的 HMAC token，单轮最多 5 条、单条 ≤1800 字；返回 `{ok:true,index}`，非法/过期/超限分别 `400/403/404/410/429`；文本只进入缓冲，不立即外发。该路由不在 Cloudflare Access bypass 中，生产由本机 MCP 访问 `127.0.0.1`。
- `GET /api/bots/status` → `BotStatus`（功能关闭时也可读；用于前端判断是否展示配置指引）。
- `GET /api/bots/connectivity` → `BotConnectivitySnapshot`；需要会话，功能关闭时仍返回当前快照/未检测状态。
- `POST /api/bots/connectivity/check` → `BotConnectivitySnapshot`；需要会话 + CSRF，30 次/分钟；手动复检外网/QQ 平台。
- `GET /api/bots` → `{ "items": [BotSummary] }`；`GET /api/bots/:id` → `{ "bot": BotSummary }`；不存在/已删除 `404 not_found`。
  功能未启用时列表/详情返回 `503 bot_disabled|bot_key_missing`（前端应先用 `/api/bots/status` 判断）。
- `GET /api/bots/:id/metrics?hours=24` → `{ "metrics": BotMetrics }`；`hours` 默认 24、范围 1–720，非法/越界值回退 24；需要会话，Bot 功能关闭时 `503`，Bot 不存在 `404`；`lastErrorHint` 为服务端按 `lastError` 映射的中文提示（未知为 null）。
- `POST /api/bots/:id/check` → `{ "health": BotHealthCheck }`；需要会话 + CSRF，30 次/分钟；调用 QQ 适配器换取 `access_token` 做只读自检，
  结果脱敏并刷新 `lastCheckedAt`；即使失败也返回 200 + `ok:false` 项；适配器不支持自检时 `400 bot_health_unsupported`；Bot 关闭/不存在 `503/404`。
- `GET /api/bots/:id/events?hours=24&limit=50&offset=0&outcome=ok` → `{ "items": [BotEventItem], "total": n }`；需要会话；`hours` 1–720（默认 24）、`limit` 1–200（默认 50）、`offset` ≥0；
  `outcome` 缺省返回全部，只接受 `received|ok|denied|rate_limited|ignored|error`，非法值 `400 invalid_request`；只返回事件元数据，**不含消息正文/用户名**。
- `GET /api/bots/:id/roles?limit=20&offset=0` → `{ "items": [BotRoleSummary], "total": n }`；需要会话；只返回元数据（用户/名字/长度/启停/时间），不返回角色设定正文。
  - `PATCH /api/bots/:id/roles/:userId` body `{enabled:boolean}` → `{ "ok": true }`；需要会话 + CSRF；启停指定用户角色卡，不存在/非布尔值 `404/400`。
  - `DELETE /api/bots/:id/roles/:userId` → `{ "ok": true }`；需要会话 + CSRF；删除角色卡并清理该用户 chat 会话（task 会话与记忆保留），不存在 `404`。
  - `GET /api/bots/:id/group-roles` → `{ "items": [BotGroupRoleSummary] }`；需要会话；列出全部群聊目标及角色卡元数据（未配置时 name/updatedAt 为 null）。
  - `GET /api/bots/:id/group-roles/:targetId` → `{ "groupRole": BotGroupRoleDetail|null }`；需要会话；群聊角色卡正文仅管理员可读；目标不是群聊 `400`，不存在 `404`。
  - `PUT /api/bots/:id/group-roles/:targetId` body `{name,prompt}` → `{ "groupRole": BotGroupRoleDetail }`；需要会话 + CSRF；新建/覆盖并启用角色卡；名字 1–32、正文 1–1000，非法 `400`；目标必须为群聊。
  - `PATCH /api/bots/:id/group-roles/:targetId` body `{enabled:boolean}` → `{ "ok": true }`；需要会话 + CSRF；启停群聊角色卡，不存在 `404`。
  - `DELETE /api/bots/:id/group-roles/:targetId` → `{ "ok": true }`；需要会话 + CSRF；删除群聊角色卡，不存在 `404`。
- `GET /api/bots/:id/memories?limit=20&offset=0` → `{ "items": [BotMemoryUserSummary], "total": n }`；需要会话；用户级元数据（itemCount/kinds/memoryEnabled/updatedAt），**不返回 key/value 或摘要正文**。
  - `GET /api/bots/:id/memories/:userId/items?limit=20&offset=0` → `{ "items": [BotMemoryItemSummary], "total": n }`；需要会话；条目元数据（id/kind/importance/confidence/updatedAt/expiresAt），不过期条目的 `expiresAt` 为 null。
  - `DELETE /api/bots/:id/memories/:userId/items/:itemId` → `{ "ok": true }`；需要会话 + CSRF；删除单条结构化记忆（审计 `bot.memory.delete_item`），不存在 `404`。
  - `DELETE /api/bots/:id/memories/:userId` → `{ "ok": true }`；需要会话 + CSRF；删除该用户结构化条目、状态与 legacy 摘要（不清 AI 会话；清全部会话与远端会话由用户自助 `/forget confirm`）；审计 `bot.memory.delete_user`；不存在 `404`。
  - `GET /api/bots/:id/group-memories?limit=20&offset=0` → `{ "items": [BotMemoryGroupSummary], "total": n }`；需要会话；按群目标聚合的共享记忆元数据（scope/targetExternalId/targetName/itemCount/kinds/updatedAt），**不返回 key/value 正文**。
  - `DELETE /api/bots/:id/group-memories/:scope` → `{ "ok": true }`；需要会话 + CSRF；scope 必须为 `group:<targetExternalId>`，只清空该群共享记忆，不影响用户记忆/群目标/会话；审计 `bot.memory.delete_user`。
  - 群聊记忆条目复用 `GET .../memories/:scope/items` 与 `DELETE .../memories/:scope/items/:itemId`；启动时一次性把现有群聊参与者的用户级记忆复制到对应群共享记忆（仅群聊用户执行移动），`meta.bot_group_memory_migrated_v1` 保证幂等。
- `GET /api/bots/:id/inbound-targets?limit=50` → `{ "items": [BotInboundTarget] }`；需要会话，Bot 功能关闭时 `503`，Bot 不存在 `404`；`limit` 1–200（默认 50；越界按边界截断）。
  只记录最近命令/Chat 事件的目标、用户、类型、时间与是否私聊，不返回消息正文；每 Bot 最多保留 500 条、按 `BOT_EVENT_RETENTION_DAYS` 清理。`/bots` 目标分区用该接口做“最近入站目标”登记。
- `POST /api/bots` body `{platform,name,token,config?}` → `200 { "bot": BotSummary }`。
  - `platform` 必须为 `qq`（其它平台值 `400 invalid_bot_config`）；`name` ≤80；最多 `BOT_MAX_BOTS`（默认 10）个。
  - QQ 需 `token`（AppSecret，≥16）与 `config.appId`（5–32 位数字）；`token` 只存密文，AppID 可公开；不再接受 `webhookSecret/publicKey/signingSecret`。
  - 校验失败 `400 invalid_bot_config`（`details` 为 `qq_token_invalid` 等错误码数组）；超过上限 `400`。
  - 新建 Bot 默认 `enabled=false`；需显式 `PATCH enabled=true` 才处理 Webhook/队列。
- `PATCH /api/bots/:id` body 任意 `{name?,enabled?,config?,token?}` → `200 { "bot": BotSummary }`；`token` 省略或空串表示保持原值；修改成功会清空 `lastError`。
  `DELETE /api/bots/:id` → `{ "ok": true }`（级联删除目标/投递/发布/事件/AI 会话/记忆/角色卡）。
- `POST /api/bots/:id/test` body `{targetId?}` → `{ "ok": true }`；缺目标 `400`；未配置目标时使用最早登记的目标；限流 20 次/小时。
- 目标：
  - `GET /api/bots/:id/targets` → `{ "items": [BotTarget] }`。
  - `POST /api/bots/:id/targets` body `{externalId,label,kind,allowCommands?,allowNotifications?,allowChat?,groupReplyMode?,quietStartMinute?,quietEndMinute?}` → `200 { "target": BotTarget }`；`allowCommands` 默认 false、`allowNotifications` 默认 true、`allowChat` 默认 false、`groupReplyMode` 默认 `mention`；每 Bot ≤100；`(bot_id, external_id)` 唯一，重复 `409 conflict`。
    `quietStartMinute`/`quietEndMinute` 为 Asia/Shanghai 本地分钟（0–1439），必须同时设置或同时留空，不能相同；窗口跨午夜（start > end）按跨越处理；设置后该目标的告警通知在窗口内延后到结束时刻。
    `groupReplyMode=all` 仅 `kind=group` 可传（实验性）；非群聊传 `all` 返回 `400`。全量消息需 QQ 后台开启“接收所有消息”并订阅 `GROUP_MESSAGE_CREATE`；默认 `mention` 仅接受 @Bot 或文本包含 Bot 名称的消息。
  - `PATCH /api/bots/:id/targets/:targetId` body `{label?,kind?,allowCommands?,allowNotifications?,allowChat?,groupReplyMode?,quietStartMinute?,quietEndMinute?}` → `{ "target": BotTarget }`；`null` 表示清空，未传字段沿用当前值；合并后静默起止必须同时有值或同时为空且不能相同，否则 `400`；`all` 仅群聊目标可用；`DELETE` → `{ "ok": true }`。
  - 群聊/频道目标不再执行任何斜杠命令（含自助命令）；收到 `/` 开头消息只写 `bot.command.disabled` 审计并返回 200，不回复。C2C 私聊命令仍需目标 `allow_commands=1` + 用户白名单；`/help`、`/role`（仅私聊）、`/reset`、`/forget confirm`、`/memory`、`/search` 为自助命令，不要求目标/用户白名单；`/ask` 为未知命令（非管理员被拒、管理员回全量帮助）。
  - `/reset`、`/forget confirm`、角色卡变更（含管理员删除角色）在清理本地映射时尽力删除对应远端 OpenCode 会话与旧摘要会话（删除失败只记日志，不影响响应）。
  - `allowChat` 只授权普通消息 Chat，不授予斜杠命令：Chat 只需目标 `allow_chat=1`（不要求用户白名单）；C2C 私聊直接进入；群/频道默认仅 @Bot 事件进入，群目标设为 `groupReplyMode=all` 且 QQ 后台开启全量消息后进入 `GROUP_MESSAGE_CREATE`。非管理员只能 Chat，不能借 Chat 执行命令；Chat 仍受 `BOT_CHAT_RATE_PER_MINUTE` 与 `BOT_AI_RATE_PER_HOUR` 限制。
- 投递：
  - `GET /api/bots/:id/deliveries?limit=50`（1–200）→ `{ "items": [BotDelivery] }`，按创建时间倒序。
  - `POST /api/bots/:id/deliveries/:deliveryId/retry` → `{ "ok": true }`；仅 `failed|dead` 可重投，其它 `404`。
- 发布（仅文本）：
  - `GET /api/bots/:id/publish?limit=50`（1–200）→ `{ "items": [BotPublishJob] }`。
  - `POST /api/bots/:id/publish` body `{targetId,text,scheduledAt?,totpCode,confirmText}` → `200 { "job": BotPublishJob }`。
    - **必须** `totpCode`：缺码 `400 totp_required`；验证失败 `401 invalid_code`（计入 TOTP/再认证限流，审计 `reauth_bot_publish`）。不能用会话 + CSRF 直接外发。
    - **必须** `confirmText: "PUBLISH"`：缺失/不匹配 `400 publish_confirm_required`；与 TOTP 共同构成双确认。
    - `targetId` 必须是本 Bot 的 `channel|group` 目标（`user` 返回 400）；`text` 非空，**≤2000 字符**（QQ 单条上限）；超过返回 `400 publish_text_too_long`，不再静默截断或服务端分段。
    - 不再支持 `mediaFileIds`/媒体附件；带媒体字段不再校验或外发，QQ 仅文本。
    - `scheduledAt` 为 ISO 时间，可为空（立即入队）；不得早于当前时间 30 秒以上，最长 `BOT_PUBLISH_MAX_SCHEDULED_DAYS`（默认 30）天。
    - 发布文本不再分段：单条 ≤2000 字符；已发送后失败时任务标记 `failed` 且 `last_error` 含 `partial_text_sent`，**不自动重试**（避免重复外发），需人工确认后重建任务。
    - 限流 20 次/小时；队列每 `BOT_DELIVERY_INTERVAL_SECONDS`（30）扫描，失败按指数退避（30s 起，≤1h），达到 `BOT_DELIVERY_MAX_ATTEMPTS`（5）标记 `failed`/死信。
  - `DELETE /api/bots/:id/publish/:jobId` → `{ "ok": true }`；仅 `queued|draft` 可取消，其它 `404`。
- 审计动作：`bot.create/update/delete`、`bot.target.create/update/delete`、`bot.delivery.retry/partial`、`bot.publish.create/sent/cancel/partial`、`bot.command`、`bot.command.denied`、`bot.chat`、`bot.chat.denied`、`bot.ai.chat`（detail 含 `context: docs|inline`/`docBytes`/`memoryItems`）、`bot.ai.context_failed`、`bot.ai.memory`（legacy）、`bot.ai.permissions_fallback`、`bot.memory.extract`、`bot.memory.toggle`、`bot.memory.delete_item`、`bot.memory.delete_user`、`bot.memory.legacy_cleanup`、`bot.ai.image`、`bot.webhook.challenge`、`bot.webhook.rejected/rate_limited`、`bot.event.ignored`、`bot.test`、`bot.check`、`bot.reset`、`bot.memory.forget`、`bot.role.admin`、`bot.memory.admin`、`reauth_bot_publish`。诊断/自助/管理动作只记录动作、数量/长度与截断 ID，不记录正文。备份危险操作用 `backup_reauth_failed` 记录 TOTP 再认证失败（route/错误摘要/IP，不含 TOTP）。

### 公开 Webhook

`POST /api/bot/webhook/:botId`（无会话/CSRF/Origin 校验；独立 raw body scope；Cloudflare Access 需 bypass；仅 QQ 官方 Bot）

- Content-Type：`application/json` 或 `application/x-www-form-urlencoded`；body ≤ `BOT_WEBHOOK_MAX_BODY_BYTES`（默认 256 KiB）。
- 成功：QQ op=13 回调校验返回 `{"plain_token":"…","signature":"…"}`；普通事件/重复事件/未授权目标或用户统一返回 `200 {"opcode":12}`（不泄露是否存在/是否授权）。
- 失败：签名缺失/错误 `401 invalid_signature`；时间戳超出 ±300 秒 `401 stale_signature`；payload 无效/缺字段 `400 invalid_payload|missing_fields`；Bot 未启用/不存在/未启用 `404 not_found`；限流 `429 rate_limited`（IP scope 带 `Retry-After`，Bot scope 不带）。
- 验签规则（QQ）：
  - `op=13` 回调地址校验：无签名头，使用 AppSecret 派生 Ed25519 私钥对 `${event_ts}${plain_token}` 签名，返回 `plain_token`/`signature`；`plain_token` 只接受 `^[A-Za-z0-9_-]{1,128}$`、`event_ts` 只接受 `^\d{1,12}$`，不匹配返回 `400 invalid_payload`（阻止把任意事件 JSON 当作 plain_token 换取签名）。
  - `op=0` 事件：校验 `X-Signature-Ed25519` + `X-Signature-Timestamp`（±300 秒）后解析 `C2C_MESSAGE_CREATE`/`GROUP_AT_MESSAGE_CREATE`/`AT_MESSAGE_CREATE`；
    命令与普通文本分别进入命令/Chat，未知事件也回 `{"opcode":12}` 防止重推。
- 事件内容：C2C 私聊普通文本直接进入 Chat；群/频道只有 @Bot 事件进入（平台限制，无“全部消息”）；入站图片在 `d.attachments` 中取首个 `image/*`（`content_type`/`filename`/`size`/`url`），
  仅图片无文字也可进入 Chat；QQ 不支持出站媒体/按钮/引用。
- 去重：事件 ID `qq:<message_id|target:timestamp>` 写入 `bot_events`，并记录 event_kind/outcome/detail/target/user/updated_at 供诊断；保留 `BOT_EVENT_RETENTION_DAYS`（7）天。
- 命令：`/help`（自助、动态）、`/memory`（自助，查看/`off|on`）、`/status`、`/backup`、`/world`、`/mc`、`/files <关键词>`、`/role`（仅私聊）、`/reset`、`/forget confirm`（后三者全用户自助）。
  回复文本清洗内部路径/URL，命令回复 ≤1500 字符；`/files` 最多 10 条、只含名称与大小。`/help`：仅输出命令列表（管理员 11 条、非管理员 6 条），不含标题、说明、权限声明或用法注释；未知命令对管理员回全量帮助、对非管理员被拒（无回复）；斜杠命令不调用 AI。
- Chat：非斜杠普通消息在目标 `allow_chat=1` 且 `BOT_AI_ENABLED=true` 时进入 AI；C2C 私聊直接进入，群/频道仅 @Bot 事件；
  复用会话若被 OpenCode 清理（404），自动删除 `bot_ai_sessions` 旧映射并重建一次，避免持续 `bot_ai_http_error`；
  群聊用户消息在提示词中格式为 `<用户名>：<消息>`；提示词声明群聊环境，未 @ 的全量消息默认沉默、不要求每轮调用发送工具；群聊使用独立共享记忆 scope（`group:<targetExternalId>`），只注入 `<用户名>：<记忆>` 条目，成员用户级记忆不进入群聊；
  提示词固定为「角色卡（个人卡/群共享卡或默认 lofii）+ 精简安全边界 + 记忆 + 用户」；不再注入空记忆占位段；AI 仅 Chat（`allow_chat` 目标/C2C 私聊）；
  `bot_ai_sessions.mode` 只写 `chat`（列保留）；AI 文本经 sanitize → QQ 纯文本格式化 → 按 2000 字符分段（最多 4 段）发送；
  第二段起失败时返回错误并记录 `partial_text_sent`，不自动重试。Chat 不执行命令/写操作；未开启 `allow_chat`、AI 未启用或群/频道非 @Bot 的事件返回 `200` 但不调用 AI（写诊断事件 `ignored`）。
- 图片：`BOT_AI_VISION_ENABLED=true`（默认）时，QQ 入站图片（`d.attachments`）经 `.qpic.cn`/`.qq.com`/`.qq.com.cn`/`.gtimg.cn`（QQ 实际图床如 `multimedia.nt.qq.com.cn`） 域名后缀白名单、image mime 白名单、≤`BOT_AI_IMAGE_MAX_BYTES`、
  内存下载（不落盘）后以 OpenCode prompt files 交给 AI；`BOT_AI_VISION_ENABLED=false`、下载失败或 mime/大小非法时降级为文字回答。审计 `bot.ai.image` 只记录 mime/大小/跳过原因。
- 限流：Webhook scope 按统一 `requestMeta` 信任模型取客户端 IP（仅 loopback 对端采信 Cloudflare 头）120 次/分钟；BotService 对**未验签**请求按每 Bot 每分钟 120 次、对**已验签**事件按每 Bot 每分钟 300 次分别计数（验签通过后才扣减），拒绝/限流审计按窗口聚合。命令按 `botId:userId` 每 `BOT_COMMAND_RATE_PER_MINUTE`（120）次/分钟；
  Chat 另按每分钟 `BOT_CHAT_RATE_PER_MINUTE`（30）次、每小时 `BOT_AI_RATE_PER_HOUR`（120）次。记忆摘要不额外占用每小时 AI 配额（每轮对话只计 1 次）。
- 公开 Webhook 失败码补充：限流 `429 rate_limited`（无效流量走未验签桶；已验签桶超限同样 429 但不应影响合法重试）；工具隔离不可用不通过 Webhook 返回 503，而是 Chat 侧固定提示 + 诊断事件，AI 内部错误码 `bot_ai_tool_isolation_unavailable` 只用于 API/日志状态。
- Bot 关闭（`BOT_ENABLED=false`/无密钥）、Bot 不存在或 `enabled=false` 时统一 `404`，不泄露 Bot 是否存在。

### 错误码汇总

`bot_disabled`（503）、`bot_key_missing`（503）、`bot_ai_tool_isolation_unavailable`（503，AI 工具隔离不可用且发送工具启用时新 Chat 被拒绝，10 分钟窗口后重试）、`bot_key_invalid`（500，仅启动/配置阶段）、`invalid_bot_config`（400，含非 QQ 平台/字段校验失败）、`publish_confirm_required`（400）、`publish_text_too_long`（400，发布文本超过 2000 字符）、`totp_required`（400）、`invalid_code`（401）、`conflict`（409，目标重复）、`rate_limited`（429）、`not_found`（404）、`invalid_request`（400，静默时段/事件结果非法）、`bot_health_unsupported`（400，适配器不支持连接自检）。AI 图片内部错误码 `bot_ai_image_unsupported`/`bot_ai_image_invalid` 只用于日志/降级，不作为管理端点响应。Webhook 额外使用 `invalid_signature`、`stale_signature`、`invalid_payload`、`missing_fields`。删除 `chat_trigger_unsupported` 与媒体相关错误码（`too_many_media`/`media_too_large`/`media_total_too_large`/`qq_media_unsupported`）。

## 15. Lofii Bot 对接（v0.8.0，默认关闭）

Lofii 是独立的 Minecraft 附属 Bot 服务（仅监听 `127.0.0.1:3010`）；应用服务端轮询其只读接口并代理少量控制操作，**浏览器不直连 Lofii、服务端不下发 Lofii Token/URL**。上游契约为 lofii-bot **v0.6.0**、`contractVersion=1`；旧版无 `/events/recent`（404）时只降级 `eventsSupported=false`，`/status` 仍可用。全部端点需要会话；写操作需要 CSRF；凭据与响应边界见 `docs/SECURITY.md`。

### 通用语义

- 启用：`LOFII_ENABLED=true` 且配置 `LOFII_READ_TOKEN`（启动校验：`LOFII_URL` 必须 loopback + http(s)）；控制：`LOFII_CONTROL_TOKEN` 非空。
- 关闭：`LOFII_ENABLED=false` 时除 `GET /api/lofii/status`（返回 `enabled:false` 空壳）外均返回 `503 lofii_disabled`。
- 只读：控制 Token 为空时 `/tasks*`、`/move` 返回 `503 lofii_control_disabled`；`/status`、`/history`、`/say` 仍可用（`/say` 使用读 Token）。
- 轮询：服务端每 `LOFII_POLL_MS`（默认 5000，2000–60000）拉一次 `/status` + `/events/recent?limit=100`；单飞（不并发/不堆积）；失败只更新 `reachable/stale/error` 并保留上次成功数据。
- 限流：控制类（tasks/stop/resume/move 共用）**20 次/分钟/IP**，`/say` **10 次/分钟/IP**；超限 `429 rate_limited` 并带 `Retry-After`。
- 审计：`lofii.task.start`（target=任务名）、`lofii.task.stop`、`lofii.task.resume`（target=taskId 或 `task`）、`lofii.move`（target=action）、`lofii.say`（只记 `chars`）、失败 `lofii.control_failed`（只记稳定错误码）；不记录聊天正文、Token、URL。
- 错误映射：上游 400/409 保留状态码，`error.code=lofii_<上游稳定码>`；上游 401/403 → `502 lofii_auth_failed`；上游 429 → `429 lofii_rate_limited`；其它上游错误/非 JSON/超限 → `502 lofii_upstream_error`；禁用/不可达/控制未启用 → `503 lofii_disabled`/`lofii_unavailable`/`lofii_control_disabled`。`message` 为固定中文兜底，不含上游原文/地址/Token。

### GET /api/lofii/status

需要会话。返回聚合快照（禁用时为空壳）：

```json
{
  "enabled": true,
  "reachable": true,
  "stale": false,
  "controlEnabled": true,
  "alertsEnabled": true,
  "eventsSupported": true,
  "version": "0.6.0",
  "contractVersion": 1,
  "lastPollAt": "2026-10-27T09:00:00.000Z",
  "error": null,
  "status": { "version": "0.6.0", "uptimeSec": 123, "state": "connected", "minecraft": { "connected": true, "username": "lofii" }, "player": { "health": 20, "food": 20 }, "server": { "reachable": true, "online": 1, "max": 6 }, "task": { "enabled": true, "active": false, "name": null, "state": "idle", "pendingResume": null, "queue": [] }, "admin": { "rcon": true, "tps": { "one": 19.9, "five": 19.8, "fifteen": 19.7 } } },
  "events": [ { "id": "036e732d-10", "type": "presence", "ts": "2026-10-27T08:59:58.000Z", "data": {} } ]
}
```

- `status`：上游 `/status` 快照（完整字段以 lofii-bot v0.6.0 契约为准），不含 Token/记忆正文；不承诺固定字段，前端只读取已知字段并容忍缺失。
- `stale`：连续 3 个轮询周期无成功或距上次成功超过 3 个周期；`reachable=false` 时保留最后一次成功快照。
- `eventsSupported`：上游是否提供 `/events/recent`（旧版 404 时 false）；`contractVersion` 来自该接口。
- `events`：内存环最近事件，**newest-first，最多 100 条**；服务端重启清空；不写入 DB/日志。
- `error`：稳定错误码（如 `lofii_unavailable`/`lofii_auth_failed`/`lofii_cursor_failed`/`lofii_upstream_error`），不是上游原文。

### GET /api/lofii/history

需要会话。查询参数：`kind=samples|alerts`（默认 `samples`，其它值 `400 invalid_request`）、`from`/`to`（ISO 时间，非法 `400 invalid_request`）、`limit`（默认 100，范围 1–200）。响应透传上游 `/history`：

```json
{
  "kind": "alerts",
  "from": "2026-10-26T09:00:00.000Z",
  "to": "2026-10-27T09:00:00.000Z",
  "count": 1,
  "alerts": [ { "id": 1, "ts": "2026-10-27T08:00:00.000Z", "type": "low_health", "severity": "warning", "message": "Lofii 血量偏低", "details": {} } ]
}
```

`samples` 时返回 `samples` 数组（每 60s 一条，上游保留 30 天）；字段以上游契约为准，不含聊天正文/Token/密码。只读，不写审计。

### POST /api/lofii/tasks

需要会话 + CSRF。body：

```json
{ "name": "fishing" }
```

`name` 必须是 `fishing|farming|woodcutting|mining|forest|sleep|patrol` 之一（否则 `400 invalid_request`）。成功 `200 { "ok": true, ...上游响应 }`；上游已 active 时入队（`queued:true`、`position:1..3`）；有 pending → `409 lofii_resume_pending`；队列满 → `409 lofii_queue_full`；任务功能关闭 → `503 lofii_task_disabled`。

### POST /api/lofii/tasks/stop

需要会话 + CSRF，body 可为空。成功 `200 { "ok": true, ... }`（中断当前任务并清空队列；只有 pending 时取消 pending 与队列）。无任务 → `409 lofii_no_active_task`。

### POST /api/lofii/tasks/resume

需要会话 + CSRF。body 可选：

```json
{ "taskId": "46451943-eae1-41c0-8df3-beef3c7b60f4" }
```

`taskId` 省略时恢复唯一 pending；提供时必须是 1–64 字符（否则 `400 invalid_request`）。成功 `200 { "ok": true, ... }`；无 pending → `409 lofii_no_pending_task`；过期/不匹配 → `409 lofii_resume_failed`。上游 pending 10 分钟未确认会自动中断。

### POST /api/lofii/move

需要会话 + CSRF。body：

```json
{ "action": "come", "target": "Steve" }
```

`action` 必须是 `home|come|follow|stop`；`target` 可选（trim 后 ≤32 字符，`home`/`stop` 忽略）。成功 `200 { "ok": true, ... }`；任务进行中 → `409 lofii_task_active`；目标不在线 → `409 lofii_target_not_online`；Lofii 未连接 Minecraft → `409 lofii_not_connected`；上游 202 只表示接受，结果通过事件流反映。

### POST /api/lofii/say

需要会话 + CSRF。body：

```json
{ "message": "来自 AntifieldCloud 的问候" }
```

成功 `200 { "ok": true, "lines": 1 }`。约束：trim 后非空、≤**720** 字符、不能以 `/` 开头（`400 invalid_request` / `400 message_must_not_start_with_slash`）；Lofii 未连接 → `409 lofii_not_connected`；上游限流 → `429 lofii_rate_limited`。**只聊天、不执行命令；内容不落库、不写日志，审计只记字符数**。

### 事件与告警

- `/events/recent` 事件 envelope `{id,type,ts,data}`；`type` 已知 `presence|task|chat|movement|alert`，`data` 形状随类型变化且视为不可信输入，前端只读取白名单字段并纯文本渲染。
- `alert` 事件映射为本应用告警事件（`status='event'`），映射与字段见 §10；告警游标保存在 `meta.lofii.event_cursor={bootId,lastEventId,lastTs}`，首次/重启/`bootId` 变化只建基线不重放；`LOFII_ALERTS_ENABLED=false` 仍推进游标但不写告警。
- 聊天事件只进服务端内存事件缓存（≤100 条），不提供历史查询、不持久化、不写日志/审计正文；应用重启或 Lofii 重启即丢失。
