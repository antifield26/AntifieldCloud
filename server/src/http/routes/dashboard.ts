/** 仪表盘、审计、版本信息路由。 */
import type { FastifyInstance } from 'fastify'
import type { Config } from '../../config.ts'
import type { DashboardService } from '../../dashboard/service.ts'
import type { DatabaseSync } from 'node:sqlite'
import { listAudit } from '../../auth/audit.ts'
import { asRecord, parsePositiveInt } from '../util.ts'
import { requireAuth } from '../guards.ts'

export function registerDashboardRoutes(
  app: FastifyInstance,
  config: Config,
  dashboard: DashboardService,
  db: DatabaseSync,
): void {
  app.get('/api/dashboard', { preHandler: [requireAuth] }, async () => dashboard.get())

  app.get('/api/audit', { preHandler: [requireAuth] }, async (request) => {
    const query = asRecord(request.query)
    const limit = parsePositiveInt(query.limit, 50, 1, 200)
    const offset = parsePositiveInt(query.offset, 0, 0, 100_000)
    const action = typeof query.action === 'string' && query.action ? query.action : null
    return listAudit(db, { limit, offset, action })
  })

  app.get('/api/version', { preHandler: [requireAuth] }, async () => ({ version: config.appVersion }))
}
