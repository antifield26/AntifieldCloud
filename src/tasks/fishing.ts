import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { depositProduce } from './deposit.ts'
import { countFish, eatIfNeeded, emptySlots, equipItem } from './inventory.ts'
import {
  isExpired,
  requireBot,
  sleep,
  stopSignal,
  TaskError,
  TaskStopError,
  type TaskContext
} from './types.ts'

const CAST_TIMEOUT_MS = 45000
const MAX_CAST_TIMEOUTS = 3
const MIN_ROD_REMAINING = 10

function rodRemaining (item: { durabilityUsed?: number | null, maxDurability?: number | null }): number {
  return (item.maxDurability ?? 0) - (item.durabilityUsed ?? 0)
}

function freshRod (bot: Bot): ReturnType<Bot['inventory']['items']>[number] | null {
  return bot.inventory.items()
    .filter(item => item.name === 'fishing_rod')
    .sort((a, b) => rodRemaining(b) - rodRemaining(a))
    .find(item => rodRemaining(item) > MIN_ROD_REMAINING) ?? null
}

function reelIn (bot: Bot): void {
  try {
    bot.activateItem()
  } catch {
    // ignore
  }
}

async function equipRod (ctx: TaskContext, bot: Bot): Promise<void> {
  const rod = freshRod(bot)
  if (!rod) throw new TaskError('没有可用的鱼竿，先放一根到箱子里')
  await equipItem(bot, rod)
}

async function faceWater (ctx: TaskContext, bot: Bot): Promise<void> {
  const water = new Vec3(ctx.config.fishWater.x, ctx.config.fishWater.y, ctx.config.fishWater.z)
  let block = bot.blockAt(water, false)
  if (block?.name !== 'water') {
    try {
      await bot.waitForChunksToLoad()
    } catch {
      // continue with retries below
    }
    for (let attempt = 0; attempt < 10 && block?.name !== 'water'; attempt++) {
      await sleep(500)
      block = bot.blockAt(water, false)
    }
  }
  if (!block || block.name !== 'water') throw new TaskError('钓点前面没有水了')
  await bot.lookAt(water, true)
}

async function castOnce (ctx: TaskContext, bot: Bot): Promise<void> {
  await equipRod(ctx, bot)
  await faceWater(ctx, bot)
  let timeout: NodeJS.Timeout | null = null
  try {
    await Promise.race([
      bot.fish(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reelIn(bot)
          reject(new TaskError('钓鱼超时了，我重抛一次'))
        }, CAST_TIMEOUT_MS)
      }),
      stopSignal(ctx.signal)
    ])
  } catch (error) {
    reelIn(bot)
    if (error instanceof TaskStopError) throw error
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

interface ItemEntityLike {
  name?: string
  displayName?: string
  position: Vec3
}

function isItemEntity (entity: ItemEntityLike): boolean {
  return entity.name === 'item' || entity.displayName === 'Item'
}

async function collectDrops (ctx: TaskContext, bot: Bot): Promise<void> {
  await sleep(900, ctx.signal)
  for (let pass = 0; pass < 2; pass++) {
    const items = Object.values(bot.entities)
      .filter(entity => {
        if (!isItemEntity(entity as unknown as ItemEntityLike)) return false
        return bot.entity ? bot.entity.position.distanceTo(entity.position) <= 16 : false
      })
    if (items.length === 0) return
    for (const item of items) {
      try {
        await ctx.movement.goNearPoint(item.position.x, item.position.y, item.position.z, 1, 6000, true)
        await sleep(300, ctx.signal)
      } catch (error) {
        if (error instanceof TaskStopError) throw error
        ctx.logger.debug('fishing: item pickup skipped', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
}

export async function runFishing (ctx: TaskContext): Promise<void> {
  const bot = requireBot(ctx)
  if (bot.entity && bot.entity.position.distanceTo(new Vec3(ctx.config.fishStand.x, ctx.config.fishStand.y, ctx.config.fishStand.z)) > 1.5) {
    await ctx.movement.teleportTo(ctx.config.fishStand.x, ctx.config.fishStand.y, ctx.config.fishStand.z)
  }
  await equipRod(ctx, bot)
  let castTimeouts = 0

  while (!ctx.signal.aborted && !isExpired(ctx)) {
    if (ctx.depositRequested()) {
      await depositProduce(ctx)
      ctx.clearDepositRequest()
      continue
    }
    if (bot.health < 8) throw new TaskError('血量太低了，我先回家')
    await ctx.defend()
    await eatIfNeeded(ctx)
    if (emptySlots(bot) <= 3) {
      await depositProduce(ctx)
      if (emptySlots(bot) <= 1) throw new TaskError('背包满了，箱子也存不下了')
      continue
    }
    const before = countFish(bot)
    try {
      await castOnce(ctx, bot)
      castTimeouts = 0
    } catch (error) {
      if (error instanceof TaskStopError) throw error
      castTimeouts += 1
      ctx.logger.warn('fishing: cast failed', {
        attempt: castTimeouts,
        error: error instanceof Error ? error.message : String(error)
      })
      if (castTimeouts >= MAX_CAST_TIMEOUTS) throw new TaskError('连续几次都没钓上来，我先停下')
      await sleep(800, ctx.signal)
      continue
    }
    await collectDrops(ctx, bot)
    const gained = Math.max(0, countFish(bot) - before)
    if (gained > 0) {
      ctx.updateProgress({ fishCaught: ctx.progress.fishCaught + gained })
      ctx.logger.info('fishing: caught', { gained, total: ctx.progress.fishCaught })
    }
  }
}
