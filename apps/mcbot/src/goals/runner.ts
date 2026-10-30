/**
 * 多步目标执行器：串行执行 task/deposit/home 步骤，失败分类后暂停或安全重试。
 *
 * 安全边界：目标创建后必须由主人显式 start/resume；重启后只保留为 paused。
 * path 失败最多安全重试一次；survival 中断在恢复且无威胁后最多自动恢复一次；
 * 其它失败暂停等待主人处理，不自动执行新的动作。
 */
import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'
import type { RuntimeState, TaskName } from '../state.ts'
import type { EventBus } from '../events/bus.ts'
import type { AuditLogger } from '../audit.ts'
import type { MovementManager } from '../minecraft/movement.ts'
import type { TaskController } from '../tasks/types.ts'
import { GoalStore, type Goal, type GoalFailureKind, type GoalStepInput } from './store.ts'

export interface GoalRunnerDeps {
  config: Config
  logger: Logger
  state: RuntimeState
  tasks: TaskController
  movement: MovementManager
  events: EventBus
  audit: AuditLogger
  store: GoalStore
  now?: () => Date
}

interface TaskEventData {
  action?: unknown
  task?: { name?: unknown, lastError?: unknown }
}

export class GoalRunner {
  private readonly deps: GoalRunnerDeps
  private readonly unsubscribe: () => void
  private readonly autoResumed = new Set<string>()
  private survivalTimer: NodeJS.Timeout | null = null
  private starting = false

  constructor (deps: GoalRunnerDeps) {
    this.deps = deps
    this.unsubscribe = deps.events.subscribe(event => {
      if (event.type === 'task') this.onTaskEvent(event.data)
    })
  }

  list (limit = 20): Goal[] {
    return this.deps.store.list(limit)
  }

  get (id: string): Goal | null {
    return this.deps.store.get(id)
  }

  create (owner: string, objective: string, steps: GoalStepInput[]): Goal {
    const goal = this.deps.store.create(owner, objective, steps)
    this.deps.audit.append({
      event: 'goal.create',
      source: 'http_control',
      actor: owner.slice(0, 64),
      action: 'create',
      result: 'accepted',
      details: { steps: steps.length }
    })
    return goal
  }

  async start (id: string, by = 'panel'): Promise<Goal> {
    if (this.starting) throw new Error('goal_busy')
    const goal = this.requireGoal(id)
    if (goal.status !== 'pending' && goal.status !== 'paused') throw new Error('goal_not_startable')
    if (this.deps.tasks.isActive() || this.deps.tasks.snapshot().queue.length > 0 || this.deps.tasks.snapshot().pendingResume) {
      throw new Error('goal_busy')
    }
    this.starting = true
    try {
      this.deps.store.update(id, {
        status: 'running',
        startedAt: goal.startedAt ?? this.nowIso(),
        finishedAt: null,
        lastError: null,
        lastFailureKind: null
      })
      this.deps.audit.append({
        event: 'goal.start',
        source: 'http_control',
        actor: by.slice(0, 64),
        action: 'start',
        result: 'accepted',
        details: { goal: id.slice(0, 8) }
      })
      await this.executeCurrent(id)
      return this.requireGoal(id)
    } finally {
      this.starting = false
    }
  }

  async pause (id: string, by = 'panel'): Promise<Goal> {
    const goal = this.requireGoal(id)
    if (goal.status !== 'running') throw new Error('goal_not_running')
    await this.deps.tasks.stopAndWait('goal_pause')
    this.deps.store.update(id, { status: 'paused', lastError: null })
    this.deps.audit.append({
      event: 'goal.pause',
      source: 'http_control',
      actor: by.slice(0, 64),
      action: 'pause',
      result: 'accepted',
      details: {}
    })
    return this.requireGoal(id)
  }

  async cancel (id: string, by = 'panel'): Promise<Goal> {
    const goal = this.requireGoal(id)
    if (goal.status === 'running') await this.deps.tasks.stopAndWait('goal_cancel')
    this.deps.store.update(id, { status: 'canceled', finishedAt: this.nowIso() })
    for (const step of goal.steps) {
      if (step.status === 'pending' || step.status === 'running') {
        this.deps.store.updateStep(id, step.index, { status: 'skipped', finishedAt: this.nowIso() })
      }
    }
    this.deps.audit.append({
      event: 'goal.cancel',
      source: 'http_control',
      actor: by.slice(0, 64),
      action: 'cancel',
      result: 'accepted',
      details: {}
    })
    return this.requireGoal(id)
  }

  stop (): void {
    this.unsubscribe()
    if (this.survivalTimer) clearTimeout(this.survivalTimer)
    this.survivalTimer = null
  }

  private async executeCurrent (goalId: string): Promise<void> {
    const goal = this.requireGoal(goalId)
    if (goal.status !== 'running') return
    const step = goal.steps[goal.currentStep]
    if (!step) {
      this.deps.store.update(goalId, { status: 'completed', finishedAt: this.nowIso() })
      return
    }
    this.deps.store.updateStep(goalId, step.index, {
      status: 'running',
      startedAt: this.nowIso(),
      finishedAt: null,
      lastError: null
    })
    if (step.kind === 'home') {
      try {
        await this.deps.movement.home()
        this.finishStep(goalId, step.index)
      } catch (error) {
        this.failStep(goalId, step.index, error, 'path')
      }
      return
    }
    if (step.kind === 'deposit') {
      try {
        await this.deps.tasks.depositNow()
        this.finishStep(goalId, step.index)
      } catch (error) {
        this.failStep(goalId, step.index, error, 'supplies')
      }
      return
    }
    try {
      const result = await this.deps.tasks.start(step.taskName as TaskName, 'panel', 'http_control')
      if (result.status === 'rejected') {
        this.failStep(goalId, step.index, new Error(result.reason ?? 'task_rejected'), 'unknown')
      }
    } catch (error) {
      this.failStep(goalId, step.index, error, 'unknown')
    }
  }

