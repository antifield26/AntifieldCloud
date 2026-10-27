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
  /** 服务端可能拿不到 UA（旧会话/异常客户端），展示层需容忍 null。 */
  userAgent: string | null
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

/**
 * 世界一致性备份状态（只读文件，由 root 备份脚本写入；文件缺失时服务端返回 null）。
 * 字段以 scripts/backup-world.mjs 实际写出的 JSON 为准：`kept` 是归档名数组，份数看 `keptCount`。
 */
export interface WorldBackupStatus {
  lastRunAt?: string | null
  ok?: boolean | null
  archiveName?: string | null
  sizeBytes?: number | null
  sha256?: string | null
  durationMs?: number | null
  /** 上次运行后保留的归档名（Pi 端）；不是数字。 */
  kept?: string[] | null
  /** 保留份数（脚本单独写出的计数）。 */
  keptCount?: number | null
  error?: string | null
  message?: string | null
}

/**
 * PC 周度拉取状态（只读文件，由 scripts/world-pull.ps1 写入）。
 * `kept` 是本地保留的归档名数组，份数看 `keptCount`。
 */
export interface WorldPullStatus {
  /** 契约字段为 lastPullAt；兼容脚本可能写入 lastRunAt */
  lastPullAt?: string | null
  lastRunAt?: string | null
  ok?: boolean | null
  archiveName?: string | null
  archiveNames?: string[] | null
  pulledCount?: number | null
  ackedCount?: number | null
  sizeBytes?: number | null
  /** 本地保留的归档名；不是数字。 */
  kept?: string[] | null
  /** 本地保留份数（脚本单独写出的计数）。 */
  keptCount?: number | null
  pendingRemaining?: number | null
  lastBackupOk?: boolean | null
  lastBackupArchive?: string | null
  error?: string | null
  message?: string | null
}

/**
 * 恢复演练状态（只读文件，由 scripts/drill.ps1 写入）。
 * 实际字段为 `report/latestDb/schemaVersion/worldArchive/worldChecked/...`；
 * `reportPath`/`dbIntegrity` 仅用于兼容旧状态文件，当前脚本不再写入。
 */
export interface DrillStatus {
  lastRunAt?: string | null
  ok?: boolean | null
  /** 报告目录名（脚本写入的 `report`），不包含本地路径。 */
  report?: string | null
  fullArchive?: string | null
  incCount?: number | null
  latestDb?: string | null
  schemaVersion?: number | null
  worldArchive?: string | null
  worldChecked?: boolean | null
  error?: string | null
  message?: string | null
  /** 旧状态文件兼容字段：仅当真实字段缺失时回退展示。 */
  reportPath?: string | null
  /** 旧状态文件兼容字段：仅当真实字段缺失时回退展示。 */
  dbIntegrity?: string | null
}

export interface BackupEncryptionStatus {
  /** 备份整包加密是否启用（默认关闭）。 */
  enabled: boolean
  /** Pi 端是否已配置可用的 age 公钥（缺失时 prepare 会失败关闭）。 */
  keyConfigured: boolean
}

