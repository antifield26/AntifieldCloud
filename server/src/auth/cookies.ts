/**
 * 认证 Cookie 的读写与安全属性。
 *
 * 安全边界：
 * - 新 Cookie 一律 host-only（不设置 Domain）：只有签发它的主机（app）会收到；AI 工作区
 *   (ai 主机)通过一次性 SSO ticket 换取 ai 主机自己的 host-only 会话 Cookie。
 * - HttpOnly + Secure + SameSite=Lax；Secure 按请求协议设置，仅 loopback HTTP 例外。
 * - 过渡期清理：登录/退出时额外删除 v0.6.0 之前按父域共享的旧 af_session/af_csrf
 *   （`Domain=<legacyCookieDomain>`、Max-Age=0）；该域只用于删除旧 Cookie，绝不用于设置新值。
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.ts'
import { requestMeta } from '../http/request-meta.ts'

export const SESSION_COOKIE = 'af_session'
export const CSRF_COOKIE = 'af_csrf'

/** Cookie 安全属性：只由请求协议决定，不再有 Domain 作用域。 */
export function cookieSecurity(request: FastifyRequest): { secure: boolean } {
  const meta = requestMeta(request)
  return { secure: meta.protocol === 'https' }
}

/**
 * 删除旧版本父域共享的 af_session/af_csrf（过渡期，仅当配置了清理域时）。
 * 供登录/退出以及 /api/auth/me 调用：长期不重新登录的浏览器在启动时也会被清理一次，
 * 避免旧父域 Cookie 与新 host-only Cookie 长期共存。
 * 删除请求固定带 Secure（旧 Cookie 是 Secure 的，非 Secure 的删除请求不会覆盖它）。
 */
export function clearLegacyAuthCookies(reply: FastifyReply, config: Config): void {
  const domain = config.legacyCookieDomain
  if (!domain) return
  const base = { path: '/', sameSite: 'lax' as const, secure: true, domain }
  reply.clearCookie(SESSION_COOKIE, { ...base, httpOnly: true })
  reply.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false })
}

export function setAuthCookies(
  reply: FastifyReply,
  request: FastifyRequest,
  config: Config,
  sessionToken: string,
  csrfToken: string,
  expiresAt: string,
): void {
  const { secure } = cookieSecurity(request)
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000))
  const base = { path: '/', sameSite: 'lax' as const, secure }
  reply.setCookie(SESSION_COOKIE, sessionToken, { ...base, httpOnly: true, maxAge })
  reply.setCookie(CSRF_COOKIE, csrfToken, { ...base, httpOnly: false, maxAge })
  clearLegacyAuthCookies(reply, config)
}

/** 仅补发 CSRF Cookie（会话存在但 af_csrf 丢失时使用）。 */
export function setCsrfCookie(reply: FastifyReply, request: FastifyRequest, csrfToken: string, expiresAt: string): void {
  const { secure } = cookieSecurity(request)
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000))
  reply.setCookie(CSRF_COOKIE, csrfToken, {
    path: '/',
    sameSite: 'lax',
    secure,
    httpOnly: false,
    maxAge,
  })
}

export function clearAuthCookies(reply: FastifyReply, request: FastifyRequest, config: Config): void {
  const { secure } = cookieSecurity(request)
  const base = { path: '/', sameSite: 'lax' as const, secure }
  reply.clearCookie(SESSION_COOKIE, { ...base, httpOnly: true })
  reply.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false })
  clearLegacyAuthCookies(reply, config)
}

export function readSessionToken(request: FastifyRequest): string | null {
  const value = request.cookies?.[SESSION_COOKIE]
  return typeof value === 'string' && value.length > 0 ? value : null
}
