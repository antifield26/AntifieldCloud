/**
 * 备份 CLI（在 Pi 上以 antifieldcloud 运行）：
 * - 两阶段协议：`--prepare` 只生成 pending 归档；Windows 拉取成功校验后 `--ack` 才推进备份游标。
 * - `--pending` 供拉取脚本查询待拉取归档与建议模式；`--snapshot-db` 供部署/升级前做一致性 DB 快照。
 * - 旧单阶段模式必须显式 `--legacy`（deprecated，仅排障用），无动作参数会直接报错。
 * - 输出附带 backups 目录中无 DB 记录的孤儿归档；只报告，不自动删除敏感数据。
 *
 * 一致性：所有文件内容不可变，增量只取 `created_at > 上次已确认备份时间` 的新增文件；
 * 重命名/移动只改元数据，由 DB 快照覆盖。
 *
 * 安全边界：归档含用户/TOTP/会话与文件内容，落盘权限 0640；DB 快照与临时清单 0600；
 * pending 归档在 PC 确认前不删除；已确认归档最多保留 2 个。
 *
 * stdout 只输出一行 JSON 供 Windows 拉取脚本解析；失败时 `{ok:false,error}` 且退出码 1。
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'
import { promisify } from 'node:util'
import { ensureRuntimeDirs, loadConfig, type Config } from '../config.ts'
import { getMeta, openDatabase, setMeta, transaction } from '../db.ts'
import { audit } from '../auth/audit.ts'
import {
  archiveSidecarName,
  assertAgeBinary,
  buildArchiveSidecar,
  encryptArchiveFile,
  isEncryptedArchiveName,
  readAgeRecipientFile,
} from './backup-encryption.ts'

const execFileAsync = promisify(execFile)
const GIB = 1024 * 1024 * 1024
/** 生成归档前额外预留的空间，避免把磁盘写满后无法继续提供只读服务。 */
const PREPARE_RESERVE_BYTES = 2 * GIB
/** 已确认归档在 Pi 上保留的最大数量（PC 拉取成功后通常已被删除，这里兜底清理失败场景）。 */
const MAX_ACKED_ARCHIVES = 2
/** 部署前 DB 快照保留数量（v0.7.0：明文快照仅保留最近 2 份，降低 TOTP/会话暴露面）。 */
const MAX_PREDEPLOY_SNAPSHOTS = 2
/** 放弃的明文临时归档清理阈值：崩溃/断电后下次 prepare 清理。 */
const ABANDONED_PLAIN_TEMP_MAX_AGE_MS = 24 * 60 * 60_000
/** 超过该天数没有成功全量则建议再做一次全量。 */
const FULL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
/** meta 键：上次 ack 后仍未落盘、等待恢复后自动补入增量的文件 id（JSON 数组）。 */
const BACKUP_MISSING_META_KEY = 'backup_missing_files'
/** prepare 输出中缺失 id 的展示上限，完整列表在 manifest/meta 中。 */
const MAX_MISSING_REPORT = 200

type Command = 'prepare' | 'pending' | 'ack' | 'snapshot-db' | 'legacy'
type ArchiveMode = 'full' | 'inc'

interface ParsedArgs {
  command: Command
  full: boolean
  name: string | null
  sha256: string | null
  noWarnings: boolean
}

interface FileEntry {
  id: string
  size: number
  created_at: string
}

interface PendingRow {
  name: string
  mode: ArchiveMode
  created_at: string
  sha256: string
  size: number
  file_count: number
}

interface ArchiveRow {
  name: string
  mode: ArchiveMode
  created_at: string
  sha256: string
  size: number
  acked_at: string | null
  deleted_at: string | null
  manifest_json: string | null
}

interface BackupStateRow {
  last_backup_at: string | null
}

interface ArchiveResult {
  ok: true
  status: 'pending'
  mode: ArchiveMode
  archive: string
  archiveName: string
  sizeBytes: number
  sha256: string
  fileCount: number
  totalBytes: number
  createdAt: string
  orphanBytes: number
  orphans: OrphanArchive[]
  /** 缺失物理文件被跳过时的告警；空数组表示全部落盘文件都已归档。 */
  warnings: string[]
  /** 快照中存在但磁盘缺失、本次未归档的文件 id（已写入 manifest 便于人工核对）。 */
  skippedMissing: string[]
  /** 上次 ack 记录、本次强制重新检查的历史缺失文件数。 */
  previousMissing: number
  /** v0.7.0：是否为 age 加密归档（`.tar.gz.age`）。 */
  encrypted: boolean
  archiveFormat: 'tar.gz' | 'tar.gz.age'
  /** 加密归档的外部元数据文件名；明文归档为 null。 */
  metaName: string | null
  plainSha256: string | null
  plainSize: number | null
}

/** backups 目录中存在、但 backup_archives 里没有记录的归档（只报告，不删除）。 */
interface OrphanArchive {
  name: string
  sizeBytes: number
  modifiedAt: string
}

