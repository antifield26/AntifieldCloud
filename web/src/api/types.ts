// 与 docs/API.md 对应的前端类型定义。
// 所有时间均为 ISO 8601 UTC 字符串；展示层负责转换为 Asia/Shanghai。
// 本文件是前端唯一的数据结构来源，页面与组件不得自行臆造字段。

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
    retryAfterSec?: number
  }
  retryAfterSec?: number
}

export interface User {
  username: string
}

export interface SessionInfo {
  createdAt: string
  expiresAt: string
  ip: string
  userAgent: string
}

export interface PasswordChallenge {
  challenge: string
  expiresIn: number
}

export interface LoginResult {
  user: User
  /** 服务端在极少数情况下可能不下发 CSRF（如降级），前端需容忍 */
  csrfToken: string | null
}

export interface MeResult {
  user: User
  csrfToken: string | null
  session: SessionInfo
}

export interface OkResult {
  ok: boolean
}

export type ServiceState = 'active' | 'inactive' | 'unknown'

export interface HostMemInfo {
  totalBytes: number
  usedBytes: number
  availableBytes: number
}

export interface HostDiskInfo {
  totalBytes: number
  usedBytes: number
  freeBytes: number
}

export interface HostInfo {
  hostname: string
  uptimeSec: number
  load: number[]
  cpuPercent: number
  mem: HostMemInfo
  /** 非 Linux 或无法读取温度时为 null */
  tempC: number | null
  root: HostDiskInfo
}

export interface StorageInfo {
  quotaBytes: number
  usedBytes: number
  trashBytes: number
  fileCount: number
  freeBytes: number
}

export interface PlayersInfo {
  online: number
  max: number
  names: string[]
}

export interface TpsInfo {
  m1: number
  m5: number
  m15: number
}

export interface MinecraftStatus {
  online: boolean
  version: string | null
  motd: string | null
  players: PlayersInfo
  tps: TpsInfo | null
  whitelistCount: number | null
  serviceActive: ServiceState
  publicAddress: string | null
  checkedAt: string
  error: string | null
}

export interface OpencodeStatus {
  reachable: boolean
  url: string
  sessions: number | null
  /** 反向代理异常时的简短原因 */
  error?: string | null
}

/** 世界一致性备份状态（只读文件，由 root 备份脚本写入；文件缺失时服务端返回 null）。 */
export interface WorldBackupStatus {
  lastRunAt?: string | null
  ok?: boolean | null
  archiveName?: string | null
  sizeBytes?: number | null
  sha256?: string | null
  durationMs?: number | null
  kept?: number | null
  error?: string | null
}

/** PC 周度拉取状态（只读文件；契约见 docs/API.md §12）。 */
export interface WorldPullStatus {
  /** 契约字段为 lastPullAt；兼容脚本可能写入 lastRunAt */
  lastPullAt?: string | null
  lastRunAt?: string | null
  ok?: boolean | null
  archiveName?: string | null
  pulledCount?: number | null
  ackedCount?: number | null
  kept?: number | null
  error?: string | null
}

/** 恢复演练状态（只读文件；报告路径由脚本写入，不在 Web 端下载）。 */
export interface DrillStatus {
  lastRunAt?: string | null
  ok?: boolean | null
  reportPath?: string | null
  dbIntegrity?: string | null
  error?: string | null
}

export interface BackupStatus {
  lastPullAt: string | null
  ageHours: number | null
  sizeBytes: number | null
  ok: boolean | null
  overdue: boolean | null
  /** 密钥包（secrets）状态；旧服务端可能不下发 */
  secretsOk?: boolean | null
  lastSecretsAt?: string | null
  secretsLastError?: string | null
  /** v0.3/v0.4 可选扩展：待确认/孤儿/已确认归档统计与最近错误 */
  pendingCount?: number | null
  pendingBytes?: number | null
  orphanCount?: number | null
  ackedBytes?: number | null
  lastError?: string | null
  /** v0.4.0：世界备份、PC 拉取与恢复演练状态（文件缺失时为 null） */
  world?: WorldBackupStatus | null
  worldPull?: WorldPullStatus | null
  drill?: DrillStatus | null
}

