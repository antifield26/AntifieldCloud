import type { Bot } from 'mineflayer'
import pathfinderPackage from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'
import { insideSafeZone, safeSpotNear } from '../tasks/navigation.ts'
import { planRoute } from './routing/planner.ts'
import { RouteExecutor, type ExecutorBot } from './routing/executor.ts'
import { canStand } from './routing/sampler.ts'
import { buildTerrainSummary } from '../ai/path-advisor.ts'
import { NavigationTrace } from './routing/trace.ts'
import type {
  NavArea,
  NavigationSnapshot,
  NavVector,
  NavWorld,
  RouteAdvisor,
  RouteFailureKind
} from './routing/types.ts'

const { goals, Movements } = pathfinderPackage

export class MovementError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'MovementError'
  }
}

interface Target {
  username: string
  entity: Bot['players'][string]['entity']
}

function targetFor (bot: Bot, username: string): Target | null {
  const player = bot.players[username]
  if (!player || !player.entity) return null
  return { username: player.username, entity: player.entity }
}

function distanceTo (bot: Bot, x: number, y: number, z: number): number {
  if (!bot.entity) return Number.POSITIVE_INFINITY
  return bot.entity.position.distanceTo(new Vec3(x, y, z))
}

export class MovementManager {
  private readonly logger: Logger
  private config: Config | null
  private bot: Bot | null = null
  private current: 'come' | 'follow' | 'task' | null = null
  private followedName: string | null = null
  private cancelled = false
  private followMonitor: NodeJS.Timeout | null = null
  private notify: ((message: string) => void) | null = null
  private advisor: RouteAdvisor | null = null
  private navigationListener: ((snapshot: NavigationSnapshot) => void) | null = null
  private fallbackListener: ((fallback: 'teleport' | 'stopped', reason: string) => void) | null = null
  private readonly executor = new RouteExecutor()
  private readonly trace = new NavigationTrace()
  private lastAiAt = 0
  private navigation: NavigationSnapshot = {
    state: 'idle',
    source: null,
    attempts: 0,
    lastFailureKind: null,
    lastFallback: null,
    aiUsed: false,
    updatedAt: null
  }

  constructor (logger: Logger, config: Config | null = null) {
    this.logger = logger
    this.config = config
  }

  setConfig (config: Config): void {
    this.config = config
  }

  attach (bot: Bot): void {
    this.bot = bot
    const movements = new Movements(bot)
    movements.canDig = false
    movements.canOpenDoors = false
    movements.allowParkour = false
    movements.allowSprinting = true
    // PaperMC 高低差地形：允许安全的两格下落，避免一格台阶/坡道边缘被判定为不可达。
    // 仍禁止挖掘、开门、跑酷、搭建与跨维度。
    movements.maxDropDown = 2
    movements.scafoldingBlocks = []
    bot.pathfinder.setMovements(movements)
    bot.pathfinder.thinkTimeout = 3000
    bot.pathfinder.tickTimeout = 40
    this.logger.info('pathfinder configured', { canDig: false, allowParkour: false, maxDropDown: 2 })
  }

  detach (): void {
    this.clearFollowMonitor()
    this.current = null
    this.followedName = null
    this.bot = null
    this.cancelled = false
  }

  setNotify (notify: ((message: string) => void) | null): void {
    this.notify = notify
  }

  setRouteAdvisor (advisor: RouteAdvisor | null): void {
    this.advisor = advisor
  }

  setNavigationListener (listener: ((snapshot: NavigationSnapshot) => void) | null): void {
    this.navigationListener = listener
  }

  setFallbackListener (listener: ((fallback: 'teleport' | 'stopped', reason: string) => void) | null): void {
    this.fallbackListener = listener
  }

  navigationSnapshot (): NavigationSnapshot {
    return { ...this.navigation }
  }

  navigationTrace (): ReturnType<NavigationTrace['recent']> {
    return this.trace.recent()
  }

  private updateNavigation (patch: Partial<NavigationSnapshot>): void {
    this.navigation = {
      ...this.navigation,
      ...patch,
      updatedAt: new Date().toISOString()
    }
    this.navigationListener?.({ ...this.navigation })
  }

