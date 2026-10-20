/** 文件/回收站路由：上传、目录、搜索、预览、Range 下载、回收站。 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance } from 'fastify'
import type { Config } from '../../config.ts'
import type { Actor, FileItem, FileService } from '../../files/service.ts'
import { canInline, previewKindFor } from '../../files/mime.ts'
import { AppError, badRequest, insufficientStorage, tooLarge } from '../../util/errors.ts'
import { asRecord, actorFrom, contentDisposition, decodeUploadFilename, parsePositiveInt, parseRange, requireString } from '../util.ts'
import { csrfGuard, requireAuth } from '../guards.ts'

function parentIdFrom(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function statusForCode(code: string): number {
  switch (code) {
    case 'quota_exceeded':
      return 409
    case 'file_too_large':
      return 413
    case 'insufficient_storage':
      return 507
    case 'invalid_name':
    case 'invalid_request':
    case 'not_a_directory':
    case 'upload_failed':
      return 400
    case 'unauthenticated':
      return 401
    default:
      return 400
  }
}

/** 上传异常映射：磁盘满 → 507；超限 → 413；其它 → 通用 400（不回显路径/内部 message）。 */
function uploadFailure(error: unknown): AppError {
  if (error instanceof AppError) return error
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOSPC' || code === 'EDQUOT') return insufficientStorage()
  if (code === 'FST_REQ_FILE_TOO_LARGE') return tooLarge('文件超过单文件大小限制')
  return badRequest('上传失败，请重试', 'upload_failed')
}

interface UploadError {
  name: string
  code: string
  message: string
}

/**
 * 删除到回收站前先吊销该子树的分享。
 * 顺序保证：吊销失败 → 抛错并中止删除（文件仍可访问，不会产生“回收站里仍可下载的分享”）；
 * 吊销成功后即使软删除失败，也只是分享提前失效，安全方向。
 */
export function trashFileWithShareRevoke(
  files: FileService,
  revokeShares: ((id: string) => void) | undefined,
  actor: Actor,
  id: string,
): { count: number; item: FileItem } {
  revokeShares?.(id)
  return files.trash(actor, id)
}

