/**
 * Fastify/pino 日志配置：对 Cookie、Authorization、密码、TOTP 与分享 token 做脱敏。
 * 分享 token 只出现在 URL 路径中（/s/<token>、/api/public/shares/<token>），
 * 通过自定义 req serializer 在请求日志里替换，避免 journal/备份日志泄漏可用链接。
 */
import type { FastifyServerOptions } from 'fastify'
import type { Config } from './config.ts'

const CENSOR = '[REDACTED]'
const SHARE_PAGE_PATTERN = /^\/s\/[^/?#]+/
const PUBLIC_SHARE_API_PATTERN = /^\/api\/public\/shares\/[^/?#]+/

/** 把 URL 路径中的分享 token 替换为 [REDACTED]，其余部分保持不变。 */
export function redactSensitiveRequestUrl(rawUrl: string): string {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return ''
  return rawUrl
    .replace(SHARE_PAGE_PATTERN, `/s/${CENSOR}`)
    .replace(PUBLIC_SHARE_API_PATTERN, `/api/public/shares/${CENSOR}`)
}

interface RawRequestLike {
  method?: unknown
  url?: unknown
  headers?: Record<string, unknown>
  socket?: { remoteAddress?: unknown; remotePort?: unknown }
}

/** pino req serializer：保留排障常用字段，URL 中的分享 token 脱敏。 */
export function serializeRequest(request: unknown): Record<string, unknown> {
  const raw = (request ?? {}) as RawRequestLike
  const headers = raw.headers && typeof raw.headers === 'object' ? raw.headers : {}
  return {
    method: typeof raw.method === 'string' ? raw.method : undefined,
    url: redactSensitiveRequestUrl(typeof raw.url === 'string' ? raw.url : ''),
    host: typeof headers.host === 'string' ? headers.host : undefined,
    remoteAddress: typeof raw.socket?.remoteAddress === 'string' ? raw.socket.remoteAddress : undefined,
    remotePort: typeof raw.socket?.remotePort === 'number' ? raw.socket.remotePort : undefined,
  }
}

/** pino res serializer：只记录状态码（响应头/Cookie 不进入日志）。 */
export function serializeResponse(response: unknown): Record<string, unknown> {
  const raw = (response ?? {}) as { statusCode?: unknown }
  return { statusCode: typeof raw.statusCode === 'number' ? raw.statusCode : undefined }
}

export function loggerOptions(config: Config): FastifyServerOptions['logger'] {
  if (config.logLevel === 'silent') return false
  return {
    level: config.logLevel,
    serializers: {
      req: serializeRequest,
      res: serializeResponse,
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'req.body.password',
        'req.body.currentPassword',
        'req.body.newPassword',
        'req.body.code',
        'req.body.recoveryCode',
        '*.password',
        '*.totpSecret',
      ],
      censor: CENSOR,
    },
  }
}
