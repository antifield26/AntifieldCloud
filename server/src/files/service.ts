/**
 * 文件领域服务：目录树、上传落库、配额、搜索、回收站、文本预览。
 *
 * 安全约束：
 * - 客户端只能通过 DB id 访问文件，物理路径由 id 派生。
 * - 文件内容不可变；重命名/移动只改元数据（备份可只带新增内容）。
 * - 配额包含回收站；所有写操作在事务中重新校验。
 */
import { closeSync, openSync, readSync, statfsSync, unlinkSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../config.ts'
import type { FileRow } from '../types.ts'
import { audit } from '../auth/audit.ts'
import { badRequest, conflict, insufficientStorage, notFound, quotaExceeded, unsupportedMedia } from '../util/errors.ts'
import { newId } from '../util/ids.ts'
import { nowIso } from '../util/time.ts'
import { transaction } from '../db.ts'
import { canInline, detectMime, previewKindFor, sanitizeName, withSuffix, type PreviewKind } from './mime.ts'
import { FileStorage } from './storage.ts'

/** 可选日志接口，便于 purge/autoPurge 记录物理删除失败而不依赖 Fastify。 */
export interface FileServiceLogger {
  warn(obj: Record<string, unknown>, message: string): void
}

/** 上传前要求保留的最小磁盘余量，避免写满根分区导致 DB/备份一起失败。 */
const MIN_FREE_DISK_BYTES = 1024 * 1024 * 1024
/** 配额占用缓存的刷新间隔（用于流式上传预留，事务内仍以 DB 为准）。 */
const RESERVATION_CACHE_MS = 500

export interface FileItem {
  id: string
  parentId: string | null
  name: string
  kind: 'file' | 'dir'
  size: number
  mime: string | null
  sha256: string | null
  createdAt: string
  updatedAt: string
  previewKind: PreviewKind
  inlineAllowed: boolean
}

export interface TrashItem extends FileItem {
  deletedAt: string
  originalParentId: string | null
  originalPath: string
}

export interface Breadcrumb {
  id: string | null
  name: string
}

export interface Actor {
  username: string
  ip: string | null
}

export interface ListOptions {
  parentId: string | null
  page: number
  pageSize: number
  sort: 'name' | 'updated' | 'size'
  dir: 'asc' | 'desc'
}

export interface ListResult {
  items: FileItem[]
  page: number
  pageSize: number
  total: number
  breadcrumb: Breadcrumb[]
}

export interface Usage {
  usedBytes: number
  trashBytes: number
  fileCount: number
  quotaBytes: number
  freeBytes: number
}

export interface TextPreview {
  name: string
  mime: string
  size: number
  truncated: boolean
  content: string
}

function toItem(row: FileRow): FileItem {
  const previewKind = row.kind === 'dir' ? 'none' : previewKindFor(row.name, row.mime ?? '')
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    kind: row.kind,
    size: row.size,
    mime: row.mime,
    sha256: row.sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    previewKind,
    inlineAllowed: row.kind === 'file' && canInline(previewKind),
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

export class FileService {
  private readonly db: DatabaseSync
  private readonly config: Config
  private readonly log: FileServiceLogger | null
  private reservedUploadBytes = 0
  private usageCache: { at: number; usedBytes: number } | null = null
  readonly storage: FileStorage

  constructor(db: DatabaseSync, config: Config, log?: FileServiceLogger) {
    this.db = db
    this.config = config
    this.log = log ?? null
    this.storage = new FileStorage(config.dataDir)
  }

  // ---------- 查询 ----------

  private activeRow(id: string): FileRow {
    const row = this.db.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as FileRow | undefined
    if (!row) throw notFound('文件不存在')
    return row
  }

  private activeDir(id: string | null): FileRow | null {
    if (id === null) return null
    const row = this.db.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as FileRow | undefined
    if (!row) throw notFound('目标文件夹不存在')
    if (row.kind !== 'dir') throw badRequest('目标不是文件夹', 'not_a_directory')
    return row
  }

  get(id: string): { item: FileItem; path: Breadcrumb[] } {
    const row = this.activeRow(id)
    return { item: toItem(row), path: this.breadcrumbFor(row.parent_id) }
  }

  breadcrumbFor(parentId: string | null): Breadcrumb[] {
    const chain: Breadcrumb[] = []
    let current = parentId
    const seen = new Set<string>()
    for (let depth = 0; current && depth < 64; depth += 1) {
      if (seen.has(current)) break
      seen.add(current)
      const row = this.db.prepare('SELECT * FROM files WHERE id = ?').get(current) as unknown as FileRow | undefined
      if (!row) break
      chain.push({ id: row.id, name: row.name })
      current = row.parent_id
    }
    return [{ id: null, name: '全部文件' }, ...chain.reverse()]
  }

  list(options: ListOptions): ListResult {
    const parentId = options.parentId
    if (parentId) this.activeDir(parentId)
    const page = Math.max(1, Math.floor(options.page))
    const pageSize = Math.min(500, Math.max(1, Math.floor(options.pageSize)))
    const total = (
      this.db
        .prepare('SELECT COUNT(*) AS c FROM files WHERE parent_id IS ? AND deleted_at IS NULL')
        .get(parentId) as { c: number }
    ).c
    const sortColumn = options.sort === 'updated' ? 'updated_at' : options.sort === 'size' ? 'size' : 'name'
    const direction = options.dir === 'desc' ? 'DESC' : 'ASC'
    const order = sortColumn === 'name' ? `kind = 'dir' DESC, name COLLATE NOCASE ${direction}` : `kind = 'dir' DESC, ${sortColumn} ${direction}`
    const rows = this.db
      .prepare(
        `SELECT * FROM files WHERE parent_id IS ? AND deleted_at IS NULL
         ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(parentId, pageSize, (page - 1) * pageSize) as unknown as FileRow[]
    return {
      items: rows.map(toItem),
      page,
      pageSize,
      total,
      breadcrumb: this.breadcrumbFor(parentId),
    }
  }

  search(query: string, limit = 100): { items: FileItem[]; total: number } {
    const q = query.trim()
    if (!q) return { items: [], total: 0 }
    const pattern = `%${escapeLike(q)}%`
    const rows = this.db
      .prepare(
        `SELECT * FROM files
         WHERE deleted_at IS NULL AND kind = 'file' AND name LIKE ? ESCAPE '\\'
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(pattern, limit) as unknown as FileRow[]
    return { items: rows.map(toItem), total: rows.length }
  }

  usage(): Usage {
    const used = this.db
      .prepare("SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE kind = 'file'")
      .get() as { total: number }
    const trash = this.db
      .prepare("SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE kind = 'file' AND deleted_at IS NOT NULL")
      .get() as { total: number }
    const count = this.db
      .prepare("SELECT COUNT(*) AS c FROM files WHERE kind = 'file' AND deleted_at IS NULL")
      .get() as { c: number }
    let freeBytes: number
    try {
      const stats = statfsSync(this.config.dataDir)
      freeBytes = Number(stats.bavail) * Number(stats.bsize)
    } catch {
      freeBytes = 0
    }
    return {
      usedBytes: Number(used.total),
      trashBytes: Number(trash.total),
      fileCount: count.c,
      quotaBytes: this.config.quotaBytes,
      freeBytes,
    }
  }

  // ---------- 上传预留与磁盘检查 ----------

  /** 读取（带短缓存）当前配额占用，供热路径上的流式预留使用。 */
  private usedBytesForReservation(): number {
    const now = Date.now()
    if (this.usageCache && now - this.usageCache.at < RESERVATION_CACHE_MS) return this.usageCache.usedBytes
    const row = this.db
      .prepare("SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE kind = 'file'")
      .get() as { total: number }
    this.usageCache = { at: now, usedBytes: Number(row.total) }
    return this.usageCache.usedBytes
  }

  /**
   * 上传流式预留：所有进行中的上传字节都计入配额，避免并发请求各自通过
   * 检查而把配额/磁盘临时打满。超限抛 409 quota_exceeded。
   */
  reserveUploadBytes(bytes: number): void {
    if (bytes <= 0) return
    const used = this.usedBytesForReservation()
    const remaining = this.config.quotaBytes - used - this.reservedUploadBytes
    if (bytes > remaining) throw quotaExceeded(Math.max(0, remaining))
    this.reservedUploadBytes += bytes
  }

  releaseUploadBytes(bytes: number): void {
    if (bytes <= 0) return
    this.reservedUploadBytes = Math.max(0, this.reservedUploadBytes - bytes)
  }

  /** 上传前检查剩余磁盘空间（至少保留 MIN_FREE_DISK_BYTES），不足抛 507。 */
  ensureFreeDiskSpace(): void {
    if (this.usage().freeBytes < MIN_FREE_DISK_BYTES) throw insufficientStorage()
  }

  // ---------- 变更 ----------

  createFolder(actor: Actor, parentId: string | null, rawName: string): FileItem {
    this.activeDir(parentId)
    const name = sanitizeName(rawName)
    if (!name) throw badRequest('文件夹名不能为空', 'invalid_name')
    const now = nowIso()
    const id = newId()
    const finalName = this.uniqueName(parentId, name)
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO files (id, parent_id, name, kind, size, mime, sha256, storage_key, created_at, updated_at, deleted_at, deleted_parent_id)
           VALUES (?, ?, ?, 'dir', 0, NULL, NULL, NULL, ?, ?, NULL, NULL)`,
        )
        .run(id, parentId, finalName, now, now)
    })
    audit(this.db, actor.username, 'mkdir', finalName, { id, parentId }, actor.ip)
    const row = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as unknown as FileRow
    return toItem(row)
  }

  /**
   * 事务内配额校验：DB 已用 + 其它进行中上传的预留 + 本次新增。
   * ownReservedBytes 是当前请求已预留的字节（避免重复计算）。
   */
  assertQuota(additionalBytes: number, ownReservedBytes = 0): void {
    const used = this.db
      .prepare("SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE kind = 'file'")
      .get() as { total: number }
    const reservedOthers = Math.max(0, this.reservedUploadBytes - Math.max(0, ownReservedBytes))
    const remaining = this.config.quotaBytes - Number(used.total) - reservedOthers
    if (additionalBytes > remaining) throw quotaExceeded(Math.max(0, remaining))
  }

  /**
   * 上传落库：tempPath 已完整写入并计算 sha256。
   * 事务内重新校验配额；物理文件 rename 失败则回滚 DB 行。
   */
  async registerUpload(
    actor: Actor,
    input: { parentId: string | null; rawName: string; tempPath: string; size: number; sha256: string; reservedBytes?: number },
  ): Promise<FileItem> {
    this.activeDir(input.parentId)
    const name = sanitizeName(input.rawName)
    const id = newId()
    const mime = detectMime(name)
    const now = nowIso()
    const finalName = this.uniqueName(input.parentId, name)
    transaction(this.db, () => {
      this.assertQuota(input.size, input.reservedBytes ?? 0)
      this.db
        .prepare(
          `INSERT INTO files (id, parent_id, name, kind, size, mime, sha256, storage_key, created_at, updated_at, deleted_at, deleted_parent_id)
           VALUES (?, ?, ?, 'file', ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(id, input.parentId, finalName, input.size, mime, input.sha256, id, now, now)
    })
    try {
      await this.storage.moveIntoPlace(input.tempPath, id)
    } catch (error) {
      this.db.prepare('DELETE FROM files WHERE id = ?').run(id)
      this.storage.removeTemp(input.tempPath)
      throw error
    }
    if (this.usageCache) this.usageCache = { at: Date.now(), usedBytes: this.usageCache.usedBytes + input.size }
    audit(this.db, actor.username, 'upload', finalName, { id, size: input.size, parentId: input.parentId }, actor.ip)
    const row = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as unknown as FileRow
    return toItem(row)
  }

  rename(actor: Actor, id: string, rawName: string): FileItem {
    const row = this.activeRow(id)
    const name = sanitizeName(rawName)
    if (!name) throw badRequest('名称不能为空', 'invalid_name')
    if (name.toLowerCase() === row.name.toLowerCase()) return toItem(row)
    const finalName = this.uniqueName(row.parent_id, name, id)
    this.db.prepare('UPDATE files SET name = ?, updated_at = ? WHERE id = ?').run(finalName, nowIso(), id)
    audit(this.db, actor.username, 'rename', finalName, { id, from: row.name }, actor.ip)
    return toItem(this.activeRow(id))
  }

  move(actor: Actor, id: string, targetParentId: string | null): FileItem {
    const row = this.activeRow(id)
    this.activeDir(targetParentId)
    if (targetParentId === id) throw conflict('不能移动到自身', 'cycle_detected')
    let cursor = targetParentId
    const seen = new Set<string>()
    while (cursor) {
      if (cursor === id) throw conflict('不能移动到自己的子目录', 'cycle_detected')
      if (seen.has(cursor)) break
      seen.add(cursor)
      const parent = this.db.prepare('SELECT * FROM files WHERE id = ?').get(cursor) as unknown as FileRow | undefined
      cursor = parent?.parent_id ?? null
    }
    const finalName = this.uniqueName(targetParentId, row.name, id)
    this.db
      .prepare('UPDATE files SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?')
      .run(targetParentId, finalName, nowIso(), id)
    audit(this.db, actor.username, 'move', finalName, { id, parentId: targetParentId }, actor.ip)
    return toItem(this.activeRow(id))
  }

  trash(actor: Actor, id: string): { count: number; item: FileItem } {
    const row = this.activeRow(id)
    const now = nowIso()
    let changes = 0
    transaction(this.db, () => {
      const result = this.db
        .prepare(
          `WITH RECURSIVE tree(id) AS (
             SELECT id FROM files WHERE id = ? AND deleted_at IS NULL
             UNION ALL
             SELECT f.id FROM files f JOIN tree t ON f.parent_id = t.id WHERE f.deleted_at IS NULL
           )
           UPDATE files
           SET deleted_at = ?,
               deleted_parent_id = CASE WHEN id = ? THEN COALESCE(parent_id, '') ELSE deleted_parent_id END
           WHERE id IN (SELECT id FROM tree)`,
        )
        .run(id, now, id)
      changes = Number(result.changes)
    })
    if (changes === 0) throw notFound('文件不存在')
    audit(this.db, actor.username, 'trash', row.name, { id, count: changes }, actor.ip)
    return { count: changes, item: toItem(this.activeRowForDeleted(id)) }
  }

  private activeRowForDeleted(id: string): FileRow {
    const row = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as unknown as FileRow | undefined
    if (!row) throw notFound('文件不存在')
    return row
  }

  listTrash(options: { page: number; pageSize: number }): {
    items: TrashItem[]
    page: number
    pageSize: number
    total: number
    trashBytes: number
  } {
    const page = Math.max(1, Math.floor(options.page))
    const pageSize = Math.min(500, Math.max(1, Math.floor(options.pageSize)))
    const total = (
      this.db
        .prepare(
          'SELECT COUNT(*) AS c FROM files WHERE deleted_at IS NOT NULL AND deleted_parent_id IS NOT NULL',
        )
        .get() as { c: number }
    ).c
    const rows = this.db
      .prepare(
        `SELECT * FROM files WHERE deleted_at IS NOT NULL AND deleted_parent_id IS NOT NULL
         ORDER BY deleted_at DESC LIMIT ? OFFSET ?`,
      )
      .all(pageSize, (page - 1) * pageSize) as unknown as FileRow[]
    const trash = this.db
      .prepare("SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE kind = 'file' AND deleted_at IS NOT NULL")
      .get() as { total: number }
    return {
      items: rows.map((row) => this.toTrashItem(row)),
      page,
      pageSize,
      total,
      trashBytes: Number(trash.total),
    }
  }

  private toTrashItem(row: FileRow): TrashItem {
    const originalParentId = row.deleted_parent_id === '' ? null : row.deleted_parent_id
    return {
      ...toItem(row),
      deletedAt: row.deleted_at ?? nowIso(),
      originalParentId,
      originalPath: this.pathNames(originalParentId),
    }
  }

  private pathNames(parentId: string | null): string {
    const names: string[] = []
    let current = parentId
    const seen = new Set<string>()
    for (let depth = 0; current && depth < 64; depth += 1) {
      if (seen.has(current)) break
      seen.add(current)
      const row = this.db.prepare('SELECT * FROM files WHERE id = ?').get(current) as unknown as FileRow | undefined
      if (!row) break
      names.push(row.name)
      current = row.parent_id
    }
    return ['全部文件', ...names.reverse()].join(' / ')
  }

  restore(actor: Actor, id: string): FileItem {
    const row = this.db.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NOT NULL').get(id) as unknown as FileRow | undefined
    if (!row) throw notFound('回收站中不存在该文件')
    if (row.deleted_parent_id === null) throw badRequest('该条目不是回收站顶层项', 'invalid_restore')
    const originalParentId = row.deleted_parent_id === '' ? null : row.deleted_parent_id
    let targetParentId: string | null = null
    if (originalParentId) {
      const parent = this.db
        .prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL')
        .get(originalParentId) as unknown as FileRow | undefined
      targetParentId = parent?.kind === 'dir' ? parent.id : null
    }
    const finalName = this.uniqueName(targetParentId, row.name, id)
    transaction(this.db, () => {
      this.db
        .prepare(
          `WITH RECURSIVE tree(id) AS (
             SELECT id FROM files WHERE id = ? AND deleted_at IS NOT NULL
             UNION ALL
             SELECT f.id FROM files f JOIN tree t ON f.parent_id = t.id WHERE f.deleted_at IS NOT NULL
           )
           UPDATE files SET deleted_at = NULL, deleted_parent_id = NULL WHERE id IN (SELECT id FROM tree)`,
        )
        .run(id)
      this.db
        .prepare('UPDATE files SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?')
        .run(targetParentId, finalName, nowIso(), id)
    })
    audit(this.db, actor.username, 'restore', finalName, { id, parentId: targetParentId }, actor.ip)
    return toItem(this.activeRow(id))
  }

  purge(actor: Actor, id: string): { count: number; freedBytes: number } {
    const row = this.db.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NOT NULL').get(id) as unknown as FileRow | undefined
    if (!row) throw notFound('回收站中不存在该文件')
    if (row.deleted_parent_id === null) throw badRequest('该条目不是回收站顶层项', 'invalid_purge')
    const keys = this.storageKeysForTree(id)
    let freedBytes = 0
    for (const entry of keys) {
      if (entry.kind === 'file') freedBytes += entry.size
    }
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM files WHERE id = ?').run(id)
    })
    const failures: { id: string; error: string }[] = []
    for (const entry of keys) {
      if (entry.kind === 'file' && entry.storage_key) {
        const error = this.storage.remove(entry.storage_key)
        if (error) failures.push({ id: entry.storage_key, error: error.message })
      }
    }
    // 物理删除失败不改变 DB 结果（文件已不可见），但必须留日志便于人工清理。
    if (failures.length > 0) this.log?.warn({ failures, freedBytes }, '回收站物理文件删除失败，需人工清理')
    if (this.usageCache) this.usageCache = { at: Date.now(), usedBytes: Math.max(0, this.usageCache.usedBytes - freedBytes) }
    audit(this.db, actor.username, 'purge', row.name, { id, freedBytes }, actor.ip)
    return { count: keys.length, freedBytes }
  }

  private storageKeysForTree(id: string): { id: string; kind: string; size: number; storage_key: string | null }[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM files WHERE id = ?
           UNION ALL
           SELECT f.id FROM files f JOIN tree t ON f.parent_id = t.id
         )
         SELECT id, kind, size, storage_key FROM files WHERE id IN (SELECT id FROM tree)`,
      )
      .all(id) as unknown as { id: string; kind: string; size: number; storage_key: string | null }[]
    return rows
  }

  emptyTrash(actor: Actor): { count: number; freedBytes: number } {
    const rows = this.db
      .prepare("SELECT id FROM files WHERE deleted_at IS NOT NULL AND deleted_parent_id IS NOT NULL")
      .all() as unknown as { id: string }[]
    let count = 0
    let freedBytes = 0
    for (const row of rows) {
      const result = this.purge(actor, row.id)
      count += result.count
      freedBytes += result.freedBytes
    }
    return { count, freedBytes }
  }

  autoPurge(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
    const rows = this.db
      .prepare(
        "SELECT id FROM files WHERE deleted_at IS NOT NULL AND deleted_parent_id IS NOT NULL AND deleted_at < ?",
      )
      .all(cutoff) as unknown as { id: string }[]
    let count = 0
    for (const row of rows) {
      try {
        count += this.purge({ username: 'system', ip: null }, row.id).count
      } catch (error) {
        this.log?.warn({ err: error, id: row.id }, '回收站自动清理失败')
      }
    }
    return count
  }

  // ---------- 内容 ----------

  contentInfo(id: string): FileRow {
    const row = this.activeRow(id)
    if (row.kind !== 'file') throw badRequest('目录没有内容', 'not_a_file')
    return row
  }

  readText(id: string, limitBytes: number): TextPreview {
    const row = this.contentInfo(id)
    const previewKind = previewKindFor(row.name, row.mime ?? '')
    if (previewKind !== 'text' && previewKind !== 'markdown') throw unsupportedMedia('该文件不支持文本预览')
    const max = Math.max(1, limitBytes)
    const buffer = Buffer.alloc(max + 1)
    const fd = openSync(this.storage.finalPath(row.id), 'r')
    let bytesRead: number
    try {
      bytesRead = readSync(fd, buffer, 0, max + 1, 0)
    } finally {
      closeSync(fd)
    }
    const truncated = bytesRead > max
    const slice = buffer.subarray(0, Math.min(bytesRead, max))
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(slice)
    } catch {
      text = new TextDecoder('utf-8').decode(slice).replace(/\uFFFD+$/, '')
    }
    return { name: row.name, mime: row.mime ?? 'text/plain', size: row.size, truncated, content: text }
  }

  /** 删除物理文件（仅恢复/清理测试使用）。 */
  removePhysical(id: string): void {
    try {
      unlinkSync(this.storage.finalPath(id))
    } catch {
      // 忽略。
    }
  }

  // ---------- 内部 ----------

  private uniqueName(parentId: string | null, desired: string, excludeId?: string): string {
    const rows = this.db
      .prepare('SELECT id, name FROM files WHERE parent_id IS ? AND deleted_at IS NULL')
      .all(parentId) as unknown as { id: string; name: string }[]
    const used = new Set(rows.filter((row) => row.id !== excludeId).map((row) => row.name.toLowerCase()))
    if (!used.has(desired.toLowerCase())) return desired
    for (let index = 2; index < 10_000; index += 1) {
      const candidate = withSuffix(desired, index)
      if (!used.has(candidate.toLowerCase())) return candidate
    }
    throw conflict('同名文件过多', 'name_exhausted')
  }
}
