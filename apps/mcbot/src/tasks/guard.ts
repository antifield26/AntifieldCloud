import { isExpired, requireBot, sleep, TaskStopError, type TaskContext } from './types.ts'

/**
 * 基地守卫：在 BOT_HOME 附近（GUARD_RADIUS）驻守，只对任务中被动防御白名单内的敌对生物接战，
 * 不主动追击、不 PvP、不离开安全区。超时由 TaskManager 统一收尾。
 */
export async function runGuard (ctx: TaskContext): Promise<void> {
  const bot = requireBot(ctx)
  const { config, movement } = ctx
  while (!isExpired(ctx)) {
    if (ctx.signal.aborted) throw new TaskStopError()
    const outcome = await ctx.defend()
    if (outcome === 'cleared') {
      ctx.updateProgress({ guardKills: ctx.progress.guardKills + 1 })
    }
    const position = bot.entity?.position
    if (position) {
      const distance = Math.hypot(position.x - config.home.x, position.z - config.home.z)
      if (distance > config.guardRadius) {
        try {
          await movement.goNearPoint(config.home.x, config.home.y, config.home.z, 4, 12000, true)
        } catch (error) {
          if (ctx.signal.aborted) throw new TaskStopError()
          ctx.logger.warn('guard: return to base failed', {
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
    }
    await sleep(2000, ctx.signal)
  }
}
