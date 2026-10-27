import type { Bot } from 'mineflayer'
import type { Chest } from 'mineflayer'
import { sleep, TaskError, TaskStopError, requireBot, type TaskContext } from './types.ts'
import { findChestAt } from './navigation.ts'
import { isFood, isKeptItem, itemStorageCategory, type StorageCategory } from './inventory.ts'
import type { ConfigPoint } from '../config.ts'

export interface SupplyRequest {
  name: string
  count: number
}

function chestPoint (ctx: TaskContext, category: StorageCategory): ConfigPoint {
  return ctx.config.storageChests[category] ?? ctx.config.chest
}

function chestLabel (category: StorageCategory): string {
  switch (category) {
    case 'ores': return '矿石箱'
    case 'food': return '食物箱'
    case 'saplings': return '树苗箱'
    case 'misc': return '杂物箱'
  }
}

async function openChestAt (ctx: TaskContext, point: ConfigPoint, label: string): Promise<{ bot: Bot, chest: Chest }> {
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
      const block = findChestAt(bot, point, label)
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
        label,
        error: lastError.message
      })
      await sleep(500, ctx.signal)
    }
  }
  throw lastError ?? new TaskError(`找不到${label}，请确认箱子还在原地`)
}

function chestFreeSlots (chest: Chest): number {
  return chest.slots.slice(0, chest.inventoryStart).filter(slot => slot === null).length
}

export async function withdrawSupplies (ctx: TaskContext, requests: SupplyRequest[]): Promise<void> {
  const categories: StorageCategory[] = ['food', 'saplings', 'misc', 'ores']
  for (const category of categories) {
    const categoryRequests = requests.filter(request => supplyCategory(request.name) === category)
    if (categoryRequests.length === 0) continue
    const label = chestLabel(category)
    const { bot, chest } = await openChestAt(ctx, chestPoint(ctx, category), label)
    try {
      for (const request of categoryRequests) {
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
          throw new TaskError(request.name === 'food' ? `${label}里没有足够的食物` : `${label}里没有足够的 ${request.name}`)
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
}

function supplyCategory (name: string): StorageCategory {
  if (name === 'food') return 'food'
  if (name.endsWith('_sapling')) return 'saplings'
  return 'misc'
}

export async function depositProduce (ctx: TaskContext): Promise<number> {
  const bot = requireBot(ctx)
  const items = bot.inventory.items().filter(item => !isKeptItem(bot, item))
  if (items.length === 0) return 0
  const grouped = new Map<StorageCategory, typeof items>()
  for (const item of items) {
    const category = itemStorageCategory(bot, item)
    const bucket = grouped.get(category)
    if (bucket) bucket.push(item)
    else grouped.set(category, [item])
  }
  let deposited = 0
  let lastError: string | null = null
  for (const [category, bucket] of grouped) {
    const label = chestLabel(category)
    let opened: { bot: Bot, chest: Chest } | null = null
    try {
      opened = await openChestAt(ctx, chestPoint(ctx, category), label)
      const { chest } = opened
      if (chestFreeSlots(chest) === 0) throw new TaskError(`${label}满了，我先停下`)
      for (const item of bucket) {
        try {
          await chest.deposit(item.type, null, item.count)
          deposited += item.count
        } catch (error) {
          throw new TaskError(`${label}存箱失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } catch (error) {
      if (error instanceof TaskStopError) throw error
      lastError = error instanceof Error ? error.message : String(error)
      ctx.logger.warn('task: deposit category failed', { category, error: lastError })
    } finally {
      if (opened) {
        try {
          await opened.chest.close()
        } catch {
          // ignore
        }
      }
    }
  }
  if (deposited > 0) {
    ctx.updateProgress({ deposited: ctx.progress.deposited + deposited })
    ctx.logger.info('task: deposited items', { count: deposited })
  }
  // 任分类箱失败都要上抛（即使其他分类已存入），由任务层记录失败并触发 chest_full 告警。
  if (lastError) throw new TaskError(lastError)
  return deposited
}

export async function oneShotDeposit (ctx: TaskContext): Promise<number> {
  return depositProduce(ctx)
}
