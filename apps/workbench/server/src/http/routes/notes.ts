/**
 * 笔记与书签 HTTP 路由：CRUD、置顶、标签列表、搜索与分页；笔记附件上传/列表/删除；版本历史。
 *
 * 安全边界：全部端点需要登录会话；写操作额外校验 CSRF。
 * 附件上传复用文件上传的临时文件/流式哈希/配额预留写法，单请求 1–5 个文件；
 * 输入校验与错误码由 notes 领域服务统一负责，路由只做参数解析。
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance } from 'fastify'
import type { Config } from '../../config.ts'
import type { FileService } from '../../files/service.ts'
import {
  BookmarkService,
  DEFAULT_PAGE_SIZE,
  MAX_ATTACHMENTS_PER_REQUEST,
  MAX_PAGE_SIZE,
  MAX_VERSION_PAGE_SIZE,
  NoteService,
  parseOptionalPinned,
  type ListQuery,
  type NoteAttachmentUpload,
} from '../../notes/service.ts'
import { AppError, badRequest, insufficientStorage, tooLarge } from '../../util/errors.ts'
import { asRecord, actorFrom, decodeUploadFilename, parsePositiveInt } from '../util.ts'
import { csrfGuard, requireAuth } from '../guards.ts'

/** 上传异常映射：磁盘满 → 507；超限 → 413；其它 → 通用 400（不回显路径/内部 message）。 */
function uploadFailure(error: unknown): AppError {
  if (error instanceof AppError) return error
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOSPC' || code === 'EDQUOT') return insufficientStorage()
  if (code === 'FST_REQ_FILE_TOO_LARGE') return tooLarge('附件超过单文件大小限制')
  return badRequest('附件上传失败，请重试', 'upload_failed')
}

