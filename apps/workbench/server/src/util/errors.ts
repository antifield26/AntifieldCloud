/** 统一错误类型与响应序列化，确保 API 不泄露内部细节。 */
export class AppError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly details?: Record<string, unknown>

  constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}

export const badRequest = (message = '请求参数不合法', code = 'invalid_request') => new AppError(400, code, message)
export const unauthorized = (message = '请先登录', code = 'unauthenticated') => new AppError(401, code, message)
export const invalidCredentials = () => new AppError(401, 'invalid_credentials', '用户名或密码错误')
export const invalidCode = () => new AppError(401, 'invalid_code', '验证码无效')
export const challengeExpired = () => new AppError(410, 'challenge_expired', '验证已过期，请重新登录')
export const forbidden = (message = '禁止访问', code = 'forbidden') => new AppError(403, code, message)
export const csrfFailed = () => new AppError(403, 'csrf_failed', '请求校验失败，请刷新页面重试')
export const notFound = (message = '未找到', code = 'not_found') => new AppError(404, code, message)
export const conflict = (message = '资源冲突', code = 'conflict') => new AppError(409, code, message)
export const quotaExceeded = (remaining?: number) =>
  new AppError(409, 'quota_exceeded', '存储空间不足', remaining === undefined ? undefined : { remainingBytes: remaining })
export const tooLarge = (message = '文件超过大小限制') => new AppError(413, 'file_too_large', message)
export const unsupportedMedia = (message = '不支持该文件类型') => new AppError(415, 'unsupported_media_type', message)
export const rateLimited = (retryAfterSec: number) =>
  new AppError(429, 'rate_limited', `尝试次数过多，请 ${Math.ceil(retryAfterSec)} 秒后重试`, { retryAfterSec })
export const insufficientStorage = () => new AppError(507, 'insufficient_storage', '磁盘空间不足')
export const rconUnavailable = (message = 'Minecraft RCON 不可用') => new AppError(502, 'rcon_unavailable', message)

export interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

export function toErrorBody(error: AppError): ErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  }
}