/** 解析命令行；同一时间只允许一个动作，旧单阶段模式必须显式 --legacy。 */
function parseArgs(argv: string[]): ParsedArgs {
  const commands: Command[] = []
  let full = false
  let name: string | null = null
  let sha256: string | null = null
  let noWarnings = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === '--full') {
      full = true
    } else if (arg === '--no-warnings') {
      noWarnings = true
    } else if (arg === '--prepare') {
      commands.push('prepare')
    } else if (arg === '--pending') {
      commands.push('pending')
    } else if (arg === '--snapshot-db') {
      commands.push('snapshot-db')
    } else if (arg === '--legacy') {
      commands.push('legacy')
    } else if (arg === '--ack') {
      commands.push('ack')
      name = argv[++index] ?? null
    } else if (arg === '--sha256') {
      sha256 = argv[++index] ?? null
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  const unique = [...new Set(commands)]
  if (unique.length > 1) throw new Error(`动作互斥：${unique.join(' / ')}`)
  if (unique.length === 0) {
    throw new Error(
      '未指定动作：请使用 --prepare、--pending、--ack <name> --sha256 <hash> 或 --snapshot-db；旧的单阶段模式需显式 --legacy',
    )
  }
  const command = unique[0]!
  if (command === 'ack') {
    if (!name) throw new Error('--ack 需要归档名')
    if (!sha256) throw new Error('--ack 需要 --sha256')
    if (/[\\/]/.test(name)) throw new Error(`归档名非法：${name}`)
  } else if (name || sha256) {
    throw new Error('--ack/--sha256 只能与 --ack 一起使用')
  }
  if (full && command !== 'prepare' && command !== 'legacy') {
    throw new Error('--full 只能与 --prepare 或 --legacy 一起使用')
  }
  return { command, full, name, sha256, noWarnings }
}

function compactTimestamp(date: Date): string {
  // 保留毫秒，避免同一秒内两次 prepare 生成同名归档覆盖前一个 pending。
  return date.toISOString().replace(/[-:.]/g, '')
}