function listQuery(query: Record<string, unknown>): ListQuery {
  return {
    q: typeof query.q === 'string' ? query.q : null,
    tag: typeof query.tag === 'string' ? query.tag : null,
    pinned: parseOptionalPinned(query.pinned),
    page: parsePositiveInt(query.page, 1, 1, 100_000),
    pageSize: parsePositiveInt(query.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
  }
}

interface AttachmentUploadState {
  upload: NoteAttachmentUpload
  reserved: number
}

export function registerNoteRoutes(
  app: FastifyInstance,
  config: Config,
  notes: NoteService,
  bookmarks: BookmarkService,
  files?: FileService,
): void {
  const csrf = csrfGuard(config)

  // ---------- 笔记 ----------

  app.get('/api/notes', { preHandler: [requireAuth] }, async (request) => {
    return notes.list(listQuery(asRecord(request.query)))
  })

  app.get('/api/notes/tags', { preHandler: [requireAuth] }, async () => {
    return notes.listTags()
  })

  app.post('/api/notes', { preHandler: [requireAuth, csrf] }, async (request, reply) => {
    const body = asRecord(request.body)
    const item = notes.create(actorFrom(request), body)
    reply.code(201)
    return item
  })

  app.get('/api/notes/:id', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as { id: string }
    return notes.get(params.id)
  })

  app.patch('/api/notes/:id', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as { id: string }
    return notes.update(actorFrom(request), params.id, asRecord(request.body))
  })

  app.delete('/api/notes/:id', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as { id: string }
    return notes.remove(actorFrom(request), params.id)
  })

  // ---------- 笔记附件 ----------

  app.get('/api/notes/:id/attachments', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as { id: string }
    return notes.listAttachments(params.id)
  })

  app.post('/api/notes/:id/attachments', { preHandler: [requireAuth, csrf] }, async (request) => {
    if (!files || !request.isMultipart()) throw badRequest('需要 multipart/form-data 请求', 'invalid_multipart')
    const params = request.params as { id: string }
    // 先确认笔记存在：避免为不存在的笔记白写临时文件。
    notes.get(params.id)
    const actor = actorFrom(request)
    const uploads: AttachmentUploadState[] = []
    files.ensureFreeDiskSpace()

    try {
      for await (const part of request.parts()) {
        if (part.type === 'field') continue
        const rawName = decodeUploadFilename(part.filename || '未命名')
        if (uploads.length >= MAX_ATTACHMENTS_PER_REQUEST) {
          part.file.resume()
          throw tooLarge(`单次最多上传 ${MAX_ATTACHMENTS_PER_REQUEST} 个附件`)
        }
        const tempPath = files.storage.tempPath()
        const hash = createHash('sha256')
        const state: AttachmentUploadState = {
          upload: { rawName, tempPath, size: 0, sha256: '', reservedBytes: 0 },
          reserved: 0,
        }
        uploads.push(state)
        try {
          const meter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              const nextSize = state.upload.size + chunk.length
              if (nextSize > config.noteAttachmentMaxBytes) {
                callback(tooLarge(`单个附件不能超过 ${Math.floor(config.noteAttachmentMaxBytes / 1024 / 1024)} MiB`))
                return
              }
              hash.update(chunk)
              state.upload.size = nextSize
              try {
                // 与普通上传一致：并发请求共享剩余配额，避免各自通过检查后打满磁盘。
                files.reserveUploadBytes(chunk.length)
              } catch (error) {
                callback(error instanceof Error ? error : new Error('配额不足'))
                return
              }
              state.reserved += chunk.length
              state.upload.reservedBytes = state.reserved
              callback(null, chunk)
            },
          })
          await pipeline(part.file, meter, createWriteStream(tempPath))
          if (part.file.truncated) throw tooLarge('附件超过单文件大小限制')
          state.upload.sha256 = hash.digest('hex')
        } catch (error) {
          throw uploadFailure(error)
        }
      }
      if (uploads.length === 0) throw badRequest('没有收到文件', 'invalid_request')
      const result = await notes.addAttachments(
        actor,
        params.id,
        uploads.map((state) => state.upload),
        {
          // 每个附件登记成功即释放其上传预留，避免把已消费的字节算进后续文件的“他人预留”。
          onRegistered: (index) => {
            const state = uploads[index]
            if (!state || state.reserved === 0) return
            files.releaseUploadBytes(state.reserved)
            state.reserved = 0
          },
        },
      )
      return result
    } catch (error) {
      // 登记失败时清理尚未被服务接管的临时文件；已登记的由 NoteService 回滚。
      for (const state of uploads) files.storage.removeTemp(state.upload.tempPath)
      throw error instanceof AppError ? error : uploadFailure(error)
    } finally {
      for (const state of uploads) {
        if (state.reserved > 0) {
          files.releaseUploadBytes(state.reserved)
          state.reserved = 0
        }
      }
    }
  })

  app.delete('/api/notes/:id/attachments/:fileId', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as { id: string; fileId: string }
    return notes.removeAttachment(actorFrom(request), params.id, params.fileId)
  })

  // ---------- 版本历史 ----------

  app.get('/api/notes/:id/versions', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as { id: string }
    const query = asRecord(request.query)
    return notes.listVersions(params.id, {
      limit: parsePositiveInt(query.limit, 20, 1, MAX_VERSION_PAGE_SIZE),
      offset: parsePositiveInt(query.offset, 0, 0, 100_000),
    })
  })

  app.get('/api/notes/:id/versions/:versionId', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as { id: string; versionId: string }
    return notes.getVersion(params.id, params.versionId)
  })

  app.post('/api/notes/:id/versions/:versionId/restore', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as { id: string; versionId: string }
    return notes.restoreVersion(actorFrom(request), params.id, params.versionId)
  })

  // ---------- 书签 ----------

  app.get('/api/bookmarks', { preHandler: [requireAuth] }, async (request) => {
    return bookmarks.list(listQuery(asRecord(request.query)))
  })

  app.get('/api/bookmarks/tags', { preHandler: [requireAuth] }, async () => {
    return bookmarks.listTags()
  })

  app.post('/api/bookmarks', { preHandler: [requireAuth, csrf] }, async (request, reply) => {
    const body = asRecord(request.body)
    const item = bookmarks.create(actorFrom(request), body)
    reply.code(201)
    return item
  })

  app.get('/api/bookmarks/:id', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as { id: string }
    return bookmarks.get(params.id)
  })

  app.patch('/api/bookmarks/:id', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as { id: string }
    return bookmarks.update(actorFrom(request), params.id, asRecord(request.body))
  })

  app.delete('/api/bookmarks/:id', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as { id: string }
    return bookmarks.remove(actorFrom(request), params.id)
  })
}
