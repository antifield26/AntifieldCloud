/** Fastify 类型增强：@fastify/cookie 的 request.cookies/reply.setCookie 与认证上下文。 */
import '@fastify/cookie'
import type { AuthContext } from '../types.ts'

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext
  }
}
