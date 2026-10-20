/**
 * 指标历史路由：`GET /api/metrics?range=1h|6h|24h|7d|30d`。
 *
 * 安全边界：需要登录会话；只读；返回聚合后的主机指标，不含文件内容或路径。
 */
import type { FastifyInstance } from 'fastify'
import type { MetricsService } from '../../metrics/service.ts'
import { asRecord } from '../util.ts'
import { requireAuth } from '../guards.ts'

export function registerMetricsRoutes(app: FastifyInstance, metrics: MetricsService): void {
  app.get('/api/metrics', { preHandler: [requireAuth] }, async (request) => {
    const query = asRecord(request.query)
    return metrics.query(query.range)
  })
}