export interface ServicesStatus {
  minecraft: ServiceState
  cloudflared: ServiceState
  opencode: ServiceState
}

export interface AuditItem {
  id: number
  ts: string
  action: string
  target: string | null
  /** 服务端返回任意结构化元数据，不做直接渲染 */
  detail: Record<string, unknown> | null
  ip: string | null
}

export interface DashboardData {
  host: HostInfo
  storage: StorageInfo
  minecraft: MinecraftStatus
  opencode: OpencodeStatus
  services: ServicesStatus
  backup: BackupStatus | null
  activity: AuditItem[]
  generatedAt: string
}

export interface AuditPage {
  items: AuditItem[]
  total: number
}

/** v0.4.0 审计查询：q 对 action/target/ip 做 LIKE 搜索；from/to 为 ISO 时间。 */
export interface AuditQuery {
  limit?: number
  offset?: number
  action?: string
  q?: string
  from?: string
  to?: string
}

export type FileKind = 'file' | 'dir'
export type PreviewKind = 'image' | 'text' | 'markdown' | 'pdf' | 'audio' | 'video' | 'none'

export interface FileItem {
  id: string
  parentId: string | null
  name: string
  kind: FileKind
  size: number
  /** 目录没有 MIME，服务端返回 null */
  mime: string | null
  sha256: string | null
  createdAt: string
  updatedAt: string
  previewKind: PreviewKind
  /** 是否允许 ?inline=1 内联预览（仅栅格图片/PDF）；旧服务端可能不下发 */
  inlineAllowed?: boolean
  // 以下字段仅在回收站接口返回
  deletedAt?: string | null
  originalParentId?: string | null
  originalPath?: string | null
}

export interface BreadcrumbItem {
  id: string | null
  name: string
}

export interface FileListResult {
  items: FileItem[]
  page: number
  pageSize: number
  total: number
  breadcrumb: BreadcrumbItem[]
}

export interface FileSearchResult {
  items: FileItem[]
  total: number
}

export interface UploadError {
  name: string
  code: string
  message: string
}

export interface UploadResult {
  items: FileItem[]
  errors: UploadError[]
}

/** 分片上传 init/status 契约（后端 v0.3.1）。 */
export interface ChunkUploadInit {
  uploadId: string
  chunkSize: number
  totalChunks: number
  expiresAt: string
  received: number[]
}

export interface ChunkUploadStatus {
  uploadId: string
  fileName: string
  size: number
  chunkSize: number
  totalChunks: number
  received: number[]
  missing: number[]
  status: 'uploading' | 'assembling' | 'completed' | 'aborted' | 'expired'
  expiresAt: string
}

export interface TextPreviewResult {
  name: string
  mime: string
  size: number
  truncated: boolean
  content: string
}

export interface TrashListResult {
  items: FileItem[]
  page: number
  pageSize: number
  total: number
  trashBytes: number
}

export interface DeleteFileResult {
  ok: boolean
  id?: string
  count?: number
  freedBytes?: number
}

export interface ClearTrashResult {
  ok: boolean
  count: number
  freedBytes?: number
}

export interface WhitelistResult {
  names: string[]
  checkedAt: string
  error: string | null
}

export interface WhitelistMutationResult {
  ok: boolean
  name: string
  names: string[]
  checkedAt?: string
  error?: string | null
}

