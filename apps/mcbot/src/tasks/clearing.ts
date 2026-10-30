import { isExpired, requireBot, TaskStopError, type TaskContext } from './types.ts'
import { patrolCorners } from './patrol.ts'
import { safeSpotNear } from './navigation.ts'

/**
 * 安全区清怪：沿安全区巡逻点移动，使用任务被动防御白名单主动接战；
 * 不攻击玩家、不追击到安全区外、不破坏/放置方块；低血/低食物沿用 Defender 撤退策略。
 */
export async function runClearing (ctx: TaskContext): Promise<void> {
  const bot = requireBot(ctx)
  const corners = patrolCorners(ctx.config)
  let index = 0
  while (!isExpired(ctx)) {
    if (ctx.signal.aborted) throw new TaskStopError()
    const outcome = await ctx.defend()
    if (outcome === 'cleared') {
      ctx.updateProgress({ mobsKilled: ctx.progress.mobsKilled + 1 })
    }
    const corner = corners[index % corners.length]
    index += 1
    if (!corner) continue
    const spot = safeSpotNear(bot, ctx.config, corner, 24)
    if (!spot) continue
    try {
      await ctx.movement.goNearPoint(spot.x, spot.y, spot.z, 3, 15000, true)
    } catch (error) {
      if (ctx.signal.aborted) throw new TaskStopError()
      ctx.logger.warn('clearing: waypoint unreachable', {
        corner: `${corner.x},${corner.z}`,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
