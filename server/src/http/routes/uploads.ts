/**
 * 分片上传 HTTP 路由：所有写操作 requireAuth + CSRF，会话仅创建者可见。
 *
 * 安全边界：分片块的 raw body 上限（CHUNK_SIZE + 64 KiB）只在本文件的独立 encapsulate
 * scope 内注册；全局 octet-stream 解析器保持实例默认 1 MiB，避免公开/无关端点在鉴权、
 * Origin 与限流校验之前缓冲 8 MiB 级请求体。
 */
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

  // 子 scope 继承父级解析器表：先移除全局 1 MiB 的 octet-stream 解析器，再按分片块大小
  // 注册；该 8 MiB 级上限只影响本 scope 内的分片路由。
  // 注意：这里不能 await app.register(...)（Fastify 实例 thenable 会提前触发 ready，
  // 导致之后注册的错误处理器不生效）；插件在服务器 ready 时加载。
  void app.register(async (scope) => {
    scope.removeContentTypeParser('application/octet-stream')
    scope.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: config.chunkSizeBytes + 64 * 1024 },
      (_request, body, done) => done(null, body),
    )

    scope.post('/api/uploads', { preHandler: [requireAuth, csrf] }, async (request, reply) => {
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

    scope.get('/api/uploads/:id', { preHandler: [requireAuth] }, async (request) => {
      const params = request.params as { id?: string }
      return uploads.status(actorFrom(request), params.id ?? '')
    })

    scope.put(
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

    scope.post('/api/uploads/:id/complete', { preHandler: [requireAuth, csrf] }, async (request) => {
      const params = request.params as { id?: string }
      const body = asRecord(request.body)
      const expected = body.sha256 === undefined ? undefined : requireString(body.sha256, 'SHA-256', 64)
      return uploads.complete(actorFrom(request), params.id ?? '', expected)
    })

    scope.delete('/api/uploads/:id', { preHandler: [requireAuth, csrf] }, async (request) => {
      const params = request.params as { id?: string }
      const id = params.id ?? ''
      if (!id) throw notFound('上传会话不存在', 'upload_not_found')
      return uploads.abort(actorFrom(request), id)
    })
  })
}
