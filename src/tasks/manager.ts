import { randomUUID } from 'node:crypto'
import type { Bot } from 'mineflayer'
import type { AuditLogger } from '../audit.ts'
import type { Config } from '../config.ts'
import type { EventBus } from '../events/bus.ts'
import type { Logger } from '../logger.ts'
import type { PendingResume, QueuedTask, RuntimeState, TaskName, TaskProgress, TaskSnapshot, TaskState } from '../state.ts'
import type { ChatSender } from '../minecraft/chat.ts'
import type { MovementManager } from '../minecraft/movement.ts'
import type { TaskDefender } from '../combat/types.ts'
import { depositProduce, oneShotDeposit, withdrawSupplies } from './deposit.ts'
import { runFarming } from './farming.ts'
import { runFishing } from './fishing.ts'
import { runWoodcutting } from './woodcutting.ts'
import { countItem, countFood, findItem, isKeptItem } from './inventory.ts'
import { TaskStore, type PersistedQueueTask, type PersistedTask } from './store.ts'
import {
  requireBot,
  TaskError,
  TaskStopError,
  type TaskContext,
  type TaskController,
  type TaskStartResult
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
  defenseFailed: boolean
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

class DefenseRetreatError extends TaskError {
  constructor (message: string) {
    super(message)
    this.name = 'DefenseRetreatError'
  }
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
  defender?: TaskDefender
}

const EMPTY_PROGRESS: TaskProgress = {
  fishCaught: 0,
  wheatHarvested: 0,
  planted: 0,
  deposited: 0,
  treesChopped: 0,
  logsChopped: 0,
  saplingsPlanted: 0,
  mobsKilled: 0
}

function label (name: TaskName): string {
  if (name === 'fishing') return '钓鱼'
  if (name === 'farming') return '种田'
  return '砍树'
}

function startMessage (name: TaskName): string {
  if (name === 'fishing') return '好，我去钓鱼啦。'
  if (name === 'farming') return '好，我去种田啦。'
  return '好，我去砍树啦。'
}

function stateAction (state: TaskState): string {
  switch (state) {
    case 'starting': return 'started'
    case 'running': return 'progress'
    case 'depositing': return 'depositing'
    case 'recovering': return 'recovering'
    case 'stopping': return 'stopping'
    case 'defending': return 'defending'
    case 'pending_resume': return 'resume_required'
    default: return 'idle'
  }
}

function makeProgress (): TaskProgress {
  return { ...EMPTY_PROGRESS }
}

export class TaskManager implements TaskController {
  private readonly deps: TaskManagerDeps
  private readonly logger: Logger
  private active: ActiveTask | null = null
  private pending: PendingTask | null = null
  private queue: QueuedTask[] = []
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
    this.queue = saved.queue.map(item => ({ ...item }))
    if (!saved.active) {
      if (this.queue.length > 0) {
        this.deps.state.setTask({ enabled: this.deps.config.taskEnabled, queue: this.queue })
        void this.startNext()
      }
      return
    }
    const expiresAt = Math.min(saved.savedAt + this.deps.config.taskPendingTtlMs, saved.active.deadline)
    if (Date.now() >= expiresAt) {
      await this.deps.store.clear()
      this.queue = []
      this.deps.state.setTask({
        enabled: this.deps.config.taskEnabled,
        active: false,
        name: null,
        state: 'idle',
        startedAt: null,
        elapsedSec: Math.floor((saved.active.deadline - saved.active.startedAt) / 1000),
        progress: { ...saved.active.progress },
        failures: saved.active.failures,
        lastError: '任务恢复窗口已过期',
        pendingResume: null,
        queue: []
      })
      this.deps.audit.append({
        event: 'task.interrupted',
        source: 'task',
        actor: 'lofii',
        action: saved.active.name,
        result: 'interrupted',
        details: { reason: 'resume_expired' }
      })
      this.emitTask('interrupted')
      return
    }
    this.pending = {
      taskId: saved.active.taskId,
      name: saved.active.name,
      startedAt: saved.active.startedAt,
      deadline: saved.active.deadline,
      progress: { ...saved.active.progress },
      failures: saved.active.failures,
      expiresAt
    }
    this.publishPending()
    this.deps.logger.info('task pending resume loaded', {
      name: saved.active.name,
      taskId: saved.active.taskId,
      queue: this.queue.length
    })
    this.pendingTimer = setTimeout(() => { void this.expirePending() }, Math.max(0, expiresAt - Date.now()))
    this.pendingTimer.unref?.()
  }

  snapshot (): TaskSnapshot {
    return this.deps.state.snapshot().task
  }

  keepOnline (): boolean {
    return this.active !== null || this.queue.length > 0
  }

  isActive (): boolean {
    return this.active !== null
  }

  async start (name: TaskName, username: string): Promise<TaskStartResult> {
    const { config } = this.deps
    if (this.stopped) return { status: 'rejected', reason: 'stopped' }
    if (!config.taskEnabled) {
      await this.say('自动化开关没有打开。')
      return { status: 'rejected', reason: 'task_disabled' }
    }
    if (this.pending) {
      await this.say('有一个待恢复任务，先在面板确认恢复或取消。')
      return { status: 'rejected', reason: 'resume_pending' }
    }
    if (this.active) {
      if (this.queue.length >= config.queueMax) {
        await this.say('队列已经满了，先等一会儿。')
        return { status: 'rejected', reason: 'queue_full' }
      }
      const queued: QueuedTask = {
        taskId: randomUUID(),
        name,
        requestedBy: username,
        requestedAt: new Date().toISOString()
      }
      this.queue.push(queued)
      this.deps.state.setTask({ enabled: config.taskEnabled, queue: this.queue })
      await this.persistState(this.active)
      this.deps.audit.append({
        event: 'task.queued',
        source: username === 'panel' ? 'http_control' : 'chat',
        actor: username,
        action: name,
        result: 'accepted',
        details: { taskId: queued.taskId, position: this.queue.length }
      })
      this.emitTask('queued')
      await this.say(`好，排队第 ${this.queue.length} 个${label(name)}。`)
      return { status: 'queued', position: this.queue.length }
    }
    const active = this.createActive(name, randomUUID(), Date.now())
    this.deps.audit.append({
      event: 'task.start',
      source: username === 'panel' ? 'http_control' : 'chat',
      actor: username,
      action: name,
      result: 'accepted',
      details: { taskId: active.taskId }
    })
    await this.launch(active, startMessage(name))
    return { status: 'started' }
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
    const active = this.createActive(pending.name, pending.taskId, pending.startedAt, pending.progress, pending.failures)
    active.deadline = pending.deadline
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
    this.queue = []
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
      pendingResume: null,
      queue: []
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
    this.queue = []
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
      pendingResume: null,
      queue: []
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

  private createActive (
    name: TaskName,
    taskId: string,
    startedAt: number,
    progress?: TaskProgress,
    failures = 0
  ): ActiveTask {
    const now = Date.now()
    return {
      taskId,
      name,
      startedAt,
      deadline: startedAt + this.deps.config.taskMaxMinutes * 60_000,
      progress: progress ? { ...progress } : makeProgress(),
      failures,
      lastError: null,
      stopRequested: false,
      depositRequested: false,
      defenseFailed: false
    }
  }

  private async launch (active: ActiveTask, message: string): Promise<void> {
    this.active = active
    this.controller = new AbortController()
    this.publish(active, 'starting')
    await this.persistState(active)
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

  private async startNext (): Promise<void> {
    if (this.stopped || this.active || this.pending) return
    const next = this.queue.shift()
    if (!next) return
    this.deps.state.setTask({ enabled: this.deps.config.taskEnabled, queue: this.queue })
    const active = this.createActive(next.name, next.taskId, Date.now())
    this.deps.audit.append({
      event: 'task.queue_started',
      source: 'task',
      actor: next.requestedBy,
      action: next.name,
      result: 'accepted',
      details: { taskId: next.taskId }
    })
    this.emitTask('queue_started')
    await this.launch(active, startMessage(active.name))
  }

  private async run (active: ActiveTask): Promise<void> {
    let attempt = 0
    while (!this.stopped && !active.stopRequested) {
      try {
        if (!this.deps.getBot()?.entity) await this.waitForBot(60000)
        await this.ensureAtAnchor(active)
        await this.ensureSupplies(active)
        if (this.deps.config.defenseEnabled && this.deps.defender) {
          try {
            await this.deps.defender.prepare(this.context(active))
          } catch (error) {
            this.logger.warn('defense gear prepare failed', {
              error: error instanceof Error ? error.message : String(error)
            })
          }
        }
        await this.defend(active)
        this.publish(active, 'running')
        const ctx = this.context(active)
        if (active.name === 'fishing') await runFishing(ctx)
        else if (active.name === 'farming') await runFarming(ctx)
        else await runWoodcutting(ctx)
        break
      } catch (error) {
        if (this.shutdownPending) break
        if (active.stopRequested || this.stopped || error instanceof TaskStopError) break
        if (error instanceof DefenseRetreatError) {
          active.defenseFailed = true
          active.lastError = error.message
          break
        }
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

  private async defend (active: ActiveTask): Promise<'none' | 'cleared'> {
    const defender = this.deps.defender
    if (!this.deps.config.defenseEnabled || !defender || !defender.hasThreat()) return 'none'
    this.publish(active, 'defending')
    const outcome = await defender.defend(this.context(active))
    if (outcome === 'retreat') {
      active.defenseFailed = true
      active.lastError = '附近有怪，我先回家'
      throw new DefenseRetreatError('附近有怪，我先回家')
    }
    if (outcome === 'cleared' || outcome === 'none') this.publish(active, 'running')
    return outcome === 'cleared' ? 'cleared' : 'none'
  }

  private async ensureAtAnchor (active: ActiveTask): Promise<void> {
    const { config, movement } = this.deps
    requireBot(this.context(active))
    if (active.name === 'fishing') {
      if (config.taskAnchorTeleport) {
        await movement.teleportTo(config.fishStand.x, config.fishStand.y, config.fishStand.z)
      } else {
        await movement.goNearPoint(config.fishStand.x, config.fishStand.y, config.fishStand.z, 2, 15000, true)
      }
      return
    }
    if (active.name === 'woodcutting') {
      const centerX = (config.treeFarm.minX + config.treeFarm.maxX) / 2
      const centerZ = (config.treeFarm.minZ + config.treeFarm.maxZ) / 2
      if (config.taskAnchorTeleport) {
        await movement.teleportNearPoint(centerX, config.treeFarm.logMinY, centerZ, 5)
      } else {
        await movement.goNearPoint(centerX, config.treeFarm.logMinY, centerZ, 4, 15000, true)
      }
      return
    }
    const bot = requireBot(this.context(active))
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
    let requests: Array<{ name: string, count: number }>
    if (active.name === 'fishing') {
      const rods = bot.inventory.items().filter(item => item.name === 'fishing_rod')
      const hasFreshRod = rods.some(item => ((item.maxDurability ?? 0) - (item.durabilityUsed ?? 0)) > 10)
      requests = [{ name: 'fishing_rod', count: Math.max(2, rods.length + 1) }, { name: 'food', count: 4 }]
      const missing = !hasFreshRod || countFood(bot) < 4
      if (missing) await this.withdraw(ctx, requests)
    } else if (active.name === 'farming') {
      requests = [{ name: 'iron_hoe', count: 1 }, { name: 'wheat_seeds', count: 64 }, { name: 'food', count: 4 }]
      const missing = !findItem(bot, 'iron_hoe') ||
        countItem(bot, 'wheat_seeds') < 64 ||
        countFood(bot) < 4
      if (missing) await this.withdraw(ctx, requests)
    } else {
      const axes = bot.inventory.items().filter(item => item.name === 'iron_axe')
      const hasFreshAxe = axes.some(item => ((item.maxDurability ?? 0) - (item.durabilityUsed ?? 0)) > 10)
      const saplings = countItem(bot, this.deps.config.treeFarm.saplingType)
      requests = [
        { name: 'iron_axe', count: Math.max(2, axes.length + 1) },
        { name: this.deps.config.treeFarm.saplingType, count: 16 },
        { name: 'food', count: 4 }
      ]
      const missing = !hasFreshAxe || saplings < 8 || countFood(bot) < 4
      if (missing) await this.withdraw(ctx, requests)
    }
    const fresh = requireBot(ctx)
    if (active.name === 'fishing') {
      const rods = fresh.inventory.items().filter(item => item.name === 'fishing_rod')
      if (!rods.some(item => ((item.maxDurability ?? 0) - (item.durabilityUsed ?? 0)) > 10)) {
        throw new TaskError('鱼竿快坏了，箱子里没有备用鱼竿')
      }
    } else if (active.name === 'farming') {
      if (!findItem(fresh, 'iron_hoe')) throw new TaskError('箱子里没有锄头')
      if (countItem(fresh, 'wheat_seeds') === 0) throw new TaskError('箱子里没有小麦种子')
    } else {
      const axes = fresh.inventory.items().filter(item => item.name === 'iron_axe')
      if (!axes.some(item => ((item.maxDurability ?? 0) - (item.durabilityUsed ?? 0)) > 10)) {
        throw new TaskError('铁斧快坏了，箱子里没有备用斧')
      }
      if (countItem(fresh, this.deps.config.treeFarm.saplingType) === 0) {
        throw new TaskError('箱子里没有橡树树苗')
      }
    }
    if (countFood(fresh) === 0) throw new TaskError('箱子里没有食物，先放点吃的')
    this.logger.info('task supplies ready', { name: active.name, food: fresh.food })
  }

  private async withdraw (ctx: TaskContext, requests: Array<{ name: string, count: number }>): Promise<void> {
    try {
      await withdrawSupplies(ctx, requests)
    } catch (error) {
      if (error instanceof TaskStopError) throw error
      this.logger.warn('task: supply withdraw failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
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
      clearDepositRequest: () => { active.depositRequested = false },
      defend: async () => {
        return await this.defend(active)
      }
    }
  }

  private async finish (active: ActiveTask, attempts: number): Promise<void> {
    if (this.shutdownPending) {
      await this.persistState(active)
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
        details: { taskId: active.taskId, queue: this.queue.length }
      })
      return
    }
    const { config } = this.deps
    const bot = this.deps.getBot()
    let depositError: string | null = null
    const produced = active.progress.fishCaught + active.progress.wheatHarvested + active.progress.logsChopped
    const hasLeftover = Boolean(bot?.entity && bot.inventory.items().some(item => !isKeptItem(bot, item)))
    if (config.autoDeposit && bot?.entity && (produced > 0 || hasLeftover)) {
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
    } else if (active.name === 'farming') {
      const harvested = active.progress.wheatHarvested
      const planted = active.progress.planted
      await this.say(harvested + planted > 0
        ? `收工啦，收了 ${harvested} 格小麦，补种 ${planted} 格。`
        : '这次农田没什么可做的，我先停下了。')
    } else {
      const logs = active.progress.logsChopped
      const trees = active.progress.treesChopped
      const planted = active.progress.saplingsPlanted
      await this.say(logs > 0
        ? `收工啦，砍了 ${trees} 棵树、${logs} 个原木，补种 ${planted} 棵。`
        : '树场没有可砍的橡木了，我先停下了。')
    }
    if (depositError) await this.say(`存箱时出了点问题：${depositError}`)

    const failed = active.defenseFailed || attempts >= config.taskRecoveryMax
    const stopped = active.stopRequested
    const result = failed ? 'failed' : stopped ? 'stopped' : 'completed'
    if (failed || stopped) this.queue = []
    this.clearPersistTimer()
    this.pending = null

    if (failed) {
      await this.deps.store.clear()
      this.publishIdle(active)
      this.emitTask('failed')
      this.auditFinish(active, attempts, result, depositError)
      this.taskEndedHandler?.()
      return
    }
    if (stopped) {
      await this.deps.store.clear()
      this.publishIdle(active)
      this.emitTask('stopped')
      this.auditFinish(active, attempts, result, depositError)
      this.taskEndedHandler?.()
      return
    }

    // Normal completion: start the next queued task without dropping the queue.
    this.publishIdle(active)
    this.emitTask('completed')
    this.auditFinish(active, attempts, result, depositError)
    if (this.queue.length > 0 && !this.stopped) {
      this.active = null
      this.controller = null
      this.loop = null
      await this.startNext()
      return
    }
    await this.deps.store.clear()
    this.taskEndedHandler?.()
  }

  private auditFinish (active: ActiveTask, attempts: number, result: string, depositError: string | null): void {
    this.deps.audit.append({
      event: 'task.finish',
      source: 'task',
      actor: 'lofii',
      action: active.name,
      result: result === 'failed' ? 'failed' : result === 'stopped' ? 'interrupted' : 'completed',
      details: {
        taskId: active.taskId,
        attempts,
        progress: active.progress,
        depositError,
        result,
        defenseFailed: active.defenseFailed,
        queue: this.queue.length
      }
    })
    this.logger.info('task finished', {
      name: active.name,
      attempts,
      progress: active.progress,
      failures: active.failures,
      depositError,
      result
    })
  }

  private async waitForBot (timeoutMs: number): Promise<void> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (this.stopped || this.controller?.signal.aborted) throw new TaskStopError('task stopped')
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
      if (this.queue.length > 0) {
        this.queue = []
        this.deps.state.setTask({ enabled: this.deps.config.taskEnabled, queue: [] })
        void this.deps.store.clear()
        this.deps.audit.append({
          event: 'task.queue_cleared',
          source: 'chat',
          actor: 'Antifield',
          action: 'queue',
          result: 'accepted',
          details: { reason }
        })
        this.emitTask('queue_cleared')
        void this.say('队列清空了。')
        return
      }
      void this.say('现在没有任务。')
      return
    }
    this.active.stopRequested = true
    const cleared = this.queue.length
    this.queue = []
    this.controller?.abort()
    this.deps.movement.stop(`task:${reason}`)
    this.publish(this.active, 'stopping')
    this.deps.audit.append({
      event: 'task.stop',
      source: reason === 'user' ? 'chat' : 'system',
      actor: reason === 'user' ? 'Antifield' : 'system',
      action: this.active.name,
      result: 'accepted',
      details: { taskId: this.active.taskId, reason, clearedQueue: cleared }
    })
    if (cleared > 0) {
      this.deps.audit.append({
        event: 'task.queue_cleared',
        source: 'task',
        actor: 'system',
        action: 'queue',
        result: 'accepted',
        details: { reason, cleared }
      })
      this.emitTask('queue_cleared')
    }
    this.logger.info('task stop requested', { name: this.active.name, reason, clearedQueue: cleared })
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
    const fake = this.createActive('fishing', randomUUID(), Date.now())
    fake.progress = { ...previous.progress }
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
        pendingResume: null,
        queue: previous.queue
      })
      await this.say(count > 0 ? `存好了，共 ${count} 个。` : '背包里没有需要存的东西。')
    } catch (error) {
      await this.say(`存箱失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async shutdown (): Promise<void> {
    this.stopped = true
    this.clearPendingTimer()
    if (!this.active) {
      if (this.queue.length > 0) await this.persistState(null)
      return
    }
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
    await this.persistState(this.active)
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
      pendingResume: null,
      queue: this.queue
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
      pendingResume: this.pendingResume(),
      queue: this.queue
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
      pendingResume: null,
      queue: this.queue
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
      void this.persistState(active)
    }, 1000)
    this.persistTimer.unref?.()
  }

  private async persistState (active: ActiveTask | null): Promise<void> {
    const persistedActive: PersistedTask | null = active
      ? {
          taskId: active.taskId,
          name: active.name,
          startedAt: active.startedAt,
          deadline: active.deadline,
          progress: { ...active.progress },
          failures: active.failures,
          savedAt: Date.now()
        }
      : null
    const queue: PersistedQueueTask[] = this.queue.map(item => ({
      taskId: item.taskId,
      name: item.name,
      requestedBy: item.requestedBy,
      requestedAt: item.requestedAt
    }))
    await this.deps.store.save({
      version: 2,
      active: persistedActive,
      queue,
      savedAt: Date.now()
    })
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
