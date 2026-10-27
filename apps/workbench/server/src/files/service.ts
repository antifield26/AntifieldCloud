/**
 * 文件领域服务：目录树、上传落库、配额、搜索、回收站、文本预览。
 *
 * 安全约束：
 * - 客户端只能通过 DB id 访问文件，物理路径由 id 派生。
 * - 文件内容不可变；重命名/移动只改元数据（备份可只带新增内容）。
 * - 配额包含回收站；所有写操作在事务中重新校验。
 * - files.origin 区分可见性：user=普通云盘，note=笔记附件（不在列表/搜索/回收站出现，
 *   只能经笔记接口管理，内容仍走鉴权的 /api/files/:id/content），system=系统保留。
 *   用户可见查询与目录操作只作用于 origin='user' 的行。
 */
import { closeSync, openSync, readdirSync, readSync, statfsSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../config.ts'
import type { FileRow } from '../types.ts'
import { audit } from '../auth/audit.ts'
import { AppError, badRequest, conflict, insufficientStorage, notFound, quotaExceeded, unsupportedMedia } from '../util/errors.ts'
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
/**
 * 目录树最大深度（根目录为 0，根下第一层为 1）。
 * 与面包屑回溯上限、备份快照路径索引上限对齐，避免“可创建但不可浏览/恢复”的深层树。
 */
export const MAX_TREE_DEPTH = 64
/** 物理孤儿文件回收的默认时间阈值：只清理超过 24h 且 DB 无对应行的 files/<xx>/<id>。 */
export const ORPHAN_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** 物理孤儿文件扫描只处理服务端生成的 id 形状，避免误删目录内其它文件。 */
const STORAGE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

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

/** 文件可见性来源，与 files.origin 对应。 */
export type FileOrigin = 'user' | 'note' | 'system'

export interface FileServiceOptions {
  /**
   * 硬删除（回收站彻底删除/笔记附件硬删除）前的分享吊销兜底钩子。
   * 由组合根延迟注入 ShareService（files 与 shares 构造顺序不同），缺省不注入=行为不变。
   */
  revokeSharesForFiles?: (fileIds: string[]) => void
}

export interface DeleteFilesOptions {
  /** 审计动作名，默认 file_delete。 */
  auditAction?: string
  /** 审计详情里附带的额外元数据（不含文件内容/路径）。 */
  detail?: Record<string, unknown>
}

export interface DeleteFilesResult {
  count: number
  freedBytes: number
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

/**
 * 同目录同 origin 唯一索引冲突（并发落库时重算名称并重试）。
 * Node 内置 SQLite 对部分/表达式唯一索引的报错形如
 * `UNIQUE constraint failed: index 'idx_files_unique_active_name'`，
 * 旧版 SQLite 可能报 `UNIQUE constraint failed: files.parent_id, files.name`，两者都要识别。
 */
function isUniqueNameConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return (
    /UNIQUE constraint failed: index 'idx_files_unique_active_name'/.test(error.message) ||
    /UNIQUE constraint failed: files\./.test(error.message)
  )
}

export class FileService {
  private readonly db: DatabaseSync
  private readonly config: Config
  private readonly log: FileServiceLogger | null
  private readonly revokeSharesForFiles: ((fileIds: string[]) => void) | null
  private reservedUploadBytes = 0
  private usageCache: { at: number; usedBytes: number } | null = null
  readonly storage: FileStorage

  constructor(db: DatabaseSync, config: Config, log?: FileServiceLogger, options: FileServiceOptions = {}) {
    this.db = db
    this.config = config
    this.log = log ?? null
    this.revokeSharesForFiles = options.revokeSharesForFiles ?? null
    this.storage = new FileStorage(config.dataDir)
  }

  // ---------- 查询 ----------

  /**
   * 任意 origin 的活动行：仅内容预览/物理读取使用（笔记附件经鉴权内容路由访问）。
   * 用户可见的元数据/目录操作一律走 userActiveRow。
   */
  private activeRow(id: string): FileRow {
    const row = this.db.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as FileRow | undefined
    if (!row) throw notFound('文件不存在')
    return row
  }

  /** 普通云盘活动行；笔记附件/系统行对文件接口视为不存在。 */
  private userActiveRow(id: string): FileRow {
    const row = this.db
      .prepare("SELECT * FROM files WHERE id = ? AND deleted_at IS NULL AND origin = 'user'")
      .get(id) as unknown as FileRow | undefined
    if (!row) throw notFound('文件不存在')
    return row
  }

  private activeDir(id: string | null): FileRow | null {
    if (id === null) return null
    const row = this.db
      .prepare("SELECT * FROM files WHERE id = ? AND deleted_at IS NULL AND origin = 'user'")
      .get(id) as unknown as FileRow | undefined
    if (!row) throw notFound('目标文件夹不存在')
    if (row.kind !== 'dir') throw badRequest('目标不是文件夹', 'not_a_directory')
    return row
  }

  /** 目录绝对深度：根（null）为 0，根下第一层为 1；带环保护。 */
  private directoryDepth(parentId: string | null): number {
    let depth = 0
    let current = parentId
    const seen = new Set<string>()
    while (current) {
      if (seen.has(current) || depth > MAX_TREE_DEPTH) break
      seen.add(current)
      const row = this.db.prepare('SELECT parent_id FROM files WHERE id = ?').get(current) as
        | { parent_id: string | null }
        | undefined
      if (!row) break
      depth += 1
      current = row.parent_id
    }
    return depth
  }

  /** id 子树的最大相对深度（自身为 0）；用于移动时计算整棵子树的新深度。 */
  private subtreeHeight(id: string): number {
    const row = this.db
      .prepare(
        `WITH RECURSIVE tree(id, depth) AS (
           SELECT id, 0 FROM files WHERE id = ?
           UNION ALL
           SELECT f.id, t.depth + 1 FROM files f JOIN tree t ON f.parent_id = t.id
         )
         SELECT MAX(depth) AS h FROM tree`,
      )
      .get(id) as { h: number | null } | undefined
    return Number(row?.h ?? 0)
  }

  /** 校验“父目录下新增 height+1 层”的绝对深度不超过上限。 */
  private assertTreeDepth(parentId: string | null, descendantHeight = 0): void {
    const depth = this.directoryDepth(parentId) + 1 + Math.max(0, descendantHeight)
    if (depth > MAX_TREE_DEPTH) {
      throw badRequest(`目录层级不能超过 ${MAX_TREE_DEPTH} 层`, 'path_too_deep')
    }
  }

  /**
   * 同步写路径的唯一名重试：名称计算与 INSERT/UPDATE 放在同一事务内，
   * 若仍因并发（多连接/未来工作线程）触发 UNIQUE，则重算名称最多 3 次。
   */
  private withUniqueNameRetry<T>(fn: () => T): T {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return fn()
      } catch (error) {
        if (attempt < 2 && isUniqueNameConflict(error)) continue
        throw error
      }
    }
  }

  /** 硬删除前调用分享吊销兜底钩子；钩子失败则中止删除（安全方向：宁可不删，不留可下载的分享）。 */
  private revokeSharesBeforeHardDelete(fileIds: string[]): void {
    if (fileIds.length === 0 || !this.revokeSharesForFiles) return
    try {
      this.revokeSharesForFiles(fileIds)
    } catch (error) {
      this.log?.warn({ err: error, count: fileIds.length }, '硬删除前吊销分享失败，已中止删除')
      throw error
    }
  }

  get(id: string): { item: FileItem; path: Breadcrumb[] } {
    const row = this.userActiveRow(id)
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
      // 只沿普通云盘目录树回溯；附件/系统行不参与用户面包屑。
      if (!row || row.origin !== 'user') break
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
        .prepare("SELECT COUNT(*) AS c FROM files WHERE parent_id IS ? AND deleted_at IS NULL AND origin = 'user'")
        .get(parentId) as { c: number }
    ).c
    const sortColumn = options.sort === 'updated' ? 'updated_at' : options.sort === 'size' ? 'size' : 'name'
    const direction = options.dir === 'desc' ? 'DESC' : 'ASC'
    const order = sortColumn === 'name' ? `kind = 'dir' DESC, name COLLATE NOCASE ${direction}` : `kind = 'dir' DESC, ${sortColumn} ${direction}`
    const rows = this.db
      .prepare(
        `SELECT * FROM files WHERE parent_id IS ? AND deleted_at IS NULL AND origin = 'user'
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
         WHERE deleted_at IS NULL AND kind = 'file' AND origin = 'user' AND name LIKE ? ESCAPE '\\'
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(pattern, limit) as unknown as FileRow[]
    return { items: rows.map(toItem), total: rows.length }
  }

  /**
   * 配额与用量：usedBytes/trashBytes 统计全部 kind='file'（含笔记附件，配额语义不变），
   * fileCount 只统计用户云盘可见文件（origin='user' 且未删除）。
   */
  usage(): Usage {
    const used = this.db
      .prepare("SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE kind = 'file'")
      .get() as { total: number }
    const trash = this.db
      .prepare("SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE kind = 'file' AND deleted_at IS NOT NULL")
      .get() as { total: number }
    const count = this.db
      .prepare("SELECT COUNT(*) AS c FROM files WHERE kind = 'file' AND deleted_at IS NULL AND origin = 'user'")
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

  createFolder(actor: Actor, parentId: string | null, rawName: string, origin: FileOrigin = 'user'): FileItem {
    this.activeDir(parentId)
    this.assertTreeDepth(parentId)
    const name = sanitizeName(rawName)
    if (!name) throw badRequest('文件夹名不能为空', 'invalid_name')
    const now = nowIso()
    const id = newId()
    let finalName = name
    this.withUniqueNameRetry(() => {
      transaction(this.db, () => {
        finalName = this.uniqueName(parentId, name, undefined, origin)
        this.db
          .prepare(
            `INSERT INTO files (id, parent_id, name, kind, size, mime, sha256, storage_key, created_at, updated_at, deleted_at, deleted_parent_id, origin)
             VALUES (?, ?, ?, 'dir', 0, NULL, NULL, NULL, ?, ?, NULL, NULL, ?)`,
          )
          .run(id, parentId, finalName, now, now, origin)
      })
    })
    audit(this.db, actor.username, 'mkdir', finalName, { id, parentId, origin }, actor.ip)
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
   * origin 默认 user；笔记附件传 'note' 且 parentId 必须为 null（不进用户目录树）。
   */
  async registerUpload(
    actor: Actor,
    input: {
      parentId: string | null
      rawName: string
      tempPath: string
      size: number
      sha256: string
      reservedBytes?: number
      origin?: FileOrigin
    },
  ): Promise<FileItem> {
    const origin = input.origin ?? 'user'
    if (origin !== 'user' && input.parentId !== null) {
      throw badRequest('非用户文件必须位于根目录', 'invalid_parent')
    }
    this.activeDir(input.parentId)
    this.assertTreeDepth(input.parentId)
    const name = sanitizeName(input.rawName)
    const id = newId()
    const mime = detectMime(name)
    const now = nowIso()
    // 先把物理文件落盘并 fsync（temp→final 原子 rename + 父目录 fsync），再提交 DB 行；
    // 这样断电最多产生“有文件无行”（可清理的孤儿），不会出现“有行无文件”导致 tar 备份失败。
    try {
      await this.storage.moveIntoPlace(input.tempPath, id)
    } catch (error) {
      this.storage.removeTemp(input.tempPath)
      throw error
    }
    let finalName = name
    try {
      // 落盘 await 期间父目录可能被移入回收站、同名并发上传可能插入新行：
      // 事务内复核父目录并重算唯一名；UNIQUE 冲突最多重试 3 次。
      for (let attempt = 0; ; attempt += 1) {
        try {
          transaction(this.db, () => {
            this.activeDir(input.parentId)
            this.assertTreeDepth(input.parentId)
            this.assertQuota(input.size, input.reservedBytes ?? 0)
            finalName = this.uniqueName(input.parentId, name, undefined, origin)
            this.db
              .prepare(
                `INSERT INTO files (id, parent_id, name, kind, size, mime, sha256, storage_key, created_at, updated_at, deleted_at, deleted_parent_id, origin)
                 VALUES (?, ?, ?, 'file', ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
              )
              .run(id, input.parentId, finalName, input.size, mime, input.sha256, id, now, now, origin)
          })
          break
        } catch (error) {
          if (attempt < 2 && isUniqueNameConflict(error)) continue
          throw error
        }
      }
    } catch (error) {
      // 配额/父目录/DB 失败时回滚物理文件，避免不可见占用磁盘。
      this.storage.remove(id)
      throw error
    }
    if (this.usageCache) this.usageCache = { at: Date.now(), usedBytes: this.usageCache.usedBytes + input.size }
    audit(this.db, actor.username, 'upload', finalName, { id, size: input.size, parentId: input.parentId, origin }, actor.ip)
    const row = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as unknown as FileRow
    return toItem(row)
  }

  rename(actor: Actor, id: string, rawName: string): FileItem {
    const row = this.userActiveRow(id)
    const name = sanitizeName(rawName)
    if (!name) throw badRequest('名称不能为空', 'invalid_name')
    if (name.toLowerCase() === row.name.toLowerCase()) return toItem(row)
    let finalName = name
    this.withUniqueNameRetry(() => {
      transaction(this.db, () => {
        finalName = this.uniqueName(row.parent_id, name, id)
        this.db.prepare('UPDATE files SET name = ?, updated_at = ? WHERE id = ?').run(finalName, nowIso(), id)
      })
    })
    audit(this.db, actor.username, 'rename', finalName, { id, from: row.name }, actor.ip)
    return toItem(this.userActiveRow(id))
  }

  move(actor: Actor, id: string, targetParentId: string | null): FileItem {
    const row = this.userActiveRow(id)
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
    // 移动会连同整棵子树改变绝对深度，必须按“目标深度 + 子树高度”预检。
    this.assertTreeDepth(targetParentId, this.subtreeHeight(id))
    let finalName = row.name
    this.withUniqueNameRetry(() => {
      transaction(this.db, () => {
        finalName = this.uniqueName(targetParentId, row.name, id)
        this.db
          .prepare('UPDATE files SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?')
          .run(targetParentId, finalName, nowIso(), id)
      })
    })
    audit(this.db, actor.username, 'move', finalName, { id, parentId: targetParentId }, actor.ip)
    return toItem(this.userActiveRow(id))
  }

  trash(actor: Actor, id: string): { count: number; item: FileItem } {
    const row = this.userActiveRow(id)
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
          "SELECT COUNT(*) AS c FROM files WHERE deleted_at IS NOT NULL AND deleted_parent_id IS NOT NULL AND origin = 'user'",
        )
        .get() as { c: number }
    ).c
    const rows = this.db
      .prepare(
        `SELECT * FROM files WHERE deleted_at IS NOT NULL AND deleted_parent_id IS NOT NULL AND origin = 'user'
         ORDER BY deleted_at DESC LIMIT ? OFFSET ?`,
      )
      .all(pageSize, (page - 1) * pageSize) as unknown as FileRow[]
    const trash = this.db
      .prepare(
        "SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE kind = 'file' AND deleted_at IS NOT NULL AND origin = 'user'",
      )
      .get() as { total: number }
    // 批量解析原路径：单条递归 CTE 查完所有顶层项祖先，避免 500×64 次同步查询。
    const parentPaths = this.pathNamesForParents(
      rows.map((row) => (row.deleted_parent_id ? row.deleted_parent_id : null)),
    )
    return {
      items: rows.map((row) => this.toTrashItem(row, parentPaths)),
      page,
      pageSize,
      total,
      trashBytes: Number(trash.total),
    }
  }

  /** 批量计算多个父目录的展示路径（'全部文件 / a / b'），返回 parentId → path。 */
  private pathNamesForParents(parentIds: (string | null)[]): Map<string, string> {
    const out = new Map<string, string>()
    const unique = [...new Set(parentIds.filter((id): id is string => Boolean(id)))]
    if (unique.length === 0) return out
    const placeholders = unique.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `WITH RECURSIVE chain(root_id, id, parent_id, name, depth) AS (
           SELECT f.id, f.id, f.parent_id, f.name, 0 FROM files f WHERE f.id IN (${placeholders})
           UNION ALL
           SELECT c.root_id, p.id, p.parent_id, p.name, c.depth + 1
             FROM chain c JOIN files p ON p.id = c.parent_id WHERE c.depth < 64
         )
         SELECT root_id, name, depth FROM chain ORDER BY root_id ASC, depth DESC`,
      )
      .all(...unique) as unknown as { root_id: string; name: string; depth: number }[]
    const grouped = new Map<string, string[]>()
    for (const row of rows) {
      const list = grouped.get(row.root_id) ?? []
      list.push(row.name)
      grouped.set(row.root_id, list)
    }
    for (const [rootId, names] of grouped) out.set(rootId, ['全部文件', ...names].join(' / '))
    return out
  }

  private toTrashItem(row: FileRow, parentPaths?: Map<string, string>): TrashItem {
    const originalParentId = row.deleted_parent_id === '' ? null : row.deleted_parent_id
    const originalPath = parentPaths
      ? (originalParentId ? (parentPaths.get(originalParentId) ?? '全部文件') : '全部文件')
      : this.pathNames(originalParentId)
    return {
      ...toItem(row),
      deletedAt: row.deleted_at ?? nowIso(),
      originalParentId,
      originalPath,
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
      // 与面包屑一致：只回溯普通云盘目录。
      if (!row || row.origin !== 'user') break
      names.push(row.name)
      current = row.parent_id
    }
    return ['全部文件', ...names.reverse()].join(' / ')
  }

  restore(actor: Actor, id: string): FileItem {
    const row = this.db
      .prepare("SELECT * FROM files WHERE id = ? AND deleted_at IS NOT NULL AND origin = 'user'")
      .get(id) as unknown as FileRow | undefined
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
    return toItem(this.userActiveRow(id))
  }

  purge(actor: Actor, id: string): { count: number; freedBytes: number } {
    const row = this.db
      .prepare("SELECT * FROM files WHERE id = ? AND deleted_at IS NOT NULL AND origin = 'user'")
      .get(id) as unknown as FileRow | undefined
    if (!row) throw notFound('回收站中不存在该文件')
    if (row.deleted_parent_id === null) throw badRequest('该条目不是回收站顶层项', 'invalid_purge')
    const keys = this.storageKeysForTree(id)
    let freedBytes = 0
    for (const entry of keys) {
      if (entry.kind === 'file') freedBytes += entry.size
    }
    // 纵深防御：彻底删除前吊销仍在引用这些文件的分享（正常路径已在回收站前吊销）。
    this.revokeSharesBeforeHardDelete(keys.filter((entry) => entry.kind === 'file').map((entry) => entry.id))
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

  private storageKeysForTree(id: string): { id: string; kind: string; size: number; storage_key: string | null; name: string }[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM files WHERE id = ?
           UNION ALL
           SELECT f.id FROM files f JOIN tree t ON f.parent_id = t.id
         )
         SELECT id, kind, size, storage_key, name FROM files WHERE id IN (SELECT id FROM tree)`,
      )
      .all(id) as unknown as { id: string; kind: string; size: number; storage_key: string | null; name: string }[]
    return rows
  }

  emptyTrash(actor: Actor): { count: number; freedBytes: number } {
    const rows = this.db
      .prepare("SELECT id FROM files WHERE deleted_at IS NOT NULL AND deleted_parent_id IS NOT NULL AND origin = 'user'")
      .all() as unknown as { id: string }[]
    let count = 0
    let freedBytes = 0
    for (const row of rows) {
      try {
        const result = this.purge(actor, row.id)
        count += result.count
        freedBytes += result.freedBytes
      } catch (error) {
        // 嵌套回收站/并发清理：条目已被删除（notFound）视为完成，不中断其余条目。
        if (error instanceof AppError && error.statusCode === 404) continue
        this.log?.warn({ err: error, id: row.id }, '清空回收站时删除条目失败')
      }
    }
    return { count, freedBytes }
  }

  autoPurge(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
    const rows = this.db
      .prepare(
        "SELECT id FROM files WHERE deleted_at IS NOT NULL AND deleted_parent_id IS NOT NULL AND origin = 'user' AND deleted_at < ?",
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

  // ---------- 硬删除（笔记附件等不可见文件） ----------

  /**
   * 硬删除文件行（目录递归，级联 note_attachments/share_items/子行），提交后再删物理文件。
   * 物理删除失败只记日志（DB 已不可见），返回释放的字节数与删除条目数。
   * 调用方负责先校验这些 id 属于自己管理的范围（如笔记附件归属）。
   */
  deleteFiles(actor: Actor, ids: string[], options: DeleteFilesOptions = {}): DeleteFilesResult {
    const roots = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))]
    if (roots.length === 0) return { count: 0, freedBytes: 0 }
    // 先收集子树（含 storage_key/size）；根 id 不存在时返回空，由调用方决定是否报错。
    const entries = new Map<string, { kind: string; size: number; storage_key: string | null; name: string }>()
    for (const root of roots) {
      for (const entry of this.storageKeysForTree(root)) {
        entries.set(entry.id, { kind: entry.kind, size: entry.size, storage_key: entry.storage_key, name: entry.name })
      }
    }
    if (entries.size === 0) return { count: 0, freedBytes: 0 }
    const freedBytes = [...entries.values()].reduce((sum, entry) => (entry.kind === 'file' ? sum + Number(entry.size) : sum), 0)
    const target =
      entries.size === 1 ? ([...entries.values()][0]?.name ?? roots[0]!) : `${roots.length} 个文件`
    // 纵深防御：笔记附件/其它硬删除路径也要保证不存在仍引用这些文件的分享。
    this.revokeSharesBeforeHardDelete(
      [...entries.entries()].filter(([, entry]) => entry.kind === 'file').map(([fileId]) => fileId),
    )
    transaction(this.db, () => {
      for (const root of roots) this.db.prepare('DELETE FROM files WHERE id = ?').run(root)
    })
    const failures: { id: string; error: string }[] = []
    for (const [id, entry] of entries) {
      if (entry.kind !== 'file' || !entry.storage_key) continue
      const error = this.storage.remove(entry.storage_key)
      if (error) failures.push({ id, error: error.message })
    }
    if (failures.length > 0) this.log?.warn({ failures, freedBytes }, '物理文件删除失败，需人工清理')
    if (this.usageCache) this.usageCache = { at: Date.now(), usedBytes: Math.max(0, this.usageCache.usedBytes - freedBytes) }
    audit(this.db, actor.username, options.auditAction ?? 'file_delete', target, {
      count: entries.size,
      freedBytes,
      ...(options.detail ?? {}),
    }, actor.ip)
    return { count: entries.size, freedBytes }
  }

  /**
   * 回收物理孤儿文件：`DATA_DIR/files/<xx>/<id>` 中 DB 无对应行且 mtime 超过 maxAge 的普通文件。
   * 仅处理服务端 id 形状的条目、只删文件不删目录；返回删除数量。用于断电/删除失败后的对账清理。
   */
  cleanupOrphanFiles(maxAgeMs = ORPHAN_FILE_MAX_AGE_MS): number {
    const cutoff = Date.now() - Math.max(0, maxAgeMs)
    const candidates: { id: string; path: string }[] = []
    let shards: string[]
    try {
      shards = readdirSync(this.storage.filesDir)
    } catch {
      return 0
    }
    for (const shard of shards) {
      if (!/^[A-Za-z0-9_-]{2}$/.test(shard)) continue
      let entries
      try {
        entries = readdirSync(join(this.storage.filesDir, shard), { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile() || !STORAGE_ID_PATTERN.test(entry.name)) continue
        const path = join(this.storage.filesDir, shard, entry.name)
        try {
          if (statSync(path).mtimeMs >= cutoff) continue
        } catch {
          continue
        }
        candidates.push({ id: entry.name, path })
      }
    }
    if (candidates.length === 0) return 0
    // 批量查 DB 现存 id，避免每个物理文件一次同步查询。
    const listed = new Set<string>()
    for (let offset = 0; offset < candidates.length; offset += 500) {
      const batch = candidates.slice(offset, offset + 500)
      const placeholders = batch.map(() => '?').join(', ')
      const rows = this.db
        .prepare(`SELECT id FROM files WHERE id IN (${placeholders})`)
        .all(...batch.map((item) => item.id)) as unknown as { id: string }[]
      for (const row of rows) listed.add(row.id)
    }
    let removed = 0
    let failed = 0
    for (const candidate of candidates) {
      if (listed.has(candidate.id)) continue
      try {
        unlinkSync(candidate.path)
        removed += 1
      } catch {
        failed += 1
      }
    }
    if (failed > 0) this.log?.warn({ failed, removed }, '物理孤儿文件清理失败')
    return removed
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

  /** 同父目录、同 origin 下名称唯一（大小写不敏感）；不同 origin 可同名。 */
  private uniqueName(parentId: string | null, desired: string, excludeId?: string, origin: FileOrigin = 'user'): string {
    const rows = this.db
      .prepare('SELECT id, name FROM files WHERE parent_id IS ? AND deleted_at IS NULL AND origin = ?')
      .all(parentId, origin) as unknown as { id: string; name: string }[]
    const used = new Set(rows.filter((row) => row.id !== excludeId).map((row) => row.name.toLowerCase()))
    if (!used.has(desired.toLowerCase())) return desired
    for (let index = 2; index < 10_000; index += 1) {
      const candidate = withSuffix(desired, index)
      if (!used.has(candidate.toLowerCase())) return candidate
    }
    throw conflict('同名文件过多', 'name_exhausted')
  }
}
