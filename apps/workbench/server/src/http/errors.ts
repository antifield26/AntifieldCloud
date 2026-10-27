/** 统一异常处理：AppError → 结构化 JSON；未知错误只记录、不泄露内部细节。 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  rateLimited,
  tooLarge,
  toErrorBody,
  unauthorized,
  unsupportedMedia,
} from '../util/errors.ts'

interface FastifyLikeError {
  code?: unknown
  statusCode?: unknown
  message?: unknown
}

/** Fastify/multipart 的已知错误码 → 稳定错误体（不回显原始 message）。 */
const KNOWN_ERRORS: Record<string, () => AppError> = {
  FST_REQ_FILE_TOO_LARGE: () => tooLarge('文件超过大小限制'),
  FST_FILES_LIMIT: () => tooLarge('单次上传文件数量超限'),
  FST_FIELDS_LIMIT: () => badRequest('表单字段过多', 'invalid_multipart'),
  FST_PARTS_LIMIT: () => badRequest('表单分段过多', 'invalid_multipart'),
  FST_INVALID_MULTIPART_CONTENT_TYPE: () => badRequest('需要 multipart/form-data 请求', 'invalid_multipart'),
  FST_ERR_CTP_BODY_TOO_LARGE: () => tooLarge('请求体超过大小限制'),
  FST_ERR_CTP_INVALID_MEDIA_TYPE: () => unsupportedMedia(),
  FST_ERR_CTP_INVALID_JSON_BODY: () => badRequest('请求体不是合法 JSON'),
  FST_ERR_CTP_EMPTY_JSON_BODY: () => badRequest('请求体不能为空'),
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: () => badRequest('Content-Length 不合法'),
}

/** 未知 4xx 的兜底文案：只按状态码给通用信息，绝不回显 error.message/路径。 */
const STATUS_FALLBACKS: Record<number, () => AppError> = {
  400: () => badRequest(),
  401: () => unauthorized(),
  403: () => forbidden(),
  404: () => notFound('接口不存在'),
  409: () => conflict(),
  413: () => tooLarge(),
  415: () => unsupportedMedia(),
  429: () => rateLimited(60),
}

function send(reply: FastifyReply, error: AppError): void {
  if (error.statusCode === 429) {
    const retry = Number(error.details?.retryAfterSec ?? 60)
    reply.header('retry-after', String(Math.max(1, Math.ceil(retry))))
  }
  reply.code(error.statusCode).send(toErrorBody(error))
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      send(reply, error)
      return
    }
    const code = typeof (error as FastifyLikeError).code === 'string' ? ((error as FastifyLikeError).code as string) : ''
    const known = KNOWN_ERRORS[code]
    if (known) {
      send(reply, known())
      return
    }
    const statusCode = typeof (error as FastifyLikeError).statusCode === 'number' ? ((error as FastifyLikeError).statusCode as number) : 500
    if (statusCode >= 400 && statusCode < 500) {
      const fallback = STATUS_FALLBACKS[statusCode] ?? (() => badRequest())
      send(reply, fallback())
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
