/** 备份模块测试夹具：tar.gz 构造、快照 DB 构造、BackupService/Fastify 迷你应用。 */
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import { gzipSync } from 'node:zlib'
import { readFileSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../src/config.ts'
import type { AuthContext, SessionRow } from '../src/types.ts'
import { FileService } from '../src/files/service.ts'
import { BackupService, type BackupActor, type BackupRunner } from '../src/backups/service.ts'
import { openDatabase } from '../src/db.ts'
import { registerBackupRoutes } from '../src/http/routes/backups.ts'
import { registerErrorHandler } from '../src/http/errors.ts'
import { sha256Hex } from '../src/util/ids.ts'
import { cleanupDir, currentCode, seedAdmin, tempDataDir, testConfig, testDb, type SeedResult } from './helpers.ts'

const BLOCK = 512

export const BACKUP_SESSION = 'backup-test-session'
export const BACKUP_CSRF = 'backup-test-csrf'

export interface TarFixtureEntry {
  path: string
  data?: Buffer
  type?: 'file' | 'dir' | 'symlink' | 'hardlink'
  linkname?: string
}

function writeString(buffer: Buffer, value: string, offset: number, length: number): void {
  const bytes = Buffer.from(value, 'utf8')
  bytes.copy(buffer, offset, 0, Math.min(length, bytes.length))
}

function tarHeader(entry: { path: string; size: number; typeflag: string; linkname?: string }): Buffer {
  const header = Buffer.alloc(BLOCK)
  writeString(header, entry.path, 0, 100)
  writeString(header, '0000644\0', 100, 8)
  writeString(header, '0000000\0', 108, 8)
  writeString(header, '0000000\0', 116, 8)
  writeString(header, `${entry.size.toString(8).padStart(11, '0')}\0`, 124, 12)
  writeString(header, `${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12)
  header.fill(0x20, 148, 156)
  writeString(header, entry.typeflag, 156, 1)
  writeString(header, entry.linkname ?? '', 157, 100)
  writeString(header, 'ustar\0', 257, 6)
  writeString(header, '00', 263, 2)
  writeString(header, 'root', 265, 32)
  writeString(header, 'root', 297, 32)
  let checksum = 0
  for (const byte of header) checksum += byte
  writeString(header, `${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return header
}

/** 构造 tar.gz（测试专用，支持常规文件/目录/链接以覆盖安全校验）。 */
export function tarGz(entries: TarFixtureEntry[]): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const type = entry.type ?? 'file'
    const typeflag = type === 'dir' ? '5' : type === 'symlink' ? '2' : type === 'hardlink' ? '1' : '0'
    const data = type === 'file' ? (entry.data ?? Buffer.alloc(0)) : Buffer.alloc(0)
    const path = type === 'dir' && !entry.path.endsWith('/') ? `${entry.path}/` : entry.path
    chunks.push(tarHeader({ path, size: data.length, typeflag, linkname: entry.linkname }))
    if (data.length > 0) {
      chunks.push(data)
      const padding = (BLOCK - (data.length % BLOCK)) % BLOCK
      if (padding > 0) chunks.push(Buffer.alloc(padding))
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2))
  return gzipSync(Buffer.concat(chunks))
}

export interface SnapshotFixtureRow {
  id: string
  parentId?: string | null
  name: string
  kind?: 'file' | 'dir'
  size?: number
  sha256?: string | null
  mime?: string | null
  /** 可见性来源；缺省 user（模拟旧快照）。 */
  origin?: 'user' | 'note' | 'system'
}

/** 生成一个可被归档携带的 SQLite 快照（仅 files 表内容有意义）。 */
export function buildSnapshotDb(workDir: string, rows: SnapshotFixtureRow[]): Buffer {
  const path = join(workDir, `snapshot-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sqlite`)
  const db = openDatabase({ path })
  try {
    const insert = db.prepare(
      `INSERT INTO files (id, parent_id, name, kind, size, mime, sha256, storage_key, created_at, updated_at, deleted_at, deleted_parent_id, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?)`,
    )
    const now = '2026-01-01T00:00:00.000Z'
    for (const row of rows) {
      insert.run(
        row.id,
        row.parentId ?? null,
        row.name,
        row.kind ?? 'file',
        row.size ?? 0,
        row.mime ?? null,
        row.sha256 ?? null,
        now,
        now,
        row.origin ?? 'user',
      )
    }
  } finally {
    db.close()
  }
  const bytes = readFileSync(path)
  unlinkSync(path)
  rmSync(`${path}-wal`, { force: true })
  rmSync(`${path}-shm`, { force: true })
  return bytes
}

export function compactIso(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

export interface ArchiveFixtureOptions {
  createdAt: string
  mode: 'full' | 'inc'
  since?: string | null
  snapshotRows: SnapshotFixtureRow[]
  contents: { id: string; data: Buffer }[]
  workDir: string
  includeDatabase?: boolean
  includeManifest?: boolean
  manifestPatch?: Record<string, unknown>
  extraEntries?: TarFixtureEntry[]
  nameOverride?: string
}

export interface ArchiveFixture {
  name: string
  buffer: Buffer
}

/** 构造与 scripts/backup.mjs 输出结构一致的归档（tar.gz Buffer）。 */
export function buildArchive(options: ArchiveFixtureOptions): ArchiveFixture {
  const stamp = compactIso(options.createdAt)
  const name = options.nameOverride ?? `snapshot-${stamp}-${options.mode}.tar.gz`
  const dbEntry = `backups/db-${stamp}.sqlite`
  const manifest = {
    schema: 1,
    createdAt: options.createdAt,
    mode: options.mode,
    since: options.since ?? null,
    database: dbEntry,
    files: options.contents.map((file) => ({
      id: file.id,
      size: file.data.length,
      createdAt: options.createdAt,
    })),
    fileCount: options.contents.length,
    totalBytes: options.contents.reduce((sum, file) => sum + file.data.length, 0),
    ...options.manifestPatch,
  }
  const entries: TarFixtureEntry[] = []
  if (options.includeDatabase !== false) {
    entries.push({ path: dbEntry, data: buildSnapshotDb(options.workDir, options.snapshotRows) })
  }
  if (options.includeManifest !== false) {
    entries.push({ path: `backups/manifest-${stamp}.json`, data: Buffer.from(JSON.stringify(manifest), 'utf8') })
  }
  for (const file of options.contents) {
    entries.push({ path: `files/${file.id.slice(0, 2)}/${file.id}`, data: file.data })
  }
  entries.push(...(options.extraEntries ?? []))
  return { name, buffer: tarGz(entries) }
}

export interface BackupsFixture {
  dir: string
  config: Config
  db: DatabaseSync
  files: FileService
  service: BackupService
  actor: BackupActor
  importsDir: string
  clock: { now: () => Date; set: (iso: string) => void; advanceMs: (ms: number) => void }
  close: () => void
}

export interface BackupsFixtureOptions {
  config?: Partial<Config>
  /** BackupService 专属配置（如 backupSnapshotMaxRows），不属于 Config。 */
  serviceConfig?: Partial<import('../src/backups/service.ts').BackupServiceConfig>
  runner?: BackupRunner
  clockStart?: string
  /** 测试注入可用空间（字节）；用于 507 磁盘预检用例。 */
  freeBytes?: () => number | null
}

export function backupsFixture(options: BackupsFixtureOptions = {}): BackupsFixture {
  const dir = tempDataDir()
  const config = testConfig(dir, {
    backupRestoreEnabled: true,
    backupImportMaxBytes: 100 * 1024 * 1024,
    backupRestorePlanTtlMinutes: 30,
    backupRestoreMaxEntries: 5000,
    ...options.config,
  })
  const db = testDb(dir)
  const files = new FileService(db, config)
  let current = new Date(options.clockStart ?? '2026-06-01T00:00:00.000Z')
  const clock = {
    now: (): Date => current,
    set: (iso: string): void => {
      current = new Date(iso)
    },
    advanceMs: (ms: number): void => {
      current = new Date(current.getTime() + ms)
    },
  }
  const service = new BackupService(db, { ...config, ...(options.serviceConfig ?? {}) }, {
    files,
    now: clock.now,
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.freeBytes ? { freeBytes: options.freeBytes } : {}),
  })
  return {
    dir,
    config,
    db,
    files,
    service,
    actor: { username: 'admin', ip: '127.0.0.1' },
    importsDir: join(dir, 'backups', 'imports'),
    clock,
    close: () => {
      db.close()
      cleanupDir(dir)
    },
  }
}

export async function importBuffer(fx: BackupsFixture, name: string, buffer: Buffer) {
  return fx.service.importArchive(fx.actor, { filename: name, stream: Readable.from(buffer) })
}

export function buildAndImport(
  fx: BackupsFixture,
  options: Omit<ArchiveFixtureOptions, 'workDir'>,
  verify = true,
) {
  const archive = buildArchive({ ...options, workDir: fx.dir })
  return fx.service
    .importArchive(fx.actor, { filename: archive.name, stream: Readable.from(archive.buffer) })
    .then(async (result) => {
      if (verify) await fx.service.verify(fx.actor, archive.name)
      return { archive, result }
    })
}

export function multipartFileBody(filename: string, data: Buffer): { payload: Buffer; contentType: string } {
  const boundary = `----antifieldcloud-backup-${Math.random().toString(16).slice(2)}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
    'utf8',
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  return { payload: Buffer.concat([head, data, tail]), contentType: `multipart/form-data; boundary=${boundary}` }
}

export interface BackupTestApp {
  app: FastifyInstance
  seeded: SeedResult
  authHeaders: (extra?: Record<string, string>) => Record<string, string>
  totp: () => string
  close: () => Promise<void>
}

/** 带真实 TOTP 用户、Cookie、multipart 与 CSRF 的迷你应用。 */
export async function createBackupApp(fx: BackupsFixture): Promise<BackupTestApp> {
  const seeded = await seedAdmin(fx.db)
  const session: SessionRow = {
    id: 'backup-test-session-row',
    user_id: seeded.userId,
    token_hash: sha256Hex(BACKUP_SESSION),
    csrf_hash: sha256Hex(BACKUP_CSRF),
    created_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2999-01-01T00:00:00.000Z',
    last_seen_at: '2026-01-01T00:00:00.000Z',
    ip: '127.0.0.1',
    user_agent: 'test',
  }
  const app = Fastify({ logger: false, exposeHeadRoutes: true })
  await app.register(cookie)
  await app.register(multipart, {
    limits: { fileSize: fx.config.backupImportMaxBytes, files: 1, fields: 8, parts: 10 },
  })
  app.addHook('onRequest', async (request) => {
    if (request.cookies?.af_session === BACKUP_SESSION) {
      const context: AuthContext = { user: { id: seeded.userId, username: seeded.username }, session }
      request.auth = context
    }
  })
  registerBackupRoutes(app, fx.config, fx.service, fx.db)
  registerErrorHandler(app)
  return {
    app,
    seeded,
    authHeaders: (extra: Record<string, string> = {}) => ({
      cookie: `af_session=${BACKUP_SESSION}`,
      'x-csrf-token': BACKUP_CSRF,
      ...extra,
    }),
    totp: () => currentCode(seeded.secret),
    close: async () => {
      await app.close()
    },
  }
}
