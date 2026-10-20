/**
 * 文件分享领域服务：登录用户创建/查看/吊销单文件分享；公开按 token 访问。
 *
 * 安全边界：
 * - token 为 32 字节 CSPRNG base64url，仅创建时以 URL 形式返回一次；数据库只存 SHA-256。
 * - 分享密码走 scrypt（见 shares/password.ts），数据库只存 hash + salt；日志/审计不出现 token 或密码。
 * - 过期、吊销、下载次数用尽统一返回 410；密码分享必须先 unlock 拿到 5 分钟 HttpOnly 会话 Cookie。
 * - 文件被软删除（回收站）后，即使吊销钩子未执行，公开 metadata/content 也返回 410。
 * - 下载次数按「分享会话」只计一次：会话首次成功取到内容时原子自增（Range 后续请求不重复计），
 *   因此 maxDownloads 是对新会话的近似限制，无法防御清 Cookie 的恶意客户端（个人分享可接受）。
 * - 公开下载审计按 share+IP+10 分钟窗口去重，避免公开链接被刷爆 audit_log；计数不受影响。
 * - 公开路由不经过会话认证，由路由层做 Origin/限流；本服务只做数据与状态校验。
 */
import type { ReadStream } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../config.ts'
import type { FileRow } from '../types.ts'
import { audit } from '../auth/audit.ts'
import { transaction } from '../db.ts'
import { FileStorage } from '../files/storage.ts'
import { AppError, badRequest, notFound } from '../util/errors.ts'
import { newId, randomToken, sha256Hex } from '../util/ids.ts'
import { hashSharePassword, verifySharePassword } from './password.ts'

export const SHARE_SESSION_TTL_SECONDS = 300
/** 分享密码最小长度（仅新建校验；旧分享验证不受影响）。 */
export const SHARE_PASSWORD_MIN_LENGTH = 8
/** 公开下载审计去重窗口：同一 share+IP 在窗口内只记一条审计。 */
export const DOWNLOAD_AUDIT_WINDOW_MS = 10 * 60_000
/** 审计去重 Map 上限，超出后按时间淘汰，避免公开链接制造内存增长。 */
const DOWNLOAD_AUDIT_MAX_ENTRIES = 4096
/** 过期/吊销分享行保留天数，之后由日常维护 GC（关联会话级联删除）。 */
export const SHARE_ROW_RETENTION_DAYS = 30
const MAX_NOTE_LENGTH = 500
const DEFAULT_SHARE_PAGE_SIZE = 100
const MAX_SHARE_PAGE_SIZE = 500

export type ShareState = 'active' | 'expired' | 'exhausted' | 'revoked'

interface ShareRow {
  id: string
  file_id: string
  token_hash: string
  password_hash: string | null
  password_salt: string | null
  expires_at: string
  max_downloads: number
  download_count: number
  created_at: string
  revoked_at: string | null
  created_by: string
  note: string | null
}

interface ShareSessionRow {
  id: string
  share_id: string
  token_hash: string
  expires_at: string
  created_at: string
  downloaded: number
}

export interface ShareActor {
  username: string
  ip: string | null
}

export interface ShareStorage {
  finalPath(id: string): string
  createReadStream(id: string, range?: { start: number; end: number }): ReadStream
}

export interface ShareServiceOptions {
  storage?: ShareStorage
  now?: () => Date
}

export interface CreateShareInput {
  password?: unknown
  expiresInHours?: unknown
  maxDownloads?: unknown
  note?: unknown
}

export interface ShareItem {
  id: string
  fileId: string
  fileName: string
  fileSize: number | null
  fileMime: string | null
  hasPassword: boolean
  expiresAt: string
  /** null 表示不限次数（数据库 0），与前端 `maxDownloads ?? '不限'` 约定一致。 */
  maxDownloads: number | null
  downloadCount: number
  createdAt: string
  revokedAt: string | null
  note: string | null
  status: ShareState
}

export interface CreatedShare {
  share: ShareItem
  /** `/s/<token>` 页面的完整 URL；token 只在创建响应中出现一次。 */
  url: string
}

