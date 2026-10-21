/**
 * Bot 管理 API：仅登录管理员可访问；密钥字段只写不读。
 * 路由不直接访问数据库，全部经 BotService 做校验/审计/限流。
 */
import type { FastifyInstance } from 'fastify'
import type { Config } from '../../config.ts'
import type { BotService } from '../../bot/service.ts'
import type { AuthService } from '../../auth/service.ts'
import { SlidingWindowLimiter } from '../../auth/limiter.ts'
import { isBotPlatform } from '../../bot/types.ts'
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

export function registerBotRoutes(app: FastifyInstance, config: Config, bots: BotService, auth: AuthService): void {
  const csrf = csrfGuard(config)
  const publishLimiter = new SlidingWindowLimiter(60 * 60_000, 20)
  const testLimiter = new SlidingWindowLimiter(60 * 60_000, 20)

  app.get('/api/bots/status', { preHandler: [requireAuth] }, async () => bots.status())

  app.get('/api/bots', { preHandler: [requireAuth] }, async () => ({ items: bots.listBots() }))

  app.post('/api/bots', { preHandler: [requireAuth, csrf] }, async (request) => {
    const body = asRecord(request.body) ?? {}
    const platform = isBotPlatform(body.platform) ? body.platform : null
    if (!platform) throw badRequest('不支持的平台')
    const input = {
      platform,
      name: text(body.name, 80),
      token: text(body.token, 500),
      config: asRecord(body.config) ?? undefined,
      webhookSecret: optionalText(body.webhookSecret, 500),
      publicKey: optionalText(body.publicKey, 200),
      signingSecret: optionalText(body.signingSecret, 500),
    }
    return { bot: bots.createBot(input) }
  })

  app.get('/api/bots/:id', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as Record<string, string>
    return { bot: bots.getBot(requiredId(params.id, 'id')) }
  })

  app.get('/api/bots/:id/metrics', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as Record<string, string>
    const query = asRecord(request.query) ?? {}
    return { metrics: bots.metrics(requiredId(params.id, 'id'), parsePositiveInt(query.hours, 24, 1, 720)) }
  })

  app.patch('/api/bots/:id', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    const body = asRecord(request.body) ?? {}
    const input = {
      name: optionalText(body.name, 80),
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      config: asRecord(body.config) ?? undefined,
      token: optionalText(body.token, 500),
      webhookSecret: optionalText(body.webhookSecret, 500),
      publicKey: optionalText(body.publicKey, 200),
      signingSecret: optionalText(body.signingSecret, 500),
    }
    return { bot: bots.updateBot(requiredId(params.id, 'id'), input) }
  })

  app.delete('/api/bots/:id', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    bots.deleteBot(requiredId(params.id, 'id'))
    return { ok: true }
  })

  app.post('/api/bots/:id/test', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    const body = asRecord(request.body) ?? {}
    const context = authOf(request)
    const retry = testLimiter.hit(`${context.user.username}:${requiredId(params.id, 'id')}`)
    if (retry > 0) throw rateLimited(retry)
    await bots.testBot(requiredId(params.id, 'id'), optionalText(body.targetId, 64))
    return { ok: true }
  })

  app.get('/api/bots/:id/targets', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as Record<string, string>
    return { items: bots.listTargets(requiredId(params.id, 'id')) }
  })

  app.post('/api/bots/:id/targets', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    const body = asRecord(request.body) ?? {}
    const kind = body.kind
    if (kind !== 'channel' && kind !== 'user' && kind !== 'group') throw badRequest('目标类型无效')
    return {
      target: bots.createTarget(requiredId(params.id, 'id'), {
        externalId: text(body.externalId, 128),
        label: text(body.label, 80),
        kind,
        allowCommands: boolean(body.allowCommands),
        allowNotifications: boolean(body.allowNotifications, true),
        quietStartMinute: optionalMinute(body.quietStartMinute),
        quietEndMinute: optionalMinute(body.quietEndMinute),
      }),
    }
  })

  app.patch('/api/bots/:id/targets/:targetId', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    const body = asRecord(request.body) ?? {}
    const kind = body.kind
    return {
      target: bots.updateTarget(requiredId(params.id, 'id'), requiredId(params.targetId, 'targetId'), {
        label: optionalText(body.label, 80),
        kind: kind === 'channel' || kind === 'user' || kind === 'group' ? kind : undefined,
        allowCommands: typeof body.allowCommands === 'boolean' ? body.allowCommands : undefined,
        allowNotifications: typeof body.allowNotifications === 'boolean' ? body.allowNotifications : undefined,
        quietStartMinute: optionalMinute(body.quietStartMinute),
        quietEndMinute: optionalMinute(body.quietEndMinute),
      }),
    }
  })

  app.delete('/api/bots/:id/targets/:targetId', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    bots.deleteTarget(requiredId(params.id, 'id'), requiredId(params.targetId, 'targetId'))
    return { ok: true }
  })

  app.get('/api/bots/:id/deliveries', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as Record<string, string>
    const query = asRecord(request.query) ?? {}
    return {
      items: bots.listDeliveries(requiredId(params.id, 'id'), parsePositiveInt(query.limit, 50, 1, 200)),
    }
  })

  app.post('/api/bots/:id/deliveries/:deliveryId/retry', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    bots.retryDelivery(requiredId(params.id, 'id'), requiredId(params.deliveryId, 'deliveryId'))
    return { ok: true }
  })

  app.get('/api/bots/:id/publish', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as Record<string, string>
    const query = asRecord(request.query) ?? {}
    return {
      items: bots.listPublishJobs(requiredId(params.id, 'id'), parsePositiveInt(query.limit, 50, 1, 200)),
    }
  })

  app.post('/api/bots/:id/publish', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    const body = asRecord(request.body) ?? {}
    const context = authOf(request)
    const retry = publishLimiter.hit(context.user.username)
    if (retry > 0) throw rateLimited(retry)
    // 发布 = 数据外发，要求 TOTP 再认证（BOT-02）；不能用会话+CSRF 直接外发文件。
    const totpCode = text(body.totpCode, 16)
    if (!totpCode) throw badRequest('发布需要 TOTP 验证码', 'totp_required')
    await auth.confirmTotp(context, totpCode, request.ip)
    const media = Array.isArray(body.mediaFileIds)
      ? body.mediaFileIds.map((id) => text(id, 64)).filter(Boolean)
      : []
    return {
      job: bots.createPublish(requiredId(params.id, 'id'), {
        targetId: text(body.targetId, 64),
        text: text(body.text, 4096),
        mediaFileIds: media,
        scheduledAt: optionalText(body.scheduledAt, 40) ?? null,
        confirmText: text(body.confirmText, 20),
      }),
    }
  })

  app.delete('/api/bots/:id/publish/:jobId', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as Record<string, string>
    bots.cancelPublishJob(requiredId(params.id, 'id'), requiredId(params.jobId, 'jobId'))
    return { ok: true }
  })
}
