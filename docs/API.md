# AntifieldCloud HTTP API 契约（v2，2026-10-20）

服务端与前端共同遵守本文件。所有路径除特别说明外均以 `https://app.example.com` 为源。

## 0. 约定

- JSON 请求/响应：`Content-Type: application/json; charset=utf-8`。
- 时间：ISO 8601 UTC 字符串（如 `2026-10-19T09:00:00.000Z`）；前端按 `Asia/Shanghai` 展示。
- 文件 ID：不透明字符串（UUID），前端不得解析其含义。
- 分页：`page` 从 1 开始；文件默认 200、最大 500；笔记/书签默认 20、最大 100；响应含 `page/pageSize/total`。
- 统一错误体：

```json
{ "error": { "code": "invalid_credentials", "message": "用户名或密码错误", "details": { } } }
```

- 常见状态码：`400 invalid_request`、`401 unauthenticated/invalid_password`、`403 csrf_failed`、`404 not_found`、`410 share_expired/share_revoked/share_exhausted`、`409 conflict/quota_exceeded`、`413 file_too_large`、`415 unsupported_media_type`、`429 rate_limited`、`500 internal_error`、`507 insufficient_storage`。`429` 同时带 `Retry-After` 响应头与 `error.details.retryAfterSec`。
- 认证：登录成功后服务端下发 `af_session`（HttpOnly）与 `af_csrf`（可读）Cookie。除 `GET/HEAD` 外的所有 `/api` 请求必须带 `X-CSRF-Token: <af_csrf>`，并满足 `Origin` 为 `https://app.example.com` / `https://ai.example.com` / 本机。
- 安全响应头：`Cache-Control: no-store`（静态 hash 资源除外）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、CSP（见 docs/SECURITY.md）。
- 登录限制：每 IP 5 次失败/15 分钟；全局 60 次/小时（密码）、120 次/小时（TOTP），loopback 来源不占全局桶。`429` 响应包含 `retryAfterSec`。
- 单文件上限：普通 multipart **100 MiB**（`MAX_UPLOAD_BYTES=104857600`，匹配 Cloudflare 代理）；更大文件走分片上传（v0.3.1，默认上限 **5 GiB**、8 MiB/块）。超过返回 `413 file_too_large`，磁盘不足返回 `507 insufficient_storage`。
- 未登录访问 `ai.example.com` 的 HTML 请求：`302` 到 `https://app.example.com/login?next=https%3A%2F%2Fai.example.com%2F`；API/WebSocket 返回 `401`。
- 未知 Host 返回 `404`（应用只接受 app/ai 与 loopback）。
- 再认证：`POST /api/account/password` 与 `/api/account/recovery-codes` 需要当前密码 + `totpCode`；每 IP 5 次/15 分钟 + 全局 30/h + TOTP 40/h，失败审计，恒定延迟。

## 1. 健康检查

`GET /healthz`（无需认证）

