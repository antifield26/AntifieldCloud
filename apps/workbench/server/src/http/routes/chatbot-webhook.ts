/**
 * Chatbot 公开 Webhook 入口：无 session/CSRF，按平台签名鉴权。
 * 独立 Fastify scope 使用 raw body 解析，避免影响其它 JSON API。
 */
import type { FastifyInstance } from 'fastify'
import type { Config } from '../../config.ts'
import type { ChatbotService } from '../../chatbot/service.ts'
import { SlidingWindowLimiter } from '../../auth/limiter.ts'
import { requestMeta } from '../request-meta.ts'

export function registerBotWebhookRoutes(app: FastifyInstance, config: Config, chatbots: ChatbotService): void {
  void app.register(async (scope) => {
    const limiter = new SlidingWindowLimiter(60_000, 120)
    scope.addHook('onRequest', async (request, reply) => {
      // 复用统一信任模型：仅当 socket 对端为 loopback 时才采信 CF-Connecting-IP（A5-CHATBOT-06/SEC-05）。
      const ip = requestMeta(request).ip
      const retry = limiter.hit(ip)
      if (retry > 0) {
        reply.code(429).header('retry-after', String(retry)).send({ error: { code: 'rate_limited' } })
        return reply
      }
    })
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: config.chatbotWebhookMaxBodyBytes },
      (_request, body, done) => done(null, body),
    )
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'buffer', bodyLimit: config.chatbotWebhookMaxBodyBytes },
      (_request, body, done) => done(null, body),
    )
    scope.post('/api/chatbot/webhook/:chatbotId', async (request, reply) => {
      const params = request.params as Record<string, string>
      const chatbotId = typeof params.chatbotId === 'string' ? params.chatbotId.trim().slice(0, 64) : ''
      if (!chatbotId) {
        reply.code(404).send({ error: { code: 'not_found' } })
        return
      }
      const headers: Record<string, string | string[] | undefined> = {}
      for (const [key, value] of Object.entries(request.headers)) headers[key.toLowerCase()] = value
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0)
      const result = await chatbots.handleWebhook(chatbotId, headers, body)
      reply.code(result.status).header('cache-control', 'no-store').send(result.body)
    })
  })
}
