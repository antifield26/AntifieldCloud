import type { Bot } from 'mineflayer'
import pathfinderPackage from 'mineflayer-pathfinder'
import type { Logger } from '../logger.ts'

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

export class MovementManager {
  private readonly logger: Logger
  private bot: Bot | null = null
  private current: 'come' | 'follow' | null = null
  private followedName: string | null = null
  private cancelled = false
  private followMonitor: NodeJS.Timeout | null = null
  private notify: ((message: string) => void) | null = null

  constructor (logger: Logger) {
    this.logger = logger
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
    return '待机'
  }

  isBusy (): boolean {
    return this.current !== null
  }

  private requireBot (): Bot {
    if (!this.bot) throw new MovementError('not attached')
    return this.bot
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

  async comeTo (username: string, timeoutMs = 30000): Promise<'arrived' | 'cancelled'> {
    const bot = this.requireBot()
    const target = this.requireTarget(username)
    const entity = target.entity
    if (!entity) throw new MovementError(`看不到 ${username}，请靠近一点再试`)
    this.cancelled = false
    this.current = 'come'
    this.logger.info('movement come start', { target: username, timeoutMs })
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
      if (error instanceof Error && error.name === 'PathStopped') {
        throw new MovementError('移动被中断了，我再试一次')
      }
      if (error instanceof MovementError) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (/NoPath|no path/i.test(message)) throw new MovementError('找不到过去的路，可能被挡住了')
      if (/Timeout|timeout/i.test(message)) throw new MovementError('走太久了，我先停下')
      throw new MovementError(`移动失败：${message}`)
    } finally {
      if (timeout) clearTimeout(timeout)
      if (this.current === 'come') this.current = null
    }
  }

  follow (username: string, maxMs = 600000): void {
    const bot = this.requireBot()
    const target = this.requireTarget(username)
    const entity = target.entity
    if (!entity) throw new MovementError(`看不到 ${username}，请靠近一点再试`)
    this.cancelled = false
    this.current = 'follow'
    this.followedName = username
    this.clearFollowMonitor()
    this.logger.info('movement follow start', { target: username })
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
