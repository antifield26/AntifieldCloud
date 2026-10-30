/**
 * 确定性导航的共享类型：只描述方块世界与路线结果，不依赖 mineflayer。
 * 安全边界：导航器只读方块，不提供放置/挖掘能力；所有边界检查由调用方通过 bounds 传入。
 */

export interface NavVector {
  x: number
  y: number
  z: number
}

export interface NavBlock {
  name: string
  boundingBox: string
  /** 方块碰撞形状：每项为 [minX,minY,minZ,maxX,maxY,maxZ]。 */
  shapes: number[][]
}

export interface NavWorld {
  blockAt: (x: number, y: number, z: number) => NavBlock | null
}

export interface NavArea {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  minY: number
  maxY: number
}

export type PlanStatus = 'success' | 'no_path' | 'timeout'

export interface RoutePlan {
  status: PlanStatus
  waypoints: NavVector[]
  nodesVisited: number
  reason: string | null
}

export interface RouteRequest {
  target: NavVector
  tolerance: number
  /** 任务/目标默认 false；come/follow 允许安全区外路径。 */
  allowOutsideSafeZone: boolean
  bounds: NavArea
  timeoutMs: number
  maxNodes: number
}

export type RouteFailureKind =
  | 'path_stuck'
  | 'no_path'
  | 'timeout'
  | 'unreachable'
  | 'outside_safe'
  | 'invalid_target'
  | 'ai_invalid'
  | 'ai_timeout'
  | 'stopped'

export interface RouteExecutionResult {
  status: 'arrived' | 'stuck' | 'cancelled' | 'timeout'
  reason: string | null
}

export interface RouteAdvice {
  waypoints: NavVector[]
  reason: string | null
}

export interface RouteAdvisor {
  readonly available: boolean
  suggest: (input: AdvisorInput, signal?: AbortSignal) => Promise<RouteAdvice | null>
}

export interface AdvisorInput {
  start: NavVector
  target: NavVector
  failure: RouteFailureKind
  bounds: NavArea
  allowOutsideSafeZone: boolean
  /** 有界局部高度摘要（只读方块高度/名称，不含聊天或玩家数据）。 */
  terrain: string[]
}

export interface NavigationSnapshot {
  state: 'idle' | 'planning' | 'executing' | 'fallback'
  source: 'pathfinder' | 'planner' | 'ai' | 'teleport' | 'stopped' | null
  attempts: number
  lastFailureKind: RouteFailureKind | null
  lastFallback: 'teleport' | 'stopped' | null
  aiUsed: boolean
  updatedAt: string | null
}
