// 与 docs/API.md 对应的前端类型定义。
// 所有时间均为 ISO 8601 UTC 字符串；展示层负责转换为 Asia/Shanghai。
// 本文件是前端唯一的数据结构来源，页面与组件不得自行臆造字段。

export interface ApiErrorBody {
  error: {
    code: string
    message: string
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
  csrfToken: string
}

export interface MeResult {
  user: User
  csrfToken: string
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
}

export interface BackupStatus {
  lastPullAt: string | null
  ageHours: number | null
  sizeBytes: number | null
  ok: boolean | null
  overdue: boolean | null
}

export interface ServicesStatus {
  minecraft: ServiceState
  cloudflared: ServiceState
  nginx: ServiceState
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
export type PreviewKind = 'image' | 'text' | 'markdown' | 'pdf' | 'none'

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

export interface FileDetailResult {
  item: FileItem
  path: BreadcrumbItem[]
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

export interface ClearTrashResult {
  ok: boolean
  count: number
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

export interface VersionResult {
  version: string
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
