/**
 * 分片上传会话：浏览器把大文件切成固定大小块，服务端落临时块目录并在 complete 时
 * 顺序拼接后交给 FileService 原子登记。安全边界：
 * - 会话只允许创建者访问；chunk 序号与大小由服务端会话约束，不接受客户端路径；
 * - 所有临时文件位于 DATA_DIR/tmp/chunks 下，目录 0700、文件 0600；
 * - 配额在 init 时预留，complete 仍由 FileService 事务复核；过期/放弃必须释放。
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../config.ts'
import type { Actor, FileItem } from '../files/service.ts'
import { nowIso } from '../util/time.ts'
import { newId } from '../util/ids.ts'
import { badRequest, conflict, notFound, tooLarge } from '../util/errors.ts'
import type { FileService } from '../files/service.ts'
import { sanitizeName } from '../files/mime.ts'

type UploadStatus = 'uploading' | 'assembling' | 'completed' | 'aborted' | 'expired'

interface UploadSessionRow {
  id: string
  parent_id: string | null
  file_name: string
  size: number
  chunk_size: number
  total_chunks: number
  received: number
  status: UploadStatus
  expected_sha256: string | null
  file_id: string | null
  actor: string
  created_at: string
  updated_at: string
  expires_at: string
}

interface ChunkRow {
  idx: number
  size: number
  sha256: string
}

export interface UploadStatusResult {
  uploadId: string
  fileName: string
  size: number
  chunkSize: number
  totalChunks: number
  received: number[]
  missing: number[]
  status: UploadStatus
  expiresAt: string
}

export interface UploadInitResult {
  uploadId: string
  chunkSize: number
  totalChunks: number
  expiresAt: string
  received: number[]
}

export interface CompleteResult {
  ok: true
  file: FileItem
}

const UPLOAD_ID_PATTERN = /^[0-9a-f-]{36}$/
const ACTIVE_STATUSES = "('uploading', 'assembling')"
const MAX_RECEIVED_LIST = 100_000

export class UploadService {
  private readonly db: DatabaseSync
  private readonly config: Config
  private readonly files: FileService
  private readonly rootDir: string
  private readonly reservedSessions = new Set<string>()

  constructor(db: DatabaseSync, config: Config, files: FileService) {
    this.db = db
    this.config = config
    this.files = files
    this.rootDir = join(config.dataDir, 'tmp', 'chunks')
    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 })
    this.restoreReservations()
  }

  /** 进程重启后重新占用未完成会话的配额；无法占用的会话直接过期，避免幽灵预留。 */
  private restoreReservations(): void {
    const rows = this.db
      .prepare(`SELECT id, size FROM upload_sessions WHERE status IN ${ACTIVE_STATUSES}`)
      .all() as unknown as Array<{ id: string; size: number }>
    for (const row of rows) {
      try {
        this.files.reserveUploadBytes(Number(row.size))
        this.reservedSessions.add(row.id)
      } catch {
        this.expireSession(row.id, true)
      }
    }
  }

  init(actor: Actor, input: { name: string; parentId: string | null; size: number; sha256?: string }): UploadInitResult {
    if (!this.config.chunkedUploadEnabled) throw notFound('分片上传未启用', 'chunked_upload_disabled')
    const name = sanitizeName(input.name)
    if (!Number.isSafeInteger(input.size) || input.size <= 0) throw badRequest('文件大小不正确', 'invalid_size')
    if (input.size > this.config.chunkMaxFileBytes) throw tooLarge('文件超过分片上传上限')
    const chunkSize = this.config.chunkSizeBytes
    const totalChunks = Math.ceil(input.size / chunkSize)
    const parentId = input.parentId
    if (parentId !== null) {
      const parent = this.db
        .prepare("SELECT kind FROM files WHERE id = ? AND deleted_at IS NULL")
        .get(parentId) as { kind: string } | undefined
      if (!parent || parent.kind !== 'folder') throw badRequest('目标目录不存在', 'not_a_directory')
    }
    if (input.sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(input.sha256)) {
      throw badRequest('SHA-256 格式不正确', 'invalid_sha256')
    }
    this.cleanupExpired()
    const active = this.db
      .prepare(`SELECT COUNT(*) AS c FROM upload_sessions WHERE actor = ? AND status IN ${ACTIVE_STATUSES}`)
      .get(actor.username) as { c: number }
    if (Number(active.c) >= this.config.chunkMaxConcurrentSessions) {
      throw conflict('并行上传会话过多，请完成或取消其他上传', 'too_many_uploads')
    }
    this.files.ensureFreeDiskSpace()
    // 预留失败抛 409 quota_exceeded，路由层统一映射。
    this.files.reserveUploadBytes(input.size)
    const now = new Date()
    const id = newId()
    const expiresAt = new Date(now.getTime() + this.config.chunkSessionTtlHours * 60 * 60 * 1000).toISOString()
    try {
      this.db
        .prepare(
          `INSERT INTO upload_sessions
           (id, parent_id, file_name, size, chunk_size, total_chunks, received, status, expected_sha256, file_id, actor, created_at, updated_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, 'uploading', ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          id,
          parentId,
          name,
          input.size,
          chunkSize,
          totalChunks,
          input.sha256?.toLowerCase() ?? null,
          actor.username,
          now.toISOString(),
          now.toISOString(),
          expiresAt,
        )
      this.reservedSessions.add(id)
      mkdirSync(this.sessionDir(id), { recursive: true, mode: 0o700 })
    } catch (error) {
      this.files.releaseUploadBytes(input.size)
      this.reservedSessions.delete(id)
      rmSync(this.sessionDir(id), { recursive: true, force: true })
      throw error
    }
    return { uploadId: id, chunkSize, totalChunks, expiresAt, received: [] }
  }

  status(actor: Actor, id: string): UploadStatusResult {
    const session = this.ownedSession(actor, id)
    const chunks = this.db
      .prepare('SELECT idx FROM upload_chunks WHERE session_id = ? ORDER BY idx ASC')
      .all(id) as unknown as Array<{ idx: number }>
    const received = chunks.map((row) => Number(row.idx)).slice(0, MAX_RECEIVED_LIST)
    const missing: number[] = []
    const set = new Set(received)
    for (let index = 0; index < session.total_chunks; index++) {
      if (!set.has(index)) missing.push(index)
    }
    return {
      uploadId: session.id,
      fileName: session.file_name,
      size: Number(session.size),
      chunkSize: Number(session.chunk_size),
      totalChunks: Number(session.total_chunks),
      received,
      missing,
      status: session.status,
      expiresAt: session.expires_at,
    }
  }

  async putChunk(actor: Actor, id: string, index: number, body: Buffer): Promise<{ index: number; received: number }> {
    const session = this.ownedSession(actor, id)
    if (session.status !== 'uploading') throw conflict('上传会话当前不可写入', 'upload_not_writable')
    if (!Number.isInteger(index) || index < 0 || index >= session.total_chunks) {
      throw badRequest('分片序号越界', 'invalid_chunk_index')
    }
    const expectedSize =
      index === session.total_chunks - 1
        ? Number(session.size) - Number(session.chunk_size) * (session.total_chunks - 1)
        : Number(session.chunk_size)
    if (!Buffer.isBuffer(body) || body.length !== expectedSize) {
      throw badRequest('分片大小不正确', 'invalid_chunk_size')
    }
    const sha256 = createHash('sha256').update(body).digest('hex')
    const original = this.db
      .prepare('SELECT idx, size, sha256 FROM upload_chunks WHERE session_id = ? AND idx = ?')
      .get(id, index) as ChunkRow | undefined
    if (original) {
      if (Number(original.size) === expectedSize && original.sha256 === sha256) {
        return { index, received: Number(session.received) }
      }
      throw conflict('分片内容与已上传块不一致', 'chunk_conflict')
    }
    mkdirSync(this.sessionDir(id), { recursive: true, mode: 0o700 })
    const target = this.chunkPath(id, index)
    const temp = `${target}.${newId()}.tmp`
    try {
      await writeFile(temp, body, { mode: 0o600 })
      await rename(temp, target)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
    try {
      this.db
        .prepare(
          'INSERT INTO upload_chunks (session_id, idx, size, sha256, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(id, index, expectedSize, sha256, nowIso())
      const result = this.db
        .prepare('UPDATE upload_sessions SET received = received + 1, updated_at = ? WHERE id = ? AND status = ?')
        .run(nowIso(), id, 'uploading')
      if (Number(result.changes) !== 1) {
        // 会话在写入过程中被过期/取消；块保留无害，下一次清理会删除目录。
        throw conflict('上传会话已结束', 'upload_not_writable')
      }
    } catch (error) {
      rmSync(target, { force: true })
      throw error
    }
    return { index, received: Number(session.received) + 1 }
  }

  async complete(actor: Actor, id: string, expectedSha256?: string): Promise<CompleteResult> {
    const session = this.ownedSession(actor, id)
    if (session.status === 'completed' && session.file_id) {
      return { ok: true, file: this.files.get(session.file_id).item }
    }
    if (session.status !== 'uploading') throw conflict('上传会话当前不可完成', 'upload_not_completable')
    const count = this.db
      .prepare('SELECT COUNT(*) AS c FROM upload_chunks WHERE session_id = ?')
      .get(id) as { c: number }
    if (Number(count.c) !== Number(session.total_chunks)) throw badRequest('还有分片未上传', 'chunks_missing')
    if (expectedSha256 !== undefined && !/^[0-9a-f]{64}$/i.test(expectedSha256)) {
      throw badRequest('SHA-256 格式不正确', 'invalid_sha256')
    }
    const claimed = this.db
      .prepare("UPDATE upload_sessions SET status = 'assembling', updated_at = ? WHERE id = ? AND status = 'uploading'")
      .run(nowIso(), id)
    if (Number(claimed.changes) !== 1) throw conflict('上传会话正在完成或状态已变化', 'upload_not_completable')
    const tempPath = join(this.rootDir, `${id}.assembling`)
    try {
      const hash = createHash('sha256')
      const out = createWriteStream(tempPath, { mode: 0o600 })
      try {
        for (let index = 0; index < Number(session.total_chunks); index++) {
          const stream = createReadStream(this.chunkPath(id, index))
          for await (const chunk of stream) {
            hash.update(chunk as Buffer)
            if (!out.write(chunk)) await once(out, 'drain')
          }
        }
        out.end()
        await once(out, 'finish')
      } catch (error) {
        out.destroy()
        throw error
      }
      const actual = statSync(tempPath)
      if (actual.size !== Number(session.size)) throw badRequest('拼接后文件大小不一致', 'size_mismatch')
      const sha256 = hash.digest('hex')
      const wanted = (expectedSha256 ?? session.expected_sha256)?.toLowerCase()
      if (wanted && wanted !== sha256) throw badRequest('文件 SHA-256 校验失败', 'checksum_mismatch')
      const file = await this.files.registerUpload(actor, {
        parentId: session.parent_id,
        rawName: session.file_name,
        tempPath,
        size: actual.size,
        sha256,
        reservedBytes: Number(session.size),
      })
      this.files.releaseUploadBytes(Number(session.size))
      this.reservedSessions.delete(id)
      this.db
        .prepare("UPDATE upload_sessions SET status = 'completed', file_id = ?, updated_at = ? WHERE id = ?")
        .run(file.id, nowIso(), id)
      this.db.prepare('DELETE FROM upload_chunks WHERE session_id = ?').run(id)
      this.removeSessionDir(id)
      return { ok: true, file }
    } catch (error) {
      rmSync(tempPath, { force: true })
      // 保持会话可重试；配额预留继续占用，避免失败后其他上传抢占。
      this.db.prepare("UPDATE upload_sessions SET status = 'uploading', updated_at = ? WHERE id = ? AND status = 'assembling'").run(nowIso(), id)
      throw error
    }
  }

  abort(actor: Actor, id: string): { ok: true } {
    const session = this.ownedSession(actor, id)
    if (session.status === 'completed') throw conflict('已完成的会话不能取消', 'upload_completed')
    if (session.status !== 'aborted' && session.status !== 'expired') {
      this.release(session)
      this.db.prepare("UPDATE upload_sessions SET status = 'aborted', updated_at = ? WHERE id = ?").run(nowIso(), id)
    }
    this.db.prepare('DELETE FROM upload_chunks WHERE session_id = ?').run(id)
    this.removeSessionDir(id)
    return { ok: true }
  }

  cleanupExpired(now = new Date()): number {
    const rows = this.db
      .prepare(
        `SELECT * FROM upload_sessions WHERE status IN ${ACTIVE_STATUSES} AND expires_at <= ?`,
      )
      .all(now.toISOString()) as unknown as UploadSessionRow[]
    for (const row of rows) this.expireSession(row.id, false)
    return rows.length
  }

  private expireSession(id: string, markExpired: boolean): void {
    try {
      this.files.releaseUploadBytes(this.sessionSize(id))
    } catch {
      // 仅释放本服务预留；失败不阻断过期。
    }
    this.reservedSessions.delete(id)
    if (markExpired) {
      this.db.prepare("UPDATE upload_sessions SET status = 'expired', updated_at = ? WHERE id = ?").run(nowIso(), id)
    } else {
      this.db.prepare("UPDATE upload_sessions SET status = 'expired', updated_at = ? WHERE id = ? AND status IN ('uploading', 'assembling')").run(nowIso(), id)
    }
    this.db.prepare('DELETE FROM upload_chunks WHERE session_id = ?').run(id)
    this.removeSessionDir(id)
  }

  private sessionSize(id: string): number {
    const row = this.db.prepare('SELECT size FROM upload_sessions WHERE id = ?').get(id) as { size: number } | undefined
    return row ? Number(row.size) : 0
  }

  private release(session: UploadSessionRow): void {
    if (this.reservedSessions.has(session.id)) {
      this.files.releaseUploadBytes(Number(session.size))
      this.reservedSessions.delete(session.id)
    }
  }

  private ownedSession(actor: Actor, id: string): UploadSessionRow {
    if (!UPLOAD_ID_PATTERN.test(id)) throw notFound('上传会话不存在', 'upload_not_found')
    const row = this.db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(id) as unknown as
      | UploadSessionRow
      | undefined
    if (!row || row.actor !== actor.username) throw notFound('上传会话不存在', 'upload_not_found')
    if (row.status === 'expired' || row.status === 'aborted') throw notFound('上传会话已结束', 'upload_not_found')
    return row
  }

  private sessionDir(id: string): string {
    return join(this.rootDir, id)
  }

  private chunkPath(id: string, index: number): string {
    return join(this.sessionDir(id), `${index}.part`)
  }

  private removeSessionDir(id: string): void {
    rmSync(this.sessionDir(id), { recursive: true, force: true })
  }
}

/** 供路由层读取 raw body 时判断类型（避免 Buffer/string 混淆）。 */
export function isUploadBody(value: unknown): value is Buffer {
  return Buffer.isBuffer(value)
}
