/**
 * AI 环境观察：把 bot 当前状态整理成有界、只读、可解释的快照。
 *
 * 安全边界：
 * - 只读取 bot 已加载的状态/区块；不加载新区块、不改世界、不打开容器。
 * - 方块扫描受 allowlist/半径/数量限制，且只保留安全区内目标。
 * - 输出用于提示词/只读工具，不记录到审计正文。
 */
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { Config } from '../config.ts'
import type { TaskSnapshot } from '../state.ts'
import { countFood, emptySlots, itemStorageCategory } from '../tasks/inventory.ts'
import { insideSafeZone } from '../tasks/navigation.ts'
import { nearbyHostiles } from '../tasks/safety.ts'
import { dimensionLabel, minecraftClock } from '../minecraft/status.ts'

/** 可被 inspect_chest 打开的只读容器类型；不接受任意方块。 */
export const CHEST_BLOCK_NAMES = new Set([
  'chest',
  'trapped_chest',
  'barrel',
  'ender_chest'
])

export interface EnvironmentPosition {
  x: number
  y: number
  z: number
}

export interface EnvironmentBlockGroup {
  name: string
  count: number
  distance: number
  nearest: EnvironmentPosition
}

export interface EnvironmentChest {
  type: string
  x: number
  y: number
  z: number
  distance: number
}

export interface EnvironmentInventory {
  freeSlots: number
  food: number
  ores: number
  saplings: number
  misc: number
}

export interface EnvironmentTask {
  active: boolean
  name: string | null
  state: string
  elapsedSec: number
  queueLength: number
  pendingResume: boolean
  failures: number
}

export interface EnvironmentSnapshot {
  connected: boolean
  observedAt: string
  dimension: string
  position: EnvironmentPosition | null
  health: number | null
  food: number | null
  clock: string | null
  weather: 'clear' | 'rain' | 'thunder' | null
  players: string[]
  hostiles: Array<{ name: string, distance: number }>
  heldItem: string | null
  armor: Record<string, string | null>
  inventory: EnvironmentInventory | null
  task: EnvironmentTask
  home: { distance: number | null, dimension: string } | null
  blockers: string[]
  blocks?: EnvironmentBlockGroup[]
  chests?: EnvironmentChest[]
  truncated?: boolean
}

export interface ScanOptions {
  radius: number
  maxBlocks: number
  patterns: string[]
}

export interface ScanResult {
  blocks: EnvironmentBlockGroup[]
  chests: EnvironmentChest[]
  truncated: boolean
}

function round (value: number, digits = 1): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function toPosition (position: Vec3): EnvironmentPosition {
  return { x: round(position.x), y: round(position.y), z: round(position.z) }
}

function distanceTo (from: Vec3, to: Vec3): number {
  if (typeof (from as unknown as { distanceTo?: unknown }).distanceTo === 'function') {
    return from.distanceTo(to)
  }
  return Math.hypot(from.x - to.x, from.y - to.y, from.z - to.z)
}

function gameDimension (bot: Bot): string {
  return (bot.game as unknown as { dimension?: string } | undefined)?.dimension ?? ''
}

function worldTime (bot: Bot): string | null {
  const time = (bot as unknown as { time?: { timeOfDay?: number } }).time?.timeOfDay
  return typeof time === 'number' && Number.isFinite(time) ? minecraftClock(time) : null
}

