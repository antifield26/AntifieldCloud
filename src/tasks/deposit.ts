import type { Bot } from 'mineflayer'
import type { Chest } from 'mineflayer'
import { sleep, TaskError, TaskStopError, requireBot, type TaskContext } from './types.ts'
import { findChest } from './navigation.ts'
import { isFood, isKeptItem } from './inventory.ts'

export interface SupplyRequest {
  name: string
  count: number
}

async function openChest (ctx: TaskContext): Promise<{ bot: Bot, chest: Chest }> {
  const bot = requireBot(ctx)
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (ctx.signal.aborted) throw lastError ?? new TaskError('task stopped')
    if (bot.currentWindow) {
      try {
        await bot.closeWindow(bot.currentWindow)
      } catch {
        // ignore
      }
    }
    try {
      await ctx.movement.waitForChunks()
      const block = findChest(bot, ctx.config)
      const position = bot.entity?.position
      const close = position
        ? Math.hypot(position.x - block.position.x, position.y - block.position.y, position.z - block.position.z) <= 4
        : false
      if (!close) {
        // Chest access is a hard dependency for finishing a task. Pathfinding
        // can be stuck after a stop/failed dig, so use the bounded safe
        // teleport helper when available.
        if (ctx.config.taskAnchorTeleport) {
          await ctx.movement.teleportNearPoint(block.position.x, block.position.y, block.position.z, 4)
        } else {
          await ctx.movement.goNearPoint(block.position.x, block.position.y, block.position.z, 2, 12000, true)
        }
      }
      await ctx.movement.waitForChunks()
      await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
      const chest = await bot.openContainer(block) as Chest
      return { bot, chest }
    } catch (error) {
      if (error instanceof TaskStopError) throw error
      lastError = error instanceof Error ? error : new Error(String(error))
      ctx.logger.warn('task: open chest failed, retrying', {
        attempt: attempt + 1,
        error: lastError.message
      })
      await sleep(500, ctx.signal)
    }
  }
  throw lastError ?? new TaskError('找不到存箱，请确认箱子还在原地')
}

function chestFreeSlots (chest: Chest): number {
  return chest.slots.slice(0, chest.inventoryStart).filter(slot => slot === null).length
}

export async function withdrawSupplies (ctx: TaskContext, requests: SupplyRequest[]): Promise<void> {
  const { bot, chest } = await openChest(ctx)
  try {
    for (const request of requests) {
      const have = bot.inventory.items()
        .filter(item => item.name === request.name)
        .reduce((sum, item) => sum + item.count, 0)
      const missing = Math.max(0, request.count - have)
      if (missing === 0) continue
      const stacks = request.name === 'food'
        ? chest.containerItems().filter(item => isFood(bot, item))
        : chest.containerItems().filter(item => item.name === request.name)
      let remaining = missing
      for (const stack of stacks) {
        if (remaining <= 0) break
        const take = Math.min(remaining, stack.count)
        await chest.withdraw(stack.type, null, take)
        remaining -= take
      }
      if (remaining > 0) {
        throw new TaskError(request.name === 'food' ? '箱子里没有足够的食物' : `箱子里没有足够的 ${request.name}`)
      }
    }
  } finally {
    try {
      await chest.close()
    } catch {
      // ignore
    }
  }
}

export async function depositProduce (ctx: TaskContext): Promise<number> {
  const bot = requireBot(ctx)
  const items = bot.inventory.items().filter(item => !isKeptItem(bot, item))
  if (items.length === 0) return 0
  const { chest } = await openChest(ctx)
  let deposited = 0
  try {
    if (chestFreeSlots(chest) === 0) throw new TaskError('箱子满了，我先停下')
    for (const item of items) {
      try {
        await chest.deposit(item.type, null, item.count)
        deposited += item.count
      } catch (error) {
        throw new TaskError(`存箱失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const remaining = bot.inventory.items().filter(item => !isKeptItem(bot, item))
    if (remaining.length > 0 && chestFreeSlots(chest) === 0) {
      throw new TaskError('箱子满了，还有一些东西没存进去')
    }
  } finally {
    try {
      await chest.close()
    } catch {
      // ignore
    }
  }
  if (deposited > 0) {
    ctx.updateProgress({ deposited: ctx.progress.deposited + deposited })
    ctx.logger.info('task: deposited items', { count: deposited })
  }
  return deposited
}

export async function oneShotDeposit (ctx: TaskContext): Promise<number> {
  return depositProduce(ctx)
}