/** /api/version 的 v0.2 扩展；旧服务端可能只返回 version。 */
export interface VersionResult {
  version: string
  appOrigin?: string
  aiOrigin?: string
  trashRetentionDays?: number
  maxUploadBytes?: number
  sharesEnabled?: boolean
  alertsEnabled?: boolean
  /** 备份恢复向导是否可用；后端未就绪时为 false */
  backupRestoreEnabled?: boolean
  chunkedUploadEnabled?: boolean
  chunkSizeBytes?: number
  chunkMaxFileBytes?: number
  /** v0.4.0 限额与功能开关（旧服务端不下发时使用前端安全回退值） */
  noteAttachmentMaxBytes?: number
  noteMaxAttachments?: number
  noteVersionsKeep?: number
  shareMaxItems?: number
  metricsEnabled?: boolean
  metricsSampleSeconds?: number
  metricsRetentionDays?: number
  /** 归档导入单请求上限与恢复文件数上限（v0.3 已下发，前端用于预检提示） */
  backupImportMaxBytes?: number
  backupRestoreMaxEntries?: number
  /** v0.5.0：Bot 功能是否可用与支持的平台（旧服务端不下发） */
  botsEnabled?: boolean
  botPlatforms?: string[]
}

/** 前端运行期需要的站点元数据（由 /api/version 推导 + 安全回退）。 */
export interface AppMeta {
  version: string | null
  appOrigin: string
  aiOrigin: string | null
  trashRetentionDays: number
  trashRetentionFromServer: boolean
  maxUploadBytes: number
  sharesEnabled: boolean
  alertsEnabled: boolean
  backupRestoreEnabled: boolean
  chunkedUploadEnabled: boolean
  chunkSizeBytes: number
  chunkMaxFileBytes: number
  /** 笔记附件单文件上限（默认 25 MiB） */
  noteAttachmentMaxBytes: number
  /** 每篇笔记附件数量上限（默认 100） */
  noteMaxAttachments: number
  /** 每篇笔记保留的历史版本数（默认 20） */
  noteVersionsKeep: number
  /** 单个分享最多包含的文件数（默认 50） */
  shareMaxItems: number
  /** 指标历史是否启用；旧服务端不下发时按启用处理（404 时组件自动降级） */
  metricsEnabled: boolean
  metricsSampleSeconds: number
  metricsRetentionDays: number
  /** 归档导入单请求上限（默认 100 MiB）与恢复向导文件数上限（默认 5000） */
  backupImportMaxBytes: number
  backupRestoreMaxEntries: number
}

/* ---------- 知识库：笔记与书签 ---------- */

export interface Note {
  id: string
  title: string
  bodyMd: string
  tags: string[]
  pinned: boolean
  createdAt: string
  updatedAt: string
  /** v0.4.0：笔记附件（计入总配额，不出现在普通文件列表/搜索/回收站） */
  attachments?: NoteAttachment[]
}

/** 笔记附件：url 为 /api/files/<fileId>/content?inline=1，仅登录态可访问。 */
export interface NoteAttachment {
  fileId: string
  name: string
  size: number
  mime: string | null
  url: string
}

export interface NoteAttachmentListResult {
  items: NoteAttachment[]
}

/** 历史版本摘要（不含正文，避免列表响应过大）。 */
export interface NoteVersionSummary {
  id: string
  title: string
  createdAt: string
}

export interface NoteVersionListResult {
  items: NoteVersionSummary[]
  total: number
}

export interface NoteVersion {
  id: string
  noteId: string
  title: string
  bodyMd: string
  tags: string[]
  createdAt: string
}

export interface NoteVersionResult {
  version: NoteVersion
}

export interface NoteVersionQuery {
  limit?: number
  offset?: number
}

export interface NoteListResult {
  items: Note[]
  page: number
  pageSize: number
  total: number
}

export interface NoteInput {
  title: string
  bodyMd: string
  tags?: string[]
  pinned?: boolean
}

export type NotePatch = Partial<NoteInput>

export interface Bookmark {
  id: string
  url: string
  title: string
  description: string
  tags: string[]
  pinned: boolean
  createdAt: string
  updatedAt: string
}

export interface BookmarkListResult {
  items: Bookmark[]
  page: number
  pageSize: number
  total: number
}

