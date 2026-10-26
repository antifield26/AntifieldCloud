import type { Bot } from 'mineflayer'
import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'
import type { RuntimeState, TaskName, TaskProgress, TaskSnapshot } from '../state.ts'
import type { ChatSender } from '../minecraft/chat.ts'
import type { MovementManager } from '../minecraft/movement.ts'
import { depositProduce, oneShotDeposit, withdrawSupplies } from './deposit.ts'
import { runFarming } from './farming.ts'
import { runFishing } from './fishing.ts'
import { countItem, countFood, findItem } from './inventory.ts'
import {
  requireBot,
  TaskError,
  TaskStopError,
  type TaskContext,
  type TaskController
} from './types.ts'

interface ActiveTask {
  name: TaskName
  startedAt: number
  deadline: number
  progress: TaskProgress
  failures: number
  lastError: string | null
  stopRequested: boolean
  depositRequested: boolean
}

export interface TaskManagerDeps {
  config: Config
  logger: Logger
  state: RuntimeState
  chatSender: ChatSender
  movement: MovementManager
  getBot: () => Bot | null
}

const EMPTY_PROGRESS: TaskProgress = { fishCaught: 0, wheatHarvested: 0, planted: 0, deposited: 0 }

function label (name: TaskName): string {
  return name === 'fishing' ? '钓鱼' : '种田'
}

export class TaskManager implements TaskController {
  private readonly deps: TaskManagerDeps
  private readonly logger: Logger
  private active: ActiveTask | null = null
  private controller: AbortController | null = null
  private loop: Promise<void> | null = null
  private stopped = false
  private taskEndedHandler: (() => void) | null = null

  constructor (deps: TaskManagerDeps) {
    this.deps = deps
    this.logger = deps.logger
  }

  setTaskEndedHandler (handler: () => void): void {
    this.taskEndedHandler = handler
  }

  snapshot (): TaskSnapshot {
    return this.deps.state.task
  }

  keepOnline (): boolean {
    return this.active !== null
  }

  isActive (): boolean {
    return this.active !== null
  }

