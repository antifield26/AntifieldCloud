/** 路由守卫：登录校验 + CSRF 校验。 */
import type { FastifyRequest } from 'fastify'
import type { Config } from '../config.ts'
import type { AuthContext } from '../types.ts'
import { verifyCsrf } from '../auth/csrf.ts'
import { csrfFailed, unauthorized } from '../util/errors.ts'

export async function requireAuth(request: FastifyRequest): Promise<void> {
  if (!request.auth) throw unauthorized()
}

export function authOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized()
  return request.auth
}

export function csrfGuard(config: Config) {
  return async function verifyRequestCsrf(request: FastifyRequest): Promise<void> {
    const context = authOf(request)
    if (!verifyCsrf(request, config, context.session)) throw csrfFailed()
  }
}