export interface BookmarkInput {
  url: string
  title: string
  description?: string
  tags?: string[]
  pinned?: boolean
}

export type BookmarkPatch = Partial<BookmarkInput>

export interface TagCount {
  name: string
  count: number
}

export interface TagsResult {
  items: TagCount[]
}

export interface KnowledgeQuery {
  q?: string
  tag?: string
  pinned?: boolean
  page?: number
  pageSize?: number
}

/* ---------- 文件分享 ---------- */

export interface Share {
  id: string
  fileId: string
  fileName: string
  /** v0.4.0 多文件分享的条目数；旧服务端不下发时视为 1 */
  itemCount?: number
  /** v0.4.0 多文件分享的总大小；旧服务端不下发时用首个文件大小回退 */
  totalSizeBytes?: number
  expiresAt: string | null
  /** null 表示不限下载次数 */
  maxDownloads: number | null
  downloadCount: number
  createdAt: string
  revokedAt: string | null
  hasPassword: boolean
  note: string | null
}

export interface CreateShareInput {
  password?: string
  /** 省略时服务端默认 168 小时（7 天）；最大 720 小时 */
  expiresInHours?: number
  /** 省略或传 0 表示不限次数 */
  maxDownloads?: number
  note?: string
}

/** v0.4.0 多文件分享入口：POST /api/shares，fileIds 1–50 且全部为活动普通文件。 */
export interface CreateShareBundleInput extends CreateShareInput {
  fileIds: string[]
}

export interface CreateShareResult {
  share: Share
  url: string
}

export interface ShareListResult {
  items: Share[]
  total?: number
  page?: number
  pageSize?: number
}

export interface RevokeShareResult {
  ok: boolean
  share?: Share
}

export type PublicShareState = 'active' | 'expired' | 'exhausted' | 'revoked'

/** 公开分享中的单个文件；仅在无需密码或已解锁时返回。 */
export interface PublicShareItem {
  id: string
  name: string
  size: number
  mime: string | null
}

export interface PublicShareMeta {
  fileName: string
  size: number
  mime: string | null
  /** v0.4.0 多文件分享条目数；旧服务端不下发时按 1 处理 */
  itemCount?: number
  /** v0.4.0 多文件总大小；缺失时由 items 求和或首个文件大小回退 */
  totalSizeBytes?: number
  /** 多文件列表；有密码且未解锁时服务端省略该字段 */
  items?: PublicShareItem[]
  expiresAt: string | null
  hasPassword: boolean
  /** null 表示不限下载次数 */
  maxDownloads: number | null
  downloadCount: number
  /** 备注仅分享者可见；公开接口可能不再返回该字段 */
  note?: string | null
}

export interface PublicShareInfo {
  share: PublicShareMeta
  state: PublicShareState
  requiresPassword: boolean
}

export interface PublicShareUnlockResult {
  ok: boolean
  state?: PublicShareState
  share?: PublicShareMeta
  requiresPassword?: boolean
  expiresAt?: string | null
}

/* ---------- 告警 ---------- */

export interface AlertEvent {
  id: number | string
  event: string
  severity: string
  status: string
  title: string
  message: string
  createdAt: string
  deliveredAt: string | null
  deliveryError: string | null
}

export interface AlertState {
  event: string
  status: string
  lastFiredAt: string | null
  lastOkAt: string | null
}

export interface AlertsConfig {
  enabled: boolean
  webhookConfigured: boolean
  diskFreePct: number | null
  tempC: number | null
  backupMaxAgeHours: number | null
  cooldownMinutes: number | null
  checkIntervalSeconds: number | null
}

export interface AlertsResult {
  items: AlertEvent[]
  state: AlertState[]
  config: AlertsConfig
  /** v0.4.0：筛选后的总数；旧服务端不下发时前端按当前页条数回退 */
  total?: number
}

