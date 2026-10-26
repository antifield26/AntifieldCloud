import { randomUUID } from 'node:crypto'
import type { Bot } from 'mineflayer'
import type { AuditLogger } from '../audit.ts'
import type { Config } from '../config.ts'
import type { EventBus } from '../events/bus.ts'
import type { Logger } from '../logger.ts'
import type { PendingResume, RuntimeState, TaskName, TaskProgress, TaskSnapshot, TaskState } from '../state.ts'
import type { ChatSender } from '../minecraft/chat.ts'
import type { MovementManager } from '../minecraft/movement.ts'
import { depositProduce, oneShotDeposit, withdrawSupplies } from './deposit.ts'
import { runFarming } from './farming.ts'
import { runFishing } from './fishing.ts'
import { countItem, countFood, findItem } from './inventory.ts'
import { TaskStore, type PersistedTask } from './store.ts'
import {
  requireBot,
  TaskError,
  TaskStopError,
  type TaskContext,
  type TaskController
} from './types.ts'

interface ActiveTask {
  taskId: string
  name: TaskName
  startedAt: number
  deadline: number
  progress: TaskProgress
  failures: number
  lastError: string | null
  stopRequested: boolean
  depositRequested: boolean
}

interface PendingTask {
  taskId: string
  name: TaskName
  startedAt: number
  deadline: number
  progress: TaskProgress
  failures: number
  expiresAt: number
}

export interface TaskManagerDeps {
  config: Config
  logger: Logger
  state: RuntimeState
  chatSender: ChatSender
  movement: MovementManager
  events: EventBus
  audit: AuditLogger
  store: TaskStore
  getBot: () => Bot | null
}

const EMPTY_PROGRESS: TaskProgress = { fishCaught: 0, wheatHarvested: 0, planted: 0, deposited: 0 }

function label (name: TaskName): string {
  return name === 'fishing' ? '钓鱼' : '种田'
}

function stateAction (state: TaskState): string {
  switch (state) {
    case 'starting': return 'started'
    case 'running': return 'progress'
    case 'depositing': return 'depositing'
    case 'recovering': return 'recovering'
    case 'stopping': return 'stopping'
    case 'pending_resume': return 'resume_required'
    default: return 'idle'
  }
}

export class TaskManager implements TaskController {
  private readonly deps: TaskManagerDeps
  private readonly logger: Logger
  private active: ActiveTask | null = null
  private pending: PendingTask | null = null
  private controller: AbortController | null = null
  private loop: Promise<void> | null = null
  private stopped = false
  private shutdownPending = false
  private taskEndedHandler: (() => void) | null = null
  private pendingTimer: NodeJS.Timeout | null = null
  private persistTimer: NodeJS.Timeout | null = null

  constructor (deps: TaskManagerDeps) {
    this.deps = deps
    this.logger = deps.logger
  }

  setTaskEndedHandler (handler: () => void): void {
    this.taskEndedHandler = handler
  }

  async init (): Promise<void> {
    const saved = await this.deps.store.load()
    if (!saved) return
    const expiresAt = Math.min(saved.savedAt + this.deps.config.taskPendingTtlMs, saved.deadline)
    if (Date.now() >= expiresAt) {
      await this.deps.store.clear()
      this.deps.state.setTask({
        enabled: this.deps.config.taskEnabled,
        active: false,
        name: null,
        state: 'idle',
        startedAt: null,
        elapsedSec: Math.floor((saved.deadline - saved.startedAt) / 1000),
        progress: { ...saved.progress },
        failures: saved.failures,
        lastError: '任务恢复窗口已过期',
        pendingResume: null
      })
      this.deps.audit.append({
        event: 'task.interrupted',
        source: 'task',
        actor: 'lofii',
        action: saved.name,
        result: 'interrupted',
        details: { reason: 'resume_expired' }
      })
      this.emitTask('interrupted')
      return
    }
    this.pending = {
      taskId: saved.taskId,
      name: saved.name,
      startedAt: saved.startedAt,
      deadline: saved.deadline,
      progress: { ...saved.progress },
      failures: saved.failures,
      expiresAt
    }
    this.publishPending()
    this.deps.logger.info('task pending resume loaded', { name: saved.name, taskId: saved.taskId })
    this.pendingTimer = setTimeout(() => { void this.expirePending() }, Math.max(0, expiresAt - Date.now()))
    this.pendingTimer.unref?.()
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
    const { config } = this.deps
    if (this.stopped) return
    if (!config.taskEnabled) {
      await this.say('自动化开关没有打开。')
      return
    }
    if (this.pending) {
      await this.say('有一个待恢复任务，先在面板确认恢复或取消。')
      return
    }
    if (this.active) {
      await this.say(`正在${label(this.active.name)}，先“Lofii 收工”再换任务。`)
      return
    }
    const now = Date.now()
    const active: ActiveTask = {
      taskId: randomUUID(),
      name,
      startedAt: now,
      deadline: now + config.taskMaxMinutes * 60_000,
      progress: { ...EMPTY_PROGRESS },
      failures: 0,
      lastError: null,
      stopRequested: false,
      depositRequested: false
    }
    this.deps.audit.append({
      event: 'task.start',
      source: username === 'panel' ? 'http_control' : 'chat',
      actor: username,
      action: name,
      result: 'accepted',
      details: { taskId: active.taskId }
    })
    await this.launch(active, name === 'fishing' ? '好，我去钓鱼啦。' : '好，我去种田啦。')
  }

