/**
 * Bot AI 消息发送工具回调入口（v0.6.4）。
 * 安全边界：无 session/CSRF；turn_token 由 BOT_SECRET_KEY 做 HMAC，只对当前回合有效；
 * 工具只能写入本轮缓冲，实际发送由 BotService 在回合结束时统一执行。
 */
import type { FastifyInstance } from 'fastify'
import type { BotService } from '../../bot/service.ts'

export function registerBotAiToolRoutes(app: FastifyInstance, bots: BotService): void {
  app.post('/api/bot/ai/tool/send', async (request, reply) => {
    const result = bots.handleAiSendTool(request.body)
    reply.code(result.status).header('cache-control', 'no-store').send(result.body)
  })
}