/** 告警历史筛选（全部可选，默认行为与旧版一致：最近 20 条）。 */
export interface AlertListQuery {
  limit?: number
  offset?: number
  /** 条件名，如 disk_low/backup_age */
  event?: string
  /** firing|resolved|unknown */
  status?: string
  /** critical|warning|info */
  severity?: string
}

export interface AlertTestResult {
  ok: boolean
  delivered: boolean
  message?: string
}

/* ---------- 备份管理与文件级恢复（v0.3，契约按 task-7 实现） ---------- */

export type BackupMode = 'full' | 'inc'
export type BackupArchiveStatus = 'pending' | 'acked' | 'imported' | 'missing'
export type BackupOrigin = 'pi' | 'import' | 'legacy'

/** 归档内 tar 安全解析后的清单摘要（不含文件内容）。 */
export interface BackupManifest {
  mode: BackupMode
  createdAt: string
  since: string | null
  fileCount: number
  totalBytes: number
}

export interface BackupArchive {
  /** 等于 name；后端没有独立数字 id */
  id: string
  name: string
  mode: BackupMode
  createdAt: string
  sizeBytes: number
  sha256: string
  status: BackupArchiveStatus
  origin: BackupOrigin
  verifiedAt: string | null
  pulledAt: string | null
  ackedAt: string | null
  lastError: string | null
  manifest: BackupManifest | null
}

/** imports 目录中存在但 DB 无记录的文件（孤儿）或待导入文件。 */
export interface BackupInboxItem {
  name: string
  sizeBytes: number
  modifiedAt: string
  imported: boolean
}

export interface BackupState {
  lastPullAt: string | null
  pendingCount: number
  ackedCount: number
  importCount: number
  orphanCount: number
  lastError: string | null
  dataDirFreeBytes: number
  /** v0.4.0：待确认/已确认归档占用（旧服务端可能不下发） */
  pendingBytes?: number | null
  ackedBytes?: number | null
}

export interface BackupListResult {
  items: BackupArchive[]
  inbox: BackupInboxItem[]
  orphans: BackupInboxItem[]
  state: BackupState
  /** v0.4.0：世界一致性备份、PC 拉取与恢复演练只读状态；文件缺失时为 null */
  world?: WorldBackupStatus | null
  worldPull?: WorldPullStatus | null
  drill?: DrillStatus | null
}

export interface BackupImportVerify {
  ok: boolean
  error?: string
}

export interface BackupImportResult {
  archive: BackupArchive
  verify?: BackupImportVerify
}

export interface BackupVerifyResult {
  ok: boolean
  archive: BackupArchive
}

export interface BackupPrepareResult {
  ok: boolean
  mode?: 'full' | 'inc'
  archiveName?: string
  sizeBytes?: number
  sha256?: string
  fileCount?: number
  pending?: BackupArchive[]
}

/** GET /api/backups/archives/:name/entries 的只读归档内容（最多 500 条）。 */
export interface BackupArchiveEntry {
  path: string
  name: string
  kind: 'file' | 'dir'
  size: number
}

export interface BackupEntriesResult {
  path: string
  items: BackupArchiveEntry[]
}

export interface RestorePlan {
  id: string
  status: string
  targetName: string
  archive: string
  archives: string[]
  fileCount: number
  totalBytes: number
  createdAt: string
  expiresAt: string
  completedAt?: string | null
  error?: string | null
}

export interface RestorePlanResult {
  plan: RestorePlan
}

export interface RestoreResult {
  targetFolderId: string
  targetName: string
  filesRestored: number
  bytesRestored: number
  durationMs: number
}

export interface RestoreExecuteResult {
  ok: boolean
  plan: RestorePlan
  result: RestoreResult
}

export interface FileListQuery {
  parentId?: string | null
  page?: number
  pageSize?: number
  sort?: 'name' | 'updated' | 'size'
  dir?: 'asc' | 'desc'
}

export type FileSortField = NonNullable<FileListQuery['sort']>
export type FileSortDirection = NonNullable<FileListQuery['dir']>