function freeBytes(path: string): number {
  try {
    // statfsSync 的 bavail/bsize 为 bigint，统一转 number 便于比较。
    const stats = statfsSync(path)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return 0
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

function acquireLock(path: string): number {
  try {
    const fd = openSync(path, 'wx')
    writeFileSync(fd, String(process.pid))
    return fd
  } catch (error) {
    try {
      const stats = statSync(path)
      // 进程被杀后遗留的锁：超过 1 小时视为陈旧，允许接管。
      if (Date.now() - stats.mtimeMs > 60 * 60 * 1000) {
        unlinkSync(path)
        return acquireLock(path)
      }
    } catch {
      // 锁文件不可读时继续抛原始错误。
    }
    throw new Error(
      `另一个备份操作正在进行（锁文件 ${path}）：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

function releaseLock(fd: number, path: string): void {
  try {
    closeSync(fd)
  } catch {
    // 忽略关闭失败。
  }
  try {
    unlinkSync(path)
  } catch {
    // 忽略清理失败。
  }
}

function maxTimestamp(...values: Array<string | null | undefined>): string | null {
  let max: string | null = null
  for (const value of values) {
    if (value && (max === null || value > max)) max = value
  }
  return max
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function emit(payload: object): void {
  console.log(JSON.stringify(payload))
}

/**
 * 扫描 backups 目录中形如 snapshot-*.tar.gz / snapshot-*.tar.gz.age、但 backup_archives 无记录的归档。
 * 只读报告，绝不自动删除（归档含敏感数据，需人工确认来源）。
 */
function listOrphanArchives(db: DatabaseSync, backupsDir: string): OrphanArchive[] {
  const known = new Set(
    (db.prepare('SELECT name FROM backup_archives').all() as unknown as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  )
  const orphans: OrphanArchive[] = []
  for (const name of readdirSync(backupsDir)) {
    if (!/^snapshot-.+\.tar\.gz(\.age)?$/.test(name) || known.has(name)) continue
    try {
      const stats = statSync(join(backupsDir, name))
      if (!stats.isFile()) continue
      orphans.push({
        name,
        sizeBytes: stats.size,
        modifiedAt: new Date(stats.mtimeMs).toISOString(),
      })
    } catch {
      // 读取失败的文件不列为孤儿，避免输出不可靠信息。
    }
  }
  return orphans.sort((left, right) => left.name.localeCompare(right.name))
}

/** 已确认归档只在文件仍存在时计入磁盘占用（拉取成功后文件通常已被删除）。 */
function existingArchiveBytes(rows: Array<{ name: string; size: number }>, backupsDir: string): number {
  let total = 0
  for (const row of rows) {
    if (existsSync(join(backupsDir, row.name))) total += Number(row.size)
  }
  return total
}

/** 读取 meta 中记录的“等待恢复后补入”的缺失文件 id。 */
function readMissingIds(db: DatabaseSync): string[] {
  const raw = getMeta(db, BACKUP_MISSING_META_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** 覆盖写入缺失文件 id 列表（空数组表示全部已恢复）。 */
function writeMissingIds(db: DatabaseSync, ids: string[]): void {
  const unique = [...new Set(ids)].sort()
  setMeta(db, BACKUP_MISSING_META_KEY, JSON.stringify(unique))
}

/** readdir 的安全版本：目录不存在/不可读时返回空数组。 */
function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** 扫描 tar/加密失败残留的 `.part` 或明文临时文件（只报告，供 pending 输出可观测）。 */
function listPartialArchives(backupsDir: string): Array<{ name: string; sizeBytes: number; modifiedAt: string }> {
  const partials: Array<{ name: string; sizeBytes: number; modifiedAt: string }> = []
  for (const name of readdirSyncSafe(backupsDir)) {
    if (!name.endsWith('.part') && !name.endsWith('.plain.tmp')) continue
    try {
      const stats = statSync(join(backupsDir, name))
      if (!stats.isFile()) continue
      partials.push({ name, sizeBytes: stats.size, modifiedAt: new Date(stats.mtimeMs).toISOString() })
    } catch {
      // 忽略不可读条目。
    }
  }
  return partials.sort((left, right) => left.name.localeCompare(right.name))
}

/** 读取 pending 归档（含是否仍存在），供拉取脚本决定拉取/生成。 */
function listPending(
  db: DatabaseSync,
  backupsDir: string,
  includeWarnings = true,
): Record<string, unknown> {
  const pending = db
    .prepare(
      "SELECT name, mode, created_at, sha256, size, file_count FROM backup_archives WHERE acked_at IS NULL AND deleted_at IS NULL AND origin = 'pi' ORDER BY created_at ASC",
    )
    .all() as unknown as PendingRow[]
  const lastAcked = db
    .prepare(
      "SELECT created_at FROM backup_archives WHERE acked_at IS NOT NULL AND deleted_at IS NULL AND origin = 'pi' ORDER BY created_at DESC LIMIT 1",
    )
    .get() as { created_at: string } | undefined
  const lastFull = db
    .prepare(
      "SELECT created_at FROM backup_archives WHERE mode = 'full' AND acked_at IS NOT NULL AND deleted_at IS NULL AND origin = 'pi' ORDER BY created_at DESC LIMIT 1",
    )
    .get() as { created_at: string } | undefined
  const acked = db
    .prepare("SELECT name, size FROM backup_archives WHERE acked_at IS NOT NULL AND deleted_at IS NULL AND origin = 'pi'")
    .all() as unknown as Array<{ name: string; size: number }>
  const orphans = listOrphanArchives(db, backupsDir)
  const partials = listPartialArchives(backupsDir)
  const missingFiles = readMissingIds(db)
  const pendingBytes = pending.reduce((sum, row) => sum + Number(row.size), 0)
  const ackedBytes = existingArchiveBytes(acked, backupsDir)
  const orphanBytes = orphans.reduce((sum, row) => sum + row.sizeBytes, 0)
  const now = Date.now()
  const needsFull = !lastFull || now - Date.parse(lastFull.created_at) > FULL_INTERVAL_MS
  const warnings: string[] = []
  if (includeWarnings && orphans.length > 0) {
    warnings.push(`发现 ${orphans.length} 个无 DB 记录的孤儿归档（${orphanBytes} bytes），未自动删除，请人工核对`)
  }
  if (includeWarnings && partials.length > 0) {
    warnings.push(`发现 ${partials.length} 个未完成的 .part/.plain.tmp 归档残留，确认无备份任务运行后可手动清理`)
  }
  const missingSidecars = pending
    .filter((row) => isEncryptedArchiveName(row.name) && !existsSync(join(backupsDir, archiveSidecarName(row.name))))
    .map((row) => row.name)
  if (includeWarnings && missingSidecars.length > 0) {
    warnings.push(
      `有 ${missingSidecars.length} 个加密归档缺少 .meta.json 外部元数据（无法校验明文哈希），请勿在补齐前 ack/删除`,
    )
  }
  if (includeWarnings && missingFiles.length > 0) {
    warnings.push(
      `有 ${missingFiles.length} 个文件在磁盘缺失，已阻止其内容进入备份；文件恢复后会由下一次增量自动补入`,
    )
  }
  return {
    ok: true,
    count: pending.length,
    pendingBytes,
    ackedBytes,
    orphanBytes,
    pending: pending.map((row) => ({
      name: row.name,
      mode: row.mode,
      createdAt: row.created_at,
      sha256: row.sha256,
      sizeBytes: Number(row.size),
      fileCount: Number(row.file_count),
      exists: existsSync(join(backupsDir, row.name)),
      encrypted: isEncryptedArchiveName(row.name),
      archiveFormat: isEncryptedArchiveName(row.name) ? 'tar.gz.age' : 'tar.gz',
      metaName: isEncryptedArchiveName(row.name) ? archiveSidecarName(row.name) : null,
      metaExists: isEncryptedArchiveName(row.name)
        ? existsSync(join(backupsDir, archiveSidecarName(row.name)))
        : null,
    })),
    missingSidecars,
    orphans,
    partials,
    missingFiles: missingFiles.slice(0, MAX_MISSING_REPORT),
    missingFileCount: missingFiles.length,
    warnings,
    lastAckedAt: lastAcked?.created_at ?? null,
    lastFullAt: lastFull?.created_at ?? null,
    needsFull,
    recommendedMode: needsFull ? 'full' : 'inc',
  }
}

/**
 * 部署前一致性 DB 快照：以只读方式打开现有 DB，不触发 schema 迁移、不写审计，
 * 保证快照是“迁移前”状态；生成失败由部署脚本中止切换。
 */
async function snapshotPredeploy(dataDir: string, backupsDir: string): Promise<Record<string, unknown>> {
  const created = new Date()
  const stamp = compactTimestamp(created)
  let snapshotName = `db-predeploy-${stamp}.sqlite`
  let sequence = 0
  while (existsSync(join(backupsDir, snapshotName))) {
    sequence++
    if (sequence > 100) throw new Error('无法生成唯一 DB 快照名：备份目录残留过多')
    snapshotName = `db-predeploy-${stamp}-${sequence}.sqlite`
  }
  const snapshotPath = join(backupsDir, snapshotName)
  const sourcePath = join(dataDir, 'db.sqlite')
  if (!existsSync(sourcePath)) throw new Error(`数据库不存在：${sourcePath}`)
  const source = new DatabaseSync(sourcePath, { readOnly: true })
  try {
    await backup(source, snapshotPath)
  } finally {
    try {
      source.close()
    } catch {
      // 忽略关闭失败。
    }
  }
  chmodSync(snapshotPath, 0o600)
  const sizeBytes = statSync(snapshotPath).size
  const sha256 = await sha256File(snapshotPath)

  const snapshots = readdirSync(backupsDir)
    .filter((name) => /^db-predeploy-.*\.sqlite$/.test(name))
    .sort()
    .reverse()
  for (const stale of snapshots.slice(MAX_PREDEPLOY_SNAPSHOTS)) {
    try {
      unlinkSync(join(backupsDir, stale))
    } catch {
      // 清理失败不影响本次快照。
    }
  }

  return { ok: true, snapshot: resolve(snapshotPath), snapshotName, sha256, sizeBytes, createdAt: created.toISOString() }
}

/**
 * 清理崩溃/断电遗留的明文临时归档（`*.plain.tmp`）。
 * 仅删除超过 maxAge 的普通文件；正在生成的归档由 mtime 保护，不会误删。
 */
function cleanupAbandonedPlainTemps(backupsDir: string, maxAgeMs = ABANDONED_PLAIN_TEMP_MAX_AGE_MS): number {
  let removed = 0
  const cutoff = Date.now() - Math.max(0, maxAgeMs)
  for (const name of readdirSyncSafe(backupsDir)) {
    if (!name.endsWith('.plain.tmp')) continue
    const path = join(backupsDir, name)
    try {
      const stats = statSync(path)
      if (!stats.isFile() || stats.mtimeMs >= cutoff) continue
      unlinkSync(path)
      removed += 1
    } catch {
      // 单个残留清理失败不影响本次归档；下一次再试。
    }
  }
  return removed
}

/**
 * 生成一个归档并写入 pending 记录，不推进 backup_state。
 * 增量起点取「上次已确认时间」与「最新 pending 时间」的较大者，避免 pending 未确认时重复打包。
 */
async function createArchive(
  db: DatabaseSync,
  config: Config,
  backupsDir: string,
  forceFull: boolean,
  legacy = false,
): Promise<ArchiveResult> {
  const created = new Date()
  const stamp = compactTimestamp(created)
  const createdAt = created.toISOString()
  const dbSnapshotPath = join(backupsDir, `db-${stamp}.sqlite`)
  const manifestPath = join(backupsDir, `manifest-${stamp}.json`)
  const listPath = join(backupsDir, `.files-${stamp}.txt`)
  // 归档路径在模式确定后生成；失败清理只删除本次真正创建的文件。
  let createdArchivePath: string | null = null
  let createdSidecarPath: string | null = null
  let plainTempPath: string | null = null
  let snapshotDb: DatabaseSync | null = null
  const encryptionEnabled = config.backupArchiveEncryption
  const ageBin = process.env.BACKUP_AGE_BIN ?? 'age'
  let recipient: string | null = null

  try {
    // 失败关闭：加密开启时先校验 age 与公钥，避免打包数 GiB 后才发现不可用。
    if (encryptionEnabled) {
      recipient = readAgeRecipientFile(config.backupAgeRecipientFile, {
        skipOwnerCheck: process.env.BACKUP_SKIP_KEY_OWNER_CHECK === '1',
      })
      await assertAgeBinary(ageBin)
    }
    cleanupAbandonedPlainTemps(backupsDir)
    await backup(db, dbSnapshotPath)
    chmodSync(dbSnapshotPath, 0o600)
    const dbBytes = statSync(dbSnapshotPath).size
    snapshotDb = new DatabaseSync(dbSnapshotPath, { readOnly: true })

    const state = snapshotDb.prepare('SELECT last_backup_at FROM backup_state WHERE id = 1').get() as
      | BackupStateRow
      | undefined
    const pending = snapshotDb
      .prepare(
        "SELECT name, mode, created_at, sha256, size, file_count FROM backup_archives WHERE acked_at IS NULL AND deleted_at IS NULL AND origin = 'pi' ORDER BY created_at ASC",
      )
      .all() as unknown as PendingRow[]
    const pendingBytes = pending.reduce((sum, row) => sum + Number(row.size), 0)
    const acked = snapshotDb
      .prepare("SELECT name, size FROM backup_archives WHERE acked_at IS NOT NULL AND deleted_at IS NULL AND origin = 'pi'")
      .all() as unknown as Array<{ name: string; size: number }>
    // 只有文件仍在磁盘上的已确认归档才占用空间；孤儿归档按实际文件大小计入。
    const ackedBytes = existingArchiveBytes(acked, backupsDir)
    const orphans = listOrphanArchives(db, backupsDir)
    const orphanBytes = orphans.reduce((sum, row) => sum + row.sizeBytes, 0)
    const pendingStart = pending.length > 0 ? pending[pending.length - 1]!.created_at : null
    const previous = state?.last_backup_at ?? null
    // 没有已确认历史且没有待拉取归档时才自动全量；已有 pending 全量时按增量继续。
    const mode: ArchiveMode = forceFull || (!previous && pending.length === 0) ? 'full' : 'inc'
    const since = mode === 'inc' ? maxTimestamp(previous, pendingStart) : null
    // 归档名必须唯一：同一毫秒内重试时追加序号，避免覆盖未确认的 pending 归档。
    let archiveName = ''
    let archivePath = ''
    let archiveBaseName = ''
    let sequence = 0
    for (;;) {
      const suffix = sequence === 0 ? stamp : `${stamp}-${sequence}`
      archiveBaseName = `snapshot-${suffix}-${mode}.tar.gz`
      archiveName = encryptionEnabled ? `${archiveBaseName}.age` : archiveBaseName
      archivePath = join(backupsDir, archiveName)
      const nameTaken =
        existsSync(archivePath) ||
        existsSync(join(backupsDir, `${archiveBaseName}.plain.tmp`)) ||
        db.prepare('SELECT 1 FROM backup_archives WHERE name = ?').get(archiveName) !== undefined
      if (!nameTaken) break
      sequence++
      if (sequence > 100) throw new Error('无法生成唯一归档名：备份目录残留过多')
    }

    const previousMissing = readMissingIds(snapshotDb)
    const baseSelected = (
      mode === 'full'
        ? snapshotDb.prepare("SELECT id, size, created_at FROM files WHERE kind = 'file'").all()
        : snapshotDb
            .prepare("SELECT id, size, created_at FROM files WHERE kind = 'file' AND created_at > ?")
            .all(since)
    ) as unknown as FileEntry[]
    // 上次缺失的文件即使早于水位也强制纳入本次选择：恢复后立即补入增量，避免水位越过永久漏备。
    const selectedById = new Map(baseSelected.map((file) => [file.id, file]))
    if (previousMissing.length > 0) {
      const placeholders = previousMissing.map(() => '?').join(', ')
      const recovered = snapshotDb
        .prepare(`SELECT id, size, created_at FROM files WHERE id IN (${placeholders})`)
        .all(...previousMissing) as unknown as FileEntry[]
      for (const file of recovered) selectedById.set(file.id, file)
    }
    const selected = [...selectedById.values()]

    // 物理文件预检：DB 有行但磁盘文件缺失时跳过并记录，不能让 tar 因缺失文件整体失败
    // （否则一次断电/手工误删会让后续每日备份永久停止）。
    const files: FileEntry[] = []
    const skippedMissing: string[] = []
    for (const file of selected) {
      const physicalPath = join(config.dataDir, 'files', file.id.slice(0, 2), file.id)
      if (existsSync(physicalPath)) files.push(file)
      else skippedMissing.push(file.id)
    }
    // 时针回拨/未来时间戳检测：增量依赖 created_at > 上次水位，回拨会永久漏备。
    const clockWarnings: string[] = []
    const futureCount = files.filter((file) => file.created_at > createdAt).length
    if (futureCount > 0) {
      clockWarnings.push(`${futureCount} 个文件 created_at 晚于当前时间，请检查系统时钟（NTP）`)
    }
    if (previous && previous > createdAt) {
      clockWarnings.push('备份水位晚于当前时间，系统时钟可能回拨；建议立即做一次 --full')
    }
    const warnings: string[] = []
    if (skippedMissing.length > 0) {
      warnings.push(
        `${skippedMissing.length} 个文件在磁盘上缺失，已跳过并记录到 manifest.skippedMissing；ack 后仍会阻止其内容进入备份，恢复后由下一次增量自动补入`,
      )
    }
    warnings.push(...clockWarnings)

    const totalBytes = files.reduce((sum, file) => sum + Number(file.size), 0)
    const estimate = totalBytes + dbBytes
    const available = freeBytes(config.dataDir)
    // pending 未确认、acked 未清理、孤儿归档都仍需留在磁盘上，空间预算全部计入。
    // 加密时峰值需同时容纳明文 tar 与密文（约 2× 本次估算）。
    const peakBytes = encryptionEnabled ? estimate * 2 : estimate
    const required = peakBytes + pendingBytes + ackedBytes + orphanBytes + PREPARE_RESERVE_BYTES
    if (available < required) {
      throw new Error(
        `磁盘空间不足：需要约 ${Math.ceil(required / GIB)} GiB（本次${encryptionEnabled ? '加密峰值' : ''}约 ${Math.ceil(peakBytes / GIB)} GiB + pending ${pending.length} 个/${Math.ceil(pendingBytes / GIB)} GiB + acked 未清理 ${acked.length} 个/${Math.ceil(ackedBytes / GIB)} GiB + 孤儿 ${orphans.length} 个/${Math.ceil(orphanBytes / GIB)} GiB），可用 ${Math.ceil(available / GIB)} GiB`,
      )
    }

    const manifest = {
      // 加密归档使用 schema 2：明文哈希/大小在归档外（DB/sidecar），避免自引用。
      schema: encryptionEnabled ? 2 : 1,
      createdAt,
      mode,
      since,
      database: `backups/db-${stamp}.sqlite`,
      files: files.map((file) => ({ id: file.id, size: Number(file.size), createdAt: file.created_at })),
      fileCount: files.length,
      totalBytes,
      skippedMissing,
      warnings,
      ...(encryptionEnabled ? { encrypted: true, archiveFormat: 'tar.gz.age' as const } : {}),
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 })

    const entries = [
      `backups/db-${stamp}.sqlite`,
      `backups/manifest-${stamp}.json`,
      ...files.map((file) => `files/${file.id.slice(0, 2)}/${file.id}`),
    ]
    writeFileSync(listPath, `${entries.join('\n')}\n`, { mode: 0o600 })
    // 加密路径：tar 先写明文临时文件，age 成功后再产生最终 .age；明文只在加密期间短暂存在。
    // 明文路径：先写 .part 再原子改名，tar 中途失败/被 kill 时不会留下看似完整的 snapshot 残片。
    const tarTargetPath = encryptionEnabled ? join(backupsDir, `${archiveBaseName}.plain.tmp`) : `${archivePath}.part`
    if (encryptionEnabled) plainTempPath = tarTargetPath
    // 仅测试注入：模拟 tar 中途失败，验证残片清理；生产环境该分支不可达。
    if (process.env.NODE_ENV === 'test' && process.env.BACKUP_SIMULATE_TAR_FAILURE === '1') {
      writeFileSync(tarTargetPath, 'partial-archive')
      throw new Error('模拟 tar 失败')
    }
    await execFileAsync('tar', ['-czf', tarTargetPath, '-C', config.dataDir, '--files-from', listPath], {
      maxBuffer: 16 * 1024 * 1024,
    })

    let sizeBytes: number
    let sha256: string
    let plainSha256: string | null = null
    let plainSize: number | null = null
    let manifestJson: string
    if (encryptionEnabled) {
      const plainPath = tarTargetPath
      plainSize = statSync(plainPath).size
      plainSha256 = await sha256File(plainPath)
      const cipherPartPath = `${archivePath}.part`
      await encryptArchiveFile({
        plainPath,
        cipherPath: cipherPartPath,
        recipient: recipient!,
        ageBin,
        timeoutMs: 30 * 60_000,
      })
      chmodSync(cipherPartPath, 0o640)
      renameSync(cipherPartPath, archivePath)
      createdArchivePath = archivePath
      sizeBytes = statSync(archivePath).size
      sha256 = await sha256File(archivePath)
      const sidecar = buildArchiveSidecar({
        name: archiveName,
        mode,
        createdAt,
        plainSha256,
        plainSize,
        cipherSha256: sha256,
        cipherSize: sizeBytes,
        recipient: recipient!,
      })
      const sidecarPath = join(backupsDir, archiveSidecarName(archiveName))
      const sidecarTempPath = `${sidecarPath}.part`
      writeFileSync(sidecarTempPath, JSON.stringify(sidecar, null, 2), { mode: 0o640 })
      chmodSync(sidecarTempPath, 0o640)
      renameSync(sidecarTempPath, sidecarPath)
      createdSidecarPath = sidecarPath
      // DB 中的 manifest_json 是外部元数据（应用/CLI 可读），包含明文哈希/大小与密文信息。
      manifestJson = JSON.stringify({
        ...manifest,
        plainSha256,
        plainSize,
        cipherSha256: sha256,
        cipherSize: sizeBytes,
        encryptedWith: 'age',
        recipient: recipient!,
      })
      // 明文 tar 在密文与 sidecar 落盘后立即删除；崩溃窗口由启动清理兜底。
      unlinkSync(plainPath)
      plainTempPath = null
    } else {
      renameSync(tarTargetPath, archivePath)
      createdArchivePath = archivePath
      // 归档含 TOTP 与会话等敏感数据：显式 0640，不依赖调用方 umask。
      chmodSync(archivePath, 0o640)
      sizeBytes = statSync(archivePath).size
      sha256 = await sha256File(archivePath)
      manifestJson = JSON.stringify(manifest)
    }
    db.prepare(
      `INSERT INTO backup_archives (name, mode, created_at, sha256, size, file_count, pulled_at, acked_at, deleted_at, manifest_json)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    ).run(archiveName, mode, createdAt, sha256, sizeBytes, files.length, manifestJson)
    audit(
      db,
      'cli',
      legacy ? 'backup_legacy' : 'backup_prepare',
      archiveName,
      legacy
        ? { mode, files: files.length, sizeBytes, deprecated: true, skippedMissing: skippedMissing.length, encrypted: encryptionEnabled }
        : {
            mode,
            files: files.length,
            sizeBytes,
            skippedMissing: skippedMissing.length,
            ...(encryptionEnabled ? { encrypted: true, plainSize } : {}),
          },
      null,
    )

    return {
      ok: true,
      status: 'pending',
      mode,
      archive: resolve(archivePath),
      archiveName,
      sizeBytes,
      sha256,
      fileCount: files.length,
      totalBytes,
      createdAt,
      orphanBytes,
      orphans,
      warnings,
      skippedMissing,
      previousMissing: previousMissing.length,
      encrypted: encryptionEnabled,
      archiveFormat: encryptionEnabled ? 'tar.gz.age' : 'tar.gz',
      metaName: encryptionEnabled ? archiveSidecarName(archiveName) : null,
      plainSha256,
      plainSize,
    }
  } catch (error) {
    for (const cleanupPath of [createdArchivePath, createdSidecarPath, plainTempPath]) {
      if (!cleanupPath) continue
      try {
        unlinkSync(cleanupPath)
      } catch {
        // 清理失败不影响错误返回；下一次 prepare 会清理残留临时文件。
      }
    }
    // tar/age 中途失败/超时被 kill：清理本次 .part / .plain.tmp 残片，避免 pending/孤儿报告长期堆积。
    for (const name of readdirSyncSafe(backupsDir)) {
      if (!name.startsWith(`snapshot-${stamp}`)) continue
      if (!name.endsWith('.part') && !name.endsWith('.plain.tmp')) continue
      try {
        rmSync(join(backupsDir, name), { force: true })
      } catch {
        // 忽略清理失败，pending 输出会报告残留。
      }
    }
    throw error
  } finally {
    if (plainTempPath) {
      try {
        unlinkSync(plainTempPath)
      } catch {
        // 忽略清理失败。
      }
    }
    try {
      snapshotDb?.close()
    } catch {
      // 忽略关闭失败。
    }
    // 只读打开快照仍可能因源库 WAL 模式生成 -wal/-shm，统一清理。
    for (const path of [
      dbSnapshotPath,
      `${dbSnapshotPath}-wal`,
      `${dbSnapshotPath}-shm`,
      manifestPath,
      listPath,
    ]) {
      if (existsSync(path)) {
        try {
          rmSync(path, { force: true })
        } catch {
          // 忽略清理失败。
        }
      }
    }
  }
}

/** 校验归档 SHA/大小后确认拉取，推进游标并清理过旧的已确认归档。幂等。 */
async function ackArchive(
  db: DatabaseSync,
  backupsDir: string,
  name: string,
  sha256Input: string,
  legacy = false,
): Promise<Record<string, unknown>> {
  const expectedSha = sha256Input.toLowerCase()
  const row = db
    .prepare(
      'SELECT name, mode, created_at, sha256, size, acked_at, deleted_at, manifest_json FROM backup_archives WHERE name = ?',
    )
    .get(name) as ArchiveRow | undefined
  if (!row) throw new Error(`未知归档：${name}`)
  if (row.deleted_at) throw new Error(`归档已删除，无法确认：${name}`)
  if (expectedSha !== row.sha256) {
    throw new Error(`SHA-256 与归档记录不一致：记录 ${row.sha256}，收到 ${expectedSha}`)
  }

  const alreadyAcked = row.acked_at !== null
  if (!alreadyAcked) {
    const archivePath = join(backupsDir, name)
    if (!existsSync(archivePath)) throw new Error(`归档文件不存在，无法确认：${archivePath}`)
    const actualSha = await sha256File(archivePath)
    if (actualSha !== expectedSha) {
      throw new Error(`归档 SHA-256 校验失败：本地 ${actualSha} / 记录 ${expectedSha}`)
    }
    const actualSize = statSync(archivePath).size
    if (Number(row.size) !== actualSize) {
      throw new Error(`归档大小与记录不一致：本地 ${actualSize} / 记录 ${row.size}`)
    }

    // 归档行、游标、缺失文件状态与审计在同一事务内提交，避免只推进一部分导致漏备/重复通知。
    transaction(db, () => {
      const now = new Date().toISOString()
      db.prepare('UPDATE backup_archives SET pulled_at = ?, acked_at = ? WHERE name = ?').run(now, now, name)
      advanceCursor(db, row)
      // 合并历史缺失与本归档 skippedMissing：多 pending 顺序 ack 时不能丢掉“恢复后补入下一次增量”的
      // 强制重查集合（后 ack 的 inc 未选中早期缺失文件，旧实现会用空列表覆盖历史缺失集合）。
      const missing = nextMissingIds(db, readMissingIds(db), row.manifest_json)
      writeMissingIds(db, missing)
      audit(
        db,
        'cli',
        'backup_ack',
        name,
        legacy
          ? { mode: row.mode, sizeBytes: Number(row.size), deprecated: true, legacy: true, missingFiles: missing.length }
          : { mode: row.mode, sizeBytes: Number(row.size), missingFiles: missing.length },
        null,
      )
    })
  } else {
    // 幂等补游标：历史 ack 可能只更新了行没推进 backup_state（旧实现/中断），按最大已确认时间修复。
    transaction(db, () => {
      const latest = db
        .prepare(
          "SELECT name, created_at, sha256, size FROM backup_archives WHERE acked_at IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        )
        .get() as ArchiveRow | undefined
      if (latest) advanceCursor(db, latest)
    })
  }

  const removed = pruneAcked(db, backupsDir)
  return { ok: true, name, alreadyAcked, removed, mode: row.mode, deprecated: legacy }
}

/** 游标只前进：乱序 ack 时保留最新已确认时间。 */
function advanceCursor(
  db: DatabaseSync,
  row: Pick<ArchiveRow, 'created_at' | 'name' | 'sha256' | 'size'>,
): void {
  const state = db.prepare('SELECT last_backup_at FROM backup_state WHERE id = 1').get() as
    | BackupStateRow
    | undefined
  if (!state?.last_backup_at || row.created_at > state.last_backup_at) {
    db.prepare(
      'UPDATE backup_state SET last_backup_at = ?, last_archive = ?, last_sha256 = ?, last_size = ? WHERE id = 1',
    ).run(row.created_at, row.name, row.sha256, row.size)
  }
}

/** 从归档 manifest_json 解析本次覆盖的 content id 与 skippedMissing（缺失物理文件的 id）。 */
function parseManifestIndex(raw: string | null): { files: Set<string>; skippedMissing: Set<string> } {
  const files = new Set<string>()
  const skippedMissing = new Set<string>()
  if (!raw) return { files, skippedMissing }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { files, skippedMissing }
    const record = parsed as Record<string, unknown>
    if (Array.isArray(record.files)) {
      for (const entry of record.files) {
        const id = (entry as Record<string, unknown> | null)?.id
        if (typeof id === 'string' && id) files.add(id)
      }
    }
    if (Array.isArray(record.skippedMissing)) {
      for (const id of record.skippedMissing) if (typeof id === 'string' && id) skippedMissing.add(id)
    }
  } catch {
    // manifest 损坏时按“没有任何覆盖信息”处理，由调用方保守保留历史缺失集合。
  }
  return { files, skippedMissing }
}

/**
 * ack 后应继续保留的缺失文件集合：
 * - 本归档 skippedMissing 的 id 必须保留（等待物理恢复后补入下一次增量）；
 * - 本归档 files 已包含的 id 视为已覆盖，移除；
 * - 本归档未选中、但 DB 中文件行仍存在的历史缺失 id 继续保留（多 pending 场景下后 ack 的 inc
 *   不会重复选择早期文件，直接覆盖会永久丢掉强制重查集合）；文件行已删除的 id 丢弃。
 */
function nextMissingIds(db: DatabaseSync, previous: string[], manifestJson: string | null): string[] {
  const { files, skippedMissing } = parseManifestIndex(manifestJson)
  const keep = new Set<string>()
  const existing = db.prepare("SELECT 1 AS ok FROM files WHERE id = ? AND kind = 'file'")
  for (const id of previous) {
    if (files.has(id) || skippedMissing.has(id)) continue
    try {
      if (existing.get(id) !== undefined) keep.add(id)
    } catch {
      // 查询失败时保守保留，宁可下次多打包也不能漏备。
      keep.add(id)
    }
  }
  for (const id of skippedMissing) keep.add(id)
  return [...keep]
}

/**
 * 已确认归档清理：不得删除唯一/最新 full 及其之后的所有 inc（恢复链依赖）。
 * 只允许删除「最新 full 之前」的旧归档；无 full 时保留最近 MAX_ACKED_ARCHIVES 个。
 */
function pruneAcked(db: DatabaseSync, backupsDir: string): string[] {
  const rows = db
    .prepare(
      "SELECT name, mode FROM backup_archives WHERE acked_at IS NOT NULL AND deleted_at IS NULL AND origin = 'pi' ORDER BY created_at DESC",
    )
    .all() as unknown as Array<{ name: string; mode: ArchiveMode }>
  const newestFull = rows.findIndex((row) => row.mode === 'full')
  const keepCount = newestFull >= 0 ? newestFull + 1 : MAX_ACKED_ARCHIVES
  const removed: string[] = []
  for (const row of rows.slice(keepCount)) {
    const archivePath = join(backupsDir, row.name)
    try {
      if (existsSync(archivePath)) unlinkSync(archivePath)
      // 加密归档的 sidecar 与归档同生命周期；PC 已拉取后 Pi 不再需要。
      const sidecarPath = join(backupsDir, archiveSidecarName(row.name))
      if (existsSync(sidecarPath)) unlinkSync(sidecarPath)
    } catch {
      // 删除失败时保留记录，下次 ack 再清理。
      continue
    }
    db.prepare('UPDATE backup_archives SET deleted_at = ? WHERE name = ?').run(new Date().toISOString(), row.name)
    removed.push(row.name)
  }
  return removed
}

async function main(): Promise<void> {
  let args: ParsedArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    emit({ ok: false, error: errorMessage(error) })
    process.exitCode = 1
    return
  }

  const config = loadConfig()
  ensureRuntimeDirs(config)
  const backupsDir = join(config.dataDir, 'backups')
  mkdirSync(backupsDir, { recursive: true })

  // 迁移前快照必须用只读连接：不能走 openDatabase（会先执行迁移）。
  if (args.command === 'snapshot-db') {
    emit(await snapshotPredeploy(config.dataDir, backupsDir))
    return
  }

  const db = openDatabase({ path: join(config.dataDir, 'db.sqlite') })

  try {
    if (args.command === 'pending') {
      emit(listPending(db, backupsDir, !args.noWarnings))
      return
    }

    const lockPath = join(backupsDir, '.backup.lock')
    const lockFd = acquireLock(lockPath)
    try {
      if (args.command === 'ack') {
        emit(await ackArchive(db, backupsDir, args.name!, args.sha256!))
        return
      }
      const legacy = args.command === 'legacy'
      const result = await createArchive(db, config, backupsDir, args.full, legacy)
      if (args.command === 'prepare') {
        emit(result)
        return
      }
      // 显式 --legacy：生成后立即确认（不删除归档文件），仅用于排障/兼容旧调用。
      const acked = await ackArchive(db, backupsDir, result.archiveName, result.sha256, true)
      emit({
        ...result,
        status: 'acked',
        alreadyAcked: acked.alreadyAcked,
        removed: acked.removed,
        deprecated: true,
        legacy: true,
      })
    } finally {
      releaseLock(lockFd, lockPath)
    }
  } finally {
    try {
      db.close()
    } catch {
      // 忽略关闭失败。
    }
  }
}

main().catch((error: unknown) => {
  emit({ ok: false, error: errorMessage(error) })
  process.exit(1)
})