  private onTaskEvent (data: unknown): void {
    const record = data as TaskEventData | null
    const action = typeof record?.action === 'string' ? record.action : ''
    if (!action || !['completed', 'failed', 'stopped', 'interrupted'].includes(action)) return
    const goalId = this.runningGoalId()
    if (!goalId) return
    const goal = this.deps.store.get(goalId)
    if (!goal || goal.status !== 'running') return
    const step = goal.steps[goal.currentStep]
    if (!step || step.kind !== 'task') return
    const name = record?.task?.name
    if (typeof name === 'string' && name !== step.taskName) return
    if (action === 'completed') {
      this.finishStep(goalId, step.index)
      return
    }
    const raw = record?.task?.lastError
    const message = typeof raw === 'string' ? raw : action
    const failureKind: GoalFailureKind = action === 'interrupted' ? 'interrupted' : this.classify(message)
    this.failStep(goalId, step.index, new Error(message), failureKind)
  }

  private finishStep (goalId: string, index: number): void {
    this.deps.store.updateStep(goalId, index, { status: 'completed', finishedAt: this.nowIso() })
    const goal = this.requireGoal(goalId)
    if (goal.currentStep >= goal.steps.length - 1) {
      this.deps.store.update(goalId, { status: 'completed', currentStep: goal.steps.length, finishedAt: this.nowIso() })
      this.deps.audit.append({
        event: 'goal.finish',
        source: 'task',
        actor: 'lofii',
        action: 'completed',
        result: 'completed',
        details: { steps: goal.steps.length }
      })
      return
    }
    this.deps.store.update(goalId, { currentStep: goal.currentStep + 1, lastError: null, lastFailureKind: null })
    void this.executeCurrent(goalId)
  }

  private failStep (goalId: string, index: number, error: unknown, kind: GoalFailureKind): void {
    const message = error instanceof Error ? error.message : String(error)
    const goal = this.requireGoal(goalId)
    const step = goal.steps[index]
    if (!step) return
    const attempts = step.attempts + 1
    // 高低差/NoPath 只做一次受控重试；之后必须暂停，避免反复传送。
    if (kind === 'path' && attempts <= 1) {
      this.deps.store.updateStep(goalId, index, { status: 'pending', attempts, lastError: message })
      this.deps.store.update(goalId, { attempts: attempts })
      void this.executeCurrent(goalId)
      return
    }
    this.deps.store.updateStep(goalId, index, { status: 'failed', attempts, lastError: message, finishedAt: this.nowIso() })
    this.deps.store.update(goalId, {
      status: 'paused',
      attempts,
      lastFailureKind: kind,
      lastError: message
    })
    this.deps.audit.append({
      event: 'goal.failure',
      source: 'task',
      actor: 'lofii',
      action: kind,
      result: 'failed',
      details: { goal: goalId.slice(0, 8), step: index, attempts }
    })
    if (kind === 'survival') this.scheduleSurvivalResume(goalId)
  }

  private scheduleSurvivalResume (goalId: string): void {
    if (this.autoResumed.has(goalId) || this.survivalTimer) return
    this.survivalTimer = setTimeout(() => {
      this.survivalTimer = null
      void this.trySurvivalResume(goalId)
    }, 5000)
    this.survivalTimer.unref?.()
  }

  private async trySurvivalResume (goalId: string): Promise<void> {
    const goal = this.deps.store.get(goalId)
    if (!goal || goal.status !== 'paused') return
    const player = this.deps.state.player
    const healthy = player.health === null || player.health >= this.deps.config.defenseHealthThreshold
    const fed = player.food === null || player.food >= this.deps.config.defenseFoodThreshold
    if (!healthy || !fed || this.deps.tasks.isActive()) {
      // 未恢复就继续等待，但只在一个短窗口内尝试，避免永久定时器。
      this.survivalTimer = setTimeout(() => {
        this.survivalTimer = null
        void this.trySurvivalResume(goalId)
      }, 10000)
      this.survivalTimer.unref?.()
      return
    }
    this.autoResumed.add(goalId)
    try {
      await this.start(goalId, 'survival_auto')
    } catch {
      // 无法恢复时保留 paused，由主人处理。
    }
  }

  private classify (message: string): GoalFailureKind {
    if (/path|no path|走不过去|unreachable|navigation|楔|卡住/i.test(message)) return 'path'
    if (/health|food|defend|retreat|低血|饥饿|危险/i.test(message)) return 'survival'
    if (/supply|supplies|tool|seed|chest|item|补给|工具|种子|箱子/i.test(message)) return 'supplies'
    if (/interrupt|stop|断线|中断|停止/i.test(message)) return 'interrupted'
    return 'unknown'
  }

  private runningGoalId (): string | null {
    return this.deps.store.list(50).find(goal => goal.status === 'running')?.id ?? null
  }

  private requireGoal (id: string): Goal {
    const goal = this.deps.store.get(id)
    if (!goal) throw new Error('goal_not_found')
    return goal
  }

  private nowIso (): string {
    return (this.deps.now?.() ?? new Date()).toISOString()
  }
}
