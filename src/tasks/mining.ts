import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { Config } from '../config.ts'
import { depositProduce } from './deposit.ts'
import { equipItem } from './inventory.ts'
import { isExpired, requireBot, sleep, TaskError, TaskStopError, type TaskContext } from './types.ts'
import { playerNear, scanExposedOres, type OreTarget } from './resources.ts'

function freshPickaxe (bot: Bot): ReturnType<Bot['inventory']['items']>[number] | null {
  return bot.inventory.items()
    .filter(item => item.name === 'iron_pickaxe')
    .sort((a, b) => ((b.maxDurability ?? 0) - (b.durabilityUsed ?? 0)) - ((a.maxDurability ?? 0) - (a.durabilityUsed ?? 0)))
    .find(item => ((item.maxDurability ?? 0) - (item.durabilityUsed ?? 0)) > 10) ?? null
}

async function moveToOre (ctx: TaskContext, target: Vec3): Promise<void> {
  await ctx.movement.goNearPoint(target.x + 0.5, target.y + 0.5, target.z + 0.5, 3, 15000, true)
}

async function mineOre (ctx: TaskContext, bot: Bot, target: OreTarget): Promise<boolean> {
  const pickaxe = freshPickaxe(bot)
  if (!pickaxe) throw new TaskError('铁镐快坏了，箱子里没有备用镐')
  await equipItem(bot, pickaxe)
  for (let attempt = 0; attempt < 3; attempt++) {
    if (isExpired(ctx)) throw new TaskStopError('任务时间到了')
    await ctx.defend()
    try {
      await moveToOre(ctx, target.position)
      const block = bot.blockAt(target.position, false)
      if (!block || block.name !== target.name) return false
      await bot.lookAt(target.position.offset(0.5, 0.5, 0.5), true)
      await bot.dig(block)
      return true
    } catch (error) {
      ctx.logger.warn('mining: dig failed', {
        position: `${target.position.x},${target.position.y},${target.position.z}`,
        error: error instanceof Error ? error.message : String(error)
      })
      await sleep(300, ctx.signal)
    }
  }
  return false
}

/**
 * Surface-only mining: scan loaded chunks, only mine ore blocks that already
 * have an air-facing side. No stone tunnels and no exploration outside the
 * configured safe zone.
 */
export async function runMining (ctx: TaskContext): Promise<void> {
  const bot = requireBot(ctx)
  const config = ctx.config
  const startedAt = Date.now()
  let lastDeposit = Date.now()
  let cells = surveyCells(config, bot)
  let cellIndex = 0
  let targets = scanExposedOres(bot, config)

  while (!isExpired(ctx)) {
    if (Date.now() - startedAt > config.mining.maxMinutes * 60_000) {
      ctx.logger.info('mining: time limit reached', { ores: ctx.progress.oresMined })
      return
    }
    if (ctx.progress.oresMined >= config.mining.maxOres) return
    await ctx.defend()

    if (targets.length === 0) {
      if (cellIndex >= cells.length) {
        ctx.logger.info('mining: no exposed surface ore found')
        return
      }
      const cell = cells[cellIndex]
      cellIndex += 1
      if (!cell) return
      try {
        await ctx.movement.goNearPoint(cell.x, cell.y, cell.z, 6, 15000, true)
      } catch (error) {
        ctx.logger.warn('mining: survey move failed', {
          cell: `${cell.x},${cell.y},${cell.z}`,
          error: error instanceof Error ? error.message : String(error)
        })
      }
      targets = scanExposedOres(bot, config)
      continue
    }

    const target = targets.shift()
    if (!target) continue
    if (playerNear(bot, target.position, 8)) continue

    const mined = await mineOre(ctx, bot, target)
    if (!mined) continue
    const next = {
      oresMined: ctx.progress.oresMined + 1,
      coalMined: ctx.progress.coalMined + (target.kind === 'coal' ? 1 : 0),
      ironMined: ctx.progress.ironMined + (target.kind === 'iron' ? 1 : 0),
      copperMined: ctx.progress.copperMined + (target.kind === 'copper' ? 1 : 0)
    }
    ctx.updateProgress(next)
    ctx.logger.info('mining: ore mined', { block: target.name, total: next.oresMined })

    if (ctx.progress.oresMined % 16 === 0 || Date.now() - lastDeposit >= 300_000) {
      try {
        await depositProduce(ctx)
        lastDeposit = Date.now()
      } catch (error) {
        if (error instanceof TaskStopError) throw error
        ctx.logger.warn('mining: deposit failed', { error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  throw new TaskStopError('任务时间到了')
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
  if (position) {
    cells.sort((a, b) => position.distanceTo(a) - position.distanceTo(b))
  }
  return cells
}