function expandPatterns (bot: Bot, patterns: string[]): string[] {
  const registry = (bot.registry as unknown as { blocksByName?: Record<string, unknown> }).blocksByName
  const names = new Set<string>()
  for (const pattern of patterns) {
    if (pattern.startsWith('*') && pattern.length > 1) {
      const suffix = pattern.slice(1)
      for (const name of Object.keys(registry ?? {})) {
        if (name.endsWith(suffix)) names.add(name)
      }
    } else if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1)
      for (const name of Object.keys(registry ?? {})) {
        if (name.startsWith(prefix)) names.add(name)
      }
    } else if (pattern) {
      names.add(pattern)
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

/** 扫描安全区内、allowlist 命中的方块；结果按类型聚合，不加载新区块。 */
export function scanEnvironment (bot: Bot, config: Config, options: ScanOptions): ScanResult {
  const empty: ScanResult = { blocks: [], chests: [], truncated: false }
  if (!bot.entity || !bot.inventory) return empty
  const names = expandPatterns(bot, options.patterns)
  if (names.length === 0) return empty
  const positions = bot.findBlocks({
    matching: names as never,
    maxDistance: options.radius,
    count: options.maxBlocks
  })
  const groups = new Map<string, { count: number, distance: number, nearest: EnvironmentPosition }>()
  const chests: EnvironmentChest[] = []
  for (const position of positions) {
    if (!insideSafeZone(config, position.x, position.z)) continue
    const block = bot.blockAt(position, false)
    if (!block || !names.includes(block.name)) continue
    const distance = round(distanceTo(bot.entity.position, position), 1)
    const current = groups.get(block.name)
    if (!current) {
      groups.set(block.name, { count: 1, distance, nearest: toPosition(position) })
    } else {
      current.count += 1
      if (distance < current.distance) {
        current.distance = distance
        current.nearest = toPosition(position)
      }
    }
    if (CHEST_BLOCK_NAMES.has(block.name)) {
      chests.push({
        type: block.name,
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z),
        distance
      })
    }
  }
  const blocks = [...groups.entries()]
    .map(([name, info]) => ({ name, ...info }))
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
  chests.sort((a, b) => a.distance - b.distance || a.type.localeCompare(b.type) || a.x - b.x || a.z - b.z)
  return {
    blocks,
    chests: chests.slice(0, 8),
    truncated: positions.length >= options.maxBlocks
  }
}

function taskSummary (task: TaskSnapshot): EnvironmentTask {
  return {
    active: task.active,
    name: task.name,
    state: task.state,
    elapsedSec: task.elapsedSec,
    queueLength: task.queue.length,
    pendingResume: task.pendingResume !== null,
    failures: task.failures
  }
}

function armorSummary (bot: Bot): Record<string, string | null> {
  const slots = bot.inventory?.slots
  return {
    helmet: slots?.[5]?.name ?? null,
    chestplate: slots?.[6]?.name ?? null,
    leggings: slots?.[7]?.name ?? null,
    boots: slots?.[8]?.name ?? null
  }
}

function blockersFor (
  config: Config,
  bot: Bot | null,
  task: TaskSnapshot,
  health: number | null,
  foodCount: number | null,
  freeSlots: number | null
): string[] {
  const blockers: string[] = []
  if (!bot?.entity) blockers.push('not_connected')
  if (task.pendingResume) blockers.push('pending_resume')
  if (task.active) blockers.push('task_active')
  if (task.queue.length > 0) blockers.push('queue')
  if (health !== null && health <= config.defenseHealthThreshold) blockers.push('low_health')
  if (foodCount !== null && foodCount <= config.defenseFoodThreshold) blockers.push('low_food')
  if (freeSlots !== null && freeSlots <= config.inventoryAlertFreeSlots) blockers.push('inventory_full')
  return blockers
}