  private recordFailure (source: NavigationSnapshot['source'], failure: RouteFailureKind, reason: string | null, nodes: number | null = null): void {
    this.trace.record({
      at: new Date().toISOString(),
      source: source ?? 'pathfinder',
      failure,
      reason,
      nodes
    })
    this.updateNavigation({ state: 'fallback', source, lastFailureKind: failure })
  }

  describe (): string {
    if (this.current === 'come') return '移动中'
    if (this.current === 'follow') return `跟随 ${this.followedName ?? '目标'} 中`
    if (this.current === 'task') return '任务移动中'
    return '待机'
  }

  isBusy (): boolean {
    return this.current !== null
  }

  private requireBot (): Bot {
    if (!this.bot) throw new MovementError('not attached')
    return this.bot
  }

  private requireConfig (): Config {
    if (!this.config) throw new MovementError('任务坐标未配置')
    return this.config
  }

  private requireTarget (username: string): Target {
    const bot = this.requireBot()
    const target = targetFor(bot, username)
    if (!target) throw new MovementError(`看不到 ${username}，请靠近一点再试`)
    return target
  }

  private clearFollowMonitor (): void {
    if (this.followMonitor) {
      clearInterval(this.followMonitor)
      this.followMonitor = null
    }
  }

  async waitForNear (x: number, y: number, z: number, tolerance = 3, timeoutMs = 6000): Promise<void> {
    const bot = this.requireBot()
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (distanceTo(bot, x, y, z) <= tolerance) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new MovementError('传送没有生效，可能被服务器拒绝了')
  }