export interface PublicShareInfo {
  fileName: string
  size: number
  mime: string | null
  expiresAt: string
  hasPassword: boolean
  /** null 表示不限次数（数据库 0）。 */
  maxDownloads: number | null
  downloadCount: number
}

export interface PublicShareResponse {
  share: PublicShareInfo
  /** 公开元数据只在可访问时返回 200；过期/吊销/用尽返回 410。locked 由 requiresPassword 表达。 */
  state: 'active'
  requiresPassword: boolean
}

export interface UnlockResult extends PublicShareResponse {
  sessionToken: string
  expiresAt: string
}

export interface ContentAccess {
  share: ShareRow
  file: FileRow
  session: ShareSessionRow | null
  /** 密码分享由 unlock 建会话；无密码分享在首次取内容时懒创建会话。 */
  newSessionToken: string | null
  newSessionExpiresAt: string | null
  /** 本次 GET 是否需要计入下载次数（会话首次取内容）。 */
  mustCount: boolean
}

export interface ShareListOptions {
  page?: number
  pageSize?: number
}

export interface ShareListResult {
  items: ShareItem[]
  total: number
  page: number
  pageSize: number
}

interface FileMetaRow {
  file_name: string | null
  file_size: number | null
  file_mime: string | null
}

export interface ShareServiceDeps {
  storage?: ShareStorage
  now?: () => Date
}

const shareLocked = () => new AppError(401, 'share_locked', '该分享需要密码解锁')
const sharesDisabled = () => new AppError(403, 'shares_disabled', '分享功能未启用')

function gone(code: string, message: string): AppError {
  return new AppError(410, code, message)
}

function parseExpiryHours(value: unknown, config: Config): number {
  if (value === undefined || value === null || value === '') return config.shareDefaultExpiryHours
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > config.shareMaxExpiryHours) {
    throw badRequest(`过期时间需为 1–${config.shareMaxExpiryHours} 的整数小时`, 'invalid_expiry')
  }
  return parsed
}

function parseMaxDownloads(value: unknown, config: Config): number {
  if (value === undefined || value === null || value === '') return 0
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > config.shareMaxDownloads) {
    throw badRequest(`最大下载次数需为 0–${config.shareMaxDownloads} 的整数（0 表示不限）`, 'invalid_max_downloads')
  }
  return parsed
}

function parseNote(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw badRequest('备注必须是字符串', 'invalid_note')
  const note = value.trim()
  if (!note) return null
  if (note.length > MAX_NOTE_LENGTH) throw badRequest(`备注不能超过 ${MAX_NOTE_LENGTH} 个字符`, 'invalid_note')
  return note
}

function parsePassword(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw badRequest('分享密码必须是字符串', 'invalid_password')
  if (value.trim() === '') return null
  if (value.length < SHARE_PASSWORD_MIN_LENGTH) {
    throw badRequest(`分享密码至少需要 ${SHARE_PASSWORD_MIN_LENGTH} 个字符`, 'invalid_password')
  }
  return value
}

