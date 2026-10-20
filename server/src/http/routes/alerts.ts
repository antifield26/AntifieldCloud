/**
 * 告警 HTTP 路由：`GET /api/alerts` 返回最近事件、当前状态与只读阈值配置；
 * `POST /api/alerts/test` 发送测试 webhook（会话 + CSRF + 每小时限流）。
 */
import type { FastifyInstance } from 'fastify'
import type { Config } from '../../config.ts'
import type { AlertService } from '../../alerts/service.ts'
import { SlidingWindowLimiter } from '../../auth/limiter.ts'
import { rateLimited, unauthorized } from '../../util/errors.ts'
import { asRecord, parsePositiveInt } from '../util.ts'
import { csrfGuard, requireAuth } from '../guards.ts'

export function registerAlertRoutes(app: FastifyInstance, config: Config, alerts: AlertService): void {
  const csrf = csrfGuard(config)
  const testLimiter = new SlidingWindowLimiter(60 * 60_000, 10)

  app.get('/api/alerts', { preHandler: [requireAuth] }, async (request) => {
    const query = asRecord(request.query)
    const text = (value: unknown, max: number): string | null =>
      typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
    return alerts.list({
      limit: parsePositiveInt(query.limit, 20, 1, 200),
      offset: parsePositiveInt(query.offset, 0, 0, 100_000),
      event: text(query.event, 100),
      status: text(query.status, 20),
      severity: text(query.severity, 20),
    })
  })

  app.post('/api/alerts/test', { preHandler: [requireAuth, csrf] }, async (request) => {
    const context = request.auth
    if (!context) throw unauthorized()
    const retry = testLimiter.hit(context.user.username)
    if (retry > 0) throw rateLimited(retry)
    return alerts.sendTest()
  })
}
