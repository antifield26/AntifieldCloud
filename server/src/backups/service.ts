/**
 * 备份管理服务：归档清单/导入/校验、文件级恢复计划与执行。
 *
 * 安全边界：
 * - 整库恢复不提供 Web 执行：这里只恢复归档快照中的**文件内容**到新文件夹，不替换 DB/服务状态。
 * - 导入归档来自管理员上传：流式写入 `backups/imports/`（0700），文件名为白名单格式，不覆盖已有文件；
 *   归档内容在 verify 阶段做 SHA-256 与 tar 安全扫描（路径穿越/链接/设备/超大条目）。
 * - 恢复执行只读归档、只新增 files 行与新文件夹；失败清理已创建的行/物理文件；单并发 + 锁文件。
 * - 审计只记录归档名/数量/大小，不记录 TOTP、绝对路径或归档内容。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { Transform } from 'node:stream'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { audit } from '../auth/audit.ts'
import { verifyTotpForReauth } from '../auth/totp.ts'
import type { FileService } from '../files/service.ts'
import { MAX_TREE_DEPTH } from '../files/service.ts'
import { AppError, badRequest, conflict, notFound } from '../util/errors.ts'
import { newId, randomToken } from '../util/ids.ts'
import { readStatusFile, type StatusFileRecord } from '../util/status.ts'
import { nowIso } from '../util/time.ts'
import { inspectTarGz, invalidArchive, scanTarGz, unsafeArchive } from './tar.ts'

const ARCHIVE_NAME_PATTERN = /^snapshot-[0-9TZ]+(?:-[0-9]+)?-(full|inc)\.tar\.gz(\.age)?$/
const FILE_ENTRY_PATTERN = /^files\/[A-Za-z0-9_-]+\/([A-Za-z0-9_-]{8,64})$/
const DB_ENTRY_PATTERN = /^backups\/db-.*\.sqlite$/

const MAX_RESTORE_FILES = 2000
const MAX_RESTORE_PATHS = 100
const MAX_ENTRY_LIST = 500
const MAX_IMPORT_BYTES = 100 * 1024 * 1024
const PREPARE_TIMEOUT_MS = 3300 * 1000
const STAGING_TTL_MS = 24 * 60 * 60_000
const LOCK_STALE_MS = 2 * 60 * 60_000
const RESERVED_FREE_BYTES = 256 * 1024 * 1024
/** 加载归档内 DB 快照时的行数上限，避免恶意/异常归档把内存打满（512M MemoryMax）。 */
const MAX_SNAPSHOT_ROWS = 100_000
/** 归档内 DB 快照文件大小上限（解压后），防止压缩炸弹。 */
const MAX_SNAPSHOT_DB_BYTES = 256 * 1024 * 1024
/** staging 目录总占用上限（同时受可用空间 20% 约束）。 */
const MAX_STAGING_BYTES = 2 * 1024 * 1024 * 1024
/** 恢复/校验解包预算：低于 tar 默认 32 GiB，避免恶意归档写满磁盘（安全审计 S4-02）。 */
const MAX_RESTORE_UNPACKED_BYTES = 8 * 1024 * 1024 * 1024
const MAX_RESTORE_ENTRY_BYTES = 2 * 1024 * 1024 * 1024
const STAGING_FREE_RATIO = 0.2

export interface BackupServiceConfig {
  dataDir: string
  quotaBytes: number
  maxUploadBytes: number
  backupPullFile: string
  /** Web 导入归档大小上限，默认 100 MiB（与任务约定一致）。 */
  backupImportMaxBytes?: number
  /** Web 导入归档保留天数；0=永久保留，默认 90。 */
  backupImportRetentionDays?: number
  /** 恢复计划有效期（分钟），默认 30。 */
  backupRestorePlanTtlMinutes?: number
  /** 单次恢复的文件数上限，默认 2000。 */
  backupRestoreMaxEntries?: number
  /** 恢复功能总开关；false 时计划/执行/浏览接口返回 403。 */
  backupRestoreEnabled?: boolean
  /** 生成归档超时（毫秒）；未显式配置时按 backupPrepareTimeoutSec 计算。 */
  backupPrepareTimeoutMs?: number
  /** 生成归档超时（秒），默认 3300（55 分钟，覆盖 5 GiB 归档打包）。 */
  backupPrepareTimeoutSec?: number
  /** 世界备份/拉取/演练状态文件；由 root 脚本写入，应用只读，缺失时返回 null。 */
  worldBackupStatusFile?: string
  worldPullStatusFile?: string
  drillStatusFile?: string
  /** 加载归档快照的最大行数（测试可调小），默认 100000。 */
  backupSnapshotMaxRows?: number
  /** staging 目录总占用上限（字节，测试可调小）；默认 2 GiB，同时受可用空间 20% 约束。 */
  backupStagingMaxBytes?: number
}

export type BackupRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }>

export interface BackupServiceOptions {
  files: FileService
  now?: () => Date
  runner?: BackupRunner
  logger?: (level: 'info' | 'warn' | 'error', message: string, detail?: Record<string, unknown>) => void
  /** 测试注入可用空间（字节）；返回 null 时走真实 statfs。 */
  freeBytes?: () => number | null
}

export interface BackupActor {
  username: string
  ip: string | null
}

interface ArchiveRow {
  name: string
  mode: 'full' | 'inc'
  created_at: string
  sha256: string
  size: number
  file_count: number
  pulled_at: string | null
  acked_at: string | null
  deleted_at: string | null
  verified_at: string | null
  origin: 'pi' | 'import' | 'legacy'
  manifest_json: string | null
  last_error: string | null
}

export interface BackupManifestSummary {
  schema: number
  createdAt: string
  mode: 'full' | 'inc'
  since: string | null
  database: string
  fileCount: number
  totalBytes: number
}

export interface BackupArchiveItem {
  id: string
  name: string
  mode: 'full' | 'inc'
  createdAt: string
  sizeBytes: number
  sha256: string
  status: 'pending' | 'acked' | 'imported' | 'missing'
  origin: 'pi' | 'import' | 'legacy'
  /** 服务端归档文件当前是否存在；acked 后 PC 拉取确认可能主动删除远端文件，此时仍为 acked。 */
  available: boolean
  verifiedAt: string | null
  pulledAt: string | null
  ackedAt: string | null
  lastError: string | null
  manifest: BackupManifestSummary | null
  /** v0.7.0：age 加密归档（Pi 无私钥，Web 不可校验/恢复）。 */
  encrypted: boolean
}

export interface InboxItem {
  name: string
  sizeBytes: number
  modifiedAt: string
  imported: boolean
}

export interface BackupListResult {
  items: BackupArchiveItem[]
  inbox: InboxItem[]
  orphans: InboxItem[]
  state: {
    lastPullAt: string | null
    pendingCount: number
    ackedCount: number
    importCount: number
    orphanCount: number
    lastError: string | null
    dataDirFreeBytes: number
    /** v0.7.0：加密 pending/acked 归档计数（Web 只能展示，不能校验/恢复）。 */
    encryptedPendingCount: number
    encryptedAckedCount: number
  }
  /** 世界备份/拉取/演练只读状态（文件缺失为 null）；不含密钥与服务器路径。 */
  world: StatusFileRecord | null
  worldPull: StatusFileRecord | null
  drill: StatusFileRecord | null
}

export interface ImportResult {
  archive: BackupArchiveItem
  verify: { ok: boolean; error?: string }
}

export interface RestorePlanItem {
  id: string
  status: 'planned' | 'executing' | 'completed' | 'failed' | 'expired'
  targetName: string
  archive: string
  archives: string[]
  fileCount: number
  totalBytes: number
  createdAt: string
  expiresAt: string
  completedAt: string | null
  error: string | null
  /** 因归档 manifest 标记缺失而被跳过的文件 id；恢复仍会继续进行。 */
  skippedMissing: string[]
}

export interface RestoreResult {
  targetFolderId: string
  targetName: string
  filesRestored: number
  bytesRestored: number
  durationMs: number
  /** 归档中缺少内容、本次未恢复的文件 id。 */
  skippedMissing: string[]
}

export interface ArchiveEntryItem {
  path: string
  name: string
  kind: 'file' | 'dir'
  size: number
}

interface PlanRow {
  id: string
  archives_json: string
  selection_json: string
  target_name: string
  status: RestorePlanItem['status']
  created_by: string
  created_at: string
  expires_at: string
  completed_at: string | null
  error: string | null
}

interface SelectionJson {
  paths: string[]
  fileCount: number
  totalBytes: number
  skippedMissing?: string[]
}

interface SnapshotRow {
  id: string
  parent_id: string | null
  name: string
  kind: 'file' | 'dir'
  size: number
  sha256: string | null
  mime: string | null
  /** 快照可能来自 v0.3（无 origin 列），读取时按 user 处理。 */
  origin: string | null
}

