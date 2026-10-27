/**
 * Chatbot AI 消息发送工具回调入口（v0.6.4）。
 * 安全边界：无 session/CSRF；turn_token 由 CHATBOT_SECRET_KEY 做 HMAC，只对当前回合有效；
 * 工具只能写入本轮缓冲，实际发送由 ChatbotService 在回合结束时统一执行。
 */
import type { FastifyInstance } from 'fastify'
import type { ChatbotService } from '../../chatbot/service.ts'

export function registerBotAiToolRoutes(app: FastifyInstance, chatbots: ChatbotService): void {
  app.post('/api/chatbot/ai/tool/send', async (request, reply) => {
    const result = chatbots.handleAiSendTool(request.body)
    reply.code(result.status).header('cache-control', 'no-store').send(result.body)
  })
}
