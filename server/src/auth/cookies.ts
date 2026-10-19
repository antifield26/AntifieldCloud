/** 认证 Cookie 的读写与安全属性。仅 loopback HTTP 允许非 Secure Cookie。 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.ts'
import { isLoopbackHostname } from '../http/host.ts'
import { requestMeta } from '../http/request-meta.ts'

export const SESSION_COOKIE = 'af_session'
export const CSRF_COOKIE = 'af_csrf'

/** 兼容旧调用：hostname 为 loopback 名称（127.0.0.1/localhost/::1）。 */
export function isLoopbackHost(hostname: string): boolean {
  return isLoopbackHostname(hostname)
}

export interface CookieSecurity {
  secure: boolean
  domain: string | undefined
}

/**
 * Cookie 安全属性：协议与 hostname 均来自 requestMeta（只信 loopback 对端的
 * Cloudflare 头与原始 Host），不接受 X-Forwarded-Host。
 */
export function cookieSecurity(request: FastifyRequest, config: Config): CookieSecurity {
  const meta = requestMeta(request)
  const secure = meta.protocol === 'https'
  const domain = secure && !meta.loopback && config.cookieDomain ? config.cookieDomain : undefined
  return { secure, domain }
}

export function setAuthCookies(
  reply: FastifyReply,
  request: FastifyRequest,
  config: Config,
  sessionToken: string,
  csrfToken: string,
  expiresAt: string,
): void {
  const { secure, domain } = cookieSecurity(request, config)
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000))
  const base = {
    path: '/',
    sameSite: 'lax' as const,
    secure,
    ...(domain ? { domain } : {}),
  }
  reply.setCookie(SESSION_COOKIE, sessionToken, { ...base, httpOnly: true, maxAge })
  reply.setCookie(CSRF_COOKIE, csrfToken, { ...base, httpOnly: false, maxAge })
}

/** 仅补发 CSRF Cookie（会话存在但 af_csrf 丢失时使用）。 */
export function setCsrfCookie(
  reply: FastifyReply,
  request: FastifyRequest,
  config: Config,
  csrfToken: string,
  expiresAt: string,
): void {
  const { secure, domain } = cookieSecurity(request, config)
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000))
  reply.setCookie(CSRF_COOKIE, csrfToken, {
    path: '/',
    sameSite: 'lax',
    secure,
    httpOnly: false,
    maxAge,
    ...(domain ? { domain } : {}),
  })
}

export function clearAuthCookies(reply: FastifyReply, request: FastifyRequest, config: Config): void {
  const { secure, domain } = cookieSecurity(request, config)
  const base = { path: '/', sameSite: 'lax' as const, secure, ...(domain ? { domain } : {}) }
  reply.clearCookie(SESSION_COOKIE, { ...base, httpOnly: true })
  reply.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false })
}

export function readSessionToken(request: FastifyRequest): string | null {
  const value = request.cookies?.[SESSION_COOKIE]
  return typeof value === 'string' && value.length > 0 ? value : null
}