/** 构建可注入提示词/工具结果的只读环境快照；scan=true 时才做方块扫描。 */
export function buildEnvironment (
  bot: Bot | null,
  task: TaskSnapshot,
  config: Config,
  options: { scan?: boolean } = {}
): EnvironmentSnapshot {
  const connected = Boolean(bot?.entity)
  const taskInfo = taskSummary(task)
  if (!bot?.entity) {
    return {
      connected: false,
      observedAt: new Date().toISOString(),
      dimension: '未知维度',
      position: null,
      health: null,
      food: null,
      clock: null,
      weather: null,
      players: [],
      hostiles: [],
      heldItem: null,
      armor: { helmet: null, chestplate: null, leggings: null, boots: null },
      inventory: null,
      task: taskInfo,
      home: null,
      blockers: blockersFor(config, bot, task, null, null, null)
    }
  }
  const position = bot.entity.position
  const players = Object.keys(bot.players ?? {})
    .filter(name => name !== bot.username)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 8)
  const rain = (bot as unknown as { isRaining?: boolean }).isRaining === true
  const thunder = (bot as unknown as { thunderState?: number }).thunderState ?? 0
  const weather: EnvironmentSnapshot['weather'] = thunder > 0 ? 'thunder' : rain ? 'rain' : 'clear'
  const heldItem = bot.heldItem?.name ?? null
  const armor = armorSummary(bot)
  let inventory: EnvironmentInventory | null = null
  let foodCount: number | null = null
  let freeSlots: number | null = null
  if (bot.inventory) {
    const counts: Record<'ores' | 'food' | 'saplings' | 'misc', number> = { ores: 0, food: 0, saplings: 0, misc: 0 }
    for (const item of bot.inventory.items()) {
      const category = itemStorageCategory(bot, item)
      counts[category] += item.count
    }
    freeSlots = emptySlots(bot)
    foodCount = countFood(bot)
    inventory = { freeSlots, food: foodCount, ores: counts.ores, saplings: counts.saplings, misc: counts.misc }
  }
  const dimension = dimensionLabel(gameDimension(bot))
  const homeDimension = dimensionLabel('minecraft:overworld')
  const home = {
    distance: gameDimension(bot) === 'minecraft:overworld' || gameDimension(bot) === 'overworld'
      ? round(distanceTo(position, new Vec3(config.home.x, config.home.y, config.home.z)), 1)
      : null,
    dimension: homeDimension
  }
  const snapshot: EnvironmentSnapshot = {
    connected: true,
    observedAt: new Date().toISOString(),
    dimension,
    position: toPosition(position),
    health: Number.isFinite(bot.health) ? Math.round(bot.health) : null,
    food: Number.isFinite(bot.food) ? Math.round(bot.food) : null,
    clock: worldTime(bot),
    weather,
    players,
    hostiles: nearbyHostiles(bot, config.defenseRadius, 8),
    heldItem,
    armor,
    inventory,
    task: taskInfo,
    home,
    blockers: blockersFor(config, bot, task, Number.isFinite(bot.health) ? Math.round(bot.health) : null, foodCount, freeSlots)
  }
  if (options.scan === true) {
    const scan = scanEnvironment(bot, config, {
      radius: config.autonomyScanRadius,
      maxBlocks: config.autonomyScanMaxBlocks,
      patterns: config.autonomyScanBlocks
    })
    snapshot.blocks = scan.blocks
    snapshot.chests = scan.chests
    snapshot.truncated = scan.truncated
  }
  return snapshot
}

/** 提示词用的人类可读摘要；有界，不包含完整方块坐标清单。 */
export function formatEnvironment (snapshot: EnvironmentSnapshot): string {
  const lines: string[] = []
  if (!snapshot.connected) {
    lines.push('环境：mcbot 当前未连接。')
  } else {
    lines.push(`环境：${snapshot.dimension}，坐标 (${snapshot.position?.x ?? '?'}, ${snapshot.position?.y ?? '?'}, ${snapshot.position?.z ?? '?'})，血量 ${snapshot.health ?? '?'}/20，饥饿 ${snapshot.food ?? '?'}/20，时间 ${snapshot.clock ?? '?'}，天气 ${snapshot.weather ?? '?'}。`)
    lines.push(`玩家：${snapshot.players.length > 0 ? snapshot.players.join('、') : '无'}；敌对：${snapshot.hostiles.length > 0 ? snapshot.hostiles.map(h => `${h.name}(${h.distance})`).join('、') : '无'}。`)
    lines.push(`手持：${snapshot.heldItem ?? '空'}；护甲：${Object.entries(snapshot.armor).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join('、') || '无'}。`)
    lines.push(`背包：${snapshot.inventory ? `空格 ${snapshot.inventory.freeSlots}，食物 ${snapshot.inventory.food}，矿石 ${snapshot.inventory.ores}，树苗 ${snapshot.inventory.saplings}，杂项 ${snapshot.inventory.misc}` : '不可读'}。`)
    lines.push(`任务：${snapshot.task.active ? `${snapshot.task.name} ${snapshot.task.state}，已运行 ${snapshot.task.elapsedSec}s` : '空闲'}，排队 ${snapshot.task.queueLength}，待恢复 ${snapshot.task.pendingResume ? '是' : '否'}。`)
    if (snapshot.home) lines.push(`家：距离 ${snapshot.home.distance ?? '?'} 格（${snapshot.home.dimension}）。`)
    if (snapshot.blocks && snapshot.blocks.length > 0) {
      lines.push(`附近方块：${snapshot.blocks.slice(0, 12).map(block => `${block.name}×${block.count}(${block.distance})`).join('、')}${snapshot.truncated ? '（已截断）' : ''}。`)
    }
    if (snapshot.chests && snapshot.chests.length > 0) {
      lines.push(`附近容器：${snapshot.chests.slice(0, 6).map(chest => `${chest.type}(${chest.x},${chest.y},${chest.z})`).join('、')}。`)
    }
    lines.push(`阻塞：${snapshot.blockers.length > 0 ? snapshot.blockers.join('、') : '无'}。`)
  }
  return lines.join('\n')
}
