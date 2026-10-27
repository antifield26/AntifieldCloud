import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import { Vec3 } from 'vec3'
import type { Config } from '../config.ts'
import { insideSafeZone } from './navigation.ts'
import { requireBot, sleep, TaskStopError, type TaskContext } from './types.ts'

function isNightOrStorm (bot: Bot, serverTicks: number | null): boolean {
  // Prefer the server's RCON `time` value when available. Mineflayer's
  // timeOfDay can be offset on some Paper versions.
  const time = serverTicks ?? bot.time?.timeOfDay ?? 0
  const thunder = typeof bot.thunderState === 'number' ? bot.thunderState : 0
  const night = time >= 12500 && time <= 23000
  return night || thunder > 0 || bot.isRaining === true
}

function isBed (name: string | undefined): boolean {
  return name !== undefined && name.endsWith('_bed')
}

export function findBedNear (bot: Bot, config: Config): Block | null {
  const position = bot.entity?.position
  if (!position) return null
  const radius = Math.floor(config.sleep.bedSearchRadius)
  const beds: Block[] = []
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (!insideSafeZone(config, position.x + dx, position.z + dz)) continue
      for (let dy = -3; dy <= 3; dy++) {
        const block = bot.blockAt(new Vec3(Math.floor(position.x) + dx, Math.floor(position.y) + dy, Math.floor(position.z) + dz), false)
        if (block && isBed(block.name)) beds.push(block)
      }
    }
  }
  beds.sort((a, b) => a.position.distanceTo(position) - b.position.distanceTo(position))
  return beds[0] ?? null
}

/**
 * Vote2Sleep integration. The bot right-clicks a nearby bed to cast its vote;
 * the plugin (minimum 1 player, 40% threshold) skips the night. If the night
 * is not skipped, the task ends normally rather than failing.
 */
export async function runSleep (ctx: TaskContext): Promise<void> {
  const bot = requireBot(ctx)
  const serverTicks = ctx.state.admin.time.ticks
  ctx.updateProgress({ sleepVotes: 0, nightSkipped: 0 })
  ctx.logger.info('sleep: time check', {
    serverTicks,
    timeOfDay: bot.time?.timeOfDay ?? null,
    thunderState: bot.thunderState ?? null,
    isRaining: bot.isRaining ?? null
  })
  if (!isNightOrStorm(bot, serverTicks)) {
    ctx.logger.info('sleep: not night or storm')
    return
  }
  const bed = findBedNear(bot, ctx.config)
  if (!bed) {
    ctx.logger.info('sleep: no bed near home')
    return
  }
  ctx.updateProgress({ sleepVotes: 1 })
  try {
    await ctx.movement.goNearPoint(bed.position.x + 0.5, bed.position.y, bed.position.z + 0.5, 2, 12000, true)
    await bot.activateBlock(bed)
  } catch (error) {
    ctx.logger.warn('sleep: bed interaction failed', {
      error: error instanceof Error ? error.message : String(error)
    })
    return
  }
  const startedAt = Date.now()
  while (Date.now() - startedAt < ctx.config.sleep.voteWaitMs) {
    if (ctx.signal.aborted) throw new TaskStopError()
    if (!isNightOrStorm(bot, ctx.state.admin.time.ticks)) {
      ctx.updateProgress({ nightSkipped: 1 })
      ctx.logger.info('sleep: night skipped')
      return
    }
    await sleep(500, ctx.signal)
  }
  ctx.logger.info('sleep: vote did not skip night')
}
