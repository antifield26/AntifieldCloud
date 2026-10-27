import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { Config } from '../config.ts'
import { depositProduce } from './deposit.ts'
import { equipItem } from './inventory.ts'
import { isExpired, requireBot, sleep, TaskError, TaskStopError, type TaskContext } from './types.ts'
import {
  FOREST_SPECIES,
  forestSpeciesForLog,
  insideProtected,
  isSoil,
  playerNear
} from './resources.ts'

export interface NaturalTree {
  base: Vec3
  logs: Vec3[]
  species: string
}

function seenKey (position: Vec3): string {
  return `${position.x},${position.y},${position.z}`
}

function hasLeavesNear (bot: Bot, log: Vec3, leavesName: string): boolean {
  for (let dx = -3; dx <= 3; dx++) {
    for (let dy = -3; dy <= 3; dy++) {
      for (let dz = -3; dz <= 3; dz++) {
        const block = bot.blockAt(log.offset(dx, dy, dz), false)
        if (block?.name === leavesName) return true
      }
    }
  }
  return false
}

function inForestScan (position: Vec3, config: Config): boolean {
  return position.x >= config.safeZone.minX && position.x <= config.safeZone.maxX &&
    position.z >= config.safeZone.minZ && position.z <= config.safeZone.maxZ &&
    position.y >= 60 && position.y <= 128
}

/**
 * Find natural trees in loaded chunks. A tree must have a log component,
 * matching leaves within 3 blocks, a soil base, and must not be inside a
 * player-build protection box.
 */
export function scanNaturalTrees (bot: Bot, config: Config): NaturalTree[] {
  const seen = new Set<string>()
  const trees: NaturalTree[] = []
  const position = bot.entity?.position ?? null
  const logNames = new Set(config.forest.species.map(species => FOREST_SPECIES[species]?.log).filter(Boolean) as string[])

  for (let x = config.safeZone.minX; x <= config.safeZone.maxX; x++) {
    for (let z = config.safeZone.minZ; z <= config.safeZone.maxZ; z++) {
      if (insideProtected(config, x, z, config.forest.protectRadius)) continue
      for (let y = 60; y <= 128; y++) {
        const start = new Vec3(x, y, z)
        if (seen.has(seenKey(start))) continue
        const startBlock = bot.blockAt(start, false)
        if (!startBlock || !logNames.has(startBlock.name)) continue
        const species = forestSpeciesForLog(config, startBlock.name)
        if (!species) continue
        const spec = FOREST_SPECIES[species]
        if (!spec) continue

        const logs: Vec3[] = []
        const queue: Vec3[] = [start]
        seen.add(seenKey(start))
        while (queue.length > 0) {
          const current = queue.shift() as Vec3
          logs.push(current)
          for (const offset of [
            new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
            new Vec3(0, 1, 0), new Vec3(0, -1, 0),
            new Vec3(0, 0, 1), new Vec3(0, 0, -1)
          ]) {
            const next = current.plus(offset)
            if (!inForestScan(next, config) || seen.has(seenKey(next))) continue
            const block = bot.blockAt(next, false)
            if (!block || block.name !== spec.log) continue
            seen.add(seenKey(next))
            queue.push(next)
          }
        }
        logs.sort((a, b) => a.y - b.y)
        const base = logs[0]
        if (!base) continue
        const below = bot.blockAt(base.offset(0, -1, 0), false)
        if (!isSoil(below?.name)) continue
        if (!logs.some(log => hasLeavesNear(bot, log, spec.leaves))) continue
        if (playerNear(bot, base, 8)) continue
        trees.push({ base, logs, species })
      }
    }
  }
  if (position) trees.sort((a, b) => position.distanceTo(a.base) - position.distanceTo(b.base))
  return trees
}

function freshAxe (bot: Bot): ReturnType<Bot['inventory']['items']>[number] | null {
  return bot.inventory.items()
    .filter(item => item.name === 'iron_axe')
    .sort((a, b) => ((b.maxDurability ?? 0) - (b.durabilityUsed ?? 0)) - ((a.maxDurability ?? 0) - (a.durabilityUsed ?? 0)))
    .find(item => ((item.maxDurability ?? 0) - (item.durabilityUsed ?? 0)) > 10) ?? null
}

async function moveNear (ctx: TaskContext, position: Vec3): Promise<void> {
  await ctx.movement.goNearPoint(position.x + 0.5, position.y, position.z + 0.5, 3, 15000, true)
}

