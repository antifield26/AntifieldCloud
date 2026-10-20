/** 分片上传 HTTP 路由：所有写操作 requireAuth + CSRF，会话仅创建者可见。 */
import type { FastifyInstance } from 'fastify'
import type { Config } from '../../config.ts'
import type { UploadService } from '../../uploads/service.ts'
import { isUploadBody } from '../../uploads/service.ts'
import { badRequest, notFound } from '../../util/errors.ts'
import { asRecord, actorFrom, requireString } from '../util.ts'
import { csrfGuard, requireAuth } from '../guards.ts'

function parseIndex(value: string, total: number): number {
  if (!/^\d{1,6}$/.test(value)) throw badRequest('分片序号不正确', 'invalid_chunk_index')
  const index = Number(value)
  if (!Number.isSafeInteger(index) || index < 0 || index >= total) {
    throw badRequest('分片序号越界', 'invalid_chunk_index')
  }
  return index
}

export function registerUploadRoutes(app: FastifyInstance, config: Config, uploads: UploadService): void {
  const csrf = csrfGuard(config)

  app.post('/api/uploads', { preHandler: [requireAuth, csrf] }, async (request, reply) => {
    const body = asRecord(request.body)
    const name = requireString(body.name, '文件名', 255)
    const size = Number(body.size)
    const parentId =
      body.parentId === undefined || body.parentId === null || body.parentId === ''
        ? null
        : typeof body.parentId === 'string'
          ? body.parentId
          : (() => {
              throw badRequest('目标目录不正确', 'invalid_parent')
            })()
    const sha256 = typeof body.sha256 === 'string' ? body.sha256 : undefined
    const result = uploads.init(actorFrom(request), { name, parentId, size, sha256 })
    reply.code(201)
    return result
  })

  app.get('/api/uploads/:id', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as { id?: string }
    return uploads.status(actorFrom(request), params.id ?? '')
  })

  app.put(
    '/api/uploads/:id/chunks/:index',
    { preHandler: [requireAuth, csrf], bodyLimit: config.chunkSizeBytes + 64 * 1024 },
    async (request) => {
      const params = request.params as { id?: string; index?: string }
      if (!isUploadBody(request.body)) throw badRequest('分片必须是 application/octet-stream', 'invalid_chunk_body')
      const id = params.id ?? ''
      const status = uploads.status(actorFrom(request), id)
      const index = parseIndex(params.index ?? '', status.totalChunks)
      return uploads.putChunk(actorFrom(request), id, index, request.body)
    },
  )

  app.post('/api/uploads/:id/complete', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as { id?: string }
    const body = asRecord(request.body)
    const expected = body.sha256 === undefined ? undefined : requireString(body.sha256, 'SHA-256', 64)
    return uploads.complete(actorFrom(request), params.id ?? '', expected)
  })

  app.delete('/api/uploads/:id', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as { id?: string }
    const id = params.id ?? ''
    if (!id) throw notFound('上传会话不存在', 'upload_not_found')
    return uploads.abort(actorFrom(request), id)
  })
}
