/** 认证与账号路由。 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Config } from '../../config.ts'
import type { AuthService } from '../../auth/service.ts'
import { CSRF_COOKIE, clearAuthCookies, setAuthCookies } from '../../auth/cookies.ts'
import { badRequest } from '../../util/errors.ts'
import { asRecord, clientIp, requireString } from '../util.ts'
import { authOf, csrfGuard, requireAuth } from '../guards.ts'

function userAgent(request: FastifyRequest): string | null {
  const value = request.headers['user-agent']
  return typeof value === 'string' ? value.slice(0, 300) : null
}

export function registerAuthRoutes(app: FastifyInstance, config: Config, auth: AuthService): void {
  const csrf = csrfGuard(config)

  app.post('/api/auth/password', async (request) => {
    const body = asRecord(request.body)
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

  app.get('/api/auth/me', { preHandler: [requireAuth] }, async (request) => {
    const context = authOf(request)
    return {
      user: { username: context.user.username },
      csrfToken: request.cookies?.[CSRF_COOKIE] ?? null,
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
    await auth.changePassword(authOf(request), currentPassword, newPassword)
    return { ok: true }
  })

  app.post('/api/account/recovery-codes', { preHandler: [requireAuth, csrf] }, async (request) => {
    const body = asRecord(request.body)
    const password = requireString(body.password, 'password', 256)
    const codes = await auth.regenerateRecoveryCodes(authOf(request), password)
    return { codes }
  })

  app.post('/api/account/logout-all', { preHandler: [requireAuth, csrf] }, async (request, reply) => {
    auth.logoutAll(authOf(request), clientIp(request))
    clearAuthCookies(reply, request, config)
    return { ok: true }
  })
}
