import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { Config } from '../config.ts'
import { requireBot, TaskStopError, type TaskContext } from './types.ts'
import { safeSpotNear } from './navigation.ts'

export function patrolCorners (config: Config): Vec3[] {
  // Inset by 4 blocks so the resulting safe-spot feet/head coordinates are
  // still strictly inside the configured rectangle (a spot at maxX+0.5 would
  // otherwise be rejected by insideSafeZone).
  const inset = 4
  return [
    new Vec3(config.safeZone.minX + inset, 64, config.safeZone.minZ + inset),
    new Vec3(config.safeZone.maxX - inset, 64, config.safeZone.minZ + inset),
    new Vec3(config.safeZone.maxX - inset, 64, config.safeZone.maxZ - inset),
    new Vec3(config.safeZone.minX + inset, 64, config.safeZone.maxZ - inset)
  ]
}

/**
 * One pass around the safe-zone boundary. It does not chase mobs; the normal
 * passive defender handles anything that attacks during travel.
 */
export async function runPatrol (ctx: TaskContext): Promise<void> {
  const bot: Bot = requireBot(ctx)
  const startedAt = Date.now()
  const corners = patrolCorners(ctx.config)
  for (const corner of corners) {
    if (ctx.signal.aborted) throw new TaskStopError()
    await ctx.defend()
    if (Date.now() - startedAt > ctx.config.patrol.maxMinutes * 60_000) return
    const spot = safeSpotNear(bot, ctx.config, corner, 32)
    if (!spot) {
      ctx.logger.warn('patrol: no safe spot near corner', {
        corner: `${corner.x},${corner.z}`
      })
      continue
    }
    const before = bot.entity?.position ?? null
    try {
      await ctx.movement.goNearPoint(spot.x, spot.y, spot.z, 3, 20000, true)
    } catch (error) {
      ctx.logger.warn('patrol: waypoint unreachable', {
        corner: `${corner.x},${corner.z}`,
        error: error instanceof Error ? error.message : String(error)
      })
      continue
    }
    const after = bot.entity?.position ?? null
    const distance = before && after ? before.distanceTo(after) : 0
    ctx.updateProgress({
      patrolWaypoints: ctx.progress.patrolWaypoints + 1,
      patrolDistance: ctx.progress.patrolDistance + distance
    })
    await ctx.defend()
  }
}
