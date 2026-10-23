/** 认证与账号路由。 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Config } from '../../config.ts'
import { MAX_LOGIN_USERNAME_LENGTH, type AuthService } from '../../auth/service.ts'
import {
  CSRF_COOKIE,
  clearAuthCookies,
  readSessionToken,
  setAuthCookies,
  setCsrfCookie,
} from '../../auth/cookies.ts'
import { badRequest, unauthorized } from '../../util/errors.ts'
import { asRecord, clientIp, requireString } from '../util.ts'
import { authOf, csrfGuard, requireAuth } from '../guards.ts'

function userAgent(request: FastifyRequest): string | null {
  const value = request.headers['user-agent']
  return typeof value === 'string' ? value.slice(0, 300) : null
}

/** 再认证请求体：当前密码 + TOTP 验证码（协议见 docs/API.md）。 */
function reauthFields(body: Record<string, unknown>, passwordField: string): { password: string; totpCode: string } {
  const password = requireString(body[passwordField], passwordField, 256)
  const totpCode = requireString(body.totpCode, 'totpCode', 16)
  return { password, totpCode }
}

export function registerAuthRoutes(app: FastifyInstance, config: Config, auth: AuthService): void {
  const csrf = csrfGuard(config)

  app.post('/api/auth/password', async (request) => {
    const body = asRecord(request.body)
    // 未认证输入：超长用户名直接拒绝，避免整串进入查找/审计（audit 层另有长度兜底）。
    if (typeof body.username === 'string' && body.username.length > MAX_LOGIN_USERNAME_LENGTH) {
      throw badRequest(`用户名不能超过 ${MAX_LOGIN_USERNAME_LENGTH} 个字符`, 'invalid_request')
    }
    const username =
      typeof body.username === 'string' && body.username.trim() ? body.username.trim() : config.adminUsername
    const password = typeof body.password === 'string' ? body.password : ''
    if (!password) throw badRequest('请输入密码', 'invalid_request')
    const result = await auth.beginPasswordLogin({
      username,
      password,
      ip: clientIp(request),
      userAgent: userAgent(request),
    })
    return result
  })

  app.post('/api/auth/totp', async (request, reply) => {
    const body = asRecord(request.body)
    const challenge = requireString(body.challenge, 'challenge', 256)
    const code = typeof body.code === 'string' ? body.code : undefined
    const recoveryCode = typeof body.recoveryCode === 'string' ? body.recoveryCode : undefined
    if (!code && !recoveryCode) throw badRequest('请输入验证码或恢复码', 'invalid_request')
    const result = await auth.completeTotpLogin({
      challenge,
      ...(code ? { code } : {}),
      ...(recoveryCode ? { recoveryCode } : {}),
      ip: clientIp(request),
      userAgent: userAgent(request),
    })
    setAuthCookies(reply, request, config, result.sessionToken, result.csrfToken, result.expiresAt)
    return { user: result.user, csrfToken: result.csrfToken }
  })

  app.post('/api/auth/logout', { preHandler: [requireAuth, csrf] }, async (request, reply) => {
    const context = authOf(request)
    auth.logout(context, clientIp(request))
    clearAuthCookies(reply, request, config)
    return { ok: true }
  })

  app.get('/api/auth/me', { preHandler: [requireAuth] }, async (request, reply) => {
    const context = authOf(request)
    const existing = request.cookies?.[CSRF_COOKIE]
    let csrfToken = typeof existing === 'string' && existing.length > 0 ? existing : null
    // CSRF Cookie 丢失（浏览器清理、跨域策略变化）时轮换并补发，避免前端写操作永久失败。
    if (!csrfToken) {
      csrfToken = auth.rotateCsrfToken(context)
      setCsrfCookie(reply, request, csrfToken, context.session.expires_at)
    }
    return {
      user: { username: context.user.username },
      csrfToken,
      session: {
        createdAt: context.session.created_at,
        expiresAt: context.session.expires_at,
        ip: context.session.ip,
        userAgent: context.session.user_agent,
      },
    }
  })

  app.post('/api/account/password', { preHandler: [requireAuth, csrf] }, async (request) => {
    const body = asRecord(request.body)
    const currentPassword = requireString(body.currentPassword, 'currentPassword', 256)
    const newPassword = requireString(body.newPassword, 'newPassword', 256)
    const totpCode = requireString(body.totpCode, 'totpCode', 16)
    await auth.changePassword(authOf(request), {
      currentPassword,
      newPassword,
      totpCode,
      ip: clientIp(request),
    })
    return { ok: true }
  })

  app.post('/api/account/recovery-codes', { preHandler: [requireAuth, csrf] }, async (request) => {
    const body = asRecord(request.body)
    const fields = reauthFields(body, 'password')
    const codes = await auth.regenerateRecoveryCodes(authOf(request), {
      password: fields.password,
      totpCode: fields.totpCode,
      ip: clientIp(request),
    })
    return { codes }
  })

  app.post('/api/account/logout-all', { preHandler: [requireAuth, csrf] }, async (request, reply) => {
    auth.logoutAll(authOf(request), clientIp(request))
    clearAuthCookies(reply, request, config)
    return { ok: true }
  })

  /**
   * AI 工作区 SSO 入口（app 主机 + 会话）。
   * next 必须是配置 AI_ORIGIN 的完整 URL；签发一次性 ticket 后 302 到
   * `${aiOrigin}/__af/sso/<ticket>?next=<同源相对 path+query>`，绝不重定向到其它 origin。
   */
  app.get('/api/auth/ai-ticket', { preHandler: [requireAuth] }, async (request, reply) => {
    const rawNext = asRecord(request.query).next
    if (typeof rawNext !== 'string' || !rawNext.trim()) throw badRequest('缺少 next 参数', 'invalid_next')
    let target: URL
    try {
      target = new URL(rawNext.trim())
    } catch {
      throw badRequest('next 参数不合法', 'invalid_next')
    }
    if (
      target.origin !== config.aiOrigin ||
      target.username.length > 0 ||
      target.password.length > 0 ||
      target.pathname.startsWith('//')
    ) {
      throw badRequest('next 必须是 AI 工作区同源地址', 'invalid_next')
    }
    const sessionToken = readSessionToken(request)
    if (!sessionToken) throw unauthorized()
    const ticket = auth.createAiSsoTicket(sessionToken, config.aiOrigin)
    const nextPath = `${target.pathname}${target.search}`
    const location = `${config.aiOrigin}/__af/sso/${ticket}?next=${encodeURIComponent(nextPath)}`
    reply.code(302).header('location', location).header('cache-control', 'no-store').send()
  })
}
