import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import { Vec3 } from 'vec3'
import { depositProduce } from './deposit.ts'
import { countItem, eatIfNeeded, emptySlots, findItem } from './inventory.ts'
import { findEmptyFarmland, findMatureWheat } from './navigation.ts'
import {
  isExpired,
  requireBot,
  sleep,
  stopSignal,
  TaskError,
  TaskStopError,
  type TaskContext
} from './types.ts'

async function collectDrops (ctx: TaskContext, bot: Bot): Promise<void> {
  await sleep(600, ctx.signal)
  const items = Object.values(bot.entities).filter(entity => {
    const name = (entity as { name?: string }).name
    const display = (entity as { displayName?: string }).displayName
    if (name !== 'item' && display !== 'Item') return false
    return bot.entity ? bot.entity.position.distanceTo(entity.position) <= 12 : false
  })
  for (const item of items) {
    try {
      await ctx.movement.goNearPoint(item.position.x, item.position.y, item.position.z, 1, 5000, true)
      await sleep(250, ctx.signal)
    } catch (error) {
      if (error instanceof TaskStopError) throw error
      ctx.logger.debug('farming: item pickup skipped', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

async function navigateToBlock (ctx: TaskContext, block: Block): Promise<void> {
  await ctx.movement.goNearPoint(block.position.x, block.position.y, block.position.z, 2, 10000, true)
}

async function plantSeeds (ctx: TaskContext, bot: Bot, farmland: Block): Promise<boolean> {
  const seeds = findItem(bot, 'wheat_seeds')
  if (!seeds) return false
  const cropPos = farmland.position.offset(0, 1, 0)
  const existing = bot.blockAt(cropPos, false)
  if (existing && existing.name !== 'air' && existing.name !== 'cave_air') return false
  try {
    await bot.equip(seeds, 'hand')
    await bot.placeBlock(farmland, new Vec3(0, 1, 0))
    await sleep(250, ctx.signal)
    return true
  } catch (error) {
    ctx.logger.warn('farming: plant failed', {
      position: cropPos,
      error: error instanceof Error ? error.message : String(error)
    })
    return false
  }
}

async function harvestOne (ctx: TaskContext, bot: Bot, crop: Block): Promise<boolean> {
  await navigateToBlock(ctx, crop)
  const farmland = bot.blockAt(crop.position.offset(0, -1, 0), false)
  if (!farmland || farmland.name !== 'farmland') return false
  try {
    await bot.dig(crop)
    ctx.updateProgress({ wheatHarvested: ctx.progress.wheatHarvested + 1 })
    await collectDrops(ctx, bot)
    if (await plantSeeds(ctx, bot, farmland)) {
      ctx.updateProgress({ planted: ctx.progress.planted + 1 })
    }
    ctx.logger.info('farming: harvested', {
      position: crop.position,
      harvested: ctx.progress.wheatHarvested,
      planted: ctx.progress.planted
    })
    return true
  } catch (error) {
    if (error instanceof TaskStopError) throw error
    ctx.logger.warn('farming: harvest failed', {
      position: crop.position,
      error: error instanceof Error ? error.message : String(error)
    })
    return false
  }
}

export async function runFarming (ctx: TaskContext): Promise<void> {
  const bot = requireBot(ctx)
  let lastDepositAt = Date.now()

  while (!ctx.signal.aborted && !isExpired(ctx)) {
    if (ctx.depositRequested()) {
      await depositProduce(ctx)
      ctx.clearDepositRequest()
      lastDepositAt = Date.now()
      continue
    }
    if (bot.health < 8) throw new TaskError('血量太低了，我先回家')
    await eatIfNeeded(ctx)
    if (emptySlots(bot) <= 3) {
      await depositProduce(ctx)
      if (emptySlots(bot) <= 1) throw new TaskError('背包满了，箱子也存不下了')
      lastDepositAt = Date.now()
      continue
    }

    const mature = findMatureWheat(bot, ctx.config)
    if (mature.length > 0) {
      for (const crop of mature) {
        if (ctx.signal.aborted || isExpired(ctx)) break
        await harvestOne(ctx, bot, crop)
      }
      if (Date.now() - lastDepositAt > 5 * 60 * 1000) {
        await depositProduce(ctx)
        lastDepositAt = Date.now()
      }
      continue
    }

    const empty = findEmptyFarmland(bot, ctx.config)
    if (empty.length > 0) {
      if (countItem(bot, 'wheat_seeds') === 0) {
        throw new TaskError('种子用完了，我先停下')
      }
      let planted = 0
      for (const farmland of empty) {
        if (ctx.signal.aborted || isExpired(ctx)) break
        if (countItem(bot, 'wheat_seeds') === 0) break
        await navigateToBlock(ctx, farmland)
        if (await plantSeeds(ctx, bot, farmland)) {
          planted += 1
          ctx.updateProgress({ planted: ctx.progress.planted + 1 })
        }
        if (planted >= 16) break
      }
      if (planted === 0) {
        ctx.logger.warn('farming: could not plant any plot this cycle')
        await sleep(3000, ctx.signal)
      } else {
        ctx.logger.info('farming: planted cycle', { planted })
      }
      if (Date.now() - lastDepositAt > 5 * 60 * 1000) {
        await depositProduce(ctx)
        lastDepositAt = Date.now()
      }
      continue
    }

    // Everything is planted but not mature yet. Keep the task alive while
    // the server ticks crops; deposit on request and stop at the deadline.
    await sleep(5000, ctx.signal)
    if (Date.now() - lastDepositAt > 5 * 60 * 1000) {
      await depositProduce(ctx)
      lastDepositAt = Date.now()
    }
  }
}