function parseTokenCookie(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export class ShareService {
  private readonly db: DatabaseSync
  private readonly config: Config
  readonly storage: ShareStorage
  private readonly clock: () => Date
  /** share+IP → 最近一次写入下载审计的时间戳（毫秒）。 */
  private readonly downloadAuditSeen = new Map<string, number>()

  constructor(db: DatabaseSync, config: Config, options: ShareServiceOptions | ShareStorage = {}) {
    this.db = db
    this.config = config
    const opts: ShareServiceOptions = 'createReadStream' in options ? { storage: options } : options
    this.storage = opts.storage ?? new FileStorage(config.dataDir)
    this.clock = opts.now ?? (() => new Date())
  }

  // ---------- 内部工具 ----------

  private nowDate(): Date {
    return this.clock()
  }

  private nowIso(): string {
    return this.nowDate().toISOString()
  }

  private stateOf(row: ShareRow, nowMs: number): ShareState {
    if (row.revoked_at) return 'revoked'
    if (Date.parse(row.expires_at) <= nowMs) return 'expired'
    if (row.max_downloads > 0 && row.download_count >= row.max_downloads) return 'exhausted'
    return 'active'
  }

  private assertUsable(row: ShareRow, nowMs: number): void {
    const state = this.stateOf(row, nowMs)
    if (state === 'revoked') throw gone('share_revoked', '分享链接已吊销')
    if (state === 'expired') throw gone('share_expired', '分享链接已过期')
    if (state === 'exhausted') throw gone('share_exhausted', '分享下载次数已用尽')
  }

  private shareByToken(token: unknown): ShareRow {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) throw notFound('分享链接不存在')
    const row = this.db.prepare('SELECT * FROM shares WHERE token_hash = ?').get(sha256Hex(token)) as unknown as
      | ShareRow
      | undefined
    if (!row) throw notFound('分享链接不存在')
    return row
  }

  private shareById(id: string): ShareRow {
    const row = this.db.prepare('SELECT * FROM shares WHERE id = ?').get(id) as unknown as ShareRow | undefined
    if (!row) throw notFound('分享不存在')
    return row
  }

  private fileForShare(share: ShareRow): FileRow {
    const row = this.db.prepare('SELECT * FROM files WHERE id = ?').get(share.file_id) as unknown as FileRow | undefined
    // 软删除文件在彻底删除前仍存在于 files 表；公开读取必须按“已不存在”处理，
    // 不能只依赖回收站路由里的吊销钩子（钩子失败/漏接时防止旧链接继续下载）。
    if (!row || row.deleted_at) throw gone('share_gone', '分享的文件已不存在')
    return row
  }

  private activeFile(fileId: string): FileRow {
    const row = this.db
      .prepare("SELECT * FROM files WHERE id = ? AND kind = 'file' AND deleted_at IS NULL")
      .get(fileId) as unknown as FileRow | undefined
    if (row) return row
    const any = this.db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as unknown as FileRow | undefined
    if (!any) throw notFound('文件不存在')
    if (any.deleted_at) throw badRequest('文件在回收站中，无法分享', 'file_unavailable')
    throw badRequest('仅支持分享单个文件', 'not_a_file')
  }

  private fileMeta(share: ShareRow): FileMetaRow {
    const row = this.db
      .prepare('SELECT name AS file_name, size AS file_size, mime AS file_mime FROM files WHERE id = ?')
      .get(share.file_id) as FileMetaRow | undefined
    return row ?? { file_name: null, file_size: null, file_mime: null }
  }

  private toItem(row: ShareRow): ShareItem {
    const meta = this.fileMeta(row)
    return {
      id: row.id,
      fileId: row.file_id,
      fileName: meta.file_name ?? '(文件已删除)',
      fileSize: meta.file_size === null ? null : Number(meta.file_size),
      fileMime: meta.file_mime,
      hasPassword: Boolean(row.password_hash),
      expiresAt: row.expires_at,
      maxDownloads: Number(row.max_downloads) > 0 ? Number(row.max_downloads) : null,
      downloadCount: Number(row.download_count),
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
      note: row.note,
      status: this.stateOf(row, this.nowDate().getTime()),
    }
  }

  private publicInfo(share: ShareRow, file: FileRow): PublicShareInfo {
    return {
      fileName: file.name,
      size: Number(file.size),
      mime: file.mime,
      expiresAt: share.expires_at,
      hasPassword: Boolean(share.password_hash),
      maxDownloads: Number(share.max_downloads) > 0 ? Number(share.max_downloads) : null,
      downloadCount: Number(share.download_count),
    }
  }

  private shareUrl(token: string): string {
    return `${this.config.appOrigin.replace(/\/+$/, '')}/s/${token}`
  }

  private validSession(shareId: string, sessionToken: string | null): ShareSessionRow | null {
    if (!sessionToken) return null
    const row = this.db
      .prepare('SELECT * FROM share_sessions WHERE token_hash = ?')
      .get(sha256Hex(sessionToken)) as unknown as ShareSessionRow | undefined
    if (!row || row.share_id !== shareId) return null
    if (Date.parse(row.expires_at) <= this.nowDate().getTime()) return null
    return row
  }

  private createSession(shareId: string): { row: ShareSessionRow; token: string } {
    const token = randomToken(32)
    const created = this.nowDate()
    const expiresAt = new Date(created.getTime() + SHARE_SESSION_TTL_SECONDS * 1000).toISOString()
    const row: ShareSessionRow = {
      id: newId(),
      share_id: shareId,
      token_hash: sha256Hex(token),
      expires_at: expiresAt,
      created_at: created.toISOString(),
      downloaded: 0,
    }
    this.db
      .prepare(
        'INSERT INTO share_sessions (id, share_id, token_hash, expires_at, created_at, downloaded) VALUES (?, ?, ?, ?, ?, 0)',
      )
      .run(row.id, row.share_id, row.token_hash, row.expires_at, row.created_at)
    // 顺手清理该分享已过期的会话，避免表无界增长。
    this.db.prepare('DELETE FROM share_sessions WHERE share_id = ? AND expires_at <= ?').run(shareId, this.nowIso())
    return { row, token }
  }

  // ---------- 登录用户操作 ----------

  async create(actor: ShareActor, fileId: string, input: CreateShareInput): Promise<CreatedShare> {
    if (!this.config.sharesEnabled) throw sharesDisabled()
    const file = this.activeFile(fileId)
    const expiresInHours = parseExpiryHours(input.expiresInHours, this.config)
    const maxDownloads = parseMaxDownloads(input.maxDownloads, this.config)
    const note = parseNote(input.note)
    const password = parsePassword(input.password)
    let passwordHash: { hash: string; salt: string } | null = null
    if (password) {
      try {
        passwordHash = await hashSharePassword(password)
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : '分享密码不合法', 'invalid_password')
      }
    }
    const token = randomToken(32)
    const id = newId()
    const created = this.nowDate()
    const createdAt = created.toISOString()
    const expiresAt = new Date(created.getTime() + expiresInHours * 3_600_000).toISOString()
    transaction(this.db, () => {
      // 密码哈希期间可能被并发移入回收站，事务内复核。
      this.activeFile(fileId)
      this.db
        .prepare(
          `INSERT INTO shares (id, file_id, token_hash, password_hash, password_salt, expires_at,
             max_downloads, download_count, created_at, revoked_at, created_by, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`,
        )
        .run(
          id,
          fileId,
          sha256Hex(token),
          passwordHash?.hash ?? null,
          passwordHash?.salt ?? null,
          expiresAt,
          maxDownloads,
          createdAt,
          actor.username,
          note,
        )
    })
    audit(this.db, actor.username, 'share_create', file.name, {
      shareId: id,
      fileId,
      hasPassword: passwordHash !== null,
      expiresInHours,
      maxDownloads,
    }, actor.ip)
    return { share: this.toItem(this.shareById(id)), url: this.shareUrl(token) }
  }

  list(options: ShareListOptions = {}): ShareListResult {
    const page = Number.isInteger(options.page) && (options.page as number) >= 1 ? (options.page as number) : 1
    const requestedSize = Number.isInteger(options.pageSize) && (options.pageSize as number) >= 1
      ? (options.pageSize as number)
      : DEFAULT_SHARE_PAGE_SIZE
    const pageSize = Math.min(MAX_SHARE_PAGE_SIZE, requestedSize)
    const total = (this.db.prepare('SELECT COUNT(*) AS c FROM shares').get() as { c: number }).c
    const rows = this.db
      .prepare('SELECT * FROM shares ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
      .all(pageSize, (page - 1) * pageSize) as unknown as ShareRow[]
    return { items: rows.map((row) => this.toItem(row)), total, page, pageSize }
  }

  revoke(actor: ShareActor, shareId: string): ShareItem {
    const row = this.shareById(shareId)
    if (row.revoked_at) return this.toItem(row)
    const file = this.fileForShareQuiet(row)
    const now = this.nowIso()
    transaction(this.db, () => {
      this.db.prepare('UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, shareId)
      this.db.prepare('DELETE FROM share_sessions WHERE share_id = ?').run(shareId)
    })
    audit(this.db, actor.username, 'share_revoke', file?.name ?? shareId, {
      shareId,
      fileId: row.file_id,
      downloadCount: Number(row.download_count),
    }, actor.ip)
    return this.toItem(this.shareById(shareId))
  }

  private fileForShareQuiet(share: ShareRow): FileRow | null {
    return (
      (this.db.prepare('SELECT * FROM files WHERE id = ?').get(share.file_id) as unknown as FileRow | undefined) ?? null
    )
  }

  /**
   * 文件被移入回收站或彻底删除时调用：撤销该文件及其所有子文件上的分享。
   * 返回被吊销的分享数量；由 Lead 在 files 删除/回收站流程中接入。
   */
  revokeByFile(fileId: string): number {
    return this.revokeForFileTree(fileId)
  }

  /** 递归吊销文件树上的分享（目录删除时使用）。 */
  revokeForFileTree(rootId: string): number {
    const shares = this.db
      .prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM files WHERE id = ?
           UNION ALL
           SELECT f.id FROM files f JOIN tree t ON f.parent_id = t.id
         )
         SELECT s.id AS id, s.file_id AS file_id FROM shares s
         WHERE s.revoked_at IS NULL AND s.file_id IN (SELECT id FROM tree)`,
      )
      .all(rootId) as unknown as { id: string; file_id: string }[]
    if (shares.length === 0) return 0
    const now = this.nowIso()
    const names = shares.map(() => '?').join(', ')
    transaction(this.db, () => {
      this.db
        .prepare(
          `WITH RECURSIVE tree(id) AS (
             SELECT id FROM files WHERE id = ?
             UNION ALL
             SELECT f.id FROM files f JOIN tree t ON f.parent_id = t.id
           )
           UPDATE shares SET revoked_at = ?
           WHERE revoked_at IS NULL AND file_id IN (SELECT id FROM tree)`,
        )
        .run(rootId, now)
      this.db.prepare(`DELETE FROM share_sessions WHERE share_id IN (${names})`).run(...shares.map((row) => row.id))
    })
    const file = this.db.prepare('SELECT name FROM files WHERE id = ?').get(rootId) as { name: string } | undefined
    audit(this.db, 'system', 'share_revoke', file?.name ?? rootId, {
      fileId: rootId,
      count: shares.length,
      reason: 'file_removed',
    }, null)
    return shares.length
  }

  /** 清理过期会话；顺带 GC 长期过期/吊销的分享行。返回清理的会话数。 */
  cleanup(): number {
    const result = this.db.prepare('DELETE FROM share_sessions WHERE expires_at <= ?').run(this.nowIso())
    this.purgeStaleRows()
    return Number(result.changes)
  }

  /** 删除超过保留期的过期/吊销分享（含关联会话）；返回删除行数。 */
  purgeStaleRows(retentionDays = SHARE_ROW_RETENTION_DAYS): number {
    const cutoff = new Date(this.nowDate().getTime() - Math.max(1, retentionDays) * 86_400_000).toISOString()
    const result = this.db
      .prepare('DELETE FROM shares WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR (expires_at < ?)')
      .run(cutoff, cutoff)
    return Number(result.changes)
  }

  // ---------- 公开访问 ----------

  metadata(token: unknown, sessionToken: unknown): PublicShareResponse {
    if (!this.config.sharesEnabled) throw notFound('分享链接不存在')
    const share = this.shareByToken(token)
    const now = this.nowDate().getTime()
    this.assertUsable(share, now)
    const file = this.fileForShare(share)
    const session = this.validSession(share.id, parseTokenCookie(sessionToken))
    const requiresPassword = Boolean(share.password_hash) && session === null
    return {
      share: this.publicInfo(share, file),
      state: 'active',
      requiresPassword,
    }
  }

  async unlock(token: unknown, password: string): Promise<UnlockResult> {
    if (!this.config.sharesEnabled) throw notFound('分享链接不存在')
    const share = this.shareByToken(token)
    this.assertUsable(share, this.nowDate().getTime())
    if (!share.password_hash || !share.password_salt) {
      throw badRequest('该分享无需密码', 'share_no_password')
    }
    const valid = await verifySharePassword(password, share.password_hash, share.password_salt)
    if (!valid) throw new AppError(401, 'invalid_password', '分享密码错误')
    const file = this.fileForShare(share)
    const session = this.createSession(share.id)
    return {
      share: this.publicInfo(share, file),
      state: 'active',
      requiresPassword: false,
      sessionToken: session.token,
      expiresAt: session.row.expires_at,
    }
  }

  /** 校验公开内容访问权限；返回文件与需要计数的会话信息。 */
  openContent(token: unknown, sessionToken: unknown, method: 'GET' | 'HEAD'): ContentAccess {
    if (!this.config.sharesEnabled) throw notFound('分享链接不存在')
    const share = this.shareByToken(token)
    const now = this.nowDate().getTime()
    if (share.revoked_at) throw gone('share_revoked', '分享链接已吊销')
    if (Date.parse(share.expires_at) <= now) throw gone('share_expired', '分享链接已过期')
    const file = this.fileForShare(share)
    let session = this.validSession(share.id, parseTokenCookie(sessionToken))
    const hasPassword = Boolean(share.password_hash)
    if (hasPassword && !session) throw shareLocked()
    let newSessionToken: string | null = null
    let newSessionExpiresAt: string | null = null
    if (!hasPassword && !session && method === 'GET') {
      const created = this.createSession(share.id)
      session = created.row
      newSessionToken = created.token
      newSessionExpiresAt = created.row.expires_at
    }
    const exhausted = Number(share.max_downloads) > 0 && Number(share.download_count) >= Number(share.max_downloads)
    if (exhausted && session?.downloaded !== 1) throw gone('share_exhausted', '分享下载次数已用尽')
    return {
      share,
      file,
      session,
      newSessionToken,
      newSessionExpiresAt,
      mustCount: method === 'GET' && session !== null && session.downloaded === 0,
    }
  }

  /** 公开下载审计是否应写入：同一 share+IP 在窗口内只记一次。 */
  private shouldAuditDownload(shareId: string, ip: string | null, nowMs: number): boolean {
    const key = `${shareId}|${ip ?? 'unknown'}`
    const last = this.downloadAuditSeen.get(key)
    if (last !== undefined && nowMs - last < DOWNLOAD_AUDIT_WINDOW_MS) return false
    this.downloadAuditSeen.set(key, nowMs)
    if (this.downloadAuditSeen.size > DOWNLOAD_AUDIT_MAX_ENTRIES) {
      const cutoff = nowMs - DOWNLOAD_AUDIT_WINDOW_MS
      for (const [entryKey, seenAt] of this.downloadAuditSeen) {
        if (seenAt < cutoff) this.downloadAuditSeen.delete(entryKey)
      }
      while (this.downloadAuditSeen.size > DOWNLOAD_AUDIT_MAX_ENTRIES) {
        const oldest = this.downloadAuditSeen.keys().next()
        if (oldest.done) break
        this.downloadAuditSeen.delete(oldest.value)
      }
    }
    return true
  }

  /** 会话首次成功取内容时原子 +1；次数用尽/已吊销/已过期返回 410。 */
  markDownloaded(access: ContentAccess, ip: string | null): void {
    const now = this.nowIso()
    transaction(this.db, () => {
      const result = this.db
        .prepare(
          `UPDATE shares SET download_count = download_count + 1
           WHERE id = ? AND revoked_at IS NULL AND expires_at > ?
             AND (max_downloads = 0 OR download_count < max_downloads)`,
        )
        .run(access.share.id, now)
      if (Number(result.changes) === 0) {
        const current = this.shareById(access.share.id)
        this.assertUsable(current, this.nowDate().getTime())
        throw gone('share_exhausted', '分享下载次数已用尽')
      }
      if (access.session) {
        this.db.prepare('UPDATE share_sessions SET downloaded = 1 WHERE id = ?').run(access.session.id)
      }
      // 计数与限次语义按真实下载执行；仅审计写入按 share+IP+窗口节流，防止公开链接刷爆 audit_log。
      if (this.shouldAuditDownload(access.share.id, ip, this.nowDate().getTime())) {
        audit(this.db, 'anonymous', 'share_download', access.file.name, {
          shareId: access.share.id,
          fileId: access.share.file_id,
        }, ip)
      }
    })
  }
}
