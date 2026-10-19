/** 统一异常处理：AppError → 结构化 JSON；未知错误只记录、不泄露内部细节。 */
import type { FastifyInstance } from 'fastify'
import { AppError, badRequest, rateLimited, tooLarge, toErrorBody } from '../util/errors.ts'

interface MultipartError {
  code?: string
  message?: string
  statusCode?: number
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {    if (error instanceof AppError) {
      if (error.statusCode === 429) {
        const retry = Number(error.details?.retryAfterSec ?? 60)
        reply.header('retry-after', String(Math.max(1, Math.ceil(retry))))
      }
      reply.code(error.statusCode).send(toErrorBody(error))
      return
    }
    const multipart = error as MultipartError
    if (multipart.code === 'FST_REQ_FILE_TOO_LARGE' || multipart.code === 'FST_FILES_LIMIT') {
      reply.code(413).send(toErrorBody(tooLarge('文件超过大小/数量限制')))
      return
    }
    if (multipart.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
      reply.code(400).send(toErrorBody(badRequest('需要 multipart/form-data 请求', 'invalid_multipart')))
      return
    }
    if (multipart.code === 'FST_PARTS_LIMIT') {
      reply.code(400).send(toErrorBody(badRequest('表单字段过多', 'invalid_multipart')))
      return
    }
    const statusCode = typeof (error as { statusCode?: number }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500
    if (statusCode >= 400 && statusCode < 500) {
      const message = error instanceof Error ? error.message : '请求不合法'
      reply.code(statusCode).send(toErrorBody(badRequest(message || '请求不合法', 'invalid_request')))
      return
    }
    request.log.error({ err: error }, 'unhandled error')
    reply.code(500).send({
      error: { code: 'internal_error', message: '服务器内部错误' },
    })
  })
}

export function rateLimitError(retryAfterSec: number): AppError {
  return rateLimited(retryAfterSec)
}
