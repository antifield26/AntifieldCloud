/**
 * 笔记与书签领域服务：CRUD、标签、置顶、FTS5 全文搜索、分页、附件与版本历史。
 *
 * 安全边界：
 * - 标题/正文/标签/描述只做长度与类型校验，原样入库；转义由前端负责（API 只输出 JSON）。
 * - 书签 URL 只允许 http/https，拒绝 `javascript:`、`data:` 等可执行协议。
 * - FTS5 查询只把提取出的字母/数字/汉字词元包成短语后参数化传入 MATCH；
 *   MATCH 语法异常或查询含中文（unicode61 分词对中文按整段成词）时回退 LIKE。
 * - 标签数量/长度受限，标签名大小写不敏感复用（tags.name 为 COLLATE NOCASE）。
 * - 附件经 FileService 以 origin='note' 落库并计入总配额：不出现在普通文件列表/搜索/回收站，
 *   只能通过笔记接口管理；删除笔记时硬删除附件行与物理文件。内容访问走鉴权的文件内容路由。
 * - 版本快照在标题/正文/标签变化时写入；恢复版本前先快照当前内容，跨笔记的 versionId 一律 404。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../config.ts'
import type { Actor, FileService } from '../files/service.ts'
import { audit } from '../auth/audit.ts'
import { transaction } from '../db.ts'
import { AppError, badRequest, notFound, tooLarge } from '../util/errors.ts'
import { newId } from '../util/ids.ts'
import { nowIso } from '../util/time.ts'

export const MAX_TITLE_LENGTH = 200
export const MAX_BODY_BYTES = 200 * 1024
export const MAX_TAGS_PER_ITEM = 20
export const MAX_TAG_LENGTH = 32
export const MAX_BOOKMARK_URL_LENGTH = 2048
export const MAX_DESCRIPTION_LENGTH = 2000
export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100
/** 单次笔记附件上传的文件数上限（与 docs/API.md §13 一致）。 */
export const MAX_ATTACHMENTS_PER_REQUEST = 5
/** 版本列表分页上限。 */
export const MAX_VERSION_PAGE_SIZE = 100

type SqlParam = string | number | bigint | null | Uint8Array

interface Condition {
  sql: string[]
  params: SqlParam[]
}

interface NoteRow {
  id: string
  title: string
  body_md: string
  pinned: number
  created_at: string
  updated_at: string
}

interface BookmarkRow {
  id: string
  url: string
  title: string
  description: string
  pinned: number
  created_at: string
  updated_at: string
}

export interface NoteItem {
  id: string
  title: string
  bodyMd: string
  tags: string[]
  pinned: boolean
  createdAt: string
  updatedAt: string
  /** 附件元数据（不含物理路径）；内容通过 url 走鉴权文件路由。 */
  attachments: NoteAttachmentItem[]
}

/** 笔记附件：fileId 即 /api/files/:id/content 的 id。 */
export interface NoteAttachmentItem {
  fileId: string
  name: string
  size: number
  mime: string | null
  url: string
}

/** 服务层接收的已完成落盘临时文件（由路由流式计算大小/SHA 后传入）。 */
export interface NoteAttachmentUpload {
  rawName: string
  tempPath: string
  size: number
  sha256: string
  /** 当前请求已为该文件预留的配额字节。 */
  reservedBytes?: number
}

export interface NoteVersionSummary {
  id: string
  title: string
  createdAt: string
}

export interface NoteVersionItem extends NoteVersionSummary {
  noteId: string
  bodyMd: string
  tags: string[]
}

export interface NoteServiceOptions {
  /** 附件依赖；未注入时附件接口返回 500（笔记 CRUD 仍可用）。 */
  files?: FileService
  config?: Config
  log?: { warn(obj: Record<string, unknown>, message: string): void }
}

export interface BookmarkItem {
  id: string
  url: string
  title: string
  description: string
  tags: string[]
  pinned: boolean
  createdAt: string
  updatedAt: string
}

export interface TagCount {
  name: string
  count: number
}

export interface ListQuery {
  q?: string | null
  tag?: string | null
  pinned?: boolean | null
  page?: number
  pageSize?: number
}

export interface ListResult<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
}

export interface CreateNoteInput {
  title?: unknown
  bodyMd?: unknown
  pinned?: unknown
  tags?: unknown
}

export type UpdateNoteInput = CreateNoteInput

export interface CreateBookmarkInput {
  url?: unknown
  title?: unknown
  description?: unknown
  pinned?: unknown
  tags?: unknown
}

export type UpdateBookmarkInput = CreateBookmarkInput

// ---------- 校验与归一化 ----------

function clampText(value: unknown, field: string, maxLength: number, allowEmpty: boolean): string {
  if (typeof value !== 'string') throw badRequest(`字段 ${field} 必须是字符串`, 'invalid_request')
  if (value.length > maxLength) throw badRequest(`字段 ${field} 不能超过 ${maxLength} 个字符`, 'invalid_request')
  if (!allowEmpty && value.trim().length === 0) throw badRequest(`字段 ${field} 不能为空`, 'invalid_request')
  return value
}

