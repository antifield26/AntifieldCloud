/**
 * 导航采样器：把方块碰撞形状转换为“可站立节点/可走邻接”。
 * 安全边界：只读方块，不生成放置/挖掘动作；未知方块或未加载位置一律视为不可通行。
 */
import type { NavArea, NavBlock, NavVector, NavWorld } from './types.ts'

const HAZARD_BLOCKS = new Set([
  'water', 'lava', 'fire', 'soul_fire', 'cactus', 'magma_block', 'powder_snow',
  'sweet_berry_bush', 'wither_rose', 'campfire', 'soul_campfire'
])

const NON_SOLID_NAMES = new Set([
  'air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'fern', 'large_fern',
  'dead_bush', 'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch', 'rail',
  'powered_rail', 'detector_rail', 'activator_rail', 'redstone_wire', 'tripwire',
  'vine', 'ladder', 'snow'
])

export function isHazardBlock (block: NavBlock): boolean {
  return HAZARD_BLOCKS.has(block.name)
}

export function hasCollision (block: NavBlock): boolean {
  if (block.boundingBox === 'block') return true
  return block.shapes.some(shape => {
    const minY = shape[1] ?? 0
    const maxY = shape[4] ?? 0
    return maxY - minY > 1e-6
  })
}

/** 方块顶部相对方块 y 的高度，范围 0–1；用于台阶/楼梯/半砖。 */
export function blockTop (block: NavBlock): number {
  if (block.boundingBox === 'empty' && block.shapes.length === 0) return 0
  let top = 0
  for (const shape of block.shapes) {
    const maxY = shape[4]
    if (typeof maxY === 'number' && maxY > top) top = maxY
  }
  if (top === 0 && block.boundingBox === 'block') return 1
  return Math.max(0, Math.min(1, top))
}

export function isPassable (block: NavBlock | null): boolean {
  if (!block) return false
  if (isHazardBlock(block)) return false
  if (!hasCollision(block)) return true
  return NON_SOLID_NAMES.has(block.name) || block.name.endsWith('_sign')
}

export function isSolidFloor (block: NavBlock | null): boolean {
  if (!block) return false
  if (isHazardBlock(block)) return false
  return hasCollision(block) && blockTop(block) > 0.05
}

export function nodeKey (node: NavVector): string {
  return `${node.x},${node.y},${node.z}`
}

export function insideArea (area: NavArea, x: number, y: number, z: number): boolean {
  return x >= area.minX && x <= area.maxX &&
    z >= area.minZ && z <= area.maxZ &&
    y >= area.minY && y <= area.maxY
}

/** feet 表示脚部所在方块坐标；脚部/头部均需净空，脚下需有实体顶面。 */
export function canStand (world: NavWorld, area: NavArea, x: number, y: number, z: number): boolean {
  if (!insideArea(area, x, y, z)) return false
  if (!isSolidFloor(world.blockAt(x, y - 1, z))) return false
  if (!isPassable(world.blockAt(x, y, z))) return false
  if (!isPassable(world.blockAt(x, y + 1, z))) return false
  return true
}

/** 在给定 x/z 附近找一个与 baseY 相差不超过 1 格抬高/2 格下落的可站立节点。 */
export function findStanding (world: NavWorld, area: NavArea, x: number, z: number, baseY: number): NavVector | null {
  for (let floorY = Math.floor(baseY) + 1; floorY >= Math.floor(baseY) - 2; floorY -= 1) {
    const floor = world.blockAt(x, floorY, z)
    if (!floor || !isSolidFloor(floor)) continue
    const feetY = Math.round(floorY + blockTop(floor))
    if (feetY < baseY - 2 || feetY > baseY + 1) continue
    if (canStand(world, area, x, feetY, z)) return { x, y: feetY, z }
  }
  return null
}

export function startNode (world: NavWorld, area: NavArea, position: NavVector): NavVector | null {
  const x = Math.floor(position.x)
  const z = Math.floor(position.z)
  const y = Math.floor(position.y)
  for (let dy = -1; dy <= 2; dy += 1) {
    const candidate = findStanding(world, area, x, z, y + dy)
    if (candidate) return candidate
  }
  return null
}

export function targetNode (
  world: NavWorld,
  area: NavArea,
  target: NavVector,
  tolerance: number
): NavVector | null {
  const centerX = Math.floor(target.x)
  const centerZ = Math.floor(target.z)
  const radius = Math.max(1, Math.floor(tolerance))
  let best: NavVector | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      const x = centerX + dx
      const z = centerZ + dz
      for (let dy = -2; dy <= 2; dy += 1) {
        const candidate = findStanding(world, area, x, z, Math.floor(target.y) + dy)
        if (!candidate) continue
        const distance = Math.hypot(candidate.x + 0.5 - target.x, candidate.y - target.y, candidate.z + 0.5 - target.z)
        if (distance < bestDistance) {
          best = candidate
          bestDistance = distance
        }
      }
    }
  }
  return best
}

const CARDINAL = [
  { dx: 1, dz: 0 },
  { dx: -1, dz: 0 },
  { dx: 0, dz: 1 },
  { dx: 0, dz: -1 }
] as const

const DIAGONAL = [
  { dx: 1, dz: 1 },
  { dx: 1, dz: -1 },
  { dx: -1, dz: 1 },
  { dx: -1, dz: -1 }
] as const

/**
 * 邻接生成：只使用现有方块，不放置/不挖掘。
 * 对角移动要求两侧正交邻接均可站立，避免擦墙角穿过。
 */
export function neighbors (world: NavWorld, area: NavArea, node: NavVector): NavVector[] {
  const found: NavVector[] = []
  for (const direction of CARDINAL) {
    const next = findStanding(world, area, node.x + direction.dx, node.z + direction.dz, node.y)
    if (next) found.push(next)
  }
  for (const direction of DIAGONAL) {
    const sideA = findStanding(world, area, node.x + direction.dx, node.z, node.y)
    const sideB = findStanding(world, area, node.x, node.z + direction.dz, node.y)
    if (!sideA || !sideB) continue
    const next = findStanding(world, area, node.x + direction.dx, node.z + direction.dz, node.y)
    if (next) found.push(next)
  }
  return found
}
