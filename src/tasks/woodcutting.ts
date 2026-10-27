import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { Config } from '../config.ts'
import { depositProduce, withdrawSupplies } from './deposit.ts'
import { countItem, emptySlots, equipItem } from './inventory.ts'
import {
  isExpired,
  requireBot,
  sleep,
  TaskError,
  TaskStopError,
  type TaskContext
} from './types.ts'

export interface OakTree {
  base: Vec3
  logs: Vec3[]
}

function isLog (name: string | undefined, config: Config): boolean {
  return name === config.treeFarm.logType
}

function inFarm (position: Vec3, config: Config): boolean {
  const farm = config.treeFarm
  return position.x >= farm.minX && position.x <= farm.maxX &&
    position.z >= farm.minZ && position.z <= farm.maxZ &&
    position.y >= farm.logMinY && position.y <= farm.maxY
}

export function scanOakTrees (bot: Bot, config: Config): OakTree[] {
  const farm = config.treeFarm
  const seen = new Set<string>()
  const trees: OakTree[] = []
  const key = (position: Vec3): string => `${position.x},${position.y},${position.z}`

  for (let x = farm.minX; x <= farm.maxX; x++) {
    for (let z = farm.minZ; z <= farm.maxZ; z++) {
      for (let y = farm.logMinY; y <= farm.maxY; y++) {
        const position = new Vec3(x, y, z)
        if (seen.has(key(position))) continue
        const block = bot.blockAt(position, false)
        if (!block) throw new TaskError('树场区块还没加载')
        if (!isLog(block.name, config)) continue

        // BFS one oak tree. Only oak logs inside the configured farm box.
        const logs: Vec3[] = []
        const queue: Vec3[] = [position]
        seen.add(key(position))
        while (queue.length > 0) {
          const current = queue.shift() as Vec3
          logs.push(current)
          for (const offset of [
            new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
            new Vec3(0, 1, 0), new Vec3(0, -1, 0),
            new Vec3(0, 0, 1), new Vec3(0, 0, -1)
          ]) {
            const next = current.plus(offset)
            if (!inFarm(next, config) || seen.has(key(next))) continue
            const nextBlock = bot.blockAt(next, false)
            if (!nextBlock) throw new TaskError('树场区块还没加载')
            if (!isLog(nextBlock.name, config)) continue
            seen.add(key(next))
            queue.push(next)
          }
        }
        if (logs.length === 0) continue
        logs.sort((a, b) => a.y - b.y)
        const base = logs[0] as Vec3
        // Only tree bases on the configured ground layer are valid.
        if (base.y !== farm.logMinY) continue
        trees.push({ base, logs })
      }
    }
  }
  return trees.sort((a, b) => a.base.distanceTo(b.base))
}

function freshAxe (bot: Bot): ReturnType<Bot['inventory']['items']>[number] | null {
  return bot.inventory.items()
    .filter(item => item.name === 'iron_axe')
    .sort((a, b) => ((b.maxDurability ?? 0) - (b.durabilityUsed ?? 0)) - ((a.maxDurability ?? 0) - (a.durabilityUsed ?? 0)))
    .find(item => ((item.maxDurability ?? 0) - (item.durabilityUsed ?? 0)) > 10) ?? null
}

async function moveNear (ctx: TaskContext, position: Vec3): Promise<void> {
  await ctx.movement.goNearPoint(position.x + 0.5, position.y, position.z + 0.5, 2, 12000, true)
}

