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
import { AppError, badRequest, conflict, notFound } from '../util/errors.ts'
import { newId, randomToken } from '../util/ids.ts'
import { nowIso } from '../util/time.ts'
import { inspectTarGz, invalidArchive, scanTarGz, unsafeArchive } from './tar.ts'

const ARCHIVE_NAME_PATTERN = /^snapshot-[0-9TZ]+(?:-[0-9]+)?-(full|inc)\.tar\.gz$/
const FILE_ENTRY_PATTERN = /^files\/[A-Za-z0-9_-]+\/([A-Za-z0-9_-]{8,64})$/
const DB_ENTRY_PATTERN = /^backups\/db-.*\.sqlite$/

const MAX_RESTORE_FILES = 2000
const MAX_RESTORE_PATHS = 100
const MAX_ENTRY_LIST = 500
const MAX_IMPORT_BYTES = 100 * 1024 * 1024
const PREPARE_TIMEOUT_MS = 10 * 60_000
const STAGING_TTL_MS = 24 * 60 * 60_000
const LOCK_STALE_MS = 2 * 60 * 60_000
const RESERVED_FREE_BYTES = 256 * 1024 * 1024

export interface BackupServiceConfig {
  dataDir: string
  quotaBytes: number
  maxUploadBytes: number
  backupPullFile: string
  /** Web 导入归档大小上限，默认 100 MiB（与任务约定一致）。 */
  backupImportMaxBytes?: number
  /** 恢复计划有效期（分钟），默认 30。 */
  backupRestorePlanTtlMinutes?: number
  /** 单次恢复的文件数上限，默认 2000。 */
  backupRestoreMaxEntries?: number
  /** 恢复功能总开关；false 时计划/执行/浏览接口返回 403。 */
  backupRestoreEnabled?: boolean
  /** 生成归档超时（毫秒），默认 10 分钟。 */
  backupPrepareTimeoutMs?: number
}

export type BackupRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

export interface BackupServiceOptions {
  files: FileService
  now?: () => Date
  runner?: BackupRunner
  logger?: (level: 'info' | 'warn' | 'error', message: string, detail?: Record<string, unknown>) => void
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
  verifiedAt: string | null
  pulledAt: string | null
  ackedAt: string | null
  lastError: string | null
  manifest: BackupManifestSummary | null
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
  }
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
}

export interface RestoreResult {
  targetFolderId: string
  targetName: string
  filesRestored: number
  bytesRestored: number
  durationMs: number
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
}

interface SnapshotRow {
  id: string
  parent_id: string | null
  name: string
  kind: 'file' | 'dir'
  size: number
  sha256: string | null
  mime: string | null
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

export class BackupService {
  private readonly db: DatabaseSync
  private readonly config: Required<BackupServiceConfig>
  private readonly files: FileService
  private readonly clock: () => Date
  private readonly runner: BackupRunner
  private readonly log: (level: 'info' | 'warn' | 'error', message: string, detail?: Record<string, unknown>) => void
  private prepareRunning = false
  private restoreRunning = false

