/**
 * Chatbot 管理 API：仅登录管理员可访问；密钥字段只写不读。
 * 路由不直接访问数据库，全部经 ChatbotService 做校验/审计/限流。
 */
import type { FastifyInstance } from 'fastify'
import type { Config } from '../../config.ts'
import type { ChatbotService } from '../../chatbot/service.ts'
import type { AuthService } from '../../auth/service.ts'
import { SlidingWindowLimiter } from '../../auth/limiter.ts'
import { isBotPlatform } from '../../chatbot/types.ts'
import { asRecord, parsePositiveInt } from '../util.ts'
import { authOf, csrfGuard, requireAuth } from '../guards.ts'
import { badRequest, rateLimited } from '../../util/errors.ts'

function text(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function optionalText(value: unknown, max = 200): string | undefined {
  return typeof value === 'string' ? value.trim().slice(0, max) : undefined
}

function boolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** 群消息模式：undefined 表示沿用，非法值交给路由 400。 */
function optionalGroupReplyMode(value: unknown): 'mention' | 'all' | undefined {
  if (value === undefined || value === null) return undefined
  if (value === 'mention' || value === 'all') return value
  throw badRequest('群消息模式无效')
}

/** 静默时段分钟：null 表示清空；非法值交给 service 统一校验。 */
function optionalMinute(value: unknown): number | null | undefined {
  if (value === null) return null
  if (typeof value !== 'number') return undefined
  return value
}

function requiredId(value: unknown, name: string): string {
  const id = text(value, 64)
  if (!id) throw badRequest(`${name} 不能为空`)
  return id
}

/** 分页 offset：允许 0，非法值回退 0。 */
function offsetOf(value: unknown): number {
  const parsed = Number(value ?? 0)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, Math.floor(parsed))
}

/** 事件结果筛选：只接受已知 outcome，其余交给 service 校验。 */
function optionalOutcome(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 32) : undefined
}