interface SnapshotIndex {
  rows: SnapshotRow[]
  byId: Map<string, SnapshotRow>
  pathOf: Map<string, string>
  childrenOf: Map<string | null, SnapshotRow[]>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

function compactStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function validArchiveName(name: unknown): string {
  if (typeof name !== 'string' || !ARCHIVE_NAME_PATTERN.test(name) || name.length > 200) {
    throw badRequest('归档名不合法', 'invalid_archive_name')
  }
  return name
}

/** 判断归档名是否为 age 加密归档（唯一可信来源：归档名后缀；DB 记录不新增列）。 */
export function isEncryptedArchiveName(name: string): boolean {
  return name.endsWith('.tar.gz.age')
}

/** 加密归档在 Web 侧统一返回 409：Pi 无私钥，必须在 PC 用离线身份校验/恢复。 */
function encryptedArchiveError(): AppError {
  return new AppError(409, 'archive_encrypted', '加密归档需在 PC 使用离线私钥校验/恢复，Web 不提供解密')
}

function modeFromName(name: string): 'full' | 'inc' {
  const match = ARCHIVE_NAME_PATTERN.exec(name)
  return match?.[1] === 'full' ? 'full' : 'inc'
}

function normalizeSelectionPaths(input: unknown): string[] {
  if (input === undefined || input === null) return ['/']
  if (!Array.isArray(input)) throw badRequest('paths 必须是字符串数组', 'invalid_selection')
  if (input.length === 0) return ['/']
  if (input.length > MAX_RESTORE_PATHS) throw badRequest(`一次最多选择 ${MAX_RESTORE_PATHS} 个路径`, 'invalid_selection')
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of input) {
    if (typeof raw !== 'string') throw badRequest('路径必须是字符串', 'invalid_selection')
    const text = raw.normalize('NFC').trim()
    if (!text.startsWith('/') || text.length > 1024) throw badRequest('路径不合法', 'invalid_selection')
    const segments = text.split('/').filter((segment) => segment.length > 0)
    if (segments.some((segment) => segment === '..' || segment === '.')) {
      throw badRequest('路径不能包含 . 或 ..', 'invalid_selection')
    }
    const normalized = segments.length === 0 ? '/' : `/${segments.join('/')}`
    if (!seen.has(normalized)) {
      seen.add(normalized)
      out.push(normalized)
    }
  }
  return out
}

function sanitizeMessage(message: string, dataDir: string): string {
  let text = message.split(dataDir).join('[DATA]').split(dataDir.replace(/\\/g, '/')).join('[DATA]')
  text = text.replace(/\s+/g, ' ').trim()
  return text.slice(0, 300)
}

