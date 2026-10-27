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
  const self = bot.entity
  if (!self) return null
  for (const entity of Object.values(bot.entities)) {
    if (!entity || entity === self) continue
    if (entity.type === 'player') continue
    const name = (entity as { name?: string }).name
    if (!name || !HOSTILE_NAMES.has(name)) continue
    if (self.position.distanceTo(entity.position) <= radius) return name
  }
  return null
}