  async start (name: TaskName, username: string): Promise<void> {
    const { config, state } = this.deps
    if (this.stopped) return
    if (!config.taskEnabled) {
      await this.say('自动化开关没有打开。')
      return
    }
    if (this.active) {
      await this.say(`正在${label(this.active.name)}，先“Lofii 收工”再换任务。`)
      return
    }
    const bot = this.deps.getBot()
    if (!bot || !bot.entity) {
      await this.say('我还没连上服务器，稍等一下。')
      return
    }
    const now = Date.now()
    const active: ActiveTask = {
      name,
      startedAt: now,
      deadline: now + config.taskMaxMinutes * 60_000,
      progress: { ...EMPTY_PROGRESS },
      failures: 0,
      lastError: null,
      stopRequested: false,
      depositRequested: false
    }
    this.active = active
    this.controller = new AbortController()
    this.publish(active, 'starting')
    this.logger.info('task starting', { name, username })
    await this.say(name === 'fishing' ? '好，我去钓鱼啦。' : '好，我去种田啦。')
    this.loop = this.run(active)
      .catch(error => {
        this.logger.error('task loop crashed', {
          name,
          error: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => {
        if (this.active === active) {
          this.active = null
          this.controller = null
          this.loop = null
          this.publishIdle(active)
        }
      })
  }

  private async run (active: ActiveTask): Promise<void> {
    let attempt = 0
    while (!this.stopped && !active.stopRequested) {
      try {
        await this.ensureAtAnchor(active)
        await this.ensureSupplies(active)
        this.publish(active, 'running')
        const ctx = this.context(active)
        if (active.name === 'fishing') await runFishing(ctx)
        else await runFarming(ctx)
        break
      } catch (error) {
        if (active.stopRequested || this.stopped || error instanceof TaskStopError) break
        const message = error instanceof Error ? error.message : String(error)
        attempt += 1
        active.failures = attempt
        active.lastError = message
        this.logger.warn('task attempt failed', { name: active.name, attempt, error: message })
        if (attempt >= this.deps.config.taskRecoveryMax) {
          await this.say(`连续失败 ${attempt} 次，我先停下了。${message}`)
          break
        }
        this.publish(active, 'recovering')
        await this.say(`出了点问题，我恢复一下（${attempt}/${this.deps.config.taskRecoveryMax}）：${message}`)
        try {
          await this.waitForBot(60000)
          await this.deps.movement.home()
        } catch (recoveryError) {
          this.logger.warn('task recovery failed', {
            error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
          })
        }
      }
    }
    await this.finish(active, attempt)
  }

  private async ensureAtAnchor (active: ActiveTask): Promise<void> {
    const { config, movement } = this.deps
    const bot = requireBot(this.context(active))
    if (active.name === 'fishing') {
      if (config.taskAnchorTeleport) {
        await movement.teleportTo(config.fishStand.x, config.fishStand.y, config.fishStand.z)
      } else {
        await movement.goNearPoint(config.fishStand.x, config.fishStand.y, config.fishStand.z, 2, 15000, true)
      }
      return
    }
    if (bot.entity) {
      const nearChest = Math.hypot(bot.entity.position.x - config.chest.x, bot.entity.position.z - config.chest.z) <= 5
      if (nearChest) return
    }
    if (config.taskAnchorTeleport) {
      await movement.teleportNearPoint(config.chest.x, config.chest.y, config.chest.z, 4)
    } else {
      await movement.goNearPoint(config.chest.x, config.chest.y, config.chest.z, 3, 15000, true)
    }
  }

  private async ensureSupplies (active: ActiveTask): Promise<void> {
    const { config } = this.deps
    const ctx = this.context(active)
    const bot = requireBot(ctx)
    const requests = active.name === 'fishing'
      ? [{ name: 'fishing_rod', count: 1 }, { name: 'food', count: 4 }]
      : [{ name: 'iron_hoe', count: 1 }, { name: 'wheat_seeds', count: 64 }, { name: 'food', count: 4 }]
    const missing = requests.some(request => {
      if (request.name === 'food') return countFood(bot) < request.count
      return countItem(bot, request.name) < request.count
    })
    if (missing) {
      try {
        await withdrawSupplies(ctx, requests)
      } catch (error) {
        if (error instanceof TaskStopError) throw error
        this.logger.warn('task: supply withdraw failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    const fresh = requireBot(ctx)
    if (active.name === 'fishing' && !findItem(fresh, 'fishing_rod')) {
      throw new TaskError('箱子里没有鱼竿')
    }
    if (active.name === 'farming' && !findItem(fresh, 'iron_hoe')) {
      throw new TaskError('箱子里没有锄头')
    }
    if (active.name === 'farming' && countItem(fresh, 'wheat_seeds') === 0) {
      throw new TaskError('箱子里没有小麦种子')
    }
    if (countFood(fresh) === 0) {
      throw new TaskError('箱子里没有食物，先放点吃的')
    }
    this.logger.info('task supplies ready', { name: active.name, food: fresh.food })
  }

  private context (active: ActiveTask, publish = true): TaskContext {
    return {
      config: this.deps.config,
      logger: this.logger,
      state: this.deps.state,
      chatSender: this.deps.chatSender,
      movement: this.deps.movement,
      getBot: this.deps.getBot,
      signal: this.controller?.signal ?? new AbortController().signal,
      deadline: active.deadline,
      progress: active.progress,
      say: text => this.say(text),
      updateProgress: patch => {
        Object.assign(active.progress, patch)
        active.failures = 0
        active.lastError = null
        if (publish) this.publish(active, 'running')
      },
      requestDeposit: () => { active.depositRequested = true },
      depositRequested: () => active.depositRequested,
      clearDepositRequest: () => { active.depositRequested = false }
    }
  }

  private async finish (active: ActiveTask, attempts: number): Promise<void> {
    const { config } = this.deps
    const bot = this.deps.getBot()
    let depositError: string | null = null
    if (config.autoDeposit && bot?.entity && active.progress.fishCaught + active.progress.wheatHarvested > 0) {
      try {
        await depositProduce(this.context(active))
      } catch (error) {
        depositError = error instanceof Error ? error.message : String(error)
        this.logger.warn('task: final deposit failed', { error: depositError })
      }
    }
    if (active.name === 'fishing') {
      const count = active.progress.fishCaught
      await this.say(count > 0
        ? `收工啦，钓了 ${count} 条鱼，已经存好了。`
        : '这次没钓到鱼，我先停下了。')
    } else {
      const harvested = active.progress.wheatHarvested
      const planted = active.progress.planted
      await this.say(harvested + planted > 0
        ? `收工啦，收了 ${harvested} 格小麦，补种 ${planted} 格。`
        : '这次农田没什么可做的，我先停下了。')
    }
    if (depositError) await this.say(`存箱时出了点问题：${depositError}`)
    this.logger.info('task finished', {
      name: active.name,
      attempts,
      progress: active.progress,
      failures: active.failures,
      depositError
    })
    this.taskEndedHandler?.()
  }

  private async waitForBot (timeoutMs: number): Promise<void> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const bot = this.deps.getBot()
      if (bot?.entity) return
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw new TaskError('服务器还没连回来')
  }

  requestStop (reason: string): void {
    if (!this.active) {
      void this.say('现在没有任务。')
      return
    }
    this.active.stopRequested = true
    this.controller?.abort()
    this.deps.movement.stop(`task:${reason}`)
    this.publish(this.active, 'stopping')
    this.logger.info('task stop requested', { name: this.active.name, reason })
    void this.say('好，我收工了，正在收尾。')
  }

  async stopAndWait (reason: string): Promise<void> {
    if (!this.active) return
    this.requestStop(reason)
    if (this.loop) await this.loop.catch(() => {})
  }

  async depositNow (): Promise<void> {
    if (this.active) {
      this.active.depositRequested = true
      await this.say('好，我存一下。')
      return
    }
    const bot = this.deps.getBot()
    if (!bot || !bot.entity) {
      await this.say('我还没连上服务器。')
      return
    }
    const previous = this.deps.state.task
    const fake: ActiveTask = {
      name: 'fishing',
      startedAt: Date.now(),
      deadline: Date.now() + 30000,
      progress: { ...previous.progress },
      failures: 0,
      lastError: null,
      stopRequested: false,
      depositRequested: false
    }
    try {
      const count = await oneShotDeposit(this.context(fake, false))
      this.deps.state.setTask({
        enabled: this.deps.config.taskEnabled,
        active: false,
        name: null,
        state: 'idle',
        startedAt: null,
        elapsedSec: previous.elapsedSec,
        progress: { ...fake.progress, deposited: previous.progress.deposited + count },
        failures: previous.failures,
        lastError: previous.lastError
      })
      await this.say(count > 0 ? `存好了，共 ${count} 个。` : '背包里没有需要存的东西。')
    } catch (error) {
      await this.say(`存箱失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async shutdown (): Promise<void> {
    this.stopped = true
    if (!this.active) return
    this.active.stopRequested = true
    this.controller?.abort()
    this.deps.movement.stop('shutdown')
    if (this.loop) {
      await Promise.race([
        this.loop.catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 5000))
      ])
    }
  }

  private publish (active: ActiveTask, state: 'starting' | 'running' | 'depositing' | 'recovering' | 'stopping'): void {
    this.deps.state.setTask({
      enabled: this.deps.config.taskEnabled,
      active: true,
      name: active.name,
      state,
      startedAt: new Date(active.startedAt).toISOString(),
      elapsedSec: Math.floor((Date.now() - active.startedAt) / 1000),
      progress: { ...active.progress },
      failures: active.failures,
      lastError: active.lastError
    })
  }

  private publishIdle (active: ActiveTask): void {
    this.deps.state.setTask({
      enabled: this.deps.config.taskEnabled,
      active: false,
      name: null,
      state: 'idle',
      startedAt: null,
      elapsedSec: Math.floor((Date.now() - active.startedAt) / 1000),
      progress: { ...active.progress },
      failures: active.failures,
      lastError: active.lastError
    })
  }

  private async say (text: string): Promise<void> {
    try {
      await this.deps.chatSender.say(text, 'task')
    } catch {
      // disconnected; ignore
    }
  }
}