  constructor(db: DatabaseSync, config: BackupServiceConfig, options: BackupServiceOptions) {
    this.db = db
    this.files = options.files
    this.clock = options.now ?? (() => new Date())
    this.log = options.logger ?? (() => {})
    this.config = {
      dataDir: config.dataDir,
      quotaBytes: config.quotaBytes,
      maxUploadBytes: config.maxUploadBytes,
      backupPullFile: config.backupPullFile,
      backupImportMaxBytes: Math.min(config.backupImportMaxBytes ?? MAX_IMPORT_BYTES, MAX_IMPORT_BYTES),
      backupRestorePlanTtlMinutes: config.backupRestorePlanTtlMinutes ?? 30,
      backupRestoreMaxEntries: config.backupRestoreMaxEntries ?? MAX_RESTORE_FILES,
      backupRestoreEnabled: config.backupRestoreEnabled ?? true,
      backupPrepareTimeoutMs: config.backupPrepareTimeoutMs ?? PREPARE_TIMEOUT_MS,
    }
    this.runner = options.runner ?? this.defaultRunner()
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
    let status: BackupArchiveItem['status']
    if (!exists) status = 'missing'
    else if (origin === 'import') status = 'imported'
    else if (row.acked_at) status = 'acked'
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
      verifiedAt: row.verified_at,
      pulledAt: row.pulled_at,
      ackedAt: row.acked_at,
      lastError: row.last_error,
      manifest: this.parseStoredManifest(row.manifest_json),
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
    try {
      const stats = statfsSync(this.config.dataDir)
      return Number(stats.bavail) * Number(stats.bsize)
    } catch {
      return 0
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
      },
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
        const record = error as { code?: number; stdout?: string; stderr?: string; message?: string }
        return {
          code: typeof record.code === 'number' ? record.code : 1,
          stdout: record.stdout ?? '',
          stderr: record.stderr ?? record.message ?? '备份脚本执行失败',
        }
      }
    }
  }

  async prepare(actor: BackupActor, options: { full?: boolean } = {}): Promise<{ ok: true; mode: 'full' | 'inc'; archiveName: string; sizeBytes: number; sha256: string; fileCount: number }> {
    if (this.prepareRunning) throw conflict('已有备份生成任务在执行', 'backup_busy')
    if (existsSync(join(this.backupsDir, '.backup.lock'))) {
      throw conflict('备份 CLI 正在运行（锁文件存在）', 'backup_busy')
    }
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
      if (result.code !== 0 || !parsed || parsed.ok !== true) {
        const message = sanitizeMessage(String(parsed?.error ?? result.stderr ?? '备份脚本执行失败'), this.config.dataDir)
        throw new AppError(502, 'backup_prepare_failed', `生成备份失败：${message}`)
      }
      const archiveName = validArchiveName(parsed.archiveName)
      const mode: 'full' | 'inc' = parsed.mode === 'full' ? 'full' : 'inc'
      const item = { ok: true as const, mode, archiveName, sizeBytes: Number(parsed.sizeBytes ?? 0), sha256: String(parsed.sha256 ?? ''), fileCount: Number(parsed.fileCount ?? 0) }
      audit(this.db, actor.username, 'backup_prepare', archiveName, { mode, sizeBytes: item.sizeBytes, fileCount: item.fileCount }, actor.ip)
      return item
    } finally {
      this.prepareRunning = false
    }
  }

  // ---------- 导入 / 校验 ----------

  async importArchive(actor: BackupActor, input: { filename: string; stream: Readable }): Promise<ImportResult> {
    this.ensureLayout()
    const name = validArchiveName(input.filename)
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
      throw error
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
        return { kind: 'extract', dest: target }
      }
      return { kind: 'skip' }
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
      const rows = db
        .prepare("SELECT id, parent_id, name, kind, size, sha256, mime FROM files WHERE deleted_at IS NULL")
        .all() as unknown as SnapshotRow[]
      return this.buildSnapshotIndex(rows)
    } finally {
      db.close()
    }
  }

  private buildSnapshotIndex(rows: SnapshotRow[]): SnapshotIndex {
    const byId = new Map<string, SnapshotRow>()
    const childrenOf = new Map<string | null, SnapshotRow[]>()
    for (const row of rows) {
      byId.set(row.id, row)
      const list = childrenOf.get(row.parent_id) ?? []
      list.push(row)
      childrenOf.set(row.parent_id, list)
    }
    const pathOf = new Map<string, string>()
    const walk = (parentId: string | null, base: string, depth: number): void => {
      if (depth > 128) return
      for (const row of childrenOf.get(parentId) ?? []) {
        const path = `${base}/${row.name}`
        pathOf.set(row.id, path)
        if (row.kind === 'dir') walk(row.id, path, depth + 1)
      }
    }
    walk(null, '', 0)
    return { rows: rows.filter((row) => pathOf.has(row.id)), byId, pathOf, childrenOf }
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

  private async stagingScope<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    this.ensureLayout()
    const dir = join(this.stagingRoot, randomToken(12))
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      return await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  private resolveChain(target: ArchiveRow): ArchiveRow[] {
    const rows = this.allRows()
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
          .filter((row) => row.mode && this.parseStoredManifest(row.manifest_json) && row.verified_at && existsSync(this.storedPath(row)))
          .sort((a, b) => (this.effectiveCreatedAt(a) < this.effectiveCreatedAt(b) ? 1 : -1))[0]
    if (!target) throw conflict('没有可用于恢复的归档', 'archive_not_found')
    const chain = this.resolveChain(target)
    this.assertChainUsable(chain)
    const paths = normalizeSelectionPaths(input.paths)
    const targetName = this.normalizeTargetName(input.targetName)
    const snapshot = await this.stagingScope((dir) => this.loadSnapshot(target.name, dir))
    const selection = this.resolveSelection(snapshot, paths)
    if (selection.notFound.length > 0) {
      throw badRequest('部分路径在归档中不存在', 'invalid_selection')
    }
    if (selection.files.length === 0) throw badRequest('选择内容为空', 'invalid_selection')
    if (selection.files.length > this.config.backupRestoreMaxEntries) {
      throw badRequest(`单次最多恢复 ${this.config.backupRestoreMaxEntries} 个文件`, 'restore_too_many_files')
    }
    const usage = this.files.usage()
    if (usage.usedBytes + selection.totalBytes > this.config.quotaBytes) {
      throw conflict('剩余配额不足以恢复所选文件', 'quota_exceeded')
    }
    if (this.freeBytes() < selection.totalBytes + RESERVED_FREE_BYTES) {
      throw conflict('磁盘剩余空间不足', 'insufficient_storage')
    }
    const now = this.clock()
    const plan: PlanRow = {
      id: newId(),
      archives_json: JSON.stringify(chain.map((row) => row.name)),
      selection_json: JSON.stringify({
        paths,
        fileCount: selection.files.length,
        totalBytes: selection.totalBytes,
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
          const usage = this.files.usage()
          if (usage.usedBytes + resolved.totalBytes > this.config.quotaBytes) {
            throw conflict('剩余配额不足以恢复所选文件', 'quota_exceeded')
          }
          if (this.freeBytes() < resolved.totalBytes + RESERVED_FREE_BYTES) {
            throw conflict('磁盘剩余空间不足', 'insufficient_storage')
          }
          const contentDir = join(staging, 'content')
          mkdirSync(contentDir, { recursive: true, mode: 0o700 })
          const extracted = await this.extractContents(chain, resolved.files.map((row) => row.id), contentDir)
          const createdFiles: string[] = []
          const createdFolders: string[] = []
          const target = this.files.createFolder(
            { username: actor.username, ip: actor.ip },
            null,
            this.nextTargetName(plan.target_name),
          )
          createdFolders.push(target.id)
          try {
            await this.restoreTree(snapshot, resolved.selected, extracted, target, createdFiles, createdFolders, actor)
          } catch (error) {
            this.cleanupCreated(createdFiles, createdFolders)
            throw error
          }
          const bytesRestored = resolved.files.reduce((sum, row) => sum + Number(row.size), 0)
          return {
            targetFolderId: target.id,
            targetName: target.name,
            filesRestored: resolved.files.length,
            bytesRestored,
            durationMs: Date.now() - started,
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

  private async extractContents(chain: ArchiveRow[], neededIds: string[], contentDir: string): Promise<Map<string, string>> {
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
      })
    }
    const missing = neededIds.filter((id) => !extracted.has(id))
    if (missing.length > 0) throw invalidArchive('归档链缺少所选文件内容', { missing: missing.length })
    return extracted
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
    if (!row.verified_at) throw conflict('归档尚未校验，无法浏览', 'archive_not_verified')
    if (!existsSync(this.storedPath(row))) throw notFound('归档文件不存在', 'archive_missing')
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
    })
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

  cleanup(): { expiredPlans: number; interruptedPlans: number; stagingDirs: number; partialImports: number } {
    const now = this.clock()
    const expiredPlans = this.db
      .prepare("UPDATE restore_plans SET status = 'expired' WHERE status = 'planned' AND expires_at <= ?")
      .run(now.toISOString())
    // 进程在中途崩溃时计划会停留在 executing；超过锁过期时间后标记失败，避免永久卡住。
    const interruptedPlans = this.db
      .prepare(
        "UPDATE restore_plans SET status = 'failed', error = '恢复中断（进程退出）' WHERE status = 'executing' AND created_at <= ?",
      )
      .run(new Date(now.getTime() - LOCK_STALE_MS).toISOString())
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
    if (Number(expiredPlans.changes) > 0 || Number(interruptedPlans.changes) > 0 || stagingDirs > 0 || partialImports > 0) {
      this.log('info', '备份维护清理完成', {
        expiredPlans: Number(expiredPlans.changes),
        interruptedPlans: Number(interruptedPlans.changes),
        stagingDirs,
        partialImports,
      })
    }
    return {
      expiredPlans: Number(expiredPlans.changes),
      interruptedPlans: Number(interruptedPlans.changes),
      stagingDirs,
      partialImports,
    }
  }
}
