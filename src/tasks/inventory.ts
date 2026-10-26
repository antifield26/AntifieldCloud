import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import { TaskError, requireBot, type TaskContext } from './types.ts'

const TOOL_NAMES = new Set([
  'iron_sword',
  'iron_shovel',
  'iron_pickaxe',
  'iron_axe',
  'iron_hoe',
  'fishing_rod',
  'wheat_seeds'
])

const FISH_NAMES = new Set(['cod', 'salmon', 'tropical_fish', 'pufferfish'])

export function isFood (bot: Bot, item: Item): boolean {
  const registry = bot.registry as unknown as { foodsByName?: Record<string, unknown> }
  return Boolean(registry.foodsByName?.[item.name])
}

export function isKeptItem (bot: Bot, item: Item): boolean {
  if (TOOL_NAMES.has(item.name)) return true
  // Fish are edible, but they are the fishing product and must be deposited.
  return isFood(bot, item) && !isFish(item)
}

export function isFish (item: Item): boolean {
  return FISH_NAMES.has(item.name)
}

export function findItem (bot: Bot, name: string): Item | null {
  return bot.inventory.items().find(item => item.name === name) ?? null
}

export function countItem (bot: Bot, name: string): number {
  return bot.inventory.items()
    .filter(item => item.name === name)
    .reduce((sum, item) => sum + item.count, 0)
}

export function countFish (bot: Bot): number {
  return bot.inventory.items()
    .filter(isFish)
    .reduce((sum, item) => sum + item.count, 0)
}

export function countFood (bot: Bot): number {
  return bot.inventory.items()
    .filter(item => isFood(bot, item))
    .reduce((sum, item) => sum + item.count, 0)
}

export function emptySlots (bot: Bot): number {
  return bot.inventory.emptySlotCount()
}

export async function equipItem (bot: Bot, item: Item): Promise<void> {
  if (bot.heldItem?.type === item.type) return
  await bot.equip(item, 'hand')
}

export async function eatIfNeeded (ctx: TaskContext): Promise<void> {
  const bot = requireBot(ctx)
  if (bot.food >= 14) return
  const food = bot.inventory.items().find(item => isFood(bot, item))
  if (!food) {
    if (bot.food < 6) throw new TaskError('背包里没有食物了，我先停下')
    ctx.logger.warn('task: low food without food item', { food: bot.food })
    return
  }
  try {
    await bot.equip(food, 'hand')
    await bot.consume()
    ctx.logger.info('task: ate food', { item: food.name, food: bot.food })
  } catch (error) {
    ctx.logger.warn('task: eat failed', { error: error instanceof Error ? error.message : String(error) })
    if (bot.food < 6) throw new TaskError('吃东西失败了，我先停下')
  }
}

export function inventoryItems (bot: Bot): Item[] {
  return bot.inventory.items()
}
