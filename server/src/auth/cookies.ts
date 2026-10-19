/** 认证 Cookie 的读写与安全属性。仅 loopback HTTP 允许非 Secure Cookie。 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.ts'

export const SESSION_COOKIE = 'af_session'
export const CSRF_COOKIE = 'af_csrf'

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

export interface CookieSecurity {
  secure: boolean
  domain: string | undefined
}

export function cookieSecurity(request: FastifyRequest, config: Config): CookieSecurity {
  const secure = request.protocol === 'https'
  const loopback = isLoopbackHost(request.hostname)
  const domain = secure && !loopback && config.cookieDomain ? config.cookieDomain : undefined
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
