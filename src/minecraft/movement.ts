import type { Bot } from 'mineflayer'
import pathfinderPackage from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'
import { insideSafeZone, safeSpotNear } from '../tasks/navigation.ts'

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
  private lastTeleportAt = 0
  private notify: ((message: string) => void) | null = null

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
    movements.maxDropDown = 1
    movements.scafoldingBlocks = []
    bot.pathfinder.setMovements(movements)
    bot.pathfinder.thinkTimeout = 3000
    bot.pathfinder.tickTimeout = 40
    this.logger.info('pathfinder configured', { canDig: false, allowParkour: false, maxDropDown: 1 })
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
  }

  async teleportToPlayer (username: string): Promise<void> {
    const bot = this.requireBot()
    const config = this.requireConfig()
    if (!/^[A-Za-z0-9_]{1,16}$/.test(username)) throw new MovementError('目标名字无效')
    if (!bot.players[username]) throw new MovementError(`${username} 不在线`)
    this.logger.info('movement teleport to player', { username })
    bot.chat(`/tp ${config.botUsername} ${username}`)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }

  async teleportNearPoint (x: number, y: number, z: number, radius = 4): Promise<Vec3> {
    const bot = this.requireBot()
    const config = this.requireConfig()
    const spot = safeSpotNear(bot, config, { x, y, z }, radius)
    if (!spot) throw new MovementError('附近找不到安全落点')
    await this.teleportTo(spot.x, spot.y, spot.z)
    return spot
  }

  async goNearPoint (
    x: number,
    y: number,
    z: number,
    radius = 2,
    timeoutMs = 15000,
    allowTeleport = true
  ): Promise<void> {
    const bot = this.requireBot()
    const config = this.requireConfig()
    if (!insideSafeZone(config, x, z)) throw new MovementError('目标在安全区外')
    const previous = this.current
    this.current = 'task'
    let timeout: NodeJS.Timeout | null = null
    try {
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalNear(x, y, z, radius)),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            try {
              bot.pathfinder.stop()
            } catch {
              // ignore
            }
            reject(new MovementError('走不过去'))
          }, timeoutMs)
        })
      ])
    } catch (error) {
      if (allowTeleport) {
        this.logger.warn('movement path failed, trying teleport', {
          x, y, z,
          error: error instanceof Error ? error.message : String(error)
        })
        await this.teleportNearPoint(x, y, z, Math.max(3, radius + 2))
        return
      }
      throw new MovementError(`走不过去：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (timeout) clearTimeout(timeout)
      this.current = previous
    }
  }

  async home (): Promise<void> {
    const bot = this.requireBot()
    const config = this.requireConfig()
    const home = config.home
    if (distanceTo(bot, home.x, home.y, home.z) <= 8) {
      await this.goNearPoint(home.x, home.y, home.z, 1, 15000, true)
      return
    }
    this.logger.info('movement home teleport')
    await this.teleportTo(home.x, home.y, home.z)
  }

  async comeTo (username: string, timeoutMs = 30000): Promise<'arrived' | 'cancelled'> {
    const bot = this.requireBot()
    const config = this.requireConfig()
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
    const distance = bot.entity ? bot.entity.position.distanceTo(entity.position) : 0
    if (distance > config.teleportDistance) {
      const spot = safeSpotNear(bot, config, entity.position, 4)
      if (spot) {
        try {
          await this.teleportTo(spot.x, spot.y, spot.z)
          if (this.cancelled) return 'cancelled'
          return 'arrived'
        } catch (error) {
          this.logger.warn('come teleport failed, falling back to path', {
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
    }
    const goal = new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2)
    let timeout: NodeJS.Timeout | null = null
    try {
      await Promise.race([
        bot.pathfinder.goto(goal).then(() => {
          this.logger.debug('movement goto resolved', { target: username })
        }, (error: unknown) => {
          this.logger.debug('movement goto rejected', {
            target: username,
            name: error instanceof Error ? error.name : 'unknown',
            message: error instanceof Error ? error.message : String(error)
          })
          throw error
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            this.logger.warn('movement come timeout', { target: username, timeoutMs })
            try {
              bot.pathfinder.stop()
            } catch {
              // ignore
            }
            reject(new MovementError('timeout'))
          }, timeoutMs)
        })
      ])
      if (this.cancelled) return 'cancelled'
      return 'arrived'
    } catch (error) {
      if (this.cancelled) return 'cancelled'
      if (config && bot.entity) {
        const spot = safeSpotNear(bot, config, entity.position, 4)
        if (spot) {
          try {
            await this.teleportTo(spot.x, spot.y, spot.z)
            return 'arrived'
          } catch {
            // fall through to friendly error
          }
        }
      }
      if (error instanceof Error && error.name === 'PathStopped') {
        throw new MovementError('移动被中断了，我再试一次')
      }
      if (error instanceof MovementError) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (/NoPath|no path/i.test(message)) throw new MovementError('找不到过去的路，可能被挡住了')
      if (error instanceof Error && error.name === 'Timeout') throw new MovementError('想不出过去的路，可能太远了')
      if (/Timeout|timeout|long to decide/i.test(message)) throw new MovementError('走太久了，我先停下')
      throw new MovementError(`移动失败：${message}`)
    } finally {
      if (timeout) clearTimeout(timeout)
      if (this.current === 'come') this.current = null
    }
  }

  follow (username: string, maxMs = 600000): void {
    const bot = this.requireBot()
    const config = this.requireConfig()
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
    const entity = target.entity
    this.cancelled = false
    this.current = 'follow'
    this.followedName = username
    this.clearFollowMonitor()
    this.logger.info('movement follow start', { target: username })
    const distance = bot.entity ? bot.entity.position.distanceTo(entity.position) : 0
    if (distance > config.teleportDistance) {
      const spot = safeSpotNear(bot, config, entity.position, 4)
      if (spot) {
        void this.teleportTo(spot.x, spot.y, spot.z).catch(error => {
          this.logger.warn('follow teleport failed', { error: error instanceof Error ? error.message : String(error) })
        })
      }
    }
    bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true)
    const startedAt = Date.now()
    this.followMonitor = setInterval(() => {
      const active = this.bot
      const stillThere = active?.players[username]?.entity ?? null
      if (!active || !stillThere) {
        this.stop('target-left')
        this.notify?.(`${username} 不在了，我先停下。`)
        return
      }
      if (Date.now() - startedAt > maxMs) {
        this.stop('timeout')
        this.notify?.(`跟了 ${Math.round(maxMs / 60000)} 分钟了，我先歇一下。`)
        return
      }
      if (active.entity && active.entity.position.distanceTo(stillThere.position) > config.teleportDistance) {
        if (Date.now() - this.lastTeleportAt > 5000) {
          const spot = safeSpotNear(active, config, stillThere.position, 4)
          if (spot) {
            this.lastTeleportAt = Date.now()
            void this.teleportTo(spot.x, spot.y, spot.z).catch(error => {
              this.logger.warn('follow mid teleport failed', { error: error instanceof Error ? error.message : String(error) })
            })
          }
        }
      }
    }, 1000)
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