  async confirmResume (taskId?: string): Promise<void> {
    if (!this.pending) throw new TaskError('没有待恢复任务')
    if (taskId && taskId !== this.pending.taskId) throw new TaskError('恢复任务 ID 不匹配')
    if (Date.now() >= this.pending.expiresAt) {
      await this.expirePending()
      throw new TaskError('恢复窗口已过期')
    }
    const pending = this.pending
    this.pending = null
    this.clearPendingTimer()
    const active: ActiveTask = {
      taskId: pending.taskId,
      name: pending.name,
      startedAt: pending.startedAt,
      deadline: pending.deadline,
      progress: { ...pending.progress },
      failures: pending.failures,
      lastError: null,
      stopRequested: false,
      depositRequested: false
    }
    this.deps.audit.append({
      event: 'task.resume',
      source: 'http_control',
      actor: 'panel',
      action: pending.name,
      result: 'accepted',
      details: { taskId: pending.taskId }
    })
    await this.launch(active, `好，继续${label(active.name)}。`)
  }

  async discardPending (reason: string): Promise<void> {
    if (!this.pending) return
    const pending = this.pending
    this.pending = null
    this.clearPendingTimer()
    await this.deps.store.clear()
    this.deps.state.setTask({
      enabled: this.deps.config.taskEnabled,
      active: false,
      name: null,
      state: 'idle',
      startedAt: null,
      elapsedSec: Math.floor((Date.now() - pending.startedAt) / 1000),
      progress: { ...pending.progress },
      failures: pending.failures,
      lastError: `待恢复任务已取消：${reason}`,
      pendingResume: null
    })
    this.deps.audit.append({
      event: 'task.interrupted',
      source: 'task',
      actor: 'panel',
      action: pending.name,
      result: 'interrupted',
      details: { reason, taskId: pending.taskId }
    })
    this.emitTask('interrupted')
    this.taskEndedHandler?.()
  }

  private async expirePending (): Promise<void> {
    if (!this.pending) return
    const pending = this.pending
    this.pending = null
    this.clearPendingTimer()
    await this.deps.store.clear()
    this.deps.state.setTask({
      enabled: this.deps.config.taskEnabled,
      active: false,
      name: null,
      state: 'idle',
      startedAt: null,
      elapsedSec: Math.floor((Date.now() - pending.startedAt) / 1000),
      progress: { ...pending.progress },
      failures: pending.failures,
      lastError: '任务恢复窗口已过期',
      pendingResume: null
    })
    this.deps.audit.append({
      event: 'task.interrupted',
      source: 'task',
      actor: 'lofii',
      action: pending.name,
      result: 'interrupted',
      details: { reason: 'resume_expired', taskId: pending.taskId }
    })
    this.emitTask('interrupted')
    this.taskEndedHandler?.()
  }

