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
  switch (name) {
    case 'fishing': return '钓鱼'
    case 'farming': return '种田'
    case 'woodcutting': return '砍树'
    case 'mining': return '挖矿'
    case 'forest': return '天然林'
    case 'sleep': return '睡觉'
    case 'patrol': return '巡逻'
    case 'guard': return '守卫'
    case 'escort': return '护送'
    case 'explore': return '探索'
    default: return '任务'
  }
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
  const progressText = (() => {
    if (!task) return ''
    if (task.name === 'woodcutting') {
      return `树 ${task.progress.treesChopped} · 原木 ${task.progress.logsChopped} · 补种 ${task.progress.saplingsPlanted}`
    }
    if (task.name === 'mining') {
      return `矿 ${task.progress.oresMined}（煤 ${task.progress.coalMined}/铁 ${task.progress.ironMined}/铜 ${task.progress.copperMined}）`
    }
    if (task.name === 'forest') {
      return `原木 ${task.progress.naturalLogsChopped} · 补种 ${task.progress.naturalSaplingsPlanted}`
    }
    if (task.name === 'sleep') return task.progress.nightSkipped > 0 ? '已跳夜' : '等待投票'
    if (task.name === 'patrol') return `边界点 ${task.progress.patrolWaypoints}`
    if (task.name === 'guard') return `处理威胁 ${task.progress.guardKills} 次`
    if (task.name === 'escort') return `护送距离 ${task.progress.escortDistance} 格`
    if (task.name === 'explore') return `航点 ${task.progress.exploreWaypoints}`
    return `鱼 ${task.progress.fishCaught} · 收 ${task.progress.wheatHarvested} · 种 ${task.progress.planted}`
  })()
  const taskText = task?.active
    ? `任务: ${taskLabel(task.name)} ${task.state} · ${progressText} · 存 ${task.progress.deposited}${queueText}`
    : task?.pendingResume
      ? `任务: 等待恢复 ${taskLabel(task.pendingResume.name)} · 10 分钟内面板确认${queueText}`
      : `任务: 待机${queueText}`
  return [
    `位置 (${posText}) · ${dimensionLabel(bot.game.dimension)} · 血量 ${health}/20 · 饥饿 ${food}/20`,
    `在线: ${playersText || '无'} · 时间 ${time} · ${movement.describe()}`,
    taskText
  ]
}