/** PC 端异地副本状态（只读状态文件，由 backup-offsite 脚本写入；不含远端路径/凭据）。 */
export interface OffsiteStatus {
  /** 异地副本是否启用（默认关闭；状态文件存在即视为脚本已配置）。 */
  enabled?: boolean | null
  lastRunAt?: string | null
  /** 兼容字段；优先 lastRunAt。 */
  lastPushAt?: string | null
  ok?: boolean | null
  /** 远端目标别名（不是真实路径/URL/凭据；脚本字段 remoteLabel）。 */
  remoteLabel?: string | null
  targetAlias?: string | null
  /** 本次上传/跳过/失败数量与字节数（脚本字段）。 */
  uploaded?: number | null
  skipped?: number | null
  failed?: number | null
  bytes?: number | null
  /** 远端保留的归档数（脚本字段 keptRemote）。 */
  keptRemote?: number | null
  /** 被拒绝上传的明文归档数量（安全信号：脚本只上传 .age）。 */
  plaintextSkipped?: number | null
  /** 兼容字段（旧/新脚本可能使用）。 */
  transferredCount?: number | null
  pendingRemaining?: number | null
  kept?: string[] | null
  keptCount?: number | null
  lastError?: string | null
  error?: string | null
  message?: string | null
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
  /** v0.7.0：加密归档计数、加密开关/公钥状态与 PC 异地副本状态。 */
  encryptedPendingCount?: number | null
  encryptedAckedCount?: number | null
  encryption?: BackupEncryptionStatus | null
  offsite?: OffsiteStatus | null
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
  /** 仅 status='completed' 时返回：已登记文件 id，客户端据此在响应丢失后直接结束而不重传。 */
  fileId?: string
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
/** 审计写入诊断：失败计数与最近错误（不含量级明细/审计内容）。 */
export interface VersionAuditDiagnostics {
  failureCount: number
  lastError: string | null
  lastFailureAt: string | null
}

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
  /** v0.8.0：Lofii 集成是否启用、Lofii 控制接口是否可用（旧服务端不下发时按关闭处理）。 */
  lofiiEnabled?: boolean
  lofiiControlEnabled?: boolean
  /** 当前程序支持的 schema 版本（v0.7.0）；旧服务端不下发时不比较演练一致性。 */
  schemaVersion?: number
  /** v0.7.0：备份整包加密开关与 Pi 端 age 公钥是否就绪（不读取私钥）。 */
  backupArchiveEncryption?: boolean
  backupAgeRecipientConfigured?: boolean
  /** v0.7.0：PC 异地副本状态文件是否存在（缺失时 UI 显示未配置）。 */
  backupOffsiteStatusConfigured?: boolean
  /** 审计写入诊断（失败计数/最近错误；不包含审计明细）。 */
  audit?: VersionAuditDiagnostics
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
  /** 当前 schema 版本；未知时为 null（演练一致性检查据此降级为“不比较”）。 */
  schemaVersion: number | null
  /** v0.7.0 特性状态（旧服务端不下发时按关闭/未配置处理）。 */
  backupArchiveEncryption: boolean
  backupAgeRecipientConfigured: boolean
  backupOffsiteStatusConfigured: boolean
  /** 审计写入诊断；旧服务端不下发时为 null。 */
  audit: VersionAuditDiagnostics | null
  /** v0.8.0：Lofii 集成是否启用（决定 Minecraft 页是否显示 Lofii 标签页）。 */
  lofiiEnabled: boolean
  /** v0.8.0：Lofii 控制接口是否可用（控制未启用时只读展示，禁用任务/移动/聊天操作）。 */
  lofiiControlEnabled: boolean
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
  /** Webhook 类型（旧服务端可能不下发）。 */
  webhookType?: string | null
  diskFreePct: number | null
  tempC: number | null
  /** 内存使用率告警阈值（百分比）。 */
  memoryUsedPct?: number | null
  backupMaxAgeHours: number | null
  /** 世界备份/拉取超期小时数与恢复演练超期天数（v0.4.0，旧服务端可能不下发）。 */
  worldBackupMaxAgeHours?: number | null
  drillMaxAgeDays?: number | null
  /** 异地副本超期阈值（小时，v0.7.0）。 */
  offsiteMaxAgeHours?: number | null
  cooldownMinutes: number | null
  /** 持续 firing 的重通知间隔（小时，v0.7.2；旧服务端可能不下发）。 */
  repeatHours?: number | null
  checkIntervalSeconds: number | null
  /** 最近一次告警评估时间。 */
  lastEvaluatedAt?: string | null
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
  /** 服务端归档文件是否存在；acked 后 PC 拉取确认可能主动删除远端文件，此时仍为 acked 但 available=false。 */
  available?: boolean
  verifiedAt: string | null
  pulledAt: string | null
  ackedAt: string | null
  lastError: string | null
  manifest: BackupManifest | null
  /** v0.7.0：age 加密归档（Pi 无私钥，Web 不可校验/恢复；服务端对所有危险端点返回 archive_encrypted）。 */
  encrypted?: boolean
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
  /** v0.7.0：加密 pending/acked 归档计数（Web 只能展示，不能校验/恢复）。 */
  encryptedPendingCount?: number
  encryptedAckedCount?: number
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
  /** v0.7.0：PC 异地副本状态（当前由 dashboard.backup 下发；保留可选字段兼容服务端扩展）。 */
  offsite?: OffsiteStatus | null
}

export interface BackupImportVerify {
  ok: boolean
  error?: string
}