function formatLimit(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.max(1, Math.floor(bytes / 1024 / 1024))} MiB`
  return `${Math.max(1, Math.floor(bytes / 1024))} KB`
}

/** 归档来源归类：legacy 行视为 Pi（升级前默认 origin=pi），导入归档单独成链。 */
function archiveOrigin(row: Pick<ArchiveRow, 'origin'>): 'pi' | 'import' {
  return row.origin === 'import' ? 'import' : 'pi'
}

/** 从 manifest_json 中提取 skippedMissing（旧归档没有该字段时返回空）。 */
function manifestSkippedMissing(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = asRecord(JSON.parse(raw))
    const value = parsed.skippedMissing
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export class BackupService {
  private readonly db: DatabaseSync
  private readonly config: Required<BackupServiceConfig>
  private readonly files: FileService
  private readonly clock: () => Date
  private readonly runner: BackupRunner
  private readonly log: (level: 'info' | 'warn' | 'error', message: string, detail?: Record<string, unknown>) => void
  private readonly freeBytesOverride: (() => number | null) | null
  private prepareRunning = false
  private restoreRunning = false

  constructor(db: DatabaseSync, config: BackupServiceConfig, options: BackupServiceOptions) {
    this.db = db
    this.files = options.files
    this.clock = options.now ?? (() => new Date())
    this.log = options.logger ?? (() => {})
    this.freeBytesOverride = options.freeBytes ?? null
    this.config = {
      dataDir: config.dataDir,
      quotaBytes: config.quotaBytes,
      maxUploadBytes: config.maxUploadBytes,
      backupPullFile: config.backupPullFile,
      backupImportMaxBytes: Math.min(config.backupImportMaxBytes ?? MAX_IMPORT_BYTES, MAX_IMPORT_BYTES),
      backupImportRetentionDays: Math.max(0, Math.min(3650, Math.floor(config.backupImportRetentionDays ?? 90))),
      backupRestorePlanTtlMinutes: config.backupRestorePlanTtlMinutes ?? 30,
      backupRestoreMaxEntries: config.backupRestoreMaxEntries ?? MAX_RESTORE_FILES,
      backupRestoreEnabled: config.backupRestoreEnabled ?? true,
      backupPrepareTimeoutMs:
        config.backupPrepareTimeoutMs ?? Math.max(1, config.backupPrepareTimeoutSec ?? PREPARE_TIMEOUT_MS / 1000) * 1000,
      backupPrepareTimeoutSec: config.backupPrepareTimeoutSec ?? PREPARE_TIMEOUT_MS / 1000,
      worldBackupStatusFile: config.worldBackupStatusFile ?? join(config.dataDir, 'world-backup-status.json'),
      worldPullStatusFile: config.worldPullStatusFile ?? join(config.dataDir, 'world-pull-status.json'),
      drillStatusFile: config.drillStatusFile ?? join(config.dataDir, 'drill-status.json'),
      backupSnapshotMaxRows: Math.max(1, config.backupSnapshotMaxRows ?? MAX_SNAPSHOT_ROWS),
      backupStagingMaxBytes: Math.max(
        1024 * 1024,
        Math.min(MAX_STAGING_BYTES, Math.floor(config.backupStagingMaxBytes ?? MAX_STAGING_BYTES)),
      ),
    }
    this.runner = options.runner ?? this.defaultRunner()
    // 启动即清理崩溃遗留的恢复锁（DATA-03）：单进程启动时不可能有本进程的恢复在运行。
    this.cleanupStaleRestoreLock()
  }

  /** 清理超过 LOCK_STALE_MS 的恢复锁；返回是否清理。活动恢复进程会刷新锁 mtime。 */
  private cleanupStaleRestoreLock(): boolean {
    const lockPath = join(this.config.dataDir, 'tmp', 'restore.lock')
    try {
      const stats = statSync(lockPath)
      if (Date.now() - stats.mtimeMs <= LOCK_STALE_MS) return false
      unlinkSync(lockPath)
      this.log('warn', '已清理陈旧的恢复锁（进程崩溃/超时遗留）')
      return true
    } catch {
      return false
    }
  }

  // ---------- 目录与基础查询 ----------

  private get backupsDir(): string {
    return join(this.config.dataDir, 'backups')
  }

  private get importsDir(): string {
    return join(this.backupsDir, 'imports')
  }

  private get stagingRoot(): string {
    return join(this.config.dataDir, 'tmp', 'restore')
  }

  private ensureLayout(): void {
    mkdirSync(this.backupsDir, { recursive: true, mode: 0o750 })
    mkdirSync(this.importsDir, { recursive: true, mode: 0o700 })
    mkdirSync(this.stagingRoot, { recursive: true, mode: 0o700 })
  }

  /** 归档实际存储路径：Pi 生成的在 backups/，Web 导入的在 backups/imports/。 */
  private storedPath(row: ArchiveRow): string {
    return row.origin === 'import' ? join(this.importsDir, row.name) : join(this.backupsDir, row.name)
  }

  private rowByName(name: string): ArchiveRow {
    const row = this.db.prepare('SELECT * FROM backup_archives WHERE name = ?').get(validArchiveName(name)) as unknown as
      | ArchiveRow
      | undefined
    if (!row || row.deleted_at) throw notFound('归档不存在')
    return row
  }

  private effectiveCreatedAt(row: ArchiveRow): string {
    const manifest = this.parseStoredManifest(row.manifest_json)
    return manifest?.createdAt ?? row.created_at
  }

  private parseStoredManifest(raw: string | null): BackupManifestSummary | null {
    if (!raw) return null
    try {
      const parsed = asRecord(JSON.parse(raw))
      if (typeof parsed.createdAt !== 'string' || (parsed.mode !== 'full' && parsed.mode !== 'inc')) return null
      return {
        schema: Number(parsed.schema ?? 1),
        createdAt: parsed.createdAt,
        mode: parsed.mode,
        since: typeof parsed.since === 'string' ? parsed.since : null,
        database: typeof parsed.database === 'string' ? parsed.database : '',
        fileCount: Number(parsed.fileCount ?? 0),
        totalBytes: Number(parsed.totalBytes ?? 0),
      }
    } catch {
      return null
    }
  }

  private toArchiveItem(row: ArchiveRow): BackupArchiveItem {
    const exists = existsSync(this.storedPath(row))
    const origin: BackupArchiveItem['origin'] = row.origin === 'import' || row.origin === 'legacy' ? row.origin : 'pi'
    // acked 表示 PC 已拉取确认；PC ack 后会删除远端归档文件，因此“文件不存在”对 acked 是正常状态，
    // 不能显示成 missing（否则 Dashboard 会误报应用归档文件缺失）。只有未 ack 的 Pi 归档文件缺失才是异常。
    let status: BackupArchiveItem['status']
    if (row.acked_at) status = 'acked'
    else if (origin === 'import') status = exists ? 'imported' : 'missing'
    else if (!exists) status = 'missing'
    else status = 'pending'
    return {
      id: row.name,
      name: row.name,
      mode: row.mode,
      createdAt: this.effectiveCreatedAt(row),
      sizeBytes: Number(row.size),
      sha256: row.sha256,
      status,
      origin,
      available: exists,
      verifiedAt: row.verified_at,
      pulledAt: row.pulled_at,
      ackedAt: row.acked_at,
      lastError: row.last_error,
      manifest: this.parseStoredManifest(row.manifest_json),
      encrypted: isEncryptedArchiveName(row.name),
    }
  }

  private allRows(): ArchiveRow[] {
    return this.db
      .prepare('SELECT * FROM backup_archives WHERE deleted_at IS NULL ORDER BY created_at ASC, name ASC')
      .all() as unknown as ArchiveRow[]
  }

  private pullState(): string | null {
    try {
      const raw = asRecord(JSON.parse(readFileSync(this.config.backupPullFile, 'utf8')))
      return typeof raw.lastPullAt === 'string' ? raw.lastPullAt : null
    } catch {
      return null
    }
  }

  private freeBytes(): number {
    const override = this.freeBytesOverride?.()
    if (typeof override === 'number' && Number.isFinite(override)) return Math.max(0, override)
    try {
      const stats = statfsSync(this.config.dataDir)
      return Number(stats.bavail) * Number(stats.bsize)
    } catch {
      return 0
    }
  }

  /** 当前 staging 目录总占用（字节）；目录不存在/不可读按 0。 */
  private stagingBytes(): number {
    let total = 0
    const walk = (dir: string): void => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        try {
          if (entry.isDirectory()) walk(full)
          else if (entry.isFile()) total += statSync(full).size
        } catch {
          // 单条目统计失败忽略。
        }
      }
    }
    walk(this.stagingRoot)
    return total
  }

  /** 清理 staging 下超过 TTL 的异常残留目录（崩溃/异常中断）。 */
  private cleanupStaleStaging(): void {
    let entries
    try {
      entries = readdirSync(this.stagingRoot, { withFileTypes: true })
    } catch {
      return
    }
    const now = this.clock().getTime()
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = join(this.stagingRoot, entry.name)
      try {
        if (now - statSync(full).mtimeMs > STAGING_TTL_MS) rmSync(full, { recursive: true, force: true })
      } catch {
        // 清理失败不影响后续流程。
      }
    }
  }

  /**
   * staging 空间预检：同时受总量上限（默认 2 GiB，测试可调）与可用空间 20% 约束，
   * 不足返回 507，避免解包归档把系统盘写满。调用方应传入**真实解包字节**，不能用归档内元数据声明值。
   */
  private assertStagingCapacity(neededBytes: number): void {
    this.cleanupStaleStaging()
    const free = this.freeBytes()
    if (free === 0) {
      // 无法读取可用空间（异常环境/测试）：不允许会解包的操作，只读操作继续。
      if (neededBytes > 0) throw new AppError(507, 'insufficient_storage', '无法读取磁盘空间，已拒绝解包归档')
      return
    }
    if (neededBytes > 0 && free < neededBytes + RESERVED_FREE_BYTES) {
      throw new AppError(507, 'insufficient_storage', '磁盘空间不足，无法解包归档')
    }
    const cap = Math.min(this.config.backupStagingMaxBytes, Math.floor(free * STAGING_FREE_RATIO))
    const used = this.stagingBytes()
    if (neededBytes > cap || used + neededBytes > cap) {
      throw new AppError(507, 'insufficient_storage', '备份解包临时空间不足，请清理后重试')
    }
  }

  list(): BackupListResult {
    const rows = this.allRows()
    const items = rows.map((row) => this.toArchiveItem(row))
    const known = new Set(rows.filter((row) => row.origin === 'import').map((row) => row.name))
    const inbox: InboxItem[] = []
    const orphans: InboxItem[] = []
    try {
      for (const entry of readdirSync(this.importsDir, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.startsWith('.part-')) continue
        const full = join(this.importsDir, entry.name)
        const stats = statSync(full)
        const item: InboxItem = {
          name: entry.name,
          sizeBytes: stats.size,
          modifiedAt: stats.mtime.toISOString(),
          imported: known.has(entry.name),
        }
        inbox.push(item)
        if (!item.imported) orphans.push(item)
      }
    } catch {
      // imports 目录不存在时视为空。
    }
    const lastError = rows
      .slice()
      .reverse()
      .find((row) => row.last_error)?.last_error ?? null
    const pendingCount = items.filter((item) => item.status === 'pending').length
    const ackedCount = items.filter((item) => item.status === 'acked').length
    const importCount = items.filter((item) => item.origin === 'import').length
    const encryptedPendingCount = items.filter((item) => item.status === 'pending' && item.encrypted).length
    const encryptedAckedCount = items.filter((item) => item.status === 'acked' && item.encrypted).length
    inbox.sort((a, b) => (a.name < b.name ? 1 : -1))
    orphans.sort((a, b) => (a.name < b.name ? 1 : -1))
    return {
      items,
      inbox,
      orphans,
      state: {
        lastPullAt: this.pullState(),
        pendingCount,
        ackedCount,
        importCount,
        orphanCount: orphans.length,
        lastError,
        dataDirFreeBytes: this.freeBytes(),
        encryptedPendingCount,
        encryptedAckedCount,
      },
      world: readStatusFile(this.config.worldBackupStatusFile),
      worldPull: readStatusFile(this.config.worldPullStatusFile),
      drill: readStatusFile(this.config.drillStatusFile),
    }
  }

  // ---------- 生成归档 ----------

  private defaultRunner(): BackupRunner {
    const scriptPath = fileURLToPath(new URL('../../../scripts/backup.mjs', import.meta.url))
    return async (args) => {
      try {
        const result = await new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
          execFile(
            process.execPath,
            [scriptPath, ...args],
            { timeout: this.config.backupPrepareTimeoutMs, maxBuffer: 4 * 1024 * 1024, cwd: resolve(scriptPath, '..', '..') },
            (error, stdout, stderr) => {
              if (error) {
                reject(Object.assign(error, { stdout, stderr }))
                return
              }
              resolvePromise({ stdout: String(stdout), stderr: String(stderr) })
            },
          )
        })
        return { code: 0, stdout: result.stdout, stderr: result.stderr }
      } catch (error) {
        const record = error as { code?: number; stdout?: string; stderr?: string; message?: string; killed?: boolean; signal?: string }
        return {
          code: typeof record.code === 'number' ? record.code : 1,
          stdout: record.stdout ?? '',
          stderr: record.stderr ?? record.message ?? '备份脚本执行失败',
          timedOut: record.killed === true || record.signal === 'SIGTERM',
        }
      }
    }
  }

  /** 超时/失败后的清理：只清理本次运行产生的锁与 .part 残片，避免误删其它进程的锁。 */
  private cleanupPrepareArtifacts(startedAt: number): void {
    const lockPath = join(this.backupsDir, '.backup.lock')
    try {
      if (existsSync(lockPath) && statSync(lockPath).mtimeMs >= startedAt - 5_000) {
        rmSync(lockPath, { force: true })
        this.log('warn', '备份生成超时/失败，已清理本次遗留的锁文件')
      }
    } catch {
      // 清理失败由后续人工处理。
    }
    let names: string[]
    try {
      names = readdirSync(this.backupsDir)
    } catch {
      names = []
    }
    for (const name of names) {
      // 加密 prepare 可能留下 .plain.tmp（明文临时）或 .part（密文/sidecar 临时）；超时后统一清理。
      if (!name.endsWith('.part') && !name.endsWith('.plain.tmp')) continue
      const full = join(this.backupsDir, name)
      try {
        if (statSync(full).mtimeMs >= startedAt - 5_000) rmSync(full, { force: true })
      } catch {
        // 忽略单个残片清理失败。
      }
    }
  }

  /** 锁状态：fresh=其它进程正在运行；stale=超过 1 小时可接管。 */
  private lockState(): 'none' | 'fresh' | 'stale' {
    const lockPath = join(this.backupsDir, '.backup.lock')
    try {
      if (!existsSync(lockPath)) return 'none'
      return Date.now() - statSync(lockPath).mtimeMs > 60 * 60 * 1000 ? 'stale' : 'fresh'
    } catch {
      return 'none'
    }
  }

  async prepare(actor: BackupActor, options: { full?: boolean } = {}): Promise<{
    ok: true
    mode: 'full' | 'inc'
    archiveName: string
    sizeBytes: number
    sha256: string
    fileCount: number
    warnings: string[]
    skippedMissing: string[]
    /** v0.7.0：本次是否生成 age 加密归档（加密开启时 Pi 无私钥，Web 不可校验/恢复）。 */
    encrypted: boolean
    archiveFormat: 'tar.gz' | 'tar.gz.age'
    metaName: string | null
    plainSha256: string | null
    plainSize: number | null
  }> {
    if (this.prepareRunning) throw conflict('已有备份生成任务在执行', 'backup_busy')
    const lock = this.lockState()
    if (lock === 'fresh') throw conflict('备份 CLI 正在运行（锁文件存在）', 'backup_busy')
    if (lock === 'stale') this.log('warn', '发现陈旧的备份锁文件（>1h），交给 CLI 按同样的陈旧规则接管')
    const startedAt = Date.now()
    this.prepareRunning = true
    try {
      this.ensureLayout()
      const args = ['--prepare', ...(options.full ? ['--full'] : [])]
      const result = await this.runner(args)
      const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      const last = lines.at(-1) ?? ''
      let parsed: Record<string, unknown> | null = null
      try {
        parsed = asRecord(JSON.parse(last))
      } catch {
        parsed = null
      }
      if (result.timedOut === true) {
        this.cleanupPrepareArtifacts(startedAt)
        throw new AppError(500, 'backup_prepare_timeout', '备份生成超时，已清理临时文件；请确认磁盘/系统负载后重试')
      }
      if (result.code !== 0 || !parsed || parsed.ok !== true) {
        this.cleanupPrepareArtifacts(startedAt)
        const message = sanitizeMessage(String(parsed?.error ?? result.stderr ?? '备份脚本执行失败'), this.config.dataDir)
        throw new AppError(502, 'backup_prepare_failed', `生成备份失败：${message}`)
      }
      const archiveName = validArchiveName(parsed.archiveName)
      const mode: 'full' | 'inc' = parsed.mode === 'full' ? 'full' : 'inc'
      const warnings = Array.isArray(parsed.warnings)
        ? parsed.warnings.filter((value): value is string => typeof value === 'string').slice(0, 20)
        : []
      const skippedMissing = Array.isArray(parsed.skippedMissing)
        ? parsed.skippedMissing.filter((value): value is string => typeof value === 'string')
        : []
      const item = {
        ok: true as const,
        mode,
        archiveName,
        sizeBytes: Number(parsed.sizeBytes ?? 0),
        sha256: String(parsed.sha256 ?? ''),
        fileCount: Number(parsed.fileCount ?? 0),
        warnings,
        skippedMissing,
        encrypted: parsed.encrypted === true || isEncryptedArchiveName(archiveName),
        archiveFormat: isEncryptedArchiveName(archiveName) ? ('tar.gz.age' as const) : ('tar.gz' as const),
        metaName: typeof parsed.metaName === 'string' && parsed.metaName ? parsed.metaName : isEncryptedArchiveName(archiveName) ? `${archiveName}.meta.json` : null,
        plainSha256: typeof parsed.plainSha256 === 'string' ? parsed.plainSha256 : null,
        plainSize: Number.isSafeInteger(parsed.plainSize) ? Number(parsed.plainSize) : null,
      }
      audit(this.db, actor.username, 'backup_prepare', archiveName, {
        mode,
        sizeBytes: item.sizeBytes,
        fileCount: item.fileCount,
        skippedMissing: skippedMissing.length,
        encrypted: item.encrypted,
      }, actor.ip)
      return item
    } finally {
      this.prepareRunning = false
    }
  }

  // ---------- 导入 / 校验 ----------

  async importArchive(actor: BackupActor, input: { filename: string; stream: Readable }): Promise<ImportResult> {
    this.ensureLayout()
    const name = validArchiveName(input.filename)
    if (isEncryptedArchiveName(name)) throw encryptedArchiveError()
    if (this.rowByNameOrNull(name)) throw conflict('同名归档已存在', 'archive_exists')
    if (existsSync(join(this.importsDir, name))) throw conflict('同名归档文件已存在', 'archive_exists')
    const maxBytes = this.config.backupImportMaxBytes
    const tempPath = join(this.importsDir, `.part-${randomToken(12)}`)
    const hash = createHash('sha256')
    let bytes = 0
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        bytes += chunk.length
        if (bytes > maxBytes) {
          callback(new AppError(413, 'archive_too_large', `归档超过 ${formatLimit(maxBytes)} 上限`))
          return
        }
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    try {
      await pipeline(input.stream, meter, createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }))
    } catch (error) {
      rmSync(tempPath, { force: true })
      if (error instanceof AppError) throw error
      throw badRequest('归档上传中断', 'invalid_archive_upload')
    }
    if (bytes === 0) {
      rmSync(tempPath, { force: true })
      throw badRequest('归档内容为空', 'invalid_archive_upload')
    }
    // Fastify multipart 在超过全局 fileSize 时会截断流；截断的归档必须拒绝。
    if ((input.stream as { truncated?: boolean }).truncated === true) {
      rmSync(tempPath, { force: true })
      throw new AppError(413, 'archive_too_large', '归档超过上传大小上限')
    }
    try {
      linkSync(tempPath, join(this.importsDir, name))
    } catch {
      rmSync(tempPath, { force: true })
      throw conflict('同名归档文件已存在', 'archive_exists')
    }
    rmSync(tempPath, { force: true })
    const sha256 = hash.digest('hex')
    const size = bytes
    const created = this.clock()
    try {
      this.db
        .prepare(
          `INSERT INTO backup_archives (name, mode, created_at, sha256, size, file_count, pulled_at, acked_at, deleted_at, verified_at, origin, manifest_json, last_error)
           VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, 'import', NULL, NULL)`,
        )
        .run(name, modeFromName(name), created.toISOString(), sha256, size)
    } catch (error) {
      rmSync(join(this.importsDir, name), { force: true })
      throw error
    }
    audit(this.db, actor.username, 'backup_import', name, { sizeBytes: size, sha256 }, actor.ip)
    let verify: ImportResult['verify']
    try {
      await this.verify(actor, name, { auditAction: false })
      verify = { ok: true }
    } catch (error) {
      verify = { ok: false, error: sanitizeMessage(error instanceof Error ? error.message : '归档校验失败', this.config.dataDir) }
    }
    return { archive: this.toArchiveItem(this.rowByName(name)), verify }
  }

  private rowByNameOrNull(name: string): ArchiveRow | null {
    const row = this.db.prepare('SELECT * FROM backup_archives WHERE name = ?').get(name) as unknown as ArchiveRow | undefined
    return row ?? null
  }

  async verify(actor: BackupActor, name: string, options: { auditAction?: boolean } = {}): Promise<{ archive: BackupArchiveItem }> {
    const row = this.rowByName(name)
    // 加密归档在最前面拒绝：不尝试读取/解包/改写 last_error（Pi 无私钥，属预期状态）。
    if (isEncryptedArchiveName(row.name)) throw encryptedArchiveError()
    const path = this.storedPath(row)
    if (!existsSync(path)) {
      this.markArchiveError(row.name, '归档文件不存在')
      throw notFound('归档文件不存在', 'archive_missing')
    }
    try {
      const actual = await sha256OfFile(path)
      if (actual !== row.sha256) {
        throw new AppError(409, 'checksum_mismatch', '归档 SHA-256 与记录不一致')
      }
      const inspection = await inspectTarGz(path)
      if (!inspection.hasManifest || !inspection.manifestRaw) throw invalidArchive('归档缺少 manifest')
      if (!inspection.hasDatabase) throw invalidArchive('归档缺少数据库快照')
      let parsed: Record<string, unknown>
      try {
        parsed = asRecord(JSON.parse(inspection.manifestRaw))
      } catch {
        throw invalidArchive('manifest 不是合法 JSON')
      }
      const mode = parsed.mode === 'full' || parsed.mode === 'inc' ? parsed.mode : null
      if (!mode || mode !== row.mode) throw invalidArchive('manifest 模式与归档名不一致')
      if (typeof parsed.createdAt !== 'string' || Number.isNaN(Date.parse(parsed.createdAt))) {
        throw invalidArchive('manifest createdAt 不合法')
      }
      if (typeof parsed.database !== 'string' || !inspection.databasePaths.includes(parsed.database)) {
        throw invalidArchive('manifest 引用的数据库快照不在归档中')
      }
      const files = Array.isArray(parsed.files) ? parsed.files : null
      if (!files) throw invalidArchive('manifest files 字段不合法')
      if (files.length !== inspection.fileEntries) throw invalidArchive('manifest 文件数与归档内容不一致')
      const fileCount = Number(parsed.fileCount ?? files.length)
      const totalBytes = Number(parsed.totalBytes ?? 0)
      if (!Number.isInteger(fileCount) || fileCount < 0) throw invalidArchive('manifest fileCount 不合法')
      if (!Number.isInteger(totalBytes) || totalBytes < 0) throw invalidArchive('manifest totalBytes 不合法')
      if (fileCount !== files.length) throw invalidArchive('manifest fileCount 与文件列表不一致')
      const listedBytes = files.reduce((sum, entry) => {
        const size = asRecord(entry).size
        return sum + (typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : Number.NaN)
      }, 0)
      if (!Number.isFinite(listedBytes) || listedBytes !== totalBytes) {
        throw invalidArchive('manifest totalBytes 与文件列表不一致')
      }
      const manifest: BackupManifestSummary = {
        schema: Number(parsed.schema ?? 1),
        createdAt: parsed.createdAt,
        mode,
        since: typeof parsed.since === 'string' ? parsed.since : null,
        database: parsed.database,
        fileCount,
        totalBytes,
      }
      this.db
        .prepare('UPDATE backup_archives SET verified_at = ?, manifest_json = ?, file_count = ?, last_error = NULL WHERE name = ?')
        .run(this.clock().toISOString(), JSON.stringify(manifest), fileCount, row.name)
      if (options.auditAction !== false) {
        audit(this.db, actor.username, 'backup_verify', row.name, { fileCount, totalBytes, mode }, actor.ip)
      }
      return { archive: this.toArchiveItem(this.rowByName(row.name)) }
    } catch (error) {
      const message = sanitizeMessage(error instanceof Error ? error.message : '归档校验失败', this.config.dataDir)
      this.markArchiveError(row.name, message)
      // DATA-11：校验失败后清除旧的 verified_at/manifest_json，避免 UI 继续显示“已校验/可恢复”。
      this.clearArchiveVerification(row.name, message)
      throw error
    }
  }

  /** 校验失败时清除派生状态；归档行保留以便重新校验。 */
  private clearArchiveVerification(name: string, message: string): void {
    try {
      this.db
        .prepare('UPDATE backup_archives SET verified_at = NULL, manifest_json = NULL, last_error = ? WHERE name = ?')
        .run(message, name)
    } catch {
      // 记录失败不覆盖原始错误。
    }
  }

  private markArchiveError(name: string, message: string): void {
    try {
      this.db.prepare('UPDATE backup_archives SET last_error = ? WHERE name = ?').run(message, name)
    } catch {
      // 记录失败不覆盖原始错误。
    }
  }

  // ---------- 快照读取 ----------

  private async extractDatabase(archiveName: string, destDir: string): Promise<string> {
    mkdirSync(destDir, { recursive: true, mode: 0o700 })
    const target = join(destDir, 'snapshot.sqlite')
    let count = 0
    const row = this.rowByName(archiveName)
    await scanTarGz(this.storedPath(row), (header) => {
      if (header.type !== 'file') return { kind: 'skip' }
      if (DB_ENTRY_PATTERN.test(header.path)) {
        count += 1
        if (count > 1) throw unsafeArchive('归档包含多个数据库快照')
        if (header.size > MAX_SNAPSHOT_DB_BYTES) throw invalidArchive('归档内数据库快照过大')
        return { kind: 'extract', dest: target }
      }
      return { kind: 'skip' }
    }, {
      maxEntryBytes: MAX_RESTORE_ENTRY_BYTES,
      maxUnpackedBytes: MAX_RESTORE_UNPACKED_BYTES,
    })
    if (count === 0) throw invalidArchive('归档缺少数据库快照')
    return target
  }

  private async loadSnapshot(archiveName: string, staging: string): Promise<SnapshotIndex> {
    const dbPath = await this.extractDatabase(archiveName, join(staging, 'snapshot'))
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'files'").get() as
        | { name: string }
        | undefined
      if (!table) throw invalidArchive('数据库快照缺少 files 表')
      // 先计数再读行：恶意/异常快照可能在恢复前把内存打满。
      const total = (db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number }).c
      if (Number(total) > this.config.backupSnapshotMaxRows) {
        throw invalidArchive('数据库快照行数超出上限', {
          rows: Number(total),
          maxRows: this.config.backupSnapshotMaxRows,
        })
      }
      const columns = (db.prepare('PRAGMA table_info(files)').all() as unknown as { name: string }[]).map(
        (column) => column.name,
      )
      const originColumn = columns.includes('origin') ? 'origin' : 'NULL AS origin'
      const rows = db
        .prepare(`SELECT id, parent_id, name, kind, size, sha256, mime, ${originColumn} FROM files WHERE deleted_at IS NULL`)
        .all() as unknown as SnapshotRow[]
      return this.buildSnapshotIndex(rows)
    } finally {
      db.close()
    }
  }

  private buildSnapshotIndex(rows: SnapshotRow[]): SnapshotIndex {
    const byId = new Map<string, SnapshotRow>()
    const childrenOf = new Map<string | null, SnapshotRow[]>()
    // 普通文件树只包含 origin='user' 行：笔记附件/系统保留不随归档恢复进用户目录。
    const visibleRows = rows.filter((row) => (row.origin ?? 'user') === 'user')
    for (const row of visibleRows) {
      byId.set(row.id, row)
      const list = childrenOf.get(row.parent_id) ?? []
      list.push(row)
      childrenOf.set(row.parent_id, list)
    }
    const pathOf = new Map<string, string>()
    const walk = (parentId: string | null, base: string, depth: number): void => {
      // 与 files/service.ts 的目录层级上限一致；超出时明确报错而不是静默丢弃子树（DATA-08）。
      if (depth > MAX_TREE_DEPTH) {
        throw invalidArchive(`归档目录层级超过支持上限（${MAX_TREE_DEPTH} 层）`)
      }
      for (const row of childrenOf.get(parentId) ?? []) {
        const path = `${base}/${row.name}`
        pathOf.set(row.id, path)
        if (row.kind === 'dir') walk(row.id, path, depth + 1)
      }
    }
    walk(null, '', 0)
    return { rows: visibleRows.filter((row) => pathOf.has(row.id)), byId, pathOf, childrenOf }
  }

  private resolveSelection(index: SnapshotIndex, paths: string[]): { selected: Set<string>; files: SnapshotRow[]; totalBytes: number; notFound: string[] } {
    const selected = new Set<string>()
    const notFound: string[] = []
    const wantAll = paths.includes('/')
    if (wantAll) {
      for (const row of index.rows) selected.add(row.id)
    } else {
      for (const path of paths) {
        const exact = index.rows.filter((row) => index.pathOf.get(row.id) === path)
        if (exact.length === 0) {
          const descendants = index.rows.filter((row) => (index.pathOf.get(row.id) ?? '').startsWith(`${path}/`))
          if (descendants.length === 0) {
            notFound.push(path)
            continue
          }
          for (const row of descendants) selected.add(row.id)
          continue
        }
        for (const row of exact) {
          selected.add(row.id)
          if (row.kind === 'dir') {
            const prefix = `${index.pathOf.get(row.id) ?? path}/`
            for (const child of index.rows) {
              if ((index.pathOf.get(child.id) ?? '').startsWith(prefix)) selected.add(child.id)
            }
          }
        }
      }
    }
    // 选中文件时把祖先目录加入集合，恢复时保留原相对目录结构。
    for (const id of [...selected]) {
      let row = index.byId.get(id)
      while (row?.parent_id) {
        const parent = index.byId.get(row.parent_id)
        if (!parent || selected.has(parent.id)) break
        selected.add(parent.id)
        row = parent
      }
    }
    const files = index.rows.filter((row) => row.kind === 'file' && selected.has(row.id))
    const totalBytes = files.reduce((sum, row) => sum + Number(row.size), 0)
    return { selected, files, totalBytes, notFound }
  }

  // ---------- 恢复计划 ----------

  private assertRestoreEnabled(): void {
    if (!this.config.backupRestoreEnabled) {
      throw new AppError(403, 'restore_disabled', '恢复功能未启用')
    }
  }

  private async stagingScope<T>(fn: (dir: string) => Promise<T>, neededBytes = 0): Promise<T> {
    this.ensureLayout()
    // 解包前先做空间预检（总量上限 + 可用空间比例），不足返回 507。
    this.assertStagingCapacity(neededBytes)
    const dir = join(this.stagingRoot, randomToken(12))
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      return await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  private resolveChain(target: ArchiveRow): ArchiveRow[] {
    // 只在与目标同来源（Pi / Web 导入）的归档集内解析链：跨来源拼链会得到错误的父子关系。
    const targetOrigin = archiveOrigin(target)
    const rows = this.allRows().filter((row) => archiveOrigin(row) === targetOrigin)
    const sorted = rows.slice().sort((a, b) => {
      const left = this.effectiveCreatedAt(a)
      const right = this.effectiveCreatedAt(b)
      return left < right ? -1 : left > right ? 1 : 0
    })
    const targetIndex = sorted.findIndex((row) => row.name === target.name)
    if (targetIndex < 0) throw conflict('目标归档不在归档列表中', 'archive_chain_invalid')
    const chain: ArchiveRow[] = []
    for (let index = targetIndex; index >= 0; index -= 1) {
      const row = sorted[index]!
      chain.unshift(row)
      if (row.mode === 'full') {
        return chain
      }
    }
    throw conflict('找不到可用的 full 归档，无法恢复', 'archive_chain_invalid')
  }

  private assertChainUsable(chain: ArchiveRow[]): void {
    for (const row of chain) {
      // 加密链在 Web 侧一律拒绝（Pi 无私钥）；不能在只读/恢复路径尝试解密。
      if (isEncryptedArchiveName(row.name)) throw encryptedArchiveError()
      if (!row.verified_at) throw conflict(`归档 ${row.name} 尚未校验`, 'archive_not_verified')
      if (!existsSync(this.storedPath(row))) throw conflict(`归档 ${row.name} 文件不存在`, 'archive_missing')
      if (!this.parseStoredManifest(row.manifest_json)) throw conflict(`归档 ${row.name} 缺少 manifest 信息`, 'archive_invalid')
    }
    if (chain[0]?.mode !== 'full') throw conflict('恢复链缺少 full 归档', 'archive_chain_invalid')
  }

  private planRow(planId: string): PlanRow {
    const row = this.db.prepare('SELECT * FROM restore_plans WHERE id = ?').get(planId) as unknown as PlanRow | undefined
    if (!row) throw notFound('恢复计划不存在', 'plan_not_found')
    return row
  }

  private toPlanItem(row: PlanRow): RestorePlanItem {
    let archives: string[]
    try {
      archives = JSON.parse(row.archives_json) as string[]
    } catch {
      archives = []
    }
    let selection: SelectionJson
    try {
      selection = JSON.parse(row.selection_json) as SelectionJson
    } catch {
      selection = { paths: [], fileCount: 0, totalBytes: 0 }
    }
    return {
      id: row.id,
      status: row.status,
      targetName: row.target_name,
      archive: archives.at(-1) ?? '',
      archives,
      fileCount: Number(selection.fileCount ?? 0),
      totalBytes: Number(selection.totalBytes ?? 0),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      completedAt: row.completed_at,
      error: row.error,
      skippedMissing: Array.isArray(selection.skippedMissing) ? selection.skippedMissing : [],
    }
  }

  async createRestorePlan(
    actor: BackupActor,
    input: { archive?: unknown; paths?: unknown; targetName?: unknown },
  ): Promise<RestorePlanItem> {
    this.assertRestoreEnabled()
    const rows = this.allRows()
    const requested = input.archive === undefined || input.archive === null ? null : validArchiveName(input.archive)
    const target = requested
      ? this.rowByName(requested)
      : rows
          .filter(
            (row) =>
              row.mode &&
              this.parseStoredManifest(row.manifest_json) &&
              row.verified_at &&
              !isEncryptedArchiveName(row.name) &&
              existsSync(this.storedPath(row)),
          )
          .sort((a, b) => (this.effectiveCreatedAt(a) < this.effectiveCreatedAt(b) ? 1 : -1))[0]
    if (!target) throw conflict('没有可用于恢复的归档', 'archive_not_found')
    if (isEncryptedArchiveName(target.name)) throw encryptedArchiveError()
    const chain = this.resolveChain(target)
    this.assertChainUsable(chain)
    const paths = normalizeSelectionPaths(input.paths)
    const targetName = this.normalizeTargetName(input.targetName)
    const snapshot = await this.stagingScope((dir) => this.loadSnapshot(target.name, dir))
    const selection = this.resolveSelection(snapshot, paths)
    if (selection.notFound.length > 0) {
      throw badRequest('部分路径在归档中不存在', 'invalid_selection')
    }
    // 归档 manifest 标记为缺失的文件内容不可用：从选择中剔除并明确报告，而不是整体失败。
    const missingContent = new Set(chain.flatMap((row) => manifestSkippedMissing(row.manifest_json)))
    const skippedMissing = selection.files.filter((file) => missingContent.has(file.id)).map((file) => file.id)
    if (skippedMissing.length > 0) {
      const skippedSet = new Set(skippedMissing)
      selection.files = selection.files.filter((file) => !skippedSet.has(file.id))
      for (const id of skippedMissing) selection.selected.delete(id)
      selection.totalBytes = selection.files.reduce((sum, row) => sum + Number(row.size), 0)
    }
    if (selection.files.length === 0) {
      throw new AppError(400, 'invalid_selection', '所选文件在归档中缺失，无法恢复', {
        skippedMissing: skippedMissing.slice(0, 200),
      })
    }
    if (selection.files.length > this.config.backupRestoreMaxEntries) {
      throw badRequest(`单次最多恢复 ${this.config.backupRestoreMaxEntries} 个文件`, 'restore_too_many_files')
    }
    const usage = this.files.usage()
    if (usage.usedBytes + selection.totalBytes > this.config.quotaBytes) {
      throw conflict('剩余配额不足以恢复所选文件', 'quota_exceeded')
    }
    // 解包与落盘都会额外占用空间（contentDir + 最终文件），按选择字节 ×2 预检。
    const requiredBytes = selection.totalBytes * 2 + RESERVED_FREE_BYTES
    if (this.freeBytes() < requiredBytes) {
      throw new AppError(507, 'insufficient_storage', '磁盘剩余空间不足，无法完成恢复')
    }
    const now = this.clock()
    const plan: PlanRow = {
      id: newId(),
      archives_json: JSON.stringify(chain.map((row) => row.name)),
      selection_json: JSON.stringify({
        paths,
        fileCount: selection.files.length,
        totalBytes: selection.totalBytes,
        skippedMissing,
      } satisfies SelectionJson),
      target_name: targetName,
      status: 'planned',
      created_by: actor.username,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.config.backupRestorePlanTtlMinutes * 60_000).toISOString(),
      completed_at: null,
      error: null,
    }
    this.db
      .prepare(
        `INSERT INTO restore_plans (id, archives_json, selection_json, target_name, status, created_by, created_at, expires_at, completed_at, error)
         VALUES (?, ?, ?, ?, 'planned', ?, ?, ?, NULL, NULL)`,
      )
      .run(plan.id, plan.archives_json, plan.selection_json, plan.target_name, plan.created_by, plan.created_at, plan.expires_at)
    audit(this.db, actor.username, 'backup_restore_plan', target.name, {
      planId: plan.id,
      archives: chain.map((row) => row.name),
      paths,
      fileCount: selection.files.length,
      totalBytes: selection.totalBytes,
      skippedMissing: skippedMissing.length,
      targetName,
    }, actor.ip)
    return this.toPlanItem(plan)
  }

  private normalizeTargetName(input: unknown): string {
    if (input === undefined || input === null || input === '') return `恢复-${compactStamp(this.clock())}`
    if (typeof input !== 'string') throw badRequest('targetName 必须是字符串', 'invalid_request')
    const text = input
      .normalize('NFC')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
    if (!text || text.length > 100) throw badRequest('targetName 不合法', 'invalid_request')
    return text
  }

  // ---------- 恢复执行 ----------

  private async withRestoreLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.restoreRunning) throw conflict('已有恢复任务在执行', 'restore_busy')
    this.restoreRunning = true
    const lockPath = join(this.config.dataDir, 'tmp', 'restore.lock')
    mkdirSync(join(this.config.dataDir, 'tmp'), { recursive: true })
    let locked = false
    try {
      try {
        const fd = openSync(lockPath, 'wx')
        writeFileSync(fd, String(process.pid))
        closeSync(fd)
        locked = true
      } catch {
        try {
          const stale = Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS
          if (stale) {
            unlinkSync(lockPath)
            const fd = openSync(lockPath, 'wx')
            writeFileSync(fd, String(process.pid))
            closeSync(fd)
            locked = true
          }
        } catch {
          locked = false
        }
        if (!locked) throw conflict('已有恢复任务在执行', 'restore_busy')
      }
      return await fn()
    } finally {
      if (locked) {
        try {
          unlinkSync(lockPath)
        } catch {
          // 锁文件清理失败不影响结果。
        }
      }
      this.restoreRunning = false
    }
  }

  async executeRestore(actor: BackupActor, planId: string): Promise<{ plan: RestorePlanItem; result: RestoreResult }> {
    this.assertRestoreEnabled()
    const initial = this.planRow(planId)
    if (initial.status === 'completed') throw conflict('恢复计划已完成', 'plan_completed')
    if (initial.status === 'expired') throw new AppError(410, 'plan_expired', '恢复计划已过期')
    if (initial.status !== 'planned') throw conflict('恢复计划当前不可执行', 'plan_not_pending')
    const now = this.clock()
    if (Date.parse(initial.expires_at) <= now.getTime()) {
      this.db.prepare("UPDATE restore_plans SET status = 'expired' WHERE id = ? AND status = 'planned'").run(planId)
      throw new AppError(410, 'plan_expired', '恢复计划已过期')
    }
    return this.withRestoreLock(async () => {
      const updated = this.db
        .prepare("UPDATE restore_plans SET status = 'executing' WHERE id = ? AND status = 'planned'")
        .run(planId)
      if (Number(updated.changes) !== 1) throw conflict('恢复计划当前不可执行', 'plan_not_pending')
      const started = Date.now()
      const plan = this.planRow(planId)
      const selection = JSON.parse(plan.selection_json) as SelectionJson
      try {
        const result = await this.stagingScope(async (staging) => {
          const archives = JSON.parse(plan.archives_json) as string[]
          if (!Array.isArray(archives) || archives.length === 0) throw invalidArchive('恢复计划缺少归档链')
          const chain = archives.map((name) => this.rowByName(name))
          this.assertChainUsable(chain)
          for (const row of chain) {
            const actual = await sha256OfFile(this.storedPath(row))
            if (actual !== row.sha256) throw new AppError(409, 'checksum_mismatch', `归档 ${row.name} 校验失败`)
          }
          const targetArchive = chain.at(-1)!
          const snapshot = await this.loadSnapshot(targetArchive.name, join(staging, 'target'))
          const resolved = this.resolveSelection(snapshot, selection.paths ?? [])
          if (resolved.files.length === 0) throw badRequest('选择内容为空', 'invalid_selection')
          // 快照中的 files.size 来自不可信归档，不能作为磁盘/配额预算；解包前按 tar 条目实际字节测量。
          const measured = await this.measureContents(chain, resolved.files.map((row) => row.id))
          // 解包前按“真实内容字节 + 当前 staging 占用”做契约上限/可用空间预检，超限直接失败，不写内容文件。
          this.assertStagingCapacity(measured.bytes)
          const usage = this.files.usage()
          if (usage.usedBytes + measured.bytes > this.config.quotaBytes) {
            throw conflict('剩余配额不足以恢复所选文件', 'quota_exceeded')
          }
          // 解包内容与最终落盘文件会同时存在，按实测字节 ×2 + 保留空间预检。
          if (this.freeBytes() < measured.bytes * 2 + RESERVED_FREE_BYTES) {
            throw new AppError(507, 'insufficient_storage', '磁盘剩余空间不足，无法完成恢复')
          }
          const contentDir = join(staging, 'content')
          mkdirSync(contentDir, { recursive: true, mode: 0o700 })
          const { extracted, missing } = await this.extractContents(
            chain,
            resolved.files.map((row) => row.id),
            contentDir,
          )
          // 归档 manifest 记录/实际内容缺失的文件：跳过并从选择中剔除，其余内容继续恢复。
          const missingContent = new Set([
            ...missing,
            ...measured.missing,
            ...chain.flatMap((row) => manifestSkippedMissing(row.manifest_json)),
          ])
          const availableFiles = resolved.files.filter((file) => !missingContent.has(file.id) && extracted.has(file.id))
          if (availableFiles.length === 0) {
            throw new AppError(422, 'invalid_archive', '归档缺少所选文件的全部内容', {
              skippedMissing: resolved.files.map((file) => file.id).slice(0, 200),
            })
          }
          const availableIds = new Set(availableFiles.map((file) => file.id))
          const selectedAvailable = new Set([...resolved.selected].filter((id) => {
            const row = snapshot.byId.get(id)
            return !row || row.kind === 'dir' || availableIds.has(id)
          }))
          const skippedMissing = resolved.files.filter((file) => !availableFiles.includes(file)).map((file) => file.id)
          const createdFiles: string[] = []
          const createdFolders: string[] = []
          const target = this.files.createFolder(
            { username: actor.username, ip: actor.ip },
            null,
            this.nextTargetName(plan.target_name),
          )
          createdFolders.push(target.id)
          try {
            await this.restoreTree(
              snapshot,
              selectedAvailable,
              new Map([...extracted].filter(([id]) => availableIds.has(id))),
              target,
              createdFiles,
              createdFolders,
              actor,
            )
          } catch (error) {
            this.cleanupCreated(createdFiles, createdFolders)
            throw error
          }
          const bytesRestored = availableFiles.reduce((sum, row) => sum + Number(row.size), 0)
          return {
            targetFolderId: target.id,
            targetName: target.name,
            filesRestored: availableFiles.length,
            bytesRestored,
            durationMs: Date.now() - started,
            skippedMissing,
          } satisfies RestoreResult
        })
        const completedAt = this.clock().toISOString()
        this.db
          .prepare("UPDATE restore_plans SET status = 'completed', completed_at = ?, error = NULL WHERE id = ?")
          .run(completedAt, planId)
        audit(this.db, actor.username, 'backup_restore_execute', plan.target_name, {
          planId,
          archives: JSON.parse(plan.archives_json) as string[],
          files: result.filesRestored,
          bytes: result.bytesRestored,
          skippedMissing: result.skippedMissing.length,
          targetFolderId: result.targetFolderId,
          durationMs: result.durationMs,
        }, actor.ip)
        return { plan: this.toPlanItem(this.planRow(planId)), result }
      } catch (error) {
        const message = sanitizeMessage(error instanceof Error ? error.message : '恢复失败', this.config.dataDir)
        this.db.prepare("UPDATE restore_plans SET status = 'failed', error = ? WHERE id = ?").run(message, planId)
        audit(this.db, actor.username, 'backup_restore_failed', plan.target_name, { planId, error: message }, actor.ip)
        throw error instanceof AppError ? error : new AppError(500, 'restore_failed', '恢复失败，已清理未完成内容')
      }
    })
  }

  private nextTargetName(desired: string): string {
    const existing = new Set(
      (this.db.prepare("SELECT name FROM files WHERE parent_id IS NULL AND deleted_at IS NULL").all() as unknown as { name: string }[]).map(
        (row) => row.name.toLowerCase(),
      ),
    )
    if (!existing.has(desired.toLowerCase())) return desired
    for (let index = 2; index < 10_000; index += 1) {
      const candidate = `${desired} (${index})`
      if (!existing.has(candidate.toLowerCase())) return candidate
    }
    return `${desired} ${randomToken(2)}`
  }

  /**
   * 不落盘测量本次恢复真正会解出的内容字节（按 tar 条目实际 size，而非归档内 DB 快照声明值）。
   * 与 extractContents 使用同一“从新到旧、每个 id 只取一次”的优先级，结果即解包字节的上界；
   * 仅读取 tar 头并跳过内容，不写 staging，供解包前的磁盘/配额预算使用（A5-DATA-03）。
   */
  private async measureContents(chain: ArchiveRow[], neededIds: string[]): Promise<{ bytes: number; missing: string[] }> {
    const needed = new Set(neededIds)
    const measured = new Map<string, number>()
    for (const row of chain.slice().reverse()) {
      if (measured.size === needed.size) break
      await scanTarGz(this.storedPath(row), (header) => {
        if (header.type !== 'file') return { kind: 'skip' }
        const match = FILE_ENTRY_PATTERN.exec(header.path)
        if (!match) return { kind: 'skip' }
        const id = match[1]!
        if (!needed.has(id) || measured.has(id)) return { kind: 'skip' }
        measured.set(id, header.size)
        return { kind: 'skip' }
      }, {
        maxEntryBytes: MAX_RESTORE_ENTRY_BYTES,
        maxUnpackedBytes: MAX_RESTORE_UNPACKED_BYTES,
      })
    }
    let bytes = 0
    for (const size of measured.values()) bytes += size
    return { bytes, missing: neededIds.filter((id) => !measured.has(id)) }
  }

  private async extractContents(chain: ArchiveRow[], neededIds: string[], contentDir: string): Promise<{ extracted: Map<string, string>; missing: string[] }> {
    const needed = new Set(neededIds)
    const extracted = new Map<string, string>()
    for (const row of chain.slice().reverse()) {
      if (extracted.size === needed.size) break
      await scanTarGz(this.storedPath(row), (header) => {
        if (header.type !== 'file') return { kind: 'skip' }
        const match = FILE_ENTRY_PATTERN.exec(header.path)
        if (!match) return { kind: 'skip' }
        const id = match[1]!
        if (!needed.has(id) || extracted.has(id)) return { kind: 'skip' }
        const dest = join(contentDir, id)
        extracted.set(id, dest)
        return { kind: 'extract', dest }
      }, {
        maxEntryBytes: MAX_RESTORE_ENTRY_BYTES,
        maxUnpackedBytes: MAX_RESTORE_UNPACKED_BYTES,
      })
    }
    const missing = neededIds.filter((id) => !extracted.has(id))
    return { extracted, missing }
  }

  /**
   * 按快照树把选中内容恢复到新文件夹：目录用 FileService.createFolder，文件用 registerUpload
   * （复用唯一命名/配额/原子落盘与审计）。任何失败由调用方清理已创建的行与物理文件。
   */
  private async restoreTree(
    snapshot: SnapshotIndex,
    selected: Set<string>,
    extracted: Map<string, string>,
    target: { id: string },
    createdFiles: string[],
    createdFolders: string[],
    actor: BackupActor,
  ): Promise<void> {
    const filesActor = { username: actor.username, ip: actor.ip }
    const roots = snapshot.rows
      .filter((row) => selected.has(row.id) && (row.parent_id === null || !selected.has(row.parent_id)))
      .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'dir' ? -1 : 1))
    const queue: { row: SnapshotRow; parentId: string }[] = roots.map((row) => ({ row, parentId: target.id }))
    const seen = new Set<string>()
    while (queue.length > 0) {
      const current = queue.shift()!
      if (seen.has(current.row.id)) continue
      seen.add(current.row.id)
      if (current.row.kind === 'dir') {
        const folder = this.files.createFolder(filesActor, current.parentId, current.row.name)
        createdFolders.push(folder.id)
        for (const child of snapshot.childrenOf.get(current.row.id) ?? []) {
          if (selected.has(child.id)) queue.push({ row: child, parentId: folder.id })
        }
        continue
      }
      const contentPath = extracted.get(current.row.id)
      if (!contentPath) throw invalidArchive('缺少文件内容')
      const size = statSync(contentPath).size
      if (size !== Number(current.row.size)) throw invalidArchive('归档内容大小与快照不一致')
      let sha256 = current.row.sha256
      if (sha256) {
        const actual = await sha256OfFile(contentPath)
        if (actual !== sha256) throw invalidArchive('归档内容哈希与快照不一致')
      } else {
        sha256 = await sha256OfFile(contentPath)
      }
      // registerUpload 会做配额校验、唯一命名与原子 move；失败时会自行清理 DB 行。
      const tempPath = this.files.storage.tempPath()
      copyFileSync(contentPath, tempPath)
      try {
        const item = await this.files.registerUpload(filesActor, {
          parentId: current.parentId,
          rawName: current.row.name,
          tempPath,
          size,
          sha256,
        })
        createdFiles.push(item.id)
      } catch (error) {
        this.files.storage.removeTemp(tempPath)
        throw error
      }
    }
  }

  private cleanupCreated(fileIds: string[], folderIds: string[]): void {
    for (const id of fileIds.slice().reverse()) {
      try {
        this.db.prepare('DELETE FROM files WHERE id = ?').run(id)
      } catch {
        // 清理失败由调用方日志记录。
      }
      this.files.storage.remove(id)
    }
    for (const id of folderIds.slice().reverse()) {
      try {
        this.db.prepare('DELETE FROM files WHERE id = ?').run(id)
      } catch {
        // 同上。
      }
    }
  }

  // ---------- 归档内容浏览 ----------

  async listArchiveEntries(name: string, path: unknown): Promise<{ path: string; items: ArchiveEntryItem[]; truncated: boolean }> {
    this.assertRestoreEnabled()
    const row = this.rowByName(name)
    if (isEncryptedArchiveName(row.name)) throw encryptedArchiveError()
    if (!row.verified_at) throw conflict('归档尚未校验，无法浏览', 'archive_not_verified')
    const archivePath = this.storedPath(row)
    if (!existsSync(archivePath)) throw notFound('归档文件不存在', 'archive_missing')
    // 基于归档实际文件大小做磁盘预检（不信任归档内 manifest 的元数据）。
    let archiveBytes: number
    try {
      archiveBytes = statSync(archivePath).size
    } catch {
      throw notFound('归档文件不存在', 'archive_missing')
    }
    if (archiveBytes > 0 && this.freeBytes() > 0 && this.freeBytes() < archiveBytes + RESERVED_FREE_BYTES) {
      throw new AppError(507, 'insufficient_storage', '磁盘空间不足，无法解包归档')
    }
    const rawPath = typeof path === 'string' && path.trim() ? path.trim() : '/'
    const normalized = normalizeSelectionPaths([rawPath])[0]!
    return this.stagingScope(async (dir) => {
      const snapshot = await this.loadSnapshot(row.name, dir)
      const root = normalized === '/' ? null : snapshot.rows.find((entry) => snapshot.pathOf.get(entry.id) === normalized) ?? null
      if (normalized !== '/' && !root) throw notFound('路径不存在', 'path_not_found')
      if (root && root.kind !== 'dir') throw badRequest('该路径不是目录', 'not_a_directory')
      const children = (snapshot.childrenOf.get(root ? root.id : null) ?? []).slice().sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
      )
      const truncated = children.length > MAX_ENTRY_LIST
      const items = children.slice(0, MAX_ENTRY_LIST).map((child) => ({
        path: snapshot.pathOf.get(child.id) ?? normalized,
        name: child.name,
        kind: child.kind,
        size: Number(child.size),
      }))
      return { path: normalized, items, truncated }
    }, archiveBytes)
  }

  getRestorePlan(planId: string): RestorePlanItem {
    return this.toPlanItem(this.planRow(planId))
  }

  // ---------- TOTP 再认证 ----------

  /** 危险操作再认证：允许当前时间步（与账号再认证一致），仅命中更大 step 时推进 last_step。 */
  verifyReauth(userId: string, code: unknown): void {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code.replace(/\s+/g, ''))) {
      throw new AppError(401, 'invalid_totp', '动态验证码无效')
    }
    const row = this.db.prepare('SELECT totp_secret, totp_last_step FROM users WHERE id = ?').get(userId) as
      | { totp_secret: string; totp_last_step: number }
      | undefined
    if (!row) throw new AppError(401, 'invalid_totp', '动态验证码无效')
    const step = verifyTotpForReauth(row.totp_secret, code, Number(row.totp_last_step ?? 0))
    if (step === null) throw new AppError(401, 'invalid_totp', '动态验证码无效')
    if (step > Number(row.totp_last_step ?? 0)) {
      this.db.prepare('UPDATE users SET totp_last_step = ?, updated_at = ? WHERE id = ?').run(step, nowIso(), userId)
    }
  }

  // ---------- 清理 ----------

  cleanup(): {
    expiredPlans: number
    interruptedPlans: number
    stagingDirs: number
    partialImports: number
    importedArchives: number
    orphanImportFiles: number
  } {
    const now = this.clock()
    // 恢复锁崩溃残留：每次维护任务也尝试清理（启动时已清一次）。
    this.cleanupStaleRestoreLock()
    const expiredPlans = this.db
      .prepare("UPDATE restore_plans SET status = 'expired' WHERE status = 'planned' AND expires_at <= ?")
      .run(now.toISOString())
    // 进程在中途崩溃时计划会停留在 executing；本进程没有恢复在跑时才标记失败。
    // 不能用 created_at 判断：计划创建后可能在 TTL 内才执行，且大恢复可能超过 2 小时。
    const interruptedPlans = this.restoreRunning
      ? { changes: 0 }
      : this.db
          .prepare("UPDATE restore_plans SET status = 'failed', error = '恢复中断（进程退出）' WHERE status = 'executing'")
          .run()
    let stagingDirs = 0
    try {
      for (const entry of readdirSync(this.stagingRoot, { withFileTypes: true })) {
        const full = join(this.stagingRoot, entry.name)
        if (entry.isDirectory() && now.getTime() - statSync(full).mtimeMs > STAGING_TTL_MS) {
          rmSync(full, { recursive: true, force: true })
          stagingDirs += 1
        }
      }
    } catch {
      // staging 目录不存在时忽略。
    }
    let partialImports = 0
    try {
      for (const entry of readdirSync(this.importsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith('.part-')) continue
        const full = join(this.importsDir, entry.name)
        if (now.getTime() - statSync(full).mtimeMs > STAGING_TTL_MS) {
          rmSync(full, { force: true })
          partialImports += 1
        }
      }
    } catch {
      // imports 目录不存在时忽略。
    }
    // DR-7：导入归档按保留期清理；活动恢复计划引用的归档不删。
    let importedArchives = 0
    if (this.config.backupImportRetentionDays > 0) {
      const cutoff = new Date(now.getTime() - this.config.backupImportRetentionDays * 86_400_000).toISOString()
      const active = new Set<string>()
      try {
        const plans = this.db
          .prepare("SELECT archives_json FROM restore_plans WHERE status IN ('planned', 'executing')")
          .all() as unknown as { archives_json: string }[]
        for (const plan of plans) {
          try {
            const names = JSON.parse(plan.archives_json) as unknown
            if (Array.isArray(names)) {
              for (const name of names) if (typeof name === 'string') active.add(name)
            }
          } catch {
            // 损坏的计划 JSON 不应导致清理失败；保守跳过该计划。
          }
        }
      } catch {
        // DB 不可用时不做破坏性清理。
      }
      try {
        const rows = this.db
          .prepare("SELECT name FROM backup_archives WHERE origin = 'import' AND created_at < ?")
          .all(cutoff) as unknown as { name: string }[]
        for (const row of rows) {
          if (active.has(row.name) || !ARCHIVE_NAME_PATTERN.test(row.name)) continue
          const full = join(this.importsDir, row.name)
          try {
            rmSync(full, { force: true })
            this.db.prepare("DELETE FROM backup_archives WHERE name = ? AND origin = 'import'").run(row.name)
            importedArchives += 1
          } catch {
            // 单个导入归档失败不阻断其余清理。
          }
        }
      } catch {
        // DB 不可用时忽略。
      }
    }
    // 加密 prepare 崩溃遗留的明文临时归档：超过 TTL 统一删除，避免“失败关闭”之外长期驻留明文。
    let abandonedPlainTemps = 0
    try {
      for (const entry of readdirSync(this.backupsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.plain.tmp')) continue
        const full = join(this.backupsDir, entry.name)
        if (now.getTime() - statSync(full).mtimeMs > STAGING_TTL_MS) {
          rmSync(full, { force: true })
          abandonedPlainTemps += 1
        }
      }
    } catch {
      // backups 目录不存在时忽略。
    }
    // 导入目录中没有 DB 记录的归档文件：只清理超过 24h 的残留，避免误删正在导入的文件。
    let orphanImportFiles = 0
    try {
      const known = new Set(
        (
          this.db.prepare("SELECT name FROM backup_archives WHERE origin = 'import'").all() as unknown as {
            name: string
          }[]
        ).map((row) => row.name),
      )
      for (const entry of readdirSync(this.importsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !ARCHIVE_NAME_PATTERN.test(entry.name) || known.has(entry.name)) continue
        const full = join(this.importsDir, entry.name)
        if (now.getTime() - statSync(full).mtimeMs > STAGING_TTL_MS) {
          rmSync(full, { force: true })
          orphanImportFiles += 1
        }
      }
    } catch {
      // imports 目录不存在时忽略。
    }
    if (
      Number(expiredPlans.changes) > 0 ||
      Number(interruptedPlans.changes) > 0 ||
      stagingDirs > 0 ||
      partialImports > 0 ||
      importedArchives > 0 ||
      orphanImportFiles > 0 ||
      abandonedPlainTemps > 0
    ) {
      this.log('info', '备份维护清理完成', {
        expiredPlans: Number(expiredPlans.changes),
        interruptedPlans: Number(interruptedPlans.changes),
        stagingDirs,
        partialImports,
        importedArchives,
        orphanImportFiles,
        abandonedPlainTemps,
      })
    }
    return {
      expiredPlans: Number(expiredPlans.changes),
      interruptedPlans: Number(interruptedPlans.changes),
      stagingDirs,
      partialImports,
      importedArchives,
      orphanImportFiles,
    }
  }
}