```json
{ "ok": true, "version": "0.3.2", "uptimeSec": 1234 }
```

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
  "backup": { "lastPullAt": "…", "ageHours": 12.3, "sizeBytes": 123456, "ok": true, "overdue": false },
  "activity": [
    { "id": 1, "ts": "…", "action": "login", "target": null, "detail": null, "ip": "…" }
  ],
  "generatedAt": "…"
}
```

`minecraft.error` 可为 `null`；`backup` 恒为对象，但 `lastPullAt/ageHours/sizeBytes` 等字段可为 `null`；`services.*` 取值 `active|inactive|unknown`。`opencode.sessions` 不可得时为 `null`。

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

### 分片上传（v0.3.1）

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

- `GET /api/version`（需要会话）：`{ "version": "0.4.0", "appOrigin": "https://app.example.com", "aiOrigin": "https://ai.example.com", "trashRetentionDays": 30, "maxUploadBytes": 104857600, "sharesEnabled": true, "alertsEnabled": true, "backupRestoreEnabled": true, "backupImportMaxBytes": 104857600, "backupRestoreMaxEntries": 5000, "chunkedUploadEnabled": true, "chunkSizeBytes": 8388608, "chunkMaxFileBytes": 5368709120, "noteAttachmentMaxBytes": 26214400, "noteMaxAttachments": 100, "noteVersionsKeep": 20, "shareMaxItems": 50, "metricsEnabled": true, "metricsSampleSeconds": 60, "metricsRetentionDays": 30 }`。
- `GET /api/storage`（需要会话；v0.4.0 轻量端点，供文件页取配额，避免触发 Dashboard 的 MC/opencode/systemctl 聚合）：`{ "quotaBytes": 10737418240, "usedBytes": 1234, "trashBytes": 0, "fileCount": 3, "freeBytes": 1 }`。字段与 `/api/dashboard.storage` 一致；`usedBytes` 含笔记附件与回收站，`fileCount` 只统计普通文件（`origin='user'`）。
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
- 笔记列表与详情均附带 `attachments`（v0.4.0，见 §13）；列表项中的附件为增量字段，旧前端可忽略。

## 9. 文件分享

登录端点（会话 + CSRF）：

- `POST /api/files/:id/shares` body `{password?, expiresInHours?, maxDownloads?, note?}` → 201（单文件兼容入口，等价于 `fileIds:[id]`）：

```json
{ "share": { "id":"uuid","fileId":"uuid","fileName":"a.txt","fileSize":12,"fileMime":"text/plain","itemCount":1,"totalSizeBytes":12,"hasPassword":true,"expiresAt":"…","maxDownloads":3,"downloadCount":0,"createdAt":"…","revokedAt":null,"note":"…","status":"active" }, "url": "https://app.example.com/s/<token>" }
```

- `POST /api/shares`（v0.4.0 多文件入口）body `{fileIds:[], password?, expiresInHours?, maxDownloads?, note?}` → 201，结构同上；`fileIds` 1–50 个、去重，必须全部是活动普通文件（不得为目录/回收站/笔记附件）。`share.fileId/fileName` 为首个文件（兼容字段），`itemCount` 为实际条目数。`maxDownloads=0/null` 表示不限；URL 仅创建响应返回一次。新建密码分享最少 8 位；旧短密码分享仍可解锁。
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
{ "items": [{ "id":1,"event":"disk_low","severity":"critical","status":"firing","title":"…","message":"…","createdAt":"…","deliveredAt":null,"deliveryError":null }], "state": [{ "event":"disk_low","status":"firing","lastFiredAt":"…","lastOkAt":null }], "config": { "enabled":true,"webhookConfigured":false,"webhookType":"generic","diskFreePct":15,"tempC":80,"memoryUsedPct":90,"backupMaxAgeHours":48,"cooldownMinutes":360,"checkIntervalSeconds":300,"lastEvaluatedAt":null } }
```

- `POST /api/alerts/test`（会话 + CSRF，10 次/小时）→ `{ok:true,delivered:boolean,message?}`；未配置 webhook 返回 200 `{ok:false,delivered:false,message:"未配置 webhook URL"}`。
- Webhook 请求体 `{source,version,event,severity,status,title,message,details,at}`；可选 HMAC 头 `x-antifieldcloud-signature: sha256=<hex>`；10s 超时、最多 3 次尝试。
- 告警条件：磁盘、温度、内存（默认 90%）、服务、备份超期、pending 备份、备份密钥包、MC、欠压（health probe JSON）；同状态去重/冷却，恢复时发 resolved。`status` 可能为 `unknown`（连续 3 次数据源不可用后降级并产生一次事件）；`alert_events` 保留 90 天。

## 11. 备份管理 / 文件级恢复

全部需要会话；写操作需 CSRF；危险操作另需 TOTP（body `totpCode` 或请求头 `X-TOTP-Code`）和 typed confirmation。整库恢复不通过 Web 执行。