export function registerFileRoutes(
  app: FastifyInstance,
  config: Config,
  files: FileService,
  onTrashed?: (id: string) => void,
): void {
  const csrf = csrfGuard(config)

  app.get('/api/files', { preHandler: [requireAuth] }, async (request) => {
    const query = asRecord(request.query)
    const parentId = parentIdFrom(query.parentId)
    const page = parsePositiveInt(query.page, 1, 1, 100_000)
    const pageSize = parsePositiveInt(query.pageSize, 200, 1, 500)
    const sortRaw = typeof query.sort === 'string' ? query.sort : 'name'
    const sort = sortRaw === 'updated' || sortRaw === 'size' ? sortRaw : 'name'
    const dir = query.dir === 'desc' ? 'desc' : 'asc'
    return files.list({ parentId, page, pageSize, sort, dir })
  })

  app.get('/api/files/search', { preHandler: [requireAuth] }, async (request) => {
    const query = asRecord(request.query)
    const q = typeof query.q === 'string' ? query.q.slice(0, 500) : ''
    return files.search(q, 100)
  })

  app.post('/api/files/folder', { preHandler: [requireAuth, csrf] }, async (request, reply) => {
    const body = asRecord(request.body)
    const name = requireString(body.name, 'name', 200)
    const parentId = parentIdFrom(body.parentId)
    const item = files.createFolder(actorFrom(request), parentId, name)
    reply.code(201)
    return item
  })

  app.post('/api/files/upload', { preHandler: [requireAuth, csrf] }, async (request) => {
    if (!request.isMultipart()) throw badRequest('需要 multipart/form-data 请求', 'invalid_multipart')
    const query = asRecord(request.query)
    let parentId = parentIdFrom(query.parentId)
    const items: FileItem[] = []
    const errors: UploadError[] = []
    let fileCount = 0
    const actor = actorFrom(request)
    files.ensureFreeDiskSpace()

    try {
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'parentId' && typeof part.value === 'string') parentId = parentIdFrom(part.value)
          continue
        }
        fileCount += 1
        const rawName = decodeUploadFilename(part.filename || '未命名')
        if (fileCount > config.maxFilesPerRequest) {
          part.file.resume()
          errors.push({ name: rawName, code: 'too_many_files', message: `单次最多 ${config.maxFilesPerRequest} 个文件` })
          continue
        }
        const tempPath = files.storage.tempPath()
        const hash = createHash('sha256')
        let size = 0
        let reserved = 0
        try {
          const meter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              hash.update(chunk)
              size += chunk.length
              try {
                // 全局配额预留：并发上传共享剩余配额，避免各自通过检查打满磁盘。
                files.reserveUploadBytes(chunk.length)
              } catch (error) {
                callback(error instanceof Error ? error : new Error('配额不足'))
                return
              }
              reserved += chunk.length
              callback(null, chunk)
            },
          })
          await pipeline(part.file, meter, createWriteStream(tempPath))
          if (part.file.truncated) throw tooLarge('文件超过单文件大小限制')
          const item = await files.registerUpload(actor, {
            parentId,
            rawName,
            tempPath,
            size,
            sha256: hash.digest('hex'),
            reservedBytes: reserved,
          })
          items.push(item)
        } catch (error) {
          files.storage.removeTemp(tempPath)
          const appError = uploadFailure(error)
          errors.push({ name: rawName, code: appError.code, message: appError.message })
        } finally {
          files.releaseUploadBytes(reserved)
          reserved = 0
        }
      }
    } catch (error) {
      if (error instanceof AppError) throw error
      const appError = uploadFailure(error)
      if (items.length === 0) throw appError
      errors.push({ name: '请求', code: appError.code, message: appError.message })
    }

    if (items.length === 0) {
      if (errors.length === 0) throw badRequest('没有收到文件', 'invalid_request')
      const first = errors[0]!
      throw new AppError(statusForCode(first.code), first.code, first.message)
    }
    return { items, errors }
  })

  app.get('/api/files/:id', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as { id: string }
    return files.get(params.id)
  })

  app.patch('/api/files/:id', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as { id: string }
    const body = asRecord(request.body)
    const actor = actorFrom(request)
    let item: FileItem | null = null
    if (typeof body.name === 'string') item = files.rename(actor, params.id, body.name)
    if (body.parentId !== undefined) item = files.move(actor, params.id, parentIdFrom(body.parentId))
    if (!item) throw badRequest('至少提供一个修改字段', 'invalid_request')
    return item
  })

  app.delete('/api/files/:id', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as { id: string }
    // 先吊销分享再软删除；钩子失败时中止删除，避免留下可下载的回收站内容。
    const result = trashFileWithShareRevoke(files, onTrashed, actorFrom(request), params.id)
    return { ok: true, id: params.id, count: result.count }
  })

  app.get('/api/files/:id/content', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = request.params as { id: string }
    const row = files.contentInfo(params.id)
    const preview = previewKindFor(row.name, row.mime ?? '')
    const inline = asRecord(request.query).inline === '1' && canInline(preview)
    const size = row.size
    const etag = `"${row.sha256 ?? row.id}"`
    if (request.headers['if-none-match'] === etag) {
      reply.code(304).header('etag', etag).send()
      return
    }
    const range = parseRange(request.headers.range, size)
    if (range === 'invalid') {
      reply.code(416).header('content-range', `bytes */${size}`).send()
      return
    }
    const start = range ? range.start : 0
    const end = range ? range.end : Math.max(0, size - 1)
    const length = size === 0 ? 0 : end - start + 1
    reply
      .code(range ? 206 : 200)
      .header('content-type', row.mime ?? 'application/octet-stream')
      .header('content-length', String(length))
      .header('accept-ranges', 'bytes')
      .header('etag', etag)
      .header('cache-control', 'private, max-age=60, must-revalidate')
      .header('content-disposition', contentDisposition(row.name, inline))
    // 内联 PDF 也限制同源框架，避免被外部页面嵌入（同源嵌入由前端使用）。
    if (inline && (row.mime ?? '').toLowerCase() === 'application/pdf') {
      reply.header('x-frame-options', 'SAMEORIGIN')
      reply.header('content-security-policy', "frame-ancestors 'self'")
    }
    if (range) reply.header('content-range', `bytes ${start}-${end}/${size}`)
    if (size === 0) {
      return reply.send()
    }
    return reply.send(files.storage.createReadStream(row.id, { start, end }))
  })

  app.get('/api/files/:id/text', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as { id: string }
    return files.readText(params.id, config.textPreviewBytes)
  })

  // ---------- 回收站 ----------

  app.get('/api/trash', { preHandler: [requireAuth] }, async (request) => {
    const query = asRecord(request.query)
    const page = parsePositiveInt(query.page, 1, 1, 100_000)
    const pageSize = parsePositiveInt(query.pageSize, 200, 1, 500)
    return files.listTrash({ page, pageSize })
  })

  app.post('/api/trash/:id/restore', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as { id: string }
    return files.restore(actorFrom(request), params.id)
  })

  app.delete('/api/trash/:id', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as { id: string }
    const result = files.purge(actorFrom(request), params.id)
    return { ok: true, ...result }
  })

  app.delete('/api/trash', { preHandler: [requireAuth, csrf] }, async (request) => {
    const result = files.emptyTrash(actorFrom(request))
    return { ok: true, ...result }
  })
}
