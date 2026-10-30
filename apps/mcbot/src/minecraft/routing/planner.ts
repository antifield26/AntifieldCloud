/**
 * 确定性 A*：在已有方块地形上寻路，支持 1 格抬高/2 格下落和台阶碰撞形状。
 * 安全边界：不修改世界；未知/未加载方块由 sampler 视为不可通行；超时或节点耗尽明确返回失败。
 */
import { neighbors, startNode, targetNode, nodeKey } from './sampler.ts'
import type { NavArea, NavVector, NavWorld, RoutePlan } from './types.ts'

interface QueueNode {
  node: NavVector
  g: number
  f: number
}

class MinHeap {
  private readonly items: QueueNode[] = []

  get size (): number {
    return this.items.length
  }

  push (item: QueueNode): void {
    this.items.push(item)
    this.bubbleUp(this.items.length - 1)
  }

  pop (): QueueNode | null {
    if (this.items.length === 0) return null
    const first = this.items[0] ?? null
    const last = this.items.pop()
    if (this.items.length > 0 && last) {
      this.items[0] = last
      this.bubbleDown(0)
    }
    return first
  }

  private bubbleUp (index: number): void {
    let current = index
    while (current > 0) {
      const parent = (current - 1) >> 1
      const currentItem = this.items[current]
      const parentItem = this.items[parent]
      if (!currentItem || !parentItem || parentItem.f <= currentItem.f) return
      this.items[current] = parentItem
      this.items[parent] = currentItem
      current = parent
    }
  }

  private bubbleDown (index: number): void {
    let current = index
    while (true) {
      const left = current * 2 + 1
      const right = left + 1
      let smallest = current
      if (left < this.items.length && (this.items[left]?.f ?? Infinity) < (this.items[smallest]?.f ?? Infinity)) {
        smallest = left
      }
      if (right < this.items.length && (this.items[right]?.f ?? Infinity) < (this.items[smallest]?.f ?? Infinity)) {
        smallest = right
      }
      if (smallest === current) return
      const a = this.items[current]
      const b = this.items[smallest]
      if (!a || !b) return
      this.items[current] = b
      this.items[smallest] = a
      current = smallest
    }
  }
}

function heuristic (node: NavVector, goal: NavVector): number {
  return Math.hypot(node.x - goal.x, node.z - goal.z) + Math.abs(node.y - goal.y) * 0.8
}

function moveCost (from: NavVector, to: NavVector): number {
  const horizontal = Math.hypot(to.x - from.x, to.z - from.z)
  const dy = to.y - from.y
  const vertical = dy > 0 ? dy * 1.4 : Math.abs(dy) * 0.4
  return horizontal + vertical + 1
}

function compress (path: NavVector[]): NavVector[] {
  if (path.length <= 2) return path
  const result: NavVector[] = [path[0] as NavVector]
  for (let index = 1; index < path.length - 1; index += 1) {
    const previous = path[index - 1] as NavVector
    const current = path[index] as NavVector
    const next = path[index + 1] as NavVector
    // 含高度变化的相邻路点不能折叠：折叠后会把“两级台阶”变成一次两格跳。
    if (previous.y !== current.y || current.y !== next.y) {
      result.push(current)
      continue
    }
    const directionA = `${current.x - previous.x},${current.y - previous.y},${current.z - previous.z}`
    const directionB = `${next.x - current.x},${next.y - current.y},${next.z - current.z}`
    if (directionA !== directionB) result.push(current)
  }
  result.push(path[path.length - 1] as NavVector)
  return result
}

export interface PlannerOptions {
  timeoutMs: number
  maxNodes: number
}

export function planRoute (
  world: NavWorld,
  area: NavArea,
  position: NavVector,
  target: NavVector,
  tolerance: number,
  options: PlannerOptions
): RoutePlan {
  const deadline = Date.now() + Math.max(100, options.timeoutMs)
  const maxNodes = Math.max(64, options.maxNodes)
  const start = startNode(world, area, position)
  const goal = targetNode(world, area, target, tolerance)
  if (!start) return { status: 'no_path', waypoints: [], nodesVisited: 0, reason: 'start_not_standable' }
  if (!goal) return { status: 'no_path', waypoints: [], nodesVisited: 0, reason: 'target_not_standable' }
  if (start.x === goal.x && start.y === goal.y && start.z === goal.z) {
    return { status: 'success', waypoints: [], nodesVisited: 1, reason: null }
  }

  const open = new MinHeap()
  const best = new Map<string, number>()
  const parents = new Map<string, NavVector>()
  const visited = new Set<string>()
  const startKey = nodeKey(start)
  best.set(startKey, 0)
  open.push({ node: start, g: 0, f: heuristic(start, goal) })
  let nodesVisited = 0

  while (open.size > 0) {
    if (Date.now() > deadline) {
      return { status: 'timeout', waypoints: [], nodesVisited, reason: 'planner_timeout' }
    }
    if (nodesVisited >= maxNodes) {
      return { status: 'timeout', waypoints: [], nodesVisited, reason: 'planner_node_limit' }
    }
    const current = open.pop()
    if (!current) break
    const currentKey = nodeKey(current.node)
    if (visited.has(currentKey)) continue
    visited.add(currentKey)
    nodesVisited += 1

    if (current.node.x === goal.x && current.node.y === goal.y && current.node.z === goal.z) {
      const raw: NavVector[] = [current.node]
      let cursor = current.node
      while (true) {
        const parent = parents.get(nodeKey(cursor))
        if (!parent) break
        raw.push(parent)
        cursor = parent
      }
      raw.reverse()
      return { status: 'success', waypoints: compress(raw), nodesVisited, reason: null }
    }

    for (const neighbor of neighbors(world, area, current.node)) {
      const key = nodeKey(neighbor)
      if (visited.has(key)) continue
      const nextG = current.g + moveCost(current.node, neighbor)
      const known = best.get(key)
      if (known !== undefined && known <= nextG) continue
      best.set(key, nextG)
      parents.set(key, current.node)
      open.push({ node: neighbor, g: nextG, f: nextG + heuristic(neighbor, goal) })
    }
  }

  return { status: 'no_path', waypoints: [], nodesVisited, reason: 'exhausted' }
}
