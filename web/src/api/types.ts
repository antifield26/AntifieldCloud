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

export interface BackupStatus {
  lastPullAt: string | null
  ageHours: number | null
  sizeBytes: number | null
  ok: boolean | null
  overdue: boolean | null
  /** v0.3 可选扩展：待确认归档/孤儿归档数与最近错误 */
  pendingCount?: number | null
  orphanCount?: number | null
  lastError?: string | null
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

export interface CreateShareResult {
  share: Share
  url: string
}

export interface ShareListResult {
  items: Share[]
}

export interface RevokeShareResult {
  ok: boolean
  share?: Share
}

export type PublicShareState = 'active' | 'expired' | 'exhausted' | 'revoked'

export interface PublicShareMeta {
  fileName: string
  size: number
  mime: string | null
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
  share?: PublicShareMeta
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
}

export interface BackupListResult {
  items: BackupArchive[]
  inbox: BackupInboxItem[]
  orphans: BackupInboxItem[]
  state: BackupState
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