- `GET /api/backups` → `{items:[Archive],inbox,orphans,state,world,worldPull,drill}`。Archive 含 `name/mode/createdAt/sizeBytes/sha256/status/origin/verifiedAt/pulledAt/ackedAt/lastError/manifest`；不返回归档路径或下载 URL。`world`/`worldPull`/`drill` 为只读状态对象（见 §12），`state` 可含 `pendingBytes/ackedBytes` 统计（缺失时前端按 0 降级）。
- `POST /api/backups/prepare` body `{totpCode,full?,confirmText:"PREPARE"}`（3 次/小时）→ 只生成 Pi pending 归档，不 ack、不推进游标；输出可带 `warnings`/`skippedMissing`/`missingFiles`/`missingFileCount`/`partials`（物理文件缺失但已跳过，游标不会越过缺失项；下次 prepare 自动补入已恢复文件）。超时由 `BACKUP_PREPARE_TIMEOUT_SEC`（默认 3300s）控制。
- `POST /api/backups/import`（multipart 字段 `file`，TOTP 走 `X-TOTP-Code`；10 次/小时）→ 201 `{archive,verify,warnings?}`。归档名必须匹配 `^snapshot-[0-9TZ]+(?:-[0-9]+)?-(full|inc)\.tar\.gz$`；落盘 `DATA_DIR/backups/imports` 0700，拒绝覆盖；单请求 ≤ min(MAX_UPLOAD_BYTES, 100 MiB)。导入归档（origin=import）不计入 pending，也不影响 Pi 增量水位。
- `POST /api/backups/verify` body `{name}` → 流式 SHA-256 + tar 安全解析；409 checksum_mismatch、422 invalid_archive/unsafe_archive、404 archive_not_found。
- `GET /api/backups/archives/:name/entries?path=/` → `{path,items,truncated}`，用于恢复选择；仅已校验归档；30 次/分钟/IP，超出 429；只返回 `origin='user'` 的普通文件（笔记附件/系统文件不参与恢复）。
- `POST /api/backups/restore-plan` body `{archive?,paths?,targetName?,totpCode,confirmText:"RESTORE"}` → `{plan}`；校验 full+inc 链、空间/配额、文件数上限；计划 30 分钟过期。计划会剔除链 manifest 中 `skippedMissing` 的文件并返回 `skippedMissing`；选择全部缺失时 `400 invalid_selection`。
- `POST /api/restores/:planId/execute` body `{totpCode,confirmText:"RESTORE"}` → `{plan,result}`；只恢复文件内容到**新文件夹**（新 ID，不覆盖），单并发/锁；`410 plan_expired`、`409 restore_busy/plan_completed`；`result.skippedMissing` 列出执行时仍缺失的文件，其余文件正常恢复。
- `GET /api/restores/:planId` → `{plan}`。
- 错误码：`restore_disabled` 403、`archive_not_verified`/`archive_chain_invalid` 409、`invalid_selection`/`confirmation_failed` 400、`invalid_totp` 401、`restore_too_many_files` 400。
- 归档导入的信任边界：归档来自管理员（TOTP 门禁），但 tar 仍按不可信输入校验路径穿越/链接/设备/超大条目；不提供归档下载。schema v6 启动时会拒绝低于/高于支持版本的数据库（迁移 5 结构 + 迁移 6 孤儿分享数据修复）。
- 整库恢复：`scripts/restore.sh`（root，停服，pre-restore 快照，失败回滚）不在 Web API 内。

## 12. 可观测性与备份状态（v0.4.0）

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

- `GET /api/alerts?limit=20&offset=0&event=&status=&severity=` → `{items,total,state,config}`；`status` 取值 `firing|resolved|unknown`，`event` 为条件名，全部参数可选，默认行为与旧版一致。
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
    "kept": 2,
    "error": null
  },
  "worldPull": {
    "lastPullAt": "2026-10-20T21:00:00.000Z",
    "ok": true,
    "archiveName": "world-20261020T200000Z.tar.gz",
    "error": null
  },
  "drill": {
    "lastRunAt": "2026-10-20T12:00:00.000Z",
    "ok": true,
    "reportPath": "drills/20261020T120000Z/report.json",
    "dbIntegrity": "ok",
    "error": null
  }
}
```

`GET /api/dashboard` 的 `backup` 始终返回对象（历史字段可为 `null`）：`lastPullAt/ageHours/sizeBytes/ok/overdue/lastError`，另含 `pendingCount/pendingBytes/orphanCount/ackedBytes`、`world/worldPull/drill`。状态文件由 root 世界备份脚本与 PC 拉取/演练脚本写入，应用只读；不含密钥。

## 13. 笔记附件与版本历史（v0.4.0）

附件计入总配额，但不出现在普通文件列表/搜索/回收站；只能通过笔记接口管理与访问。

- `GET /api/notes/:id` → Note 增加 `attachments:[{fileId,name,size,mime,url}]`；`url` 为 `/api/files/<fileId>/content?inline=1`（栅格图片可内联，其它类型浏览器按下载处理）。
- `POST /api/notes/:id/attachments`（multipart，字段 `files`，1–5 个文件）→ `200 {items:[Attachment]}`；单文件 ≤ `NOTE_ATTACHMENT_MAX_BYTES`（默认 25 MiB），每笔记 ≤ `NOTE_MAX_ATTACHMENTS`（默认 100）；超限 `413 file_too_large`、配额不足 `409 quota_exceeded`、磁盘不足 `507 insufficient_storage`、非法名 `400 invalid_name`。
- `GET /api/notes/:id/attachments` → `{items:[Attachment]}`。
- `DELETE /api/notes/:id/attachments/:fileId` → `{ok:true}`（硬删除并释放配额；不进入回收站）。
- `GET /api/notes/:id/versions?limit=20&offset=0` → `{items:[{id,title,createdAt}],total}`。
- `GET /api/notes/:id/versions/:versionId` → `{version:{id,noteId,title,bodyMd,tags,createdAt}}`；跨笔记版本 `404 not_found`。
- `POST /api/notes/:id/versions/:versionId/restore` → 200 Note（恢复前自动保存当前版本快照）。
- 版本在标题/正文/标签变化时自动生成，每笔记保留最近 `NOTE_VERSIONS_KEEP`（默认 20）条；删除笔记级联删除版本与附件。