/* ---------- 指标历史（v0.4.0，GET /api/metrics） ---------- */

export type MetricsRange = '1h' | '6h' | '24h' | '7d' | '30d'

/** 单个聚合桶：CPU/内存/温度/负载为桶内平均，磁盘剩余取桶内最小值。 */
export interface MetricsPoint {
  ts: string
  cpuPercent: number
  memUsedBytes: number
  memTotalBytes: number
  memUsedPct: number
  /** 非 Linux 或无法读取温度时为 null */
  tempC: number | null
  diskFreeBytes: number
  diskTotalBytes: number
  diskFreePct: number
  load1: number
}

export interface MetricsResult {
  range: MetricsRange
  from: string
  to: string
  bucketSeconds: number
  sampleCount: number
  series: MetricsPoint[]
}

/* ---------- 机器人管理（v0.5.0，GET/POST /api/bots*） ---------- */

/** 当前仅支持 QQ 官方 Bot。 */
export type BotPlatform = 'qq'
export type BotTargetKind = 'channel' | 'user' | 'group'
export interface BotConnectivityProbe {
  reachable: boolean
  latencyMs: number | null
  status: number | null
  error: string | null
}
/** 出站连通性快照：外网 -> QQ 平台 API（Pi 直连，不依赖代理隧道）；不含凭据。 */
export interface BotConnectivitySnapshot {
  checkedAt: string | null
  checking: boolean
  internet: BotConnectivityProbe
  platforms: Partial<Record<BotPlatform, BotConnectivityProbe>>
}
export type BotDeliveryKind = 'notification' | 'command_reply' | 'publish' | 'test'
export type BotDeliveryStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'dead'
export type BotPublishStatus = 'draft' | 'queued' | 'sending' | 'sent' | 'failed' | 'canceled'

/** 运行状态：即使 Bot 功能未启用，status 接口仍可用于判断具体原因。 */
export interface BotStatus {
  enabled: boolean
  keyConfigured: boolean
  bots: number
  enabledBots: number
  targets: number
  queuedDeliveries: number
  queuedPublishes: number
  lastError: string | null
}

/** Bot 摘要：不包含 AppSecret 等密钥字段。 */
export interface BotSummary {
  id: string
  platform: BotPlatform
  name: string
  enabled: boolean
  /** 平台公开配置（QQ 为 appId），绝不包含密钥。 */
  config: Record<string, unknown>
  webhookUrl: string
  setupSteps: string[]
  targetsCount: number
  lastError: string | null
  lastCheckedAt: string | null
  createdAt: string
  updatedAt: string
  keyVersion: number
}

export interface BotInboundTarget {
  botId: string
  targetExternalId: string
  targetKind: BotTargetKind
  userId: string
  userName: string | null
  isDirect: boolean
  lastSeenAt: string
}

export interface BotTarget {
  id: string
  botId: string
  externalId: string
  label: string
  kind: BotTargetKind
  allowCommands: boolean
  allowNotifications: boolean
  /** 是否允许该目标内成员普通消息 Chat；不授予斜杠命令权限。 */
  allowChat: boolean
  /** 静默时段（本地分钟 0-1439，Asia/Shanghai）；两者同时为空表示不静默。 */
  quietStartMinute: number | null
  quietEndMinute: number | null
  createdAt: string
}

export interface BotDelivery {
  id: string
  botId: string
  targetId: string | null
  kind: BotDeliveryKind
  status: BotDeliveryStatus
  attempts: number
  nextAttemptAt: string | null
  lastError: string | null
  /** 服务端根据 lastError 映射的中文提示（可能为空）。 */
  lastErrorHint?: string | null
  externalId: string | null
  createdAt: string
  sentAt: string | null
}