export function registerBotRoutes(app: FastifyInstance, config: Config, chatbots: ChatbotService, auth: AuthService): void {
  const csrf = csrfGuard(config)
  const publishLimiter = new SlidingWindowLimiter(60 * 60_000, 20)
  const testLimiter = new SlidingWindowLimiter(60 * 60_000, 20)
  const connectivityLimiter = new SlidingWindowLimiter(60_000, 30)
  const checkLimiter = new SlidingWindowLimiter(60_000, 30)
  const retryFailedLimiter = new SlidingWindowLimiter(60_000, 10)

  app.get('/api/chatbots/status', { preHandler: [requireAuth] }, async () => chatbots.status())

  app.get('/api/chatbots/connectivity', { preHandler: [requireAuth] }, async () => chatbots.connectivityStatus())

  app.post('/api/chatbots/connectivity/check', { preHandler: [requireAuth, csrf] }, async () => {
    if (connectivityLimiter.hit('global') > 0) throw rateLimited(60)
    return chatbots.checkConnectivity()
  })

  app.get('/api/chatbots', { preHandler: [requireAuth] }, async () => ({ items: chatbots.listBots() }))

  app.post('/api/chatbots', { preHandler: [requireAuth, csrf] }, async (request) => {
    const body = asRecord(request.body) ?? {}
    const platform = isBotPlatform(body.platform) ? body.platform : null
    if (!platform) throw badRequest('不支持的平台')
    const input = {
      platform,
      name: text(body.name, 80),
      token: text(body.token, 500),
      config: asRecord(body.config) ?? undefined,
    }
    return { chatbot: chatbots.createBot(input) }
  })

  app.get('/api/chatbots/:id', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as Record<string, string>
    return { chatbot: chatbots.getBot(requiredId(params.id, 'id')) }
  })

  app.get('/api/chatbots/:id/metrics', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as Record<string, string>
    const query = asRecord(request.query) ?? {}
    return { metrics: chatbots.metrics(requiredId(params.id, 'id'), parsePositiveInt(query.hours, 24, 1, 720)) }
  })

  app.post('/api/chatbots/:id/check', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    const context = authOf(request)
    const retry = checkLimiter.hit(`${context.user.username}:${requiredId(params.id, 'id')}`)
    if (retry > 0) throw rateLimited(retry)
    return { health: await chatbots.checkBot(requiredId(params.id, 'id')) }
  })

  app.get('/api/chatbots/:id/events', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as Record<string, string>
    const query = asRecord(request.query) ?? {}
    return chatbots.listEvents(requiredId(params.id, 'id'), {
      hours: parsePositiveInt(query.hours, 24, 1, 720),
      limit: parsePositiveInt(query.limit, 50, 1, 200),
      offset: offsetOf(query.offset),
      outcome: optionalOutcome(query.outcome),
    })
  })

  app.get('/api/chatbots/:id/roles', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as Record<string, string>
    const query = asRecord(request.query) ?? {}
    return chatbots.listRoles(requiredId(params.id, 'id'), {
      limit: parsePositiveInt(query.limit, 20, 1, 200),
      offset: offsetOf(query.offset),
    })
  })

  app.patch('/api/chatbots/:id/roles/:userId', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    const body = asRecord(request.body) ?? {}
    if (typeof body.enabled !== 'boolean') throw badRequest('enabled 必须是布尔值')
    chatbots.setRoleEnabled(requiredId(params.id, 'id'), requiredId(params.userId, 'userId'), body.enabled)
    return { ok: true }
  })

  app.delete('/api/chatbots/:id/roles/:userId', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    chatbots.deleteRole(requiredId(params.id, 'id'), requiredId(params.userId, 'userId'))
    return { ok: true }
  })

  app.get('/api/chatbots/:id/group-roles', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as Record<string, string>
    return chatbots.listGroupRoles(requiredId(params.id, 'id'))
  })

  app.get('/api/chatbots/:id/group-roles/:targetId', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as Record<string, string>
    return {
      groupRole: chatbots.getGroupRole(requiredId(params.id, 'id'), requiredId(params.targetId, 'targetId')),
    }
  })

  app.put('/api/chatbots/:id/group-roles/:targetId', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    const body = asRecord(request.body) ?? {}
    return {
      groupRole: chatbots.saveGroupRole(
        requiredId(params.id, 'id'),
        requiredId(params.targetId, 'targetId'),
        text(body.name, 32),
        text(body.prompt, 1000),
      ),
    }
  })

  app.patch('/api/chatbots/:id/group-roles/:targetId', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    const body = asRecord(request.body) ?? {}
    if (typeof body.enabled !== 'boolean') throw badRequest('enabled 必须是布尔值')
    chatbots.setGroupRoleEnabled(
      requiredId(params.id, 'id'),
      requiredId(params.targetId, 'targetId'),
      body.enabled,
    )
    return { ok: true }
  })

  app.delete('/api/chatbots/:id/group-roles/:targetId', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    chatbots.deleteGroupRole(requiredId(params.id, 'id'), requiredId(params.targetId, 'targetId'))
    return { ok: true }
  })

  app.get('/api/chatbots/:id/memories', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as Record<string, string>
    const query = asRecord(request.query) ?? {}
    return chatbots.listMemories(requiredId(params.id, 'id'), {
      limit: parsePositiveInt(query.limit, 20, 1, 200),
      offset: offsetOf(query.offset),
    })
  })

  app.get('/api/chatbots/:id/group-memories', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as Record<string, string>
    const query = asRecord(request.query) ?? {}
    return chatbots.listGroupMemories(requiredId(params.id, 'id'), {
      limit: parsePositiveInt(query.limit, 20, 1, 200),
      offset: offsetOf(query.offset),
    })
  })

  app.delete('/api/chatbots/:id/group-memories/:scope', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    chatbots.deleteGroupMemory(requiredId(params.id, 'id'), requiredId(params.scope, 'scope'))
    return { ok: true }
  })

  app.get('/api/chatbots/:id/memories/:userId/items', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as Record<string, string>
    const query = asRecord(request.query) ?? {}
    return chatbots.listMemoryItems(requiredId(params.id, 'id'), requiredId(params.userId, 'userId'), {
      limit: parsePositiveInt(query.limit, 20, 1, 200),
      offset: offsetOf(query.offset),
    })
  })

  app.delete('/api/chatbots/:id/memories/:userId/items/:itemId', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    chatbots.deleteMemoryItem(
      requiredId(params.id, 'id'),
      requiredId(params.userId, 'userId'),
      requiredId(params.itemId, 'itemId'),
    )
    return { ok: true }
  })

  app.delete('/api/chatbots/:id/memories/:userId', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    chatbots.deleteMemory(requiredId(params.id, 'id'), requiredId(params.userId, 'userId'))
    return { ok: true }
  })

  app.patch('/api/chatbots/:id', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    const body = asRecord(request.body) ?? {}
    const input = {
      name: optionalText(body.name, 80),
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      config: asRecord(body.config) ?? undefined,
      token: optionalText(body.token, 500),
    }
    return { chatbot: chatbots.updateBot(requiredId(params.id, 'id'), input) }
  })

  app.delete('/api/chatbots/:id', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    chatbots.deleteBot(requiredId(params.id, 'id'))
    return { ok: true }
  })

  app.post('/api/chatbots/:id/test', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    const body = asRecord(request.body) ?? {}
    const context = authOf(request)
    const retry = testLimiter.hit(`${context.user.username}:${requiredId(params.id, 'id')}`)
    if (retry > 0) throw rateLimited(retry)
    await chatbots.testBot(requiredId(params.id, 'id'), optionalText(body.targetId, 64))
    return { ok: true }
  })

  app.get('/api/chatbots/:id/inbound-targets', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as Record<string, string>
    const query = asRecord(request.query) ?? {}
    const limit = Number(query.limit ?? 50)
    return { items: chatbots.listInboundTargets(requiredId(params.id, 'id'), Number.isFinite(limit) ? limit : 50) }
  })

  app.get('/api/chatbots/:id/targets', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as Record<string, string>
    return { items: chatbots.listTargets(requiredId(params.id, 'id')) }
  })

  app.post('/api/chatbots/:id/targets', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    const body = asRecord(request.body) ?? {}
    const kind = body.kind
    if (kind !== 'channel' && kind !== 'user' && kind !== 'group') throw badRequest('目标类型无效')
    return {
      target: chatbots.createTarget(requiredId(params.id, 'id'), {
        externalId: text(body.externalId, 128),
        label: text(body.label, 80),
        kind,
        allowCommands: boolean(body.allowCommands),
        allowNotifications: boolean(body.allowNotifications, true),
        allowChat: boolean(body.allowChat),
        groupReplyMode: optionalGroupReplyMode(body.groupReplyMode),
        quietStartMinute: optionalMinute(body.quietStartMinute),
        quietEndMinute: optionalMinute(body.quietEndMinute),
      }),
    }
  })

  app.patch('/api/chatbots/:id/targets/:targetId', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    const body = asRecord(request.body) ?? {}
    const kind = body.kind
    return {
      target: chatbots.updateTarget(requiredId(params.id, 'id'), requiredId(params.targetId, 'targetId'), {
        label: optionalText(body.label, 80),
        kind: kind === 'channel' || kind === 'user' || kind === 'group' ? kind : undefined,
        allowCommands: typeof body.allowCommands === 'boolean' ? body.allowCommands : undefined,
        allowNotifications: typeof body.allowNotifications === 'boolean' ? body.allowNotifications : undefined,
        allowChat: typeof body.allowChat === 'boolean' ? body.allowChat : undefined,
        groupReplyMode: optionalGroupReplyMode(body.groupReplyMode),
        quietStartMinute: optionalMinute(body.quietStartMinute),
        quietEndMinute: optionalMinute(body.quietEndMinute),
      }),
    }
  })

  app.delete('/api/chatbots/:id/targets/:targetId', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    chatbots.deleteTarget(requiredId(params.id, 'id'), requiredId(params.targetId, 'targetId'))
    return { ok: true }
  })

  app.get('/api/chatbots/:id/deliveries', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as Record<string, string>
    const query = asRecord(request.query) ?? {}
    return {
      items: chatbots.listDeliveries(requiredId(params.id, 'id'), parsePositiveInt(query.limit, 50, 1, 200)),
    }
  })

  app.post('/api/chatbots/:id/deliveries/retry-failed', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    const context = authOf(request)
    const retry = retryFailedLimiter.hit(context.user.username)
    if (retry > 0) throw rateLimited(retry)
    return { retried: chatbots.retryFailedDeliveries(requiredId(params.id, 'id')) }
  })

  app.post('/api/chatbots/:id/deliveries/:deliveryId/retry', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    chatbots.retryDelivery(requiredId(params.id, 'id'), requiredId(params.deliveryId, 'deliveryId'))
    return { ok: true }
  })

  app.get('/api/chatbots/:id/publish', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as Record<string, string>
    const query = asRecord(request.query) ?? {}
    return {
      items: chatbots.listPublishJobs(requiredId(params.id, 'id'), parsePositiveInt(query.limit, 50, 1, 200)),
    }
  })

  app.post('/api/chatbots/:id/publish', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    const body = asRecord(request.body) ?? {}
    const context = authOf(request)
    const retry = publishLimiter.hit(context.user.username)
    if (retry > 0) throw rateLimited(retry)
    // 发布 = 数据外发，要求 TOTP 再认证（CHATBOT-02）；不能用会话+CSRF 直接外发内容。
    const totpCode = text(body.totpCode, 16)
    if (!totpCode) throw badRequest('发布需要 TOTP 验证码', 'totp_required')
    await auth.confirmTotp(context, totpCode, request.ip)
    return {
      job: chatbots.createPublish(requiredId(params.id, 'id'), {
        targetId: text(body.targetId, 64),
        // 不在此截断：超长必须由 service 明确返回 400 publish_text_too_long，避免静默截断后外发。
        text: typeof body.text === 'string' ? body.text : '',
        scheduledAt: optionalText(body.scheduledAt, 40) ?? null,
        confirmText: text(body.confirmText, 20),
      }),
    }
  })

  app.delete('/api/chatbots/:id/publish/:jobId', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    chatbots.cancelPublishJob(requiredId(params.id, 'id'), requiredId(params.jobId, 'jobId'))
    return { ok: true }
  })
}