  private async launch (active: ActiveTask, message: string): Promise<void> {
    this.active = active
    this.controller = new AbortController()
    await this.persistNow(active)
    this.publish(active, 'starting')
    this.logger.info('task starting', { name: active.name, taskId: active.taskId })
    await this.say(message)
    this.loop = this.run(active)
      .catch(error => {
        this.logger.error('task loop crashed', {
          name: active.name,
          error: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => {
        if (this.active === active) {
          this.active = null
          this.controller = null
          this.loop = null
          this.clearPersistTimer()
        }
      })
  }

  private async run (active: ActiveTask): Promise<void> {
    let attempt = 0
    while (!this.stopped && !active.stopRequested) {
      try {
        if (!this.deps.getBot()?.entity) await this.waitForBot(60000)
        await this.ensureAtAnchor(active)
        await this.ensureSupplies(active)
        this.publish(active, 'running')
        const ctx = this.context(active)
        if (active.name === 'fishing') await runFishing(ctx)
        else await runFarming(ctx)
        break
      } catch (error) {
        if (this.shutdownPending) break
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
        this.schedulePersist(active)
        if (publish) this.publish(active, 'running')
      },
      requestDeposit: () => { active.depositRequested = true },
      depositRequested: () => active.depositRequested,
      clearDepositRequest: () => { active.depositRequested = false }
    }
  }

  private async finish (active: ActiveTask, attempts: number): Promise<void> {
    if (this.shutdownPending) {
      await this.persistNow(active)
      this.pending = {
        taskId: active.taskId,
        name: active.name,
        startedAt: active.startedAt,
        deadline: active.deadline,
        progress: { ...active.progress },
        failures: active.failures,
        expiresAt: Math.min(Date.now() + this.deps.config.taskPendingTtlMs, active.deadline)
      }
      this.publishPending()
      this.deps.audit.append({
        event: 'task.shutdown_pending',
        source: 'task',
        actor: 'lofii',
        action: active.name,
        result: 'interrupted',
        details: { taskId: active.taskId }
      })
      return
    }
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
    this.clearPersistTimer()
    await this.deps.store.clear()
    this.pending = null
    const result = active.stopRequested ? 'stopped' : attempts >= config.taskRecoveryMax ? 'failed' : 'completed'
    this.publishIdle(active)
    this.emitTask(result)
    this.deps.audit.append({
      event: 'task.finish',
      source: 'task',
      actor: 'lofii',
      action: active.name,
      result: result === 'failed' ? 'failed' : 'completed',
      details: { taskId: active.taskId, attempts, progress: active.progress, depositError }
    })
    this.logger.info('task finished', {
      name: active.name,
      attempts,
      progress: active.progress,
      failures: active.failures,
      depositError,
      result
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
      if (this.pending) {
        void this.discardPending('user')
        return
      }
      void this.say('现在没有任务。')
      return
    }
    this.active.stopRequested = true
    this.controller?.abort()
    this.deps.movement.stop(`task:${reason}`)
    this.publish(this.active, 'stopping')
    this.deps.audit.append({
      event: 'task.stop',
      source: reason === 'user' ? 'chat' : 'system',
      actor: reason === 'user' ? 'Antifield' : 'system',
      action: this.active.name,
      result: 'accepted',
      details: { taskId: this.active.taskId, reason }
    })
    this.logger.info('task stop requested', { name: this.active.name, reason })
    void this.say('好，我收工了，正在收尾。')
  }

  async stopAndWait (reason: string): Promise<void> {
    if (this.pending && !this.active) {
      await this.discardPending(reason)
      return
    }
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
      taskId: randomUUID(),
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
        lastError: previous.lastError,
        pendingResume: null
      })
      await this.say(count > 0 ? `存好了，共 ${count} 个。` : '背包里没有需要存的东西。')
    } catch (error) {
      await this.say(`存箱失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async shutdown (): Promise<void> {
    this.stopped = true
    this.clearPendingTimer()
    if (!this.active) return
    if (this.active.stopRequested) {
      this.controller?.abort()
      this.deps.movement.stop('shutdown')
      if (this.loop) await Promise.race([
        this.loop.catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 5000))
      ])
      return
    }
    this.shutdownPending = true
    await this.persistNow(this.active)
    this.active.stopRequested = true
    this.controller?.abort()
    this.deps.movement.stop('shutdown')
    if (this.loop) {
      await Promise.race([
        this.loop.catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 8000))
      ])
    }
    this.clearPersistTimer()
  }

  private publish (active: ActiveTask, state: Exclude<TaskState, 'idle' | 'pending_resume'>): void {
    this.deps.state.setTask({
      enabled: this.deps.config.taskEnabled,
      active: true,
      name: active.name,
      state,
      startedAt: new Date(active.startedAt).toISOString(),
      elapsedSec: Math.floor((Date.now() - active.startedAt) / 1000),
      progress: { ...active.progress },
      failures: active.failures,
      lastError: active.lastError,
      pendingResume: null
    })
    this.schedulePersist(active)
    this.emitTask(stateAction(state))
  }

  private publishPending (): void {
    const pending = this.pending
    if (!pending) return
    this.deps.state.setTask({
      enabled: this.deps.config.taskEnabled,
      active: false,
      name: pending.name,
      state: 'pending_resume',
      startedAt: new Date(pending.startedAt).toISOString(),
      elapsedSec: Math.floor((Date.now() - pending.startedAt) / 1000),
      progress: { ...pending.progress },
      failures: pending.failures,
      lastError: null,
      pendingResume: this.pendingResume()
    })
    this.emitTask('resume_required')
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
      lastError: active.lastError,
      pendingResume: null
    })
  }

  private pendingResume (): PendingResume | null {
    if (!this.pending) return null
    return {
      taskId: this.pending.taskId,
      name: this.pending.name,
      startedAt: new Date(this.pending.startedAt).toISOString(),
      elapsedSec: Math.floor((Date.now() - this.pending.startedAt) / 1000),
      progress: { ...this.pending.progress },
      expiresAt: new Date(this.pending.expiresAt).toISOString()
    }
  }

  private emitTask (action: string): void {
    this.deps.events.emit('task', { action, task: this.deps.state.task })
  }

  private schedulePersist (active: ActiveTask): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persistNow(active)
    }, 1000)
    this.persistTimer.unref?.()
  }

  private async persistNow (active: ActiveTask): Promise<void> {
    const task: PersistedTask = {
      version: 1,
      taskId: active.taskId,
      name: active.name,
      startedAt: active.startedAt,
      deadline: active.deadline,
      progress: { ...active.progress },
      failures: active.failures,
      savedAt: Date.now()
    }
    await this.deps.store.save(task)
  }

  private clearPersistTimer (): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
  }

  private clearPendingTimer (): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = null
    }
  }

  private async say (text: string): Promise<void> {
    try {
      await this.deps.chatSender.say(text, 'task')
    } catch {
      // disconnected; ignore
    }
  }
}
