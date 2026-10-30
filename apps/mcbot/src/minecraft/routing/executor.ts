/**
 * 路点执行器：按规划器输出的格子中心逐段行走，1 格抬高时显式起跳。
 * 安全边界：只操作移动控制键；不挖掘、不放置、不传送；取消/超时/停滞立即释放控制。
 */
import { Vec3 } from 'vec3'
import type { NavVector, RouteExecutionResult } from './types.ts'

export interface ExecutorBot {
  entity: { position: Vec3 } | null
  lookAt: (point: Vec3, force?: boolean) => Promise<void>
  setControlState: (control: 'forward' | 'back' | 'jump' | 'sprint' | 'sneak', state: boolean) => void
  clearControlStates: () => void
  controlState?: () => Record<string, boolean>
  onGround?: () => boolean
  velocity?: () => { x: number, y: number, z: number }
  physicsEnabled?: () => boolean
  blockAtFeet?: () => string | null
  forceGround?: () => void
  getControlState?: (control: 'forward' | 'jump' | 'sprint' | 'sneak') => boolean
}

export interface ExecutorOptions {
  isCancelled: () => boolean
  /** 每个路点的硬上限，默认 2500ms。 */
  perWaypointMs?: number
  /** 整体上限，默认 25s。 */
  totalMs?: number
  /** 有界调试：每步只记录路点/位置/控制状态，不记录聊天。 */
  debug?: (data: {
    waypoint: NavVector
    position: { x: number, y: number, z: number }
    horizontal: number
    vertical: number
    controls: StepControls
    controlState?: Record<string, boolean>
    onGround?: boolean
    velocity?: { x: number, y: number, z: number }
    physicsEnabled?: boolean
    blockAtFeet?: string | null
    jumpControl?: boolean
    forwardControl?: boolean
  }) => void
}

export interface StepControls {
  jump: boolean
  forward: boolean
  sprint: boolean
}

/** 纯函数便于测试：只有真正的 1 格抬高才起跳，不会对 2 格以上高差连续硬跳。 */
export function stepControls (current: NavVector, next: NavVector): StepControls {
  const horizontal = Math.hypot(next.x - current.x, next.z - current.z)
  const dy = next.y - current.y
  return {
    jump: dy > 0.4 && dy <= 1.2 && horizontal < 2.2,
    forward: true,
    sprint: dy <= 0.4 && horizontal > 2.2
  }
}

function sleep (ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class RouteExecutor {
  async run (bot: ExecutorBot, waypoints: NavVector[], options: ExecutorOptions): Promise<RouteExecutionResult> {
    if (waypoints.length === 0) return { status: 'arrived', reason: null }
    const perWaypointMs = Math.max(800, options.perWaypointMs ?? 2500)
    const deadline = Date.now() + Math.max(3000, options.totalMs ?? 25000)
    let lastPosition: Vec3 | null = null
    let lastMovedAt = Date.now()
    try {
      for (const waypoint of waypoints) {
        const target = new Vec3(waypoint.x + 0.5, waypoint.y, waypoint.z + 0.5)
        const waypointDeadline = Math.min(deadline, Date.now() + perWaypointMs)
        let recovered = false
        while (true) {
          if (options.isCancelled()) return { status: 'cancelled', reason: 'cancelled' }
          if (Date.now() > deadline || Date.now() > waypointDeadline) {
            return { status: 'timeout', reason: 'waypoint_timeout' }
          }
          const entity = bot.entity
          if (!entity) return { status: 'cancelled', reason: 'entity_unavailable' }
          const position = entity.position
          const horizontal = Math.hypot(position.x - target.x, position.z - target.z)
          const vertical = Math.abs(position.y - target.y)
          // 只有真正站上该路点的高度才算到达；否则会跳过一级台阶后横向顶墙。
          if (horizontal <= 0.85 && vertical <= 0.6) {
            bot.setControlState('forward', false)
            bot.setControlState('jump', false)
            bot.setControlState('sprint', false)
            break
          }
          if (lastPosition && position.distanceTo(lastPosition) >= 0.05) {
            lastPosition = position.clone()
            lastMovedAt = Date.now()
          } else if (!lastPosition) {
            lastPosition = position.clone()
          } else if (Date.now() - lastMovedAt > 1000) {
            // 贴墙/卡角时先退半步再重试一次，避免把可绕行的窄口判成失败。
            if (!recovered) {
              recovered = true
              bot.setControlState('forward', false)
              bot.setControlState('back', true)
              await sleep(250)
              bot.setControlState('back', false)
              lastPosition = position.clone()
              lastMovedAt = Date.now()
              continue
            }
            return { status: 'stuck', reason: 'no_progress' }
          }

          const current: NavVector = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
          const controls = stepControls(current, waypoint)
          options.debug?.({
            waypoint,
            position: { x: position.x, y: position.y, z: position.z },
            horizontal,
            vertical,
            controls,
            controlState: bot.controlState?.(),
            onGround: bot.onGround?.(),
            velocity: bot.velocity?.()
          })
          // 贴住台阶时先退半步，给起跳留出碰撞空间；直接顶着方块跳会被服务端纠正。
          if (controls.jump && horizontal < 1.0) {
            bot.setControlState('forward', false)
            bot.setControlState('back', true)
            await sleep(220)
            bot.setControlState('back', false)
          }
          await bot.lookAt(new Vec3(target.x, target.y, target.z), true)
          bot.setControlState('forward', controls.forward)
          bot.setControlState('sprint', controls.sprint)
          if (controls.jump) {
            bot.forceGround?.()
            bot.setControlState('jump', true)
            await sleep(300)
            bot.setControlState('jump', false)
            await sleep(200)
          } else {
            await sleep(140)
          }
          const latest = bot.entity?.position ?? position
          options.debug?.({
            waypoint,
            position: { x: latest.x, y: latest.y, z: latest.z },
            horizontal: Math.hypot(latest.x - target.x, latest.z - target.z),
            vertical: Math.abs(latest.y - target.y),
            controls,
            controlState: bot.controlState?.(),
            onGround: bot.onGround?.(),
            velocity: bot.velocity?.(),
            physicsEnabled: bot.physicsEnabled?.(),
            blockAtFeet: bot.blockAtFeet?.(),
            jumpControl: bot.getControlState?.('jump'),
            forwardControl: bot.getControlState?.('forward')
          })
        }
      }
      return { status: 'arrived', reason: null }
    } finally {
      try {
        bot.clearControlStates()
      } catch {
        // 清理失败不应掩盖导航结果
      }
    }
  }
}
