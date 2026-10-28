import type { Bot } from 'mineflayer'

const HOSTILE_NAMES = new Set([
  'zombie',
  'husk',
  'drowned',
  'skeleton',
  'stray',
  'creeper',
  'spider',
  'cave_spider',
  'enderman',
  'witch',
  'slime',
  'magma_cube',
  'pillager',
  'vindicator',
  'evoker',
  'ravager',
  'phantom',
  'blaze',
  'ghast',
  'wither_skeleton',
  'piglin_brute',
  'zoglin',
  'hoglin',
  'silverfish',
  'endermite',
  'guardian',
  'elder_guardian',
  'shulker'
])

export function nearbyHostile (bot: Bot, radius = 8): string | null {
  return nearbyHostiles(bot, radius, 1)[0]?.name ?? null
}

export interface NearbyHostile {
  name: string
  distance: number
}

/** 按距离返回有界敌对生物列表；只读，不改变任务/防御状态。 */
export function nearbyHostiles (bot: Bot, radius = 8, max = 8): NearbyHostile[] {
  const self = bot.entity
  if (!self) return []
  const entities = (bot as unknown as { entities?: Record<string, unknown> }).entities ?? {}
  const found: NearbyHostile[] = []
  for (const entity of Object.values(entities)) {
    if (!entity || entity === self) continue
    const candidate = entity as { type?: string, name?: string, position?: { distanceTo?: (p: unknown) => number } }
    if (candidate.type === 'player') continue
    if (!candidate.name || !HOSTILE_NAMES.has(candidate.name)) continue
    const candidatePosition = candidate.position as unknown as { x?: number, y?: number, z?: number } | undefined
    const px = candidatePosition?.x ?? 0
    const py = candidatePosition?.y ?? 0
    const pz = candidatePosition?.z ?? 0
    const distance = typeof candidate.position?.distanceTo === 'function'
      ? candidate.position.distanceTo(self.position)
      : Math.hypot(px - self.position.x, py - self.position.y, pz - self.position.z)
    if (distance <= radius) found.push({ name: candidate.name, distance: Math.round(distance * 10) / 10 })
  }
  found.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
  return found.slice(0, Math.max(0, max))
}
