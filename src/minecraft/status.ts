import type { Bot } from 'mineflayer'
import type { PlayerSnapshot, TaskSnapshot } from '../state.ts'
import type { MovementManager } from './movement.ts'

const DIMENSION_LABELS: Record<string, string> = {
  'minecraft:overworld': '主世界',
  'minecraft:the_nether': '下界',
  'minecraft:the_end': '末地',
  overworld: '主世界',
  the_nether: '下界',
  the_end: '末地'
}

export function dimensionLabel (dimension: string | null | undefined): string {
  if (!dimension) return '未知维度'
  return DIMENSION_LABELS[dimension] ?? dimension
}

export function buildPlayerSnapshot (bot: Bot | null): PlayerSnapshot {
  if (!bot || !bot.entity) {
    return { dimension: null, position: null, health: null, food: null }
  }
  const position = bot.entity.position
  return {
    dimension: dimensionLabel(bot.game.dimension),
    position: { x: position.x, y: position.y, z: position.z },
    health: bot.health,
    food: bot.food
  }
}

export function minecraftClock (timeOfDay: number): string {
  const normalized = ((timeOfDay + 6000) % 24000 + 24000) % 24000
  const hours = Math.floor(normalized / 1000)
  const minutes = Math.floor(((normalized % 1000) * 60) / 1000)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function taskLabel (name: TaskSnapshot['name']): string {
  if (name === 'fishing') return '钓鱼'
  if (name === 'farming') return '种田'
  if (name === 'woodcutting') return '砍树'
  return '任务'
}

export function buildStatusLines (bot: Bot, movement: MovementManager, task?: TaskSnapshot): string[] {
  if (!bot.entity) return ['我还没完全加载好，稍等一下。']
  const position = bot.entity.position
  const posText = `${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}`
  const health = Math.round(bot.health)
  const food = Math.round(bot.food)
  const time = minecraftClock(bot.time.timeOfDay)
  const players = Object.keys(bot.players).sort((a, b) => a.localeCompare(b))
  const visible = players.slice(0, 6).join('、')
  const playersText = players.length > 6 ? `${visible} 等${players.length}人` : visible
  const queueText = task?.queue.length ? ` · 排队 ${task.queue.length}` : ''
  const taskText = task?.active
    ? task.name === 'woodcutting'
      ? `任务: 砍树 ${task.state} · 树 ${task.progress.treesChopped} · 原木 ${task.progress.logsChopped} · 补种 ${task.progress.saplingsPlanted} · 存 ${task.progress.deposited}${queueText}`
      : `任务: ${taskLabel(task.name)} ${task.state} · 鱼 ${task.progress.fishCaught} · 收 ${task.progress.wheatHarvested} · 种 ${task.progress.planted} · 存 ${task.progress.deposited}${queueText}`
    : task?.pendingResume
      ? `任务: 等待恢复 ${taskLabel(task.pendingResume.name)} · 10 分钟内面板确认${queueText}`
      : `任务: 待机${queueText}`
  return [
    `位置 (${posText}) · ${dimensionLabel(bot.game.dimension)} · 血量 ${health}/20 · 饥饿 ${food}/20`,
    `在线: ${playersText || '无'} · 时间 ${time} · ${movement.describe()}`,
    taskText
  ]
}