function parsePinned(value: unknown): boolean {
  if (value === undefined) return false
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1' || value === 'true') return true
  if (value === 0 || value === '0' || value === 'false') return false
  throw badRequest('字段 pinned 必须是布尔值', 'invalid_request')
}

export function parseOptionalPinned(value: unknown): boolean | null {
  if (value === undefined || value === null || value === '') return null
  if (value === 'all') return null
  return parsePinned(value)
}

function validateBody(bodyMd: unknown): string {
  const value = bodyMd === undefined || bodyMd === null ? '' : bodyMd
  if (typeof value !== 'string') throw badRequest('字段 bodyMd 必须是字符串', 'invalid_request')
  if (Buffer.byteLength(value, 'utf8') > MAX_BODY_BYTES) {
    throw badRequest(`正文不能超过 ${Math.floor(MAX_BODY_BYTES / 1024)} KB`, 'note_too_large')
  }
  return value
}

/** 归一化标签数组：NFC、去控制字符、去空白项、大小写去重、数量/长度限制。 */
export function normalizeTags(input: unknown): string[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw badRequest('字段 tags 必须是字符串数组', 'invalid_tags')
  const seen = new Set<string>()
  const tags: string[] = []
  for (const raw of input) {
    if (typeof raw !== 'string') throw badRequest('标签必须是字符串', 'invalid_tags')
    // eslint-disable-next-line no-control-regex
    const tag = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim()
    if (!tag) continue
    if (tag.length > MAX_TAG_LENGTH) {
      throw badRequest(`单个标签不能超过 ${MAX_TAG_LENGTH} 个字符`, 'invalid_tags')
    }
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
  }
  if (tags.length > MAX_TAGS_PER_ITEM) throw badRequest(`标签最多 ${MAX_TAGS_PER_ITEM} 个`, 'invalid_tags')
  return tags
}

/** 标签过滤参数：单个标签名。 */
function normalizeTagFilter(input: unknown): string | null {
  if (input === undefined || input === null) return null
  if (typeof input !== 'string') throw badRequest('字段 tag 必须是字符串', 'invalid_request')
  // eslint-disable-next-line no-control-regex
  const tag = input.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!tag) return null
  if (tag.length > MAX_TAG_LENGTH) throw badRequest('标签参数过长', 'invalid_request')
  return tag
}

/** 书签 URL：仅 http/https，长度受限；拒绝可执行/数据协议。 */
export function validateBookmarkUrl(input: unknown): string {
  const value = clampText(input, 'url', MAX_BOOKMARK_URL_LENGTH, false).trim()
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw badRequest('URL 格式不合法', 'invalid_url')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest('仅支持 http/https 链接', 'invalid_url')
  }
  if (!parsed.hostname) throw badRequest('URL 缺少主机名', 'invalid_url')
  return value
}

function normalizePage(
  page: number | undefined,
  pageSize: number | undefined,
): { page: number; pageSize: number; offset: number } {
  const safePage = Number.isInteger(page) && (page as number) >= 1 ? (page as number) : 1
  const size =
    Number.isInteger(pageSize) && (pageSize as number) >= 1
      ? Math.min(MAX_PAGE_SIZE, pageSize as number)
      : DEFAULT_PAGE_SIZE
  return { page: safePage, pageSize: size, offset: (safePage - 1) * size }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

const WIDE_CHARS = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

/** 把用户输入提取为 FTS5 短语词元；无有效词元返回 null。 */
export function ftsExpression(query: string): string | null {
  const tokens = query.normalize('NFC').match(/[\p{L}\p{N}]+/gu)
  if (!tokens || tokens.length === 0) return null
  const unique = [...new Set(tokens)].slice(0, 8)
  return unique.map((token) => `"${token}"*`).join(' ')
}

// ---------- 标签存取 ----------

function resolveTagIds(db: DatabaseSync, tags: string[]): number[] {
  if (tags.length === 0) return []
  const select = db.prepare('SELECT id FROM tags WHERE name = ?')
  const insert = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)')
  const ids: number[] = []
  for (const tag of tags) {
    let row = select.get(tag) as { id: number } | undefined
    if (!row) {
      insert.run(tag)
      row = select.get(tag) as { id: number } | undefined
    }
    if (row) ids.push(row.id)
  }
  return ids
}

function replaceTags(
  db: DatabaseSync,
  linkTable: 'note_tags' | 'bookmark_tags',
  idColumn: 'note_id' | 'bookmark_id',
  itemId: string,
  tags: string[],
): void {
  db.prepare(`DELETE FROM ${linkTable} WHERE ${idColumn} = ?`).run(itemId)
  const tagIds = resolveTagIds(db, tags)
  const insert = db.prepare(`INSERT OR IGNORE INTO ${linkTable} (${idColumn}, tag_id) VALUES (?, ?)`)
  for (const tagId of tagIds) insert.run(itemId, tagId)
}