  async waitForChunks (timeoutMs?: number): Promise<void> {
    const bot = this.requireBot()
    const config = this.requireConfig()
    const wait = timeoutMs ?? config.chunkWaitMs
    try {
      await Promise.race([
        bot.waitForChunksToLoad(),
        new Promise<void>(resolve => setTimeout(resolve, wait))
      ])
    } catch (error) {
      this.logger.warn('movement: chunk wait failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private assertSameDimension (username: string): void {
    const bot = this.requireBot()
    const player = bot.players[username]
    const dimension = (player?.entity as { dimension?: string } | null | undefined)?.dimension
    if (dimension && bot.game?.dimension && dimension !== bot.game.dimension) {
      throw new MovementError('跨维度暂不支持')
    }
  }

  async teleportTo (x: number, y: number, z: number): Promise<void> {
    const bot = this.requireBot()
    const config = this.requireConfig()
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new MovementError('传送坐标无效')
    }
    if (!insideSafeZone(config, x, z)) {
      throw new MovementError('目标在安全区外，不能传送')
    }
    const command = `/tp ${config.botUsername} ${x.toFixed(2)} ${y.toFixed(2)} ${z.toFixed(2)}`
    this.logger.info('movement teleport', { x, y, z })
    bot.chat(command)
    await this.waitForNear(x, y, z, 3, 6000)
    await this.waitForChunks(config.chunkWaitMs)
  }

  async teleportToPlayer (username: string): Promise<void> {
    const bot = this.requireBot()
    const config = this.requireConfig()
    if (!/^[A-Za-z0-9_]{1,16}$/.test(username)) throw new MovementError('目标名字无效')
    const player = bot.players[username]
    if (!player) throw new MovementError(`${username} 不在线`)
    this.assertSameDimension(username)
    if (!player.entity) {
      // The player entity can be unloaded while the player is still online.
      this.logger.info('movement teleport to unloaded player', { username })
    }
    this.logger.info('movement teleport to player', { username })
    bot.chat(`/tp ${config.botUsername} ${username}`)
    await new Promise(resolve => setTimeout(resolve, 1000))
    await this.waitForChunks()
  }

  async teleportNearPoint (x: number, y: number, z: number, radius = 4): Promise<Vec3> {
    const bot = this.requireBot()
    const config = this.requireConfig()
    await this.waitForChunks()
    const spot = safeSpotNear(bot, config, { x, y, z }, radius)
    if (!spot) throw new MovementError('附近找不到安全落点')
    await this.teleportTo(spot.x, spot.y, spot.z)
    return spot
  }

  /**
   * 带停滞看门狗的路径执行：pathfinder 在高低差/地形边缘可能一直“原地跳”而不 reject。
   * 位置 1.8 秒没有有效位移就停止路径并抛错，交给上层水平/安全点/传送兜底。
   */
  private async runPathWithWatchdog (goal: unknown, timeoutMs: number): Promise<void> {
    const bot = this.requireBot()
    if (!bot.entity) throw new MovementError('还没加载好位置')
    const start = bot.entity.position.clone()
    let last = start.clone()
    let lastMovedAt = Date.now()
    let settled = false
    const watchdog = setInterval(() => {
      if (settled || !bot.entity) return
      const position = bot.entity.position
      if (position.distanceTo(last) >= 0.25) {
        last = position.clone()
        lastMovedAt = Date.now()
        return
      }
      if (Date.now() - lastMovedAt >= 1800) {
        settled = true
        this.logger.warn('movement path stuck; aborting to fallback', {
          x: Math.round(position.x),
          y: Math.round(position.y),
          z: Math.round(position.z),
          goal: start.distanceTo(position) > 0.1 ? 'progressing' : 'blocked'
        })
        try {
          bot.pathfinder.stop()
          bot.pathfinder.setGoal(null)
        } catch {
          // ignore
        }
      }
    }, 250)
    let timeout: NodeJS.Timeout | null = null
    try {
      await Promise.race([
        bot.pathfinder.goto(goal),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            try {
              bot.pathfinder.stop()
              bot.pathfinder.setGoal(null)
            } catch {
              // ignore
            }
            reject(new MovementError('走不过去'))
          }, timeoutMs)
        }),
        new Promise<never>((_resolve, reject) => {
          const poll = setInterval(() => {
            if (!settled) return
            clearInterval(poll)
            reject(new MovementError('卡住了'))
          }, 200)
          // 确保 settle 后即使路径 Promise 因 stop 静默，也能结束等待。
          setTimeout(() => clearInterval(poll), timeoutMs + 1000).unref?.()
        })
      ])
    } finally {
      settled = true
      clearInterval(watchdog)
      if (timeout) clearTimeout(timeout)
    }
  }

  private navWorld (bot: Bot): NavWorld {
    return {
      blockAt: (x, y, z) => {
        const block = bot.blockAt(new Vec3(x, y, z), false)
        if (!block) return null
        const shapes = Array.isArray(block.shapes) ? block.shapes.map(shape => [...shape]) : []
        return {
          name: block.name,
          boundingBox: block.boundingBox ?? 'empty',
          shapes
        }
      }
    }
  }

  private navArea (bot: Bot, target: NavVector, allowOutsideSafeZone: boolean): NavArea {
    const config = this.requireConfig()
    const minY = -64
    const maxY = 320
    const targetInside = insideSafeZone(config, target.x, target.z)
    if (!allowOutsideSafeZone || targetInside) {
      return {
        minX: config.safeZone.minX,
        maxX: config.safeZone.maxX,
        minZ: config.safeZone.minZ,
        maxZ: config.safeZone.maxZ,
        minY,
        maxY
      }
    }
    const radius = config.pathOutsideSafeRadius
    const position = bot.entity?.position ?? target
    return {
      minX: Math.floor(Math.min(position.x, target.x) - radius),
      maxX: Math.ceil(Math.max(position.x, target.x) + radius),
      minZ: Math.floor(Math.min(position.z, target.z) - radius),
      maxZ: Math.ceil(Math.max(position.z, target.z) + radius),
      minY,
      maxY
    }
  }

  private executorBot (bot: Bot): ExecutorBot {
    return {
      get entity () {
        return bot.entity ? { position: bot.entity.position } : null
      },
      lookAt: (point, force) => bot.lookAt(point, force),
      setControlState: (control, state) => bot.setControlState(control, state),
      clearControlStates: () => bot.clearControlStates(),
      controlState: () => ({ ...bot.controlState }),
      onGround: () => bot.entity?.onGround === true,
      velocity: () => bot.entity ? { x: bot.entity.velocity.x, y: bot.entity.velocity.y, z: bot.entity.velocity.z } : { x: 0, y: 0, z: 0 },
      physicsEnabled: () => bot.physicsEnabled,
      blockAtFeet: () => {
        if (!bot.entity) return null
        const block = bot.blockAt(bot.entity.position)
        return block ? block.name : null
      },
      forceGround: () => this.refreshGround(bot)
    }
  }

  /**
   * 传送/重连后 mineflayer 可能保留 onGround=false，导致跳跃键被物理层忽略。
   * 只在脚下确实有完整方块且脚底贴近方块顶面时纠正；不改变真实空中状态。
   */
  private refreshGround (bot: Bot): void {
    const position = bot.entity?.position
    if (!position || bot.entity.onGround) return
    const x = Math.floor(position.x)
    const y = Math.floor(position.y)
    const z = Math.floor(position.z)
    const below = bot.blockAt(new Vec3(x, y - 1, z))
    if (below && below.boundingBox === 'block' && position.y - y <= 0.25) {
      bot.entity.onGround = true
    }
  }

  private reachedTarget (bot: Bot, target: NavVector, tolerance: number): boolean {
    const position = bot.entity?.position
    if (!position) return false
    return Math.hypot(position.x - target.x, position.z - target.z) <= Math.max(1.2, tolerance + 0.8) &&
      Math.abs(position.y - target.y) <= 0.7
  }

  private classifyPathFailure (error: unknown): RouteFailureKind {
    const message = error instanceof Error ? error.message : String(error)
    if (/NoPath|no path/i.test(message)) return 'no_path'
    if (/Timeout|timeout|太久|走不过去/i.test(message)) return 'timeout'
    if (/卡住|stuck/i.test(message)) return 'path_stuck'
    return 'unreachable'
  }

  private async tryPlannerRoute (
    bot: Bot,
    target: NavVector,
    tolerance: number,
    allowOutsideSafeZone: boolean
  ): Promise<{ ok: boolean, failure: RouteFailureKind, reason: string }> {
    const config = this.requireConfig()
    if (!config.pathPlannerEnabled) {
      return { ok: false, failure: 'no_path', reason: 'planner_disabled' }
    }
    // 进入受控执行前彻底释放 pathfinder，避免其物理循环继续覆盖控制键。
    try {
      bot.pathfinder.stop()
      bot.pathfinder.setGoal(null)
      bot.clearControlStates()
    } catch {
      // ignore
    }
    this.refreshGround(bot)
    const world = this.navWorld(bot)
    const area = this.navArea(bot, target, allowOutsideSafeZone)
    const position = bot.entity?.position
    if (!position) return { ok: false, failure: 'unreachable', reason: 'entity_unavailable' }
    const plan = planRoute(
      world,
      area,
      { x: position.x, y: position.y, z: position.z },
      target,
      tolerance,
      { timeoutMs: config.pathPlannerTimeoutMs, maxNodes: config.pathPlannerMaxNodes }
    )
    if (plan.status !== 'success') {
      const failure: RouteFailureKind = plan.status === 'timeout' ? 'timeout' : 'no_path'
      this.recordFailure('planner', failure, plan.reason ?? plan.status, plan.nodesVisited)
      this.logger.warn('movement planner failed', {
        status: plan.status,
        reason: plan.reason,
        nodes: plan.nodesVisited,
        target: { x: Math.round(target.x), y: Math.round(target.y), z: Math.round(target.z) }
      })
      return { ok: false, failure, reason: plan.reason ?? plan.status }
    }
    this.updateNavigation({ state: 'executing', source: 'planner', attempts: this.navigation.attempts + 1 })
    this.logger.info('movement planner route', {
      waypoints: plan.waypoints.map(point => `${point.x},${point.y},${point.z}`).slice(0, 12),
      nodes: plan.nodesVisited,
      start: bot.entity ? {
        x: Math.round(bot.entity.position.x * 10) / 10,
        y: Math.round(bot.entity.position.y * 10) / 10,
        z: Math.round(bot.entity.position.z * 10) / 10
      } : null,
      target: { x: Math.round(target.x), y: Math.round(target.y), z: Math.round(target.z) }
    })
    let lastExecutorLogAt = 0
    const result = await this.executor.run(
      this.executorBot(bot),
      plan.waypoints.map(point => ({ x: point.x, y: point.y, z: point.z })),
      {
        isCancelled: () => this.cancelled,
        totalMs: Math.max(6000, plan.waypoints.length * 1800),
        debug: data => {
          const now = Date.now()
          if (now - lastExecutorLogAt < 800) return
          lastExecutorLogAt = now
          this.logger.info('movement executor step', {
            waypoint: `${data.waypoint.x},${data.waypoint.y},${data.waypoint.z}`,
            position: `${Math.round(data.position.x * 10) / 10},${Math.round(data.position.y * 10) / 10},${Math.round(data.position.z * 10) / 10}`,
            horizontal: Math.round(data.horizontal * 10) / 10,
            vertical: Math.round(data.vertical * 10) / 10,
            controls: data.controls,
            controlState: data.controlState,
            onGround: data.onGround,
            velocity: data.velocity,
            physicsEnabled: data.physicsEnabled,
            blockAtFeet: data.blockAtFeet
          })
        }
      }
    )
    if (result.status !== 'arrived') {
      const failure: RouteFailureKind = result.status === 'timeout' ? 'timeout' : 'path_stuck'
      this.recordFailure('planner', failure, result.reason)
      this.logger.warn('movement planner executor failed', { status: result.status, reason: result.reason })
      return { ok: false, failure, reason: result.reason ?? result.status }
    }
    const reached = this.reachedTarget(bot, target, tolerance)
    if (!reached) {
      this.recordFailure('planner', 'unreachable', 'final_position_mismatch')
      return { ok: false, failure: 'unreachable', reason: 'final_position_mismatch' }
    }
    this.updateNavigation({ state: 'idle', source: 'planner', lastFailureKind: null })
    return { ok: true, failure: 'no_path', reason: '' }
  }

  private async tryAiRoute (
    bot: Bot,
    target: NavVector,
    tolerance: number,
    allowOutsideSafeZone: boolean,
    failure: RouteFailureKind
  ): Promise<boolean> {
    const config = this.requireConfig()
    const advisor = this.advisor
    if (!advisor || !config.pathAiEnabled || !advisor.available) return false
    if (Date.now() - this.lastAiAt < config.pathAiCooldownMs) return false
    this.lastAiAt = Date.now()
    const position = bot.entity?.position
    if (!position) return false
    const world = this.navWorld(bot)
    const area = this.navArea(bot, target, allowOutsideSafeZone)
    this.updateNavigation({ state: 'planning', source: 'ai', aiUsed: true })
    try {
      const advice = await advisor.suggest({
        start: { x: position.x, y: position.y, z: position.z },
        target,
        failure,
        bounds: area,
        allowOutsideSafeZone,
        terrain: buildTerrainSummary(world, area, { x: position.x, y: position.y, z: position.z })
      })
      if (!advice || advice.waypoints.length === 0) {
        this.recordFailure('ai', 'ai_invalid', 'empty_advice')
        return false
      }
      if (advice.waypoints.length > 3) {
        this.recordFailure('ai', 'ai_invalid', 'too_many_waypoints')
        return false
      }
      let cursor = { x: position.x, y: position.y, z: position.z }
      const waypoints: NavVector[] = []
      for (const point of advice.waypoints) {
        const rounded = { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) }
        if (!canStand(world, area, rounded.x, rounded.y, rounded.z)) {
          this.recordFailure('ai', 'ai_invalid', 'waypoint_not_standable')
          return false
        }
        const plan = planRoute(world, area, cursor, rounded, 0, {
          timeoutMs: config.pathPlannerTimeoutMs,
          maxNodes: config.pathPlannerMaxNodes
        })
        if (plan.status !== 'success') {
          this.recordFailure('ai', 'ai_invalid', 'waypoint_unreachable')
          return false
        }
        waypoints.push(...plan.waypoints)
        cursor = rounded
      }
      const finalPlan = planRoute(world, area, cursor, target, tolerance, {
        timeoutMs: config.pathPlannerTimeoutMs,
        maxNodes: config.pathPlannerMaxNodes
      })
      if (finalPlan.status !== 'success') {
        this.recordFailure('ai', 'ai_invalid', 'final_unreachable')
        return false
      }
      waypoints.push(...finalPlan.waypoints)
      this.updateNavigation({ state: 'executing', source: 'ai' })
      const result = await this.executor.run(this.executorBot(bot), waypoints, {
        isCancelled: () => this.cancelled,
        totalMs: Math.max(8000, waypoints.length * 1800)
      })
      if (result.status !== 'arrived') {
        this.recordFailure('ai', result.status === 'timeout' ? 'ai_timeout' : 'path_stuck', result.reason)
        return false
      }
      if (!this.reachedTarget(bot, target, tolerance)) {
        this.recordFailure('ai', 'unreachable', 'final_position_mismatch')
        return false
      }
      this.updateNavigation({ state: 'idle', source: 'ai', lastFailureKind: null })
      this.logger.info('movement ai route reached', { waypoints: waypoints.length })
      return true
    } catch (error) {
      this.recordFailure('ai', 'ai_timeout', error instanceof Error ? error.message : String(error))
      this.logger.warn('movement ai advisor failed', {
        error: error instanceof Error ? error.message : String(error)
      })
      return false
    }
  }

  /**
   * 统一导航：pathfinder 快速路径 → 确定性 A* → 受控执行 → AI 路点 → 安全兜底。
   * 所有入口都经过此方法；安全区外仅允许路径移动，不允许传送。
   */
  private async navigateTo (
    target: NavVector,
    tolerance: number,
    allowOutsideSafeZone: boolean,
    allowTeleport: boolean,
    timeoutMs: number
  ): Promise<void> {
    const bot = this.requireBot()
    const config = this.requireConfig()
    if (this.cancelled) throw new MovementError('移动已取消')
    this.updateNavigation({
      state: 'planning',
      source: 'pathfinder',
      attempts: 0,
      lastFailureKind: null,
      lastFallback: null,
      aiUsed: false
    })
    let failure: RouteFailureKind = 'path_stuck'
    let reason = ''
    try {
      this.refreshGround(bot)
      await this.runPathWithWatchdog(
        new goals.GoalNear(target.x, target.y, target.z, Math.max(1, tolerance)),
        Math.min(timeoutMs, 30000)
      )
      if (this.cancelled) throw new MovementError('移动已取消')
      if (!this.reachedTarget(bot, target, tolerance)) {
        // pathfinder 在 3D GoalNear 的半径内可能停在一格下方；交给确定性规划器补齐高度。
        throw new MovementError('到达位置高度不精确')
      }
      this.updateNavigation({ state: 'idle', source: 'pathfinder', lastFailureKind: null })
      return
    } catch (error) {
      if (this.cancelled) throw new MovementError('移动已取消')
      failure = this.classifyPathFailure(error)
      reason = error instanceof Error ? error.message : String(error)
      this.recordFailure('pathfinder', failure, reason)
      this.logger.warn('movement pathfinder failed; trying deterministic planner', {
        x: Math.round(target.x),
        y: Math.round(target.y),
        z: Math.round(target.z),
        reason
      })
    }

    for (let attempt = 0; attempt <= config.pathMaxReplans; attempt += 1) {
      if (this.cancelled) throw new MovementError('移动已取消')
      const planner = await this.tryPlannerRoute(bot, target, tolerance, allowOutsideSafeZone)
      if (planner.ok) return
      failure = planner.failure
      reason = planner.reason
      if (planner.failure === 'no_path') break
      await this.waitForChunks()
    }

    if (await this.tryAiRoute(bot, target, tolerance, allowOutsideSafeZone, failure)) return

    if (allowTeleport && config.pathTeleportFallback) {
      try {
        await this.teleportNearPoint(target.x, target.y, target.z, Math.max(3, tolerance + 2))
        this.updateNavigation({ state: 'fallback', source: 'teleport', lastFallback: 'teleport' })
        this.notify?.('我找不到规范路径，先安全传送过去。')
        this.fallbackListener?.('teleport', reason)
        return
      } catch (error) {
        this.logger.warn('movement teleport fallback rejected', {
          error: error instanceof Error ? error.message : String(error)
        })
        reason = error instanceof Error ? error.message : String(error)
      }
    }
    this.updateNavigation({
      state: 'fallback',
      source: 'stopped',
      lastFallback: 'stopped',
      lastFailureKind: failure
    })
    this.notify?.('我找不到规范路径，先停在这里。')
    this.fallbackListener?.('stopped', reason)
    throw new MovementError(`走不过去：${reason}`)
  }

  async goNearPoint (
    x: number,
    y: number,
    z: number,
    radius = 2,
    timeoutMs = 15000,
    allowTeleport = true
  ): Promise<void> {
    const config = this.requireConfig()
    if (!insideSafeZone(config, x, z)) throw new MovementError('目标在安全区外')
    const previous = this.current
    this.current = 'task'
    try {
      await this.navigateTo({ x, y, z }, radius, false, allowTeleport, timeoutMs)
    } finally {
      this.current = previous
    }
  }

  async home (): Promise<void> {
    const config = this.requireConfig()
    const home = config.home
    await this.goNearPoint(home.x, home.y, home.z, 1, 30000, true)
  }

  async comeTo (username: string, timeoutMs = 30000): Promise<'arrived' | 'cancelled'> {
    const bot = this.requireBot()
    this.assertSameDimension(username)
    const target = targetFor(bot, username)
    if (!target?.entity) {
      if (bot.players[username]) {
        await this.teleportToPlayer(username)
        return 'arrived'
      }
      throw new MovementError(`看不到 ${username}，请靠近一点再试`)
    }
    const entity = target.entity
    this.cancelled = false
    this.current = 'come'
    this.logger.info('movement come start', { target: username, timeoutMs })
    try {
      await this.navigateTo(
        { x: entity.position.x, y: entity.position.y, z: entity.position.z },
        2,
        true,
        true,
        timeoutMs
      )
      if (this.cancelled) return 'cancelled'
      this.logger.debug('movement come reached', { target: username })
      return 'arrived'
    } catch (error) {
      if (this.cancelled) return 'cancelled'
      if (error instanceof MovementError) throw error
      throw new MovementError(`移动失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (this.current === 'come') this.current = null
    }
  }

  follow (username: string, maxMs = 600000): void {
    const bot = this.requireBot()
    try {
      this.assertSameDimension(username)
    } catch (error) {
      this.notify?.(error instanceof Error ? error.message : String(error))
      throw error
    }
    const target = targetFor(bot, username)
    if (!target?.entity) {
      if (bot.players[username]) {
        void this.teleportToPlayer(username).then(() => {
          this.follow(username, maxMs)
        }).catch(error => {
          this.notify?.(`找不到 ${username}，我先停下。`)
          this.logger.warn('follow teleport failed', { error: error instanceof Error ? error.message : String(error) })
        })
        return
      }
      throw new MovementError(`看不到 ${username}，请靠近一点再试`)
    }
    this.cancelled = false
    this.current = 'follow'
    this.followedName = username
    this.clearFollowMonitor()
    this.logger.info('movement follow start', { target: username })
    void this.followLoop(username, maxMs)
  }

  private async followLoop (username: string, maxMs: number): Promise<void> {
    const startedAt = Date.now()
    try {
      while (!this.cancelled) {
        if (Date.now() - startedAt > maxMs) {
          this.notify?.(`跟了 ${Math.round(maxMs / 60000)} 分钟了，我先歇一下。`)
          return
        }
        const bot = this.bot
        if (!bot) return
        const target = targetFor(bot, username)
        if (!target?.entity) {
          this.notify?.(`${username} 不在了，我先停下。`)
          return
        }
        const entity = target.entity
        const distance = bot.entity ? bot.entity.position.distanceTo(entity.position) : 0
        if (distance > 3) {
          try {
            await this.navigateTo(
              { x: entity.position.x, y: entity.position.y, z: entity.position.z },
              2,
              true,
              false,
              12000
            )
          } catch (error) {
            if (this.cancelled) return
            this.notify?.('我找不到过去的路，先停下跟随。')
            this.logger.warn('movement follow failed', {
              error: error instanceof Error ? error.message : String(error)
            })
            return
          }
        }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    } finally {
      if (this.current === 'follow') {
        this.current = null
        this.followedName = null
      }
    }
  }

  stop (reason = 'user'): void {
    this.cancelled = true
    this.clearFollowMonitor()
    this.current = null
    this.followedName = null
    const bot = this.bot
    if (bot) {
      try {
        bot.pathfinder.stop()
        // pathfinder.stop() only sets a flag; force the reset so a following
        // goto() does not immediately reject with PathStopped.
        bot.pathfinder.setGoal(null)
      } catch {
        // ignore
      }
    }
    this.logger.info('movement stop', { reason })
  }

  async lookAt (username: string): Promise<void> {
    const bot = this.requireBot()
    const target = this.requireTarget(username)
    const entity = target.entity
    if (!entity) throw new MovementError(`看不到 ${username}`)
    await bot.lookAt(entity.position.offset(0, 1.6, 0), true)
  }

  async wave (): Promise<void> {
    const bot = this.requireBot()
    bot.swingArm('right')
    await new Promise(resolve => setTimeout(resolve, 300))
    bot.swingArm('right')
  }
}