export interface BotPublishJob {
  id: string
  botId: string
  targetId: string
  text: string
  scheduledAt: string | null
  status: BotPublishStatus
  attempts: number
  lastError: string | null
  /** 服务端根据 lastError 映射的中文提示（可能为空）。 */
  lastErrorHint?: string | null
  createdAt: string
  sentAt: string | null
}

/** 创建 Bot：密钥字段只提交、不回显。QQ 的 AppID 放 config.appId。 */
export interface BotCreateInput {
  platform: BotPlatform
  name: string
  /** QQ 官方 Bot AppSecret。 */
  token: string
  config?: Record<string, unknown>
}

/** 更新 Bot：省略/留空密钥表示保持原值；platform 不可修改。 */
export interface BotUpdateInput {
  name?: string
  enabled?: boolean
  config?: Record<string, unknown>
  token?: string
}

export interface BotTargetInput {
  externalId: string
  label: string
  kind: BotTargetKind
  allowCommands: boolean
  allowNotifications: boolean
  allowChat?: boolean
  quietStartMinute?: number | null
  quietEndMinute?: number | null
}

export type BotTargetPatch = Partial<Omit<BotTargetInput, 'externalId'>>

/** 发布任务：QQ 仅支持纯文本；发布属数据外发，必须 TOTP 再认证。 */
export interface BotPublishInput {
  targetId: string
  text: string
  /** 6 位 TOTP 验证码，服务端校验后立即丢弃，不写入队列。 */
  totpCode: string
  scheduledAt?: string | null
  /** 二次确认文本，必须为 PUBLISH。 */
  confirmText: 'PUBLISH'
}

/** Bot 运维指标（v0.5.1）。 */
export interface BotMetrics {
  hours: number
  deliveries: { total: number; sent: number; failed: number; dead: number; successRate: number }
  publishes: { total: number; sent: number; failed: number }
  events: number
  lastError: string | null
  /** 服务端根据 lastError 映射的中文提示（可能为空）。 */
  lastErrorHint?: string | null
  lastSentAt: string | null
}

/* ---------- 机器人诊断与用户数据（v0.5.7） ---------- */

/** 单项连接检查结果：只描述凭据/Webhook/配置是否可用，不含任何密钥。 */
export interface BotHealthItem {
  name: string
  ok: boolean
  detail: string
}

/** POST /api/bots/:id/check 的脱敏结果。 */
export interface BotHealthCheck {
  ok: boolean
  items: BotHealthItem[]
  checkedAt: string
}

/** 入站事件元数据：不含消息正文、用户名等个人数据。 */
export interface BotEventItem {
  eventId: string
  kind: string | null
  outcome: string | null
  detail: string | null
  targetExternalId: string | null
  userId: string | null
  receivedAt: string
  updatedAt: string | null
}

/** 私聊角色卡摘要：服务端只返回元数据，正文不通过 Web 暴露。 */
export interface BotRoleSummary {
  userId: string
  userName: string | null
  name: string
  enabled: boolean
  /** 角色设定字符数，仅用于展示规模，不返回正文。 */
  promptLength: number
  createdAt: string
  updatedAt: string
}

/** 结构化长期记忆类型（v0.5.11）。 */
export type BotMemoryKind =
  | 'profile'
  | 'preference'
  | 'fact'
  | 'project'
  | 'task'
  | 'relationship'
  | 'episode'

/** 管理端用户级记忆元数据：只含条目数/类型分布，不含任何 key/value 正文。 */
export interface BotMemoryUserSummary {
  userId: string
  userName: string | null
  itemCount: number
  kinds: Partial<Record<BotMemoryKind, number>>
  memoryEnabled: boolean
  /** 最近一条记忆更新时间；无条目时为 null。 */
  updatedAt: string | null
}

/** 管理端单条记忆元数据：绝不包含 key/value 正文。 */
export interface BotMemoryItemSummary {
  id: string
  kind: BotMemoryKind
  importance: number
  confidence: number
  updatedAt: string
  /** null 表示永不过期。 */
  expiresAt: string | null
}
