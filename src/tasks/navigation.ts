import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { Config } from '../config.ts'
import type { Block } from 'prismarine-block'
import { TaskError } from './types.ts'

const HAZARD_BLOCKS = new Set(['water', 'lava', 'fire', 'soul_fire', 'cactus', 'magma_block', 'powder_snow', 'sweet_berry_bush'])
const CROP_BLOCKS = new Set(['wheat', 'carrots', 'potatoes', 'beetroot', 'pumpkin_stem', 'melon_stem', 'nether_wart'])

export function insideSafeZone (config: Config, x: number, z: number): boolean {
  return x >= config.safeZone.minX && x <= config.safeZone.maxX &&
    z >= config.safeZone.minZ && z <= config.safeZone.maxZ
}

export function insideFarm (config: Config, x: number, z: number): boolean {
  return x >= config.farm.minX && x <= config.farm.maxX &&
    z >= config.farm.minZ && z <= config.farm.maxZ
}

export function assertSafe (config: Config, x: number, z: number): void {
  if (!insideSafeZone(config, x, z)) {
    throw new TaskError(`目标 (${x.toFixed(1)}, ${z.toFixed(1)}) 在安全区外`)
  }
}

function isTreeBlock (name: string): boolean {
  return name.endsWith('_log') || name.endsWith('_wood') || name.endsWith('_leaves')
}

function isSolidGround (block: Block | null): boolean {
  return block !== null && block.boundingBox === 'block' && !HAZARD_BLOCKS.has(block.name) && !isTreeBlock(block.name)
}

function isClear (block: Block | null): boolean {
  if (!block) return true
  if (HAZARD_BLOCKS.has(block.name) || CROP_BLOCKS.has(block.name)) return false
  return block.boundingBox === 'empty' || block.name === 'air' || block.name === 'cave_air'
}

export function safeSpotNear (bot: Bot, config: Config, point: { x: number, y: number, z: number }, radius = 4): Vec3 | null {
  const centerX = Math.floor(point.x)
  const centerZ = Math.floor(point.z)
  const candidates: Vec3[] = []
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const x = centerX + dx
      const z = centerZ + dz
      if (!insideSafeZone(config, x, z)) continue
      for (let y = Math.floor(point.y) + 2; y >= Math.floor(point.y) - 5; y--) {
        const below = bot.blockAt(new Vec3(x, y - 1, z), false)
        const feet = bot.blockAt(new Vec3(x, y, z), false)
        const head = bot.blockAt(new Vec3(x, y + 1, z), false)
        if (!isSolidGround(below) || !isClear(feet) || !isClear(head)) continue
        candidates.push(new Vec3(x + 0.5, y, z + 0.5))
      }
    }
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.distanceTo(point as Vec3) - b.distanceTo(point as Vec3))
  return candidates[0] ?? null
}

export function findChest (bot: Bot, config: Config): Block {
  const base = bot.blockAt(new Vec3(config.chest.x, config.chest.y, config.chest.z), false)
  if (base?.name === 'chest' || base?.name === 'trapped_chest') return base
  const pair = bot.blockAt(new Vec3(config.chest.x, config.chest.y, config.chest.z + 1), false)
  if (pair?.name === 'chest' || pair?.name === 'trapped_chest') return pair
  throw new TaskError('找不到存箱，请确认箱子还在原地')
}

export function isMatureWheat (block: Block | null): boolean {
  if (!block || block.name !== 'wheat') return false
  const age = block.getProperties().age
  return Number(age) === 7
}

export function findMatureWheat (bot: Bot, config: Config): Block[] {
  const found: Block[] = []
  for (let x = config.farm.minX; x <= config.farm.maxX; x++) {
    for (let z = config.farm.minZ; z <= config.farm.maxZ; z++) {
      const block = bot.blockAt(new Vec3(x, config.farm.cropY, z), false)
      if (isMatureWheat(block)) found.push(block as Block)
    }
  }
  return found
}

export function findEmptyFarmland (bot: Bot, config: Config): Block[] {
  const found: Block[] = []
  for (let x = config.farm.minX; x <= config.farm.maxX; x++) {
    for (let z = config.farm.minZ; z <= config.farm.maxZ; z++) {
      const ground = bot.blockAt(new Vec3(x, config.farm.groundY, z), false)
      const crop = bot.blockAt(new Vec3(x, config.farm.cropY, z), false)
      if (ground?.name === 'farmland' && isClear(crop)) found.push(ground)
    }
  }
  return found
}

export function farmAnchor (config: Config): { x: number, y: number, z: number } {
  return {
    x: (config.farm.minX + config.farm.maxX) / 2 + 0.5,
    y: config.farm.cropY,
    z: (config.farm.minZ + config.farm.maxZ) / 2 + 0.5
  }
}