async function digReachable (ctx: TaskContext, bot: Bot, position: Vec3): Promise<boolean> {
  const block = bot.blockAt(position, false)
  if (!block) throw new TaskError('树场区块还没加载')
  const target = new Vec3(position.x + 0.5, position.y + 0.5, position.z + 0.5)
  let attempts = 0
  while (attempts < 4) {
    const distance = bot.entity?.position.distanceTo(target) ?? 99
    if (distance <= 4.2) {
      try {
        await bot.lookAt(target, true)
        await bot.dig(block)
        return true
      } catch (error) {
        ctx.logger.warn('woodcutting: dig failed', {
          position: `${position.x},${position.y},${position.z}`,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    // Try a short jump for the upper logs of a tall oak.
    bot.setControlState('jump', true)
    await sleep(250, ctx.signal)
    bot.setControlState('jump', false)
    attempts += 1
    await moveNear(ctx, position)
  }
  return false
}

async function plantSapling (ctx: TaskContext, bot: Bot, base: Vec3): Promise<boolean> {
  const sapling = bot.inventory.items().find(item => item.name === ctx.config.treeFarm.saplingType)
  if (!sapling) throw new TaskError('没有橡树树苗了，先补货')
  const below = bot.blockAt(base.offset(0, -1, 0), false)
  if (!below || !['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt'].includes(below.name)) {
    ctx.logger.warn('woodcutting: no soil for sapling', { base: `${base.x},${base.y},${base.z}` })
    return false
  }
  const current = bot.blockAt(base, false)
  if (current && current.name !== 'air') {
    // The base log may still be in place if digging failed; leave it for the next attempt.
    return false
  }
  try {
    await bot.equip(sapling, 'hand')
    await bot.placeBlock(below, new Vec3(0, 1, 0))
    return true
  } catch (error) {
    ctx.logger.warn('woodcutting: plant failed', {
      base: `${base.x},${base.y},${base.z}`,
      error: error instanceof Error ? error.message : String(error)
    })
    return false
  }
}

async function chopTree (ctx: TaskContext, bot: Bot, tree: OakTree): Promise<number> {
  await moveNear(ctx, tree.base)
  const axe = freshAxe(bot)
  if (!axe) throw new TaskError('铁斧快坏了，箱子里没有备用斧')
  await equipItem(bot, axe)
  let chopped = 0
  // Bottom-up keeps later logs reachable from the ground.
  for (const log of tree.logs) {
    if (isExpired(ctx)) throw new TaskStopError('任务时间到了')
    if (await digReachable(ctx, bot, log)) chopped += 1
    if (chopped > 0 && chopped % 4 === 0) await ctx.defend()
  }
  return chopped
}

export async function runWoodcutting (ctx: TaskContext): Promise<void> {
  const bot = requireBot(ctx)
  let lastDeposit = Date.now()
  let totalChopped = 0

  while (!isExpired(ctx)) {
    const trees = scanOakTrees(bot, ctx.config)
    if (trees.length === 0) {
      ctx.logger.info('woodcutting: no mature oak trees')
      return
    }
    let choppedThisPass = false
    for (const tree of trees) {
      if (isExpired(ctx)) throw new TaskStopError('任务时间到了')
      if (ctx.progress.logsChopped >= ctx.config.treeMaxLogs) return
      await ctx.defend()
      const chopped = await chopTree(ctx, bot, tree)
      if (chopped === 0) {
        ctx.logger.warn('woodcutting: tree could not be chopped', { base: `${tree.base.x},${tree.base.y},${tree.base.z}` })
        continue
      }
      choppedThisPass = true
      totalChopped += chopped
      ctx.updateProgress({
        logsChopped: ctx.progress.logsChopped + chopped,
        treesChopped: ctx.progress.treesChopped + 1
      })
      const planted = await plantSapling(ctx, bot, tree.base)
      if (planted) {
        ctx.updateProgress({ saplingsPlanted: ctx.progress.saplingsPlanted + 1 })
      } else {
        ctx.logger.warn('woodcutting: sapling not planted', { base: `${tree.base.x},${tree.base.y},${tree.base.z}` })
      }
      await sleep(250, ctx.signal)
      if (emptySlots(bot) < 4 || Date.now() - lastDeposit >= ctx.config.treeDepositEveryMs) {
        try {
          await depositProduce(ctx)
          lastDeposit = Date.now()
        } catch (error) {
          if (error instanceof TaskStopError) throw error
          ctx.logger.warn('woodcutting: deposit failed', {
            error: error instanceof Error ? error.message : String(error)
          })
        }
        await moveNear(ctx, tree.base)
      }
      if (ctx.progress.logsChopped >= ctx.config.treeMaxLogs) return
    }
    if (!choppedThisPass) {
      ctx.logger.info('woodcutting: no logs chopped this pass')
      return
    }
  }
  throw new TaskStopError('任务时间到了')
}

export async function withdrawWoodcuttingSupplies (ctx: TaskContext): Promise<void> {
  const bot = requireBot(ctx)
  const saplingCount = countItem(bot, ctx.config.treeFarm.saplingType)
  const axes = bot.inventory.items().filter(item => item.name === 'iron_axe')
  await withdrawSupplies(ctx, [
    { name: 'iron_axe', count: Math.max(2, axes.length + 1) },
    { name: ctx.config.treeFarm.saplingType, count: Math.max(16, saplingCount + 8) }
  ])
}
