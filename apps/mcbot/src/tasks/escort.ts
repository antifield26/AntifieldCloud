import type { Bot } from 'mineflayer'
import { insideSafeZone } from './navigation.ts'
import { isExpired, requireBot, sleep, TaskStopError, type TaskContext } from './types.ts'

/** 选择护送目标：优先在线玩家（排除自己），按名字排序稳定选择。 */
export function pickEscortTarget (bot: Bot, preferred?: string): string | null {
  const names = Object.keys(bot.players)
    .filter(name => name !== bot.username)
    .sort((a, b) => a.localeCompare(b))
  if (preferred && names.includes(preferred)) return preferred
  return names[0] ?? null
}

/**
 * 玩家护送：跟随目标玩家并被动防御其周围威胁；目标离开安全区或下线时回基地，不追出安全区、不 PvP。
 * 这是陪伴行为，不是战斗替身；攻击仍受 Defender/安全白名单约束。
 */
export async function runEscort (ctx: TaskContext): Promise<void> {
  const bot = requireBot(ctx)
  const { config, movement } = ctx
  const preferred = config.commandAllowlist[0]
  let target: string | null = null
  let lastPosition = bot.entity?.position.clone() ?? null
  let saidOutOfZone = false
  while (!isExpired(ctx)) {
    if (ctx.signal.aborted) throw new TaskStopError()
    await ctx.defend()
    if (!target || !bot.players[target]?.entity) {
      target = pickEscortTarget(bot, preferred)
      if (!target) {
        try {
          await movement.goNearPoint(config.home.x, config.home.y, config.home.z, 4, 12000, true)
        } catch {
          // 目标不存在时继续等待；移动失败不视为致命。
        }
        await sleep(2000, ctx.signal)
        continue
      }
      saidOutOfZone = false
      ctx.logger.info('escort: follow target', { target })
    }
    const player = bot.players[target]
    if (!player?.entity) {
      target = null
      continue
    }
    const targetPosition = player.entity.position
    if (!insideSafeZone(config, targetPosition.x, targetPosition.z)) {
      movement.stop('escort: target outside safe zone')
      if (!saidOutOfZone) {
        saidOutOfZone = true
        await ctx.say('你离开安全区了，我在这里等你。')
      }
      await sleep(2000, ctx.signal)
      continue
    }
    const position = bot.entity?.position
    if (position && lastPosition) {
      const moved = position.distanceTo(lastPosition)
      if (moved > 0.5) {
        ctx.updateProgress({ escortDistance: ctx.progress.escortDistance + Math.round(moved) })
      }
    }
    lastPosition = position?.clone() ?? lastPosition
    const distance = position ? position.distanceTo(targetPosition) : 0
    if (distance > config.escortDistance) {
      movement.follow(target)
    } else {
      movement.stop('escort: arrived')
    }
    await sleep(1000, ctx.signal)
  }
  movement.stop('escort: task ended')
}