/** 删除没有任何关联的孤立标签；在删除笔记/书签后调用。 */
function cleanupOrphanTags(db: DatabaseSync): void {
  db.prepare(
    `DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM note_tags UNION SELECT tag_id FROM bookmark_tags)`,
  ).run()
}

function tagsFor(
  db: DatabaseSync,
  linkTable: 'note_tags' | 'bookmark_tags',
  idColumn: 'note_id' | 'bookmark_id',
  ids: string[],
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (ids.length === 0) return out
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT l.${idColumn} AS item_id, t.name AS name
       FROM ${linkTable} l JOIN tags t ON t.id = l.tag_id
       WHERE l.${idColumn} IN (${placeholders})
       ORDER BY t.name COLLATE NOCASE ASC`,
    )
    .all(...ids) as unknown as { item_id: string; name: string }[]
  for (const row of rows) {
    const list = out.get(row.item_id) ?? []
    list.push(row.name)
    out.set(row.item_id, list)
  }
  return out
}

function toNoteItem(row: NoteRow, tags: string[], attachments: NoteAttachmentItem[] = []): NoteItem {
  return {
    id: row.id,
    title: row.title,
    bodyMd: row.body_md,
    tags,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachments,
  }
}

function toBookmarkItem(row: BookmarkRow, tags: string[]): BookmarkItem {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    description: row.description,
    tags,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function changedFields(input: object): string[] {
  const record = input as Record<string, unknown>
  return Object.keys(record).filter((key) => record[key] !== undefined)
}

/** 标签集合语义比较（大小写不敏感、忽略顺序）；用于判断是否需要写版本快照。 */
export function sameTags(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const normalize = (tags: string[]): string[] => tags.map((tag) => tag.toLowerCase()).sort()
  const a = normalize(left)
  const b = normalize(right)
  return a.every((tag, index) => tag === b[index])
}

// ---------- 笔记 ----------

interface NoteVersionRow {
  id: string
  note_id: string
  title: string
  body_md: string
  tags_json: string
  actor: string
  created_at: string
}

interface NoteAttachmentRow {
  note_id: string
  file_id: string
  name: string
  size: number
  mime: string | null
}

function attachmentUrl(fileId: string): string {
  return `/api/files/${fileId}/content?inline=1`
}

function parseStoredTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((tag): tag is string => typeof tag === 'string')
  } catch {
    return []
  }
}

export class NoteService {
  private readonly db: DatabaseSync
  private readonly files: FileService | null
  private readonly config: Config | null
  private readonly log: NoteServiceOptions['log'] | null

  constructor(db: DatabaseSync, options: NoteServiceOptions = {}) {
    this.db = db
    this.files = options.files ?? null
    this.config = options.config ?? null
    this.log = options.log ?? null
  }

  private row(id: string): NoteRow {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as unknown as NoteRow | undefined
    if (!row) throw notFound('笔记不存在')
    return row
  }

  private tagsOf(ids: string[]): Map<string, string[]> {
    return tagsFor(this.db, 'note_tags', 'note_id', ids)
  }

  /** 批量读取附件，避免列表接口 N+1 查询；已删除的附件行不展示。 */
  private attachmentsOf(noteIds: string[]): Map<string, NoteAttachmentItem[]> {
    const out = new Map<string, NoteAttachmentItem[]>()
    if (noteIds.length === 0) return out
    const placeholders = noteIds.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `SELECT a.note_id AS note_id, f.id AS file_id, f.name AS name, f.size AS size, f.mime AS mime
         FROM note_attachments a JOIN files f ON f.id = a.file_id
         WHERE a.note_id IN (${placeholders}) AND f.deleted_at IS NULL AND f.origin = 'note'
         ORDER BY a.created_at ASC, f.rowid ASC`,
      )
      .all(...noteIds) as unknown as NoteAttachmentRow[]
    for (const row of rows) {
      const list = out.get(row.note_id) ?? []
      list.push({
        fileId: row.file_id,
        name: row.name,
        size: Number(row.size),
        mime: row.mime,
        url: attachmentUrl(row.file_id),
      })
      out.set(row.note_id, list)
    }
    return out
  }

  get(id: string): NoteItem {
    const row = this.row(id)
    return toNoteItem(row, this.tagsOf([row.id]).get(row.id) ?? [], this.attachmentsOf([row.id]).get(row.id) ?? [])
  }

  private filters(query: ListQuery): Condition {
    const sql: string[] = []
    const params: SqlParam[] = []
    const tag = normalizeTagFilter(query.tag)
    if (tag) {
      sql.push(
        `EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
                 WHERE nt.note_id = n.id AND t.name = ?)`,
      )
      params.push(tag)
    }
    const pinned = query.pinned ?? null
    if (pinned !== null) {
      sql.push('n.pinned = ?')
      params.push(pinned ? 1 : 0)
    }
    return { sql, params }
  }

  list(query: ListQuery = {}): ListResult<NoteItem> {
    const { page, pageSize, offset } = normalizePage(query.page, query.pageSize)
    const filter = this.filters(query)
    const where = filter.sql.length > 0 ? `AND ${filter.sql.join(' AND ')}` : ''
    const q = typeof query.q === 'string' ? query.q.trim() : ''
    let rows: NoteRow[] = []
    let total = 0
    let usedFts = false
    if (q) {
      const expression = ftsExpression(q)
      if (expression && !WIDE_CHARS.test(q)) {
        try {
          total = (
            this.db
              .prepare(
                `SELECT COUNT(*) AS c FROM notes n JOIN notes_fts ON notes_fts.rowid = n.rowid
                 WHERE notes_fts MATCH ? ${where}`,
              )
              .get(expression, ...filter.params) as { c: number }
          ).c
          rows = this.db
            .prepare(
              `SELECT n.* FROM notes n JOIN notes_fts ON notes_fts.rowid = n.rowid
               WHERE notes_fts MATCH ? ${where}
               ORDER BY n.pinned DESC, n.updated_at DESC, n.id DESC LIMIT ? OFFSET ?`,
            )
            .all(expression, ...filter.params, pageSize, offset) as unknown as NoteRow[]
          usedFts = true
        } catch {
          usedFts = false
        }
      }
      if (!usedFts) {
        const pattern = `%${escapeLike(q)}%`
        total = (
          this.db
            .prepare(
              `SELECT COUNT(*) AS c FROM notes n
               WHERE (n.title LIKE ? ESCAPE '\\' OR n.body_md LIKE ? ESCAPE '\\') ${where}`,
            )
            .get(pattern, pattern, ...filter.params) as { c: number }
        ).c
        rows = this.db
          .prepare(
            `SELECT n.* FROM notes n
             WHERE (n.title LIKE ? ESCAPE '\\' OR n.body_md LIKE ? ESCAPE '\\') ${where}
             ORDER BY n.pinned DESC, n.updated_at DESC, n.id DESC LIMIT ? OFFSET ?`,
          )
          .all(pattern, pattern, ...filter.params, pageSize, offset) as unknown as NoteRow[]
      }
    } else {
      total = (
        this.db.prepare(`SELECT COUNT(*) AS c FROM notes n WHERE 1 = 1 ${where}`).get(...filter.params) as {
          c: number
        }
      ).c
      rows = this.db
        .prepare(
          `SELECT n.* FROM notes n WHERE 1 = 1 ${where}
           ORDER BY n.pinned DESC, n.updated_at DESC, n.id DESC LIMIT ? OFFSET ?`,
        )
        .all(...filter.params, pageSize, offset) as unknown as NoteRow[]
    }
    const tags = this.tagsOf(rows.map((row) => row.id))
    const attachments = this.attachmentsOf(rows.map((row) => row.id))
    return {
      items: rows.map((row) => toNoteItem(row, tags.get(row.id) ?? [], attachments.get(row.id) ?? [])),
      page,
      pageSize,
      total,
    }
  }

  create(actor: Actor, input: CreateNoteInput): NoteItem {
    const title =
      clampText(input.title === undefined ? '' : input.title, 'title', MAX_TITLE_LENGTH, true).trim() || '无标题'
    const bodyMd = validateBody(input.bodyMd)
    const pinned = parsePinned(input.pinned)
    const tags = normalizeTags(input.tags)
    const now = nowIso()
    const id = newId()
    transaction(this.db, () => {
      this.db
        .prepare('INSERT INTO notes (id, title, body_md, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, title, bodyMd, pinned ? 1 : 0, now, now)
      replaceTags(this.db, 'note_tags', 'note_id', id, tags)
    })
    audit(this.db, actor.username, 'note_create', title, { id, pinned, tags }, actor.ip)
    return this.get(id)
  }

  update(actor: Actor, id: string, input: UpdateNoteInput): NoteItem {
    const row = this.row(id)
    const sets: string[] = []
    const params: SqlParam[] = []
    let title = row.title
    if (input.title !== undefined) {
      title = clampText(input.title, 'title', MAX_TITLE_LENGTH, true).trim() || '无标题'
      sets.push('title = ?')
      params.push(title)
    }
    let bodyMd = row.body_md
    if (input.bodyMd !== undefined) {
      bodyMd = validateBody(input.bodyMd)
      sets.push('body_md = ?')
      params.push(bodyMd)
    }
    if (input.pinned !== undefined) {
      sets.push('pinned = ?')
      params.push(parsePinned(input.pinned) ? 1 : 0)
    }
    const currentTags = this.tagsOf([id]).get(id) ?? []
    const tags = input.tags === undefined ? null : normalizeTags(input.tags)
    if (sets.length === 0 && tags === null) throw badRequest('至少提供一个修改字段', 'invalid_request')
    const now = nowIso()
    // 只有标题/正文/标签实际变化才保留旧版本；仅改置顶不产生版本。
    const contentChanged =
      (input.title !== undefined && title !== row.title) ||
      (input.bodyMd !== undefined && bodyMd !== row.body_md) ||
      (tags !== null && !sameTags(tags, currentTags))
    transaction(this.db, () => {
      if (contentChanged) this.insertVersion(row, currentTags, actor, now)
      this.db.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(now, id)
      if (sets.length > 0) {
        this.db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
      }
      if (tags !== null) replaceTags(this.db, 'note_tags', 'note_id', id, tags)
    })
    audit(this.db, actor.username, 'note_update', title, { id, fields: changedFields(input) }, actor.ip)
    return this.get(id)
  }

  remove(actor: Actor, id: string): { ok: true; id: string } {
    const row = this.row(id)
    const fileIds = (
      this.db.prepare('SELECT file_id FROM note_attachments WHERE note_id = ?').all(id) as unknown as {
        file_id: string
      }[]
    ).map((item) => item.file_id)
    transaction(this.db, () => {
      // 级联删除 note_tags/note_attachments/note_versions；随后硬删除附件文件行。
      this.db.prepare('DELETE FROM notes WHERE id = ?').run(id)
      cleanupOrphanTags(this.db)
    })
    if (fileIds.length > 0) {
      if (this.files) {
        try {
          this.files.deleteFiles(actor, fileIds, {
            auditAction: 'note_attachment_delete',
            detail: { noteId: id, reason: 'note_delete' },
          })
        } catch (error) {
          // 文件行删除失败不改变笔记删除结果（附件不可见且仍计入配额），留日志便于人工处理。
          this.log?.warn({ err: error, noteId: id, count: fileIds.length }, '笔记删除后清理附件失败')
        }
      } else {
        transaction(this.db, () => {
          const placeholders = fileIds.map(() => '?').join(', ')
          this.db.prepare(`DELETE FROM files WHERE id IN (${placeholders})`).run(...fileIds)
        })
      }
    }
    audit(this.db, actor.username, 'note_delete', row.title, { id, attachments: fileIds.length }, actor.ip)
    return { ok: true, id }
  }

  // ---------- 附件 ----------

  private attachmentDeps(): { files: FileService; config: Config } {
    if (!this.files || !this.config) {
      throw new AppError(500, 'internal_error', '笔记附件功能未启用')
    }
    return { files: this.files, config: this.config }
  }

  listAttachments(noteId: string): { items: NoteAttachmentItem[] } {
    this.row(noteId)
    return { items: this.attachmentsOf([noteId]).get(noteId) ?? [] }
  }

  /**
   * 登记附件：校验数量/单文件大小/每笔记上限后，用 FileService 以 origin='note' 落库（计入总配额）。
   * 任一步失败回滚已登记的附件（含物理文件），避免留下无主配额占用。
   * onRegistered(index) 在每个文件成功落库后回调，调用方可在此时释放该文件的配额预留
   * （否则后续文件的配额校验会把已消费的预留当成他人占用而误报 409）。
   */
  async addAttachments(
    actor: Actor,
    noteId: string,
    uploads: NoteAttachmentUpload[],
    options: { onRegistered?: (index: number) => void } = {},
  ): Promise<{ items: NoteAttachmentItem[] }> {
    const { files, config } = this.attachmentDeps()
    const note = this.row(noteId)
    if (uploads.length === 0 || uploads.length > MAX_ATTACHMENTS_PER_REQUEST) {
      throw badRequest(`每次上传 1–${MAX_ATTACHMENTS_PER_REQUEST} 个附件`, 'invalid_request')
    }
    const existing = (
      this.db.prepare('SELECT COUNT(*) AS c FROM note_attachments WHERE note_id = ?').get(noteId) as { c: number }
    ).c
    if (Number(existing) + uploads.length > config.noteMaxAttachments) {
      throw new AppError(400, 'too_many_attachments', `每篇笔记最多 ${config.noteMaxAttachments} 个附件`)
    }
    for (const upload of uploads) {
      if (!Number.isFinite(upload.size) || upload.size < 0) throw badRequest('附件大小不合法', 'invalid_request')
      if (upload.size > config.noteAttachmentMaxBytes) {
        throw tooLarge(`单个附件不能超过 ${Math.floor(config.noteAttachmentMaxBytes / 1024 / 1024)} MiB`)
      }
    }
    files.ensureFreeDiskSpace()
    const created: string[] = []
    const items: NoteAttachmentItem[] = []
    try {
      for (const [index, upload] of uploads.entries()) {
        const file = await files.registerUpload(actor, {
          parentId: null,
          rawName: upload.rawName,
          tempPath: upload.tempPath,
          size: upload.size,
          sha256: upload.sha256,
          reservedBytes: upload.reservedBytes ?? 0,
          origin: 'note',
        })
        created.push(file.id)
        this.db
          .prepare('INSERT INTO note_attachments (note_id, file_id, created_at) VALUES (?, ?, ?)')
          .run(noteId, file.id, nowIso())
        items.push({
          fileId: file.id,
          name: file.name,
          size: file.size,
          mime: file.mime,
          url: attachmentUrl(file.id),
        })
        options.onRegistered?.(index)
      }
    } catch (error) {
      if (created.length > 0) {
        try {
          files.deleteFiles(actor, created, {
            auditAction: 'note_attachment_delete',
            detail: { noteId, reason: 'rollback' },
          })
        } catch (cleanupError) {
          this.log?.warn({ err: cleanupError, noteId }, '附件回滚失败')
        }
      }
      throw error
    }
    audit(this.db, actor.username, 'note_attachment_add', note.title, {
      noteId,
      count: items.length,
      bytes: items.reduce((sum, item) => sum + item.size, 0),
    }, actor.ip)
    return { items }
  }

  removeAttachment(actor: Actor, noteId: string, fileId: string): { ok: true } {
    const { files } = this.attachmentDeps()
    this.row(noteId)
    const link = this.db
      .prepare('SELECT file_id FROM note_attachments WHERE note_id = ? AND file_id = ?')
      .get(noteId, fileId) as { file_id: string } | undefined
    if (!link) throw notFound('附件不存在')
    files.deleteFiles(actor, [fileId], {
      auditAction: 'note_attachment_delete',
      detail: { noteId, reason: 'manual' },
    })
    return { ok: true }
  }

  /**
   * 维护对账：删除 origin='note' 但没有 note_attachments 关联的孤儿文件。
   * 崩溃/删除中断可能留下不可见但仍占配额的文件行，由日常维护清理并告警留痕。
   */
  cleanupOrphanAttachments(): number {
    if (!this.files) return 0
    const rows = this.db
      .prepare(
        `SELECT id FROM files f WHERE f.origin = 'note'
         AND NOT EXISTS (SELECT 1 FROM note_attachments a WHERE a.file_id = f.id)`,
      )
      .all() as unknown as { id: string }[]
    if (rows.length === 0) return 0
    const result = this.files.deleteFiles(
      { username: 'system', ip: null },
      rows.map((row) => row.id),
      { auditAction: 'note_attachment_orphan_cleanup', detail: { reason: 'orphan' } },
    )
    this.log?.warn({ count: result.count, freedBytes: result.freedBytes }, '清理无关联的笔记附件孤儿文件')
    return result.count
  }

  // ---------- 版本历史 ----------

  private insertVersion(row: NoteRow, tags: string[], actor: Actor, createdAt: string): void {
    this.db
      .prepare(
        'INSERT INTO note_versions (id, note_id, title, body_md, tags_json, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(newId(), row.id, row.title, row.body_md, JSON.stringify(tags), actor.username, createdAt)
    this.pruneVersions(row.id)
  }

  /** 每篇笔记只保留最近 noteVersionsKeep 条；同一毫秒写入时按 rowid 稳定排序。 */
  private pruneVersions(noteId: string): void {
    const keep = this.config?.noteVersionsKeep ?? 20
    this.db
      .prepare(
        `DELETE FROM note_versions WHERE note_id = ? AND id NOT IN (
           SELECT id FROM note_versions WHERE note_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
         )`,
      )
      .run(noteId, noteId, keep)
  }

  listVersions(
    noteId: string,
    options: { limit?: number; offset?: number } = {},
  ): { items: NoteVersionSummary[]; total: number; limit: number; offset: number } {
    this.row(noteId)
    const limit = Math.min(
      MAX_VERSION_PAGE_SIZE,
      Math.max(1, Number.isInteger(options.limit) ? (options.limit as number) : 20),
    )
    const offset = Math.max(0, Number.isInteger(options.offset) ? (options.offset as number) : 0)
    const total = (
      this.db.prepare('SELECT COUNT(*) AS c FROM note_versions WHERE note_id = ?').get(noteId) as { c: number }
    ).c
    const rows = this.db
      .prepare(
        'SELECT id, title, created_at FROM note_versions WHERE note_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?',
      )
      .all(noteId, limit, offset) as unknown as { id: string; title: string; created_at: string }[]
    return {
      items: rows.map((row) => ({ id: row.id, title: row.title, createdAt: row.created_at })),
      total: Number(total),
      limit,
      offset,
    }
  }

  getVersion(noteId: string, versionId: string): { version: NoteVersionItem } {
    this.row(noteId)
    const row = this.db
      .prepare('SELECT * FROM note_versions WHERE id = ? AND note_id = ?')
      .get(versionId, noteId) as unknown as NoteVersionRow | undefined
    // 跨笔记的 versionId 与不存在一律 404，避免泄露其它笔记版本是否存在。
    if (!row) throw notFound('版本不存在')
    return {
      version: {
        id: row.id,
        noteId: row.note_id,
        title: row.title,
        bodyMd: row.body_md,
        tags: parseStoredTags(row.tags_json),
        createdAt: row.created_at,
      },
    }
  }

  /** 恢复历史版本：先把当前内容快照入版本表，再写回标题/正文/标签（置顶状态不变）。 */
  restoreVersion(actor: Actor, noteId: string, versionId: string): NoteItem {
    const current = this.row(noteId)
    const row = this.db
      .prepare('SELECT * FROM note_versions WHERE id = ? AND note_id = ?')
      .get(versionId, noteId) as unknown as NoteVersionRow | undefined
    if (!row) throw notFound('版本不存在')
    const now = nowIso()
    const currentTags = this.tagsOf([noteId]).get(noteId) ?? []
    const tags = parseStoredTags(row.tags_json)
    transaction(this.db, () => {
      this.insertVersion(current, currentTags, actor, now)
      this.db
        .prepare('UPDATE notes SET title = ?, body_md = ?, updated_at = ? WHERE id = ?')
        .run(row.title, row.body_md, now, noteId)
      replaceTags(this.db, 'note_tags', 'note_id', noteId, tags)
    })
    audit(this.db, actor.username, 'note_version_restore', row.title, { noteId, versionId, id: noteId }, actor.ip)
    return this.get(noteId)
  }

  listTags(): { items: TagCount[] } {
    const rows = this.db
      .prepare(
        `SELECT t.name AS name, COUNT(*) AS count
         FROM notes n JOIN note_tags nt ON nt.note_id = n.id JOIN tags t ON t.id = nt.tag_id
         GROUP BY t.id ORDER BY count DESC, t.name COLLATE NOCASE ASC`,
      )
      .all() as unknown as TagCount[]
    return { items: rows.map((row) => ({ name: row.name, count: Number(row.count) })) }
  }
}

// ---------- 书签 ----------

export class BookmarkService {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  private row(id: string): BookmarkRow {
    const row = this.db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id) as unknown as BookmarkRow | undefined
    if (!row) throw notFound('书签不存在')
    return row
  }

  private tagsOf(ids: string[]): Map<string, string[]> {
    return tagsFor(this.db, 'bookmark_tags', 'bookmark_id', ids)
  }

  get(id: string): BookmarkItem {
    const row = this.row(id)
    return toBookmarkItem(row, this.tagsOf([row.id]).get(row.id) ?? [])
  }

  private filters(query: ListQuery): Condition {
    const sql: string[] = []
    const params: SqlParam[] = []
    const tag = normalizeTagFilter(query.tag)
    if (tag) {
      sql.push(
        `EXISTS (SELECT 1 FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
                 WHERE bt.bookmark_id = b.id AND t.name = ?)`,
      )
      params.push(tag)
    }
    const pinned = query.pinned ?? null
    if (pinned !== null) {
      sql.push('b.pinned = ?')
      params.push(pinned ? 1 : 0)
    }
    return { sql, params }
  }

  list(query: ListQuery = {}): ListResult<BookmarkItem> {
    const { page, pageSize, offset } = normalizePage(query.page, query.pageSize)
    const filter = this.filters(query)
    const where = filter.sql.length > 0 ? `AND ${filter.sql.join(' AND ')}` : ''
    const q = typeof query.q === 'string' ? query.q.trim() : ''
    let rows: BookmarkRow[] = []
    let total = 0
    let usedFts = false
    if (q) {
      const expression = ftsExpression(q)
      if (expression && !WIDE_CHARS.test(q)) {
        try {
          total = (
            this.db
              .prepare(
                `SELECT COUNT(*) AS c FROM bookmarks b JOIN bookmarks_fts ON bookmarks_fts.rowid = b.rowid
                 WHERE bookmarks_fts MATCH ? ${where}`,
              )
              .get(expression, ...filter.params) as { c: number }
          ).c
          rows = this.db
            .prepare(
              `SELECT b.* FROM bookmarks b JOIN bookmarks_fts ON bookmarks_fts.rowid = b.rowid
               WHERE bookmarks_fts MATCH ? ${where}
               ORDER BY b.pinned DESC, b.updated_at DESC, b.id DESC LIMIT ? OFFSET ?`,
            )
            .all(expression, ...filter.params, pageSize, offset) as unknown as BookmarkRow[]
          usedFts = true
        } catch {
          usedFts = false
        }
      }
      if (!usedFts) {
        const pattern = `%${escapeLike(q)}%`
        total = (
          this.db
            .prepare(
              `SELECT COUNT(*) AS c FROM bookmarks b
               WHERE (b.title LIKE ? ESCAPE '\\' OR b.url LIKE ? ESCAPE '\\' OR b.description LIKE ? ESCAPE '\\') ${where}`,
            )
            .get(pattern, pattern, pattern, ...filter.params) as { c: number }
        ).c
        rows = this.db
          .prepare(
            `SELECT b.* FROM bookmarks b
             WHERE (b.title LIKE ? ESCAPE '\\' OR b.url LIKE ? ESCAPE '\\' OR b.description LIKE ? ESCAPE '\\') ${where}
             ORDER BY b.pinned DESC, b.updated_at DESC, b.id DESC LIMIT ? OFFSET ?`,
          )
          .all(pattern, pattern, pattern, ...filter.params, pageSize, offset) as unknown as BookmarkRow[]
      }
    } else {
      total = (
        this.db.prepare(`SELECT COUNT(*) AS c FROM bookmarks b WHERE 1 = 1 ${where}`).get(...filter.params) as {
          c: number
        }
      ).c
      rows = this.db
        .prepare(
          `SELECT b.* FROM bookmarks b WHERE 1 = 1 ${where}
           ORDER BY b.pinned DESC, b.updated_at DESC, b.id DESC LIMIT ? OFFSET ?`,
        )
        .all(...filter.params, pageSize, offset) as unknown as BookmarkRow[]
    }
    const tags = this.tagsOf(rows.map((row) => row.id))
    return { items: rows.map((row) => toBookmarkItem(row, tags.get(row.id) ?? [])), page, pageSize, total }
  }

  create(actor: Actor, input: CreateBookmarkInput): BookmarkItem {
    const url = validateBookmarkUrl(input.url)
    const fallbackTitle = (() => {
      try {
        return new URL(url).hostname || url
      } catch {
        return url
      }
    })()
    const title =
      clampText(input.title === undefined ? fallbackTitle : input.title, 'title', MAX_TITLE_LENGTH, true).trim() ||
      '未命名书签'
    const description =
      input.description === undefined ? '' : clampText(input.description, 'description', MAX_DESCRIPTION_LENGTH, true)
    const pinned = parsePinned(input.pinned)
    const tags = normalizeTags(input.tags)
    const now = nowIso()
    const id = newId()
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO bookmarks (id, url, title, description, pinned, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, url, title, description, pinned ? 1 : 0, now, now)
      replaceTags(this.db, 'bookmark_tags', 'bookmark_id', id, tags)
    })
    audit(this.db, actor.username, 'bookmark_create', title, { id, url, pinned, tags }, actor.ip)
    return this.get(id)
  }

  update(actor: Actor, id: string, input: UpdateBookmarkInput): BookmarkItem {
    const row = this.row(id)
    const sets: string[] = []
    const params: SqlParam[] = []
    let title = row.title
    if (input.url !== undefined) {
      sets.push('url = ?')
      params.push(validateBookmarkUrl(input.url))
    }
    if (input.title !== undefined) {
      title = clampText(input.title, 'title', MAX_TITLE_LENGTH, true).trim() || '未命名书签'
      sets.push('title = ?')
      params.push(title)
    }
    if (input.description !== undefined) {
      sets.push('description = ?')
      params.push(clampText(input.description, 'description', MAX_DESCRIPTION_LENGTH, true))
    }
    if (input.pinned !== undefined) {
      sets.push('pinned = ?')
      params.push(parsePinned(input.pinned) ? 1 : 0)
    }
    const tags = input.tags === undefined ? null : normalizeTags(input.tags)
    if (sets.length === 0 && tags === null) throw badRequest('至少提供一个修改字段', 'invalid_request')
    const now = nowIso()
    transaction(this.db, () => {
      this.db.prepare('UPDATE bookmarks SET updated_at = ? WHERE id = ?').run(now, id)
      if (sets.length > 0) {
        this.db.prepare(`UPDATE bookmarks SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
      }
      if (tags !== null) replaceTags(this.db, 'bookmark_tags', 'bookmark_id', id, tags)
    })
    audit(this.db, actor.username, 'bookmark_update', title, { id, fields: changedFields(input) }, actor.ip)
    return this.get(id)
  }

  remove(actor: Actor, id: string): { ok: true; id: string } {
    const row = this.row(id)
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id)
      cleanupOrphanTags(this.db)
    })
    audit(this.db, actor.username, 'bookmark_delete', row.title, { id }, actor.ip)
    return { ok: true, id }
  }

  listTags(): { items: TagCount[] } {
    const rows = this.db
      .prepare(
        `SELECT t.name AS name, COUNT(*) AS count
         FROM bookmarks b JOIN bookmark_tags bt ON bt.bookmark_id = b.id JOIN tags t ON t.id = bt.tag_id
         GROUP BY t.id ORDER BY count DESC, t.name COLLATE NOCASE ASC`,
      )
      .all() as unknown as TagCount[]
    return { items: rows.map((row) => ({ name: row.name, count: Number(row.count) })) }
  }
}