export interface BackupImportResult {
  archive: BackupArchive
  verify?: BackupImportVerify
  warnings?: string[]
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
  /** v0.7.0：本次生成是否为加密归档，以及密文/明文元数据（明文哈希只在 sidecar，PC 校验）。 */
  encrypted?: boolean
  archiveFormat?: 'tar.gz' | 'tar.gz.age'
  metaName?: string | null
  plainSha256?: string | null
  plainSize?: number | null
  /** 物理文件缺失被跳过（游标不会越过缺失项，下次 prepare 会自动补入）。 */
  skippedMissing?: string[]
  warnings?: string[]
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
  /** 条目超过服务端上限（500）时为 true：列表不完整，留空选择表示全部。 */
  truncated?: boolean
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
  /** 创建计划时因归档 manifest 标记缺失而被剔除的文件 id（服务端返回）。 */
  skippedMissing?: string[]
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
  /** 执行时归档内容仍缺失、已跳过未恢复的文件 id；非空时不能视为完整恢复。 */
  skippedMissing?: string[]
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

/** AI 工具隔离状态；supported=false 表示 OpenCode 拒绝 deny-all permissions 后降级（未隔离）。 */
export interface BotToolIsolationStatus {
  supported: boolean
  fallbackCount: number
  fallbackAt: string | null
}

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
  /** AI 工具隔离状态；未配置 AI 时为 null。 */
  aiToolIsolation?: BotToolIsolationStatus | null
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

export type GroupReplyMode = 'mention' | 'all'

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
  groupReplyMode: GroupReplyMode
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
  groupReplyMode?: GroupReplyMode
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

/** 群聊角色卡列表项：未配置时 name/enabled/updatedAt 为空。 */
export interface BotGroupRoleSummary {
  targetId: string
  targetLabel: string
  targetExternalId: string
  name: string | null
  enabled: boolean
  promptLength: number
  updatedAt: string | null
}

/** 群聊角色卡编辑详情（管理员可编辑正文）。 */
export interface BotGroupRoleDetail {
  targetId: string
  targetLabel: string
  targetExternalId: string
  name: string
  prompt: string
  enabled: boolean
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

/** 管理端群聊共享记忆元数据：按群目标聚合，不含 key/value。 */
export interface BotMemoryGroupSummary {
  scope: string
  targetExternalId: string
  targetName: string
  itemCount: number
  kinds: Partial<Record<BotMemoryKind, number>>
  updatedAt: string | null
}

/** 管理端单条记忆元数据：绝不包含 key/value 正文。 */
export interface BotMemoryItemSummary {  id: string
  kind: BotMemoryKind
  importance: number
  confidence: number
  updatedAt: string
  /** null 表示永不过期。 */
  expiresAt: string | null
}

/* ---------- Lofii 集成（v0.8.0，GET /api/lofii/status 等） ---------- */

/** Lofii 支持的 7 种任务（与 Lofii Bot 的 TaskName 一致）。 */
export type LofiiTaskName = 'fishing' | 'farming' | 'woodcutting' | 'mining' | 'forest' | 'sleep' | 'patrol'

/** 任务状态；pending_resume 表示有可恢复的暂停任务。 */
export type LofiiTaskState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'depositing'
  | 'recovering'
  | 'stopping'
  | 'defending'
  | 'pending_resume'

/** Lofii 与 Minecraft 的动态连接状态。 */
export type LofiiBotState = 'idle' | 'connecting' | 'connected' | 'backoff' | 'cooldown'

/** 手动移动动作；stop 只停止移动，不停止任务。 */
export type LofiiMoveAction = 'home' | 'come' | 'follow' | 'stop'

/** 任务进度计数（Lofii 快照原字段，未使用的计数为 0）。 */
export interface LofiiTaskProgress {
  fishCaught: number
  wheatHarvested: number
  planted: number
  deposited: number
  treesChopped: number
  logsChopped: number
  saplingsPlanted: number
  mobsKilled: number
  oresMined: number
  coalMined: number
  ironMined: number
  copperMined: number
  forestTreesChopped: number
  naturalLogsChopped: number
  naturalSaplingsPlanted: number
  sleepVotes: number
  nightSkipped: number
  patrolWaypoints: number
  patrolDistance: number
}

/** 排队中的任务；requestedBy 是发起方标识（如 panel），不是敏感信息。 */
export interface LofiiQueuedTask {
  taskId: string
  name: LofiiTaskName
  requestedBy: string
  requestedAt: string
}

/** 可恢复的暂停任务：需在 expiresAt 前恢复，否则 Lofii 自动标记 interrupted。 */
export interface LofiiPendingResume {
  taskId: string
  name: LofiiTaskName
  startedAt: string
  elapsedSec: number
  progress: LofiiTaskProgress
  expiresAt: string
}

export interface LofiiTask {
  enabled: boolean
  active: boolean
  name: LofiiTaskName | null
  state: LofiiTaskState
  startedAt: string | null
  elapsedSec: number
  progress: LofiiTaskProgress
  failures: number
  /** 已截断的短错误，不含提示词或密钥。 */
  lastError: string | null
  pendingResume: LofiiPendingResume | null
  queue: LofiiQueuedTask[]
}

/** RCON 只读管理快照（白名单/TPS/在线列表；无任何写能力）。 */
export interface LofiiAdmin {
  enabled: boolean
  rcon: boolean
  updatedAt: string | null
  lastError: string | null
  tps: { one: number | null; five: number | null; fifteen: number | null }
  online: { count: number | null; max: number | null; players: string[] }
  whitelist: { count: number | null; names: string[] }
  time: { ticks: number | null; label: string | null }
  backup: { status: string }
}

/** Bot 自身在 Minecraft 的连接信息；host/port 属于本机回环配置，不展示到 UI。 */
export interface LofiiMinecraft {
  connected: boolean
  username: string
  host: string
  port: number
  version: string
  reconnects: number
  lastDisconnect: { at: string; reason: string } | null
}

export interface LofiiPlayer {
  dimension: string | null
  position: { x: number; y: number; z: number } | null
  health: number | null
  food: number | null
}

export interface LofiiServer {
  reachable: boolean
  online: number
  max: number
  versionName: string | null
  motd: string | null
  latencyMs: number | null
  lastPingAt: string | null
}

export interface LofiiPresence {
  enabled: boolean
  pollMs: number
  graceMs: number
  checkMs: number
  otherPlayers: number
  lastDecision: string
}

export interface LofiiAi {
  enabled: boolean
  provider: string
  model: string
  inFlight: number
  queued: number
  failures: number
  lastLatencyMs: number | null
  lastError: string | null
}

export interface LofiiMemory {
  players: number
  turns: number
}

/** Lofii `/status` 快照（由服务端转发；不包含 Token、密码或记忆正文）。 */
export interface LofiiStatus {
  version: string
  uptimeSec: number
  state: LofiiBotState
  minecraft: LofiiMinecraft
  player: LofiiPlayer
  server: LofiiServer
  presence: LofiiPresence
  ai: LofiiAi
  memory: LofiiMemory
  task: LofiiTask
  admin: LofiiAdmin
}

/** 事件类型；hello 只出现在 SSE 首帧，/status 的事件环通常为其余类型。 */
export type LofiiEventType = string

/** Lofii 内存事件环中的一条事件；data 形状随 type 变化，渲染层只读取已知字段。 */
export interface LofiiEvent {
  id: string
  type: LofiiEventType
  ts: string
  data: unknown
}

/** GET /api/lofii/status 的聚合快照：集成状态 + Lofii 快照 + 最近事件（newest first，最多 100）。 */
export interface LofiiSnapshot {
  enabled: boolean
  reachable: boolean
  stale: boolean
  controlEnabled: boolean
  alertsEnabled: boolean
  version: string | null
  contractVersion: number | null
  /** 旧版 Lofii 没有 /events/recent 时为 false：UI 显示“需升级 v0.6.0”提示。 */
  eventsSupported: boolean
  lastPollAt: string | null
  error: string | null
  status: LofiiStatus | null
  events: LofiiEvent[]
}

export type LofiiHistoryKind = 'samples' | 'alerts'

/** 历史查询：服务端透传 Lofii 的 /history，from/to 为 ISO 时间。 */
export interface LofiiHistoryQuery {
  kind: LofiiHistoryKind
  from?: string
  to?: string
  /** 1–200（AntifieldComplexx 侧上限）。 */
  limit?: number
}

/** 60 秒一条的历史采样（不含聊天正文/Token）。 */
export interface LofiiHistorySample {
  ts: string
  connected: boolean
  state: string
  taskName: string | null
  taskState: string | null
  health: number | null
  food: number | null
  memoryMb: number | null
  tps: number | null
  queueLen: number
  rssMb: number | null
}

/** Lofii 历史告警（type 为 low_health/task_failed/disconnected/chest_full/defense_retreat）。 */
export interface LofiiHistoryAlert {
  id: number | string
  ts: string
  type: string
  severity: string
  message: string
  details?: Record<string, unknown> | null
}

/** GET /api/lofii/history 的响应：按 kind 动态携带 samples 或 alerts。 */
export interface LofiiHistory {
  kind: LofiiHistoryKind
  from: string | null
  to: string | null
  count: number
  samples?: LofiiHistorySample[]
  alerts?: LofiiHistoryAlert[]
}

/** 控制接口成功响应的可选字段；UI 不依赖具体形状，操作后重新拉取 status。 */
export interface LofiiActionResult {
  ok?: boolean
  requestId?: string
  task?: LofiiTask
  action?: string
  lines?: number
  /** /task/start：任务已有 active 时入队，position 为队列位置（1 起）。 */
  queued?: boolean
  position?: number | null
}
