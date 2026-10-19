/**
 * 文件分享 HTTP 路由。
 *
 * - 登录端点：创建 / 列表 / 吊销，需要会话 + CSRF。
 * - 公开端点：metadata / unlock / content，不挂会话认证，但做 Origin 校验（POST）与进程内限流；
 *   密码分享通过 5 分钟 HttpOnly `af_share` Cookie 解锁，Cookie path 限定到单个 token。
 * - content 支持 HEAD/ETag/Range；只有在会话首次成功取内容时才计入下载次数。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../../config.ts'
import type { ContentAccess, ShareService } from '../../shares/service.ts'
import { SHARE_SESSION_TTL_SECONDS } from '../../shares/service.ts'
import { SlidingWindowLimiter } from '../../auth/limiter.ts'
import { requestMeta } from '../request-meta.ts'
import { AppError, forbidden, rateLimited } from '../../util/errors.ts'
import { sha256Hex } from '../../util/ids.ts'
import { asRecord, actorFrom, clientIp, contentDisposition, parseRange } from '../util.ts'
import { csrfGuard, requireAuth } from '../guards.ts'

const SHARE_COOKIE = 'af_share'
const COOKIE_PATH_PREFIX = '/api/public/shares/'

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

/** 公开 POST 的来源校验：仅允许 appOrigin/aiOrigin，或 loopback 开发环境。 */
function assertAllowedOrigin(request: FastifyRequest, config: Config): void {
  const origin = firstHeader(request.headers.origin)
  if (!origin) throw forbidden('缺少 Origin 请求头', 'origin_rejected')
  if (origin === config.appOrigin || origin === config.aiOrigin) return
  // 协议/Host 只信 requestMeta（trustProxy:false，仅 loopback 对端采信 Cloudflare 头）。
  const meta = requestMeta(request)
  if (config.allowInsecureLoopback && meta.loopback) {
    try {
      const parsed = new URL(origin)
      const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
      if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1') {
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return
      }
    } catch {
      throw forbidden('Origin 不合法', 'origin_rejected')
    }
  }
  throw forbidden('来源校验失败', 'origin_rejected')
}

function shareCookiePath(token: string): string {
  return `${COOKIE_PATH_PREFIX}${token}`
}

function setShareCookie(
  reply: FastifyReply,
  request: FastifyRequest,
  token: string,
  value: string,
  maxAgeSeconds: number,
): void {
  // trustProxy:false 时 request.protocol 恒为 http；生产 https 由 requestMeta 按
  // 「仅 loopback 对端采信 X-Forwarded-Proto」的规则还原，保证 af_share 为 Secure。
  const secure = requestMeta(request).protocol === 'https'
  reply.setCookie(SHARE_COOKIE, value, {
    path: shareCookiePath(token),
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: maxAgeSeconds,
  })
}

function shareCookie(request: FastifyRequest): string | null {
  const value = request.cookies?.[SHARE_COOKIE]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function tokenParam(request: FastifyRequest): string {
  return (request.params as { token: string }).token
}

export function registerShareRoutes(app: FastifyInstance, config: Config, shares: ShareService): void {
  const csrf = csrfGuard(config)
  const createLimiter = new SlidingWindowLimiter(60_000, 30)
  const metadataLimiter = new SlidingWindowLimiter(60_000, 120)
  const unlockLimiter = new SlidingWindowLimiter(15 * 60_000, 8)
  const contentLimiter = new SlidingWindowLimiter(60_000, 240)

  function limit(limiter: SlidingWindowLimiter, key: string): void {
    const retry = limiter.hit(key)
    if (retry > 0) throw rateLimited(retry)
  }

  // ---------- 登录用户 ----------

  app.post('/api/files/:id/shares', { preHandler: [requireAuth, csrf] }, async (request, reply) => {
    const context = request.auth
    if (!context) throw new AppError(401, 'unauthenticated', '请先登录')
    limit(createLimiter, context.user.username)
    const params = request.params as { id: string }
    const result = await shares.create(actorFrom(request), params.id, asRecord(request.body))
    reply.code(201)
    return result
  })

  app.get('/api/shares', { preHandler: [requireAuth] }, async () => {
    return shares.list()
  })

  app.delete('/api/shares/:id', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as { id: string }
    const share = shares.revoke(actorFrom(request), params.id)
    return { ok: true, share }
  })

  // ---------- 公开访问 ----------

  app.get('/api/public/shares/:token', async (request, reply) => {
    const ip = clientIp(request)
    limit(metadataLimiter, ip)
    reply.header('x-robots-tag', 'noindex, nofollow')
    return shares.metadata(tokenParam(request), shareCookie(request))
  })

  app.post('/api/public/shares/:token/unlock', async (request, reply) => {
    assertAllowedOrigin(request, config)
    const token = tokenParam(request)
    const ip = clientIp(request)
    limit(metadataLimiter, ip)
    limit(unlockLimiter, `${ip}|${sha256Hex(token)}`)
    const body = asRecord(request.body)
    const password = typeof body.password === 'string' ? body.password : ''
    const result = await shares.unlock(token, password)
    setShareCookie(reply, request, token, result.sessionToken, SHARE_SESSION_TTL_SECONDS)
    reply.header('x-robots-tag', 'noindex, nofollow')
    return {
      ok: true,
      state: result.state,
      share: result.share,
      requiresPassword: false,
      expiresAt: result.expiresAt,
    }
  })

  app.get('/api/public/shares/:token/content', async (request, reply) => {
    const token = tokenParam(request)
    const ip = clientIp(request)
    limit(contentLimiter, ip)
    const method = request.method === 'HEAD' ? 'HEAD' : 'GET'
    const access: ContentAccess = shares.openContent(token, shareCookie(request), method)
    if (access.newSessionToken) {
      setShareCookie(reply, request, token, access.newSessionToken, SHARE_SESSION_TTL_SECONDS)
    }
    const file = access.file
    const size = Number(file.size)
    const etag = `"${file.sha256 ?? file.id}"`
    reply.header('x-robots-tag', 'noindex, nofollow')
    if (request.headers['if-none-match'] === etag) {
      reply.code(304).header('etag', etag).send()
      return
    }
    const range = parseRange(request.headers.range, size)
    if (range === 'invalid') {
      reply.code(416).header('content-range', `bytes */${size}`).send()
      return
    }
    if (access.mustCount) shares.markDownloaded(access, ip)
    const start = range ? range.start : 0
    const end = range ? range.end : Math.max(0, size - 1)
    const length = size === 0 ? 0 : end - start + 1
    reply
      .code(range ? 206 : 200)
      .header('content-type', file.mime ?? 'application/octet-stream')
      .header('content-length', String(length))
      .header('accept-ranges', 'bytes')
      .header('etag', etag)
      .header('cache-control', 'no-store')
      .header('content-disposition', contentDisposition(file.name, false))
    if (range) reply.header('content-range', `bytes ${start}-${end}/${size}`)
    if (size === 0) return reply.send()
    // HEAD 也返回可读流，由 Fastify 的 HEAD onSend 丢弃内容并保留上面设置的 content-length。
    return reply.send(shares.storage.createReadStream(file.id, { start, end }))
  })
}
