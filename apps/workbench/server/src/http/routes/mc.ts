/** Minecraft 状态与白名单路由。 */
import type { FastifyInstance } from 'fastify'
import type { Config } from '../../config.ts'
import type { MinecraftService } from '../../mc/service.ts'
import { SlidingWindowLimiter } from '../../auth/limiter.ts'
import { badRequest, rateLimited } from '../../util/errors.ts'
import { asRecord, actorFrom, clientIp, requireString } from '../util.ts'
import { requireAuth, csrfGuard } from '../guards.ts'

export function registerMcRoutes(app: FastifyInstance, config: Config, mc: MinecraftService): void {
  const csrf = csrfGuard(config)
  const mutationLimiter = new SlidingWindowLimiter(60_000, 10)

  app.get('/api/mc/status', { preHandler: [requireAuth] }, async (request) => {
    const query = asRecord(request.query)
    return mc.status(query.force === '1')
  })

  app.get('/api/mc/whitelist', { preHandler: [requireAuth] }, async () => mc.whitelist())

  app.post('/api/mc/whitelist', { preHandler: [requireAuth, csrf] }, async (request) => {
    const retry = mutationLimiter.hit(clientIp(request))
    if (retry > 0) throw rateLimited(retry)
    const body = asRecord(request.body)
    const name = requireString(body.name, 'name', 64)
    if (!name.trim()) throw badRequest('玩家名不能为空', 'invalid_name')
    const snapshot = await mc.addWhitelist(actorFrom(request), name)
    return { ok: true, name: name.trim(), ...snapshot }
  })

  app.delete('/api/mc/whitelist/:name', { preHandler: [requireAuth, csrf] }, async (request) => {
    const retry = mutationLimiter.hit(clientIp(request))
    if (retry > 0) throw rateLimited(retry)
    const params = request.params as { name: string }
    const snapshot = await mc.removeWhitelist(actorFrom(request), params.name)
    return { ok: true, name: params.name, ...snapshot }
  })
}