async function digLog (ctx: TaskContext, bot: Bot, log: Vec3): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (isExpired(ctx)) throw new TaskStopError('任务时间到了')
    try {
      await moveNear(ctx, log)
      const block = bot.blockAt(log, false)
      if (!block || !block.name.endsWith('_log')) return false
      await bot.lookAt(log.offset(0.5, 0.5, 0.5), true)
      await bot.dig(block)
      return true
    } catch (error) {
      ctx.logger.warn('forest: dig failed', {
        position: `${log.x},${log.y},${log.z}`,
        error: error instanceof Error ? error.message : String(error)
      })
      await sleep(250, ctx.signal)
    }
  }
  return false
}

async function plantSapling (ctx: TaskContext, bot: Bot, tree: NaturalTree): Promise<boolean> {
  const spec = FOREST_SPECIES[tree.species]
  if (!spec) return false
  const sapling = bot.inventory.items().find(item => item.name === spec.sapling)
  if (!sapling) return false
  const below = bot.blockAt(tree.base.offset(0, -1, 0), false)
  if (!below || !isSoil(below.name)) return false
  const current = bot.blockAt(tree.base, false)
  if (current && current.name !== 'air') return false
  try {
    await bot.equip(sapling, 'hand')
    await bot.placeBlock(below, new Vec3(0, 1, 0))
    return true
  } catch (error) {
    ctx.logger.warn('forest: plant failed', {
      base: `${tree.base.x},${tree.base.y},${tree.base.z}`,
      error: error instanceof Error ? error.message : String(error)
    })
    return false
  }
}

function surveyCells (config: Config, bot: Bot): Vec3[] {
  const cells: Vec3[] = []
  const step = 32
  for (let x = config.safeZone.minX + 16; x <= config.safeZone.maxX; x += step) {
    for (let z = config.safeZone.minZ + 16; z <= config.safeZone.maxZ; z += step) {
      cells.push(new Vec3(x, 64, z))
    }
  }
  const position = bot.entity?.position
  if (position) cells.sort((a, b) => position.distanceTo(a) - position.distanceTo(b))
  return cells
}

export async function runForest (ctx: TaskContext): Promise<void> {
  const bot = requireBot(ctx)
  const config = ctx.config
  let lastDeposit = Date.now()
  let cells = surveyCells(config, bot)
  let cellIndex = 0
  let trees = scanNaturalTrees(bot, config)

  while (!isExpired(ctx)) {
    if (ctx.signal.aborted) throw new TaskStopError()
    if (ctx.progress.naturalLogsChopped >= config.forest.maxLogs) return
    await ctx.defend()
    if (trees.length === 0) {
      if (cellIndex >= cells.length) {
        ctx.logger.info('forest: no natural trees found')
        return
      }
      const cell = cells[cellIndex]
      cellIndex += 1
      if (!cell) return
      try {
        await ctx.movement.goNearPoint(cell.x, cell.y, cell.z, 6, 15000, true)
      } catch (error) {
        ctx.logger.warn('forest: survey move failed', {
          cell: `${cell.x},${cell.y},${cell.z}`,
          error: error instanceof Error ? error.message : String(error)
        })
      }
      trees = scanNaturalTrees(bot, config)
      continue
    }
    const tree = trees.shift()
    if (!tree) continue

    const axe = freshAxe(bot)
    if (!axe) throw new TaskError('铁斧快坏了，箱子里没有备用斧')
    await equipItem(bot, axe)
    let chopped = 0
    for (const log of tree.logs) {
      if (ctx.progress.naturalLogsChopped + chopped >= config.forest.maxLogs) break
      if (await digLog(ctx, bot, log)) chopped += 1
    }
    if (chopped === 0) continue
    ctx.updateProgress({
      forestTreesChopped: ctx.progress.forestTreesChopped + 1,
      naturalLogsChopped: ctx.progress.naturalLogsChopped + chopped
    })
    if (await plantSapling(ctx, bot, tree)) {
      ctx.updateProgress({ naturalSaplingsPlanted: ctx.progress.naturalSaplingsPlanted + 1 })
    }
    ctx.logger.info('forest: tree chopped', {
      species: tree.species,
      logs: chopped,
      total: ctx.progress.naturalLogsChopped
    })
    if (Date.now() - lastDeposit >= config.forest.depositEveryMs) {
      try {
        await depositProduce(ctx)
        lastDeposit = Date.now()
      } catch (error) {
        if (error instanceof TaskStopError) throw error
        ctx.logger.warn('forest: deposit failed', { error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (ctx.progress.naturalLogsChopped % 16 === 0) cells = surveyCells(config, bot)
  }
  throw new TaskStopError('任务时间到了')
}
