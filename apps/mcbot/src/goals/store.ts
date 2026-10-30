/**
 * 长期目标/多步计划的本地持久化。
 *
 * 安全边界：只保存目标文本、步骤类型/任务名与状态元数据；不保存聊天正文、
 * 凭据、容器内容或路径。目标不会在服务重启后自动执行，必须由主人显式恢复。
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { TaskName } from '../state.ts'

export type GoalKind = 'task' | 'deposit' | 'home'
export type GoalStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'canceled'
export type GoalStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
export type GoalFailureKind = 'path' | 'survival' | 'supplies' | 'interrupted' | 'unknown'

export interface GoalStepInput {
  kind: GoalKind
  taskName?: TaskName
}

export interface GoalStep {
  index: number
  kind: GoalKind
  taskName: TaskName | null
  status: GoalStepStatus
  attempts: number
  lastError: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface Goal {
  id: string
  owner: string
  objective: string
  status: GoalStatus
  currentStep: number
  attempts: number
  lastFailureKind: GoalFailureKind | null
  lastError: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
  steps: GoalStep[]
}

export const GOAL_TASK_NAMES: readonly TaskName[] = [
  'fishing', 'farming', 'woodcutting', 'mining', 'forest', 'sleep',
  'patrol', 'guard', 'escort', 'explore', 'clearing'
]

const MAX_OBJECTIVE_CHARS = 200
const MAX_ERROR_CHARS = 300

interface GoalRow {
  id: string
  owner: string
  objective: string
  status: GoalStatus
  current_step: number
  attempts: number
  last_failure_kind: GoalFailureKind | null
  last_error: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
}

interface StepRow {
  goal_id: string
  step_index: number
  kind: GoalKind
  task_name: TaskName | null
  status: GoalStepStatus
  attempts: number
  last_error: string | null
  started_at: string | null
  finished_at: string | null
}

function isGoalStatus (value: unknown): value is GoalStatus {
  return value === 'pending' || value === 'running' || value === 'paused' ||
    value === 'completed' || value === 'failed' || value === 'canceled'
}

function isKind (value: unknown): value is GoalKind {
  return value === 'task' || value === 'deposit' || value === 'home'
}

function isTaskName (value: unknown): value is TaskName {
  return typeof value === 'string' && (GOAL_TASK_NAMES as readonly string[]).includes(value)
}

export function validateGoalSteps (steps: unknown, maxSteps: number): GoalStepInput[] {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('goal_steps_required')
  if (steps.length > maxSteps) throw new Error('goal_too_many_steps')
  return steps.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('goal_step_invalid')
    const record = value as Record<string, unknown>
    if (!isKind(record.kind)) throw new Error('goal_step_invalid')
    if (record.kind === 'task') {
      if (!isTaskName(record.taskName)) throw new Error('goal_task_invalid')
      return { kind: 'task', taskName: record.taskName }
    }
    return { kind: record.kind }
  })
}

export class GoalStore {
  private readonly file: string
  private db: DatabaseSync | null = null

  constructor (file: string) {
    this.file = file
  }

  init (): void {
    mkdirSync(dirname(this.file), { recursive: true })
    this.db = new DatabaseSync(this.file)
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        current_step INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_failure_kind TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS goal_steps (
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        step_index INTEGER NOT NULL,
        kind TEXT NOT NULL,
        task_name TEXT,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        started_at TEXT,
        finished_at TEXT,
        PRIMARY KEY (goal_id, step_index)
      );
      CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status, updated_at DESC);
    `)
    // 进程上次退出时未结束的目标不能自动继续执行。
    this.db.prepare("UPDATE goals SET status = 'paused', updated_at = ? WHERE status = 'running'").run(new Date().toISOString())
  }

  close (): void {
    this.db?.close()
    this.db = null
  }

  create (owner: string, objective: string, steps: GoalStepInput[]): Goal {
    const db = this.requireDb()
    const clean = objective.replace(/\s+/g, ' ').trim().slice(0, MAX_OBJECTIVE_CHARS)
    if (!clean) throw new Error('goal_objective_invalid')
    const id = randomUUID()
    const now = new Date().toISOString()
    db.exec('BEGIN')
    try {
      db.prepare(
        `INSERT INTO goals (id, owner, objective, status, current_step, attempts, last_failure_kind, last_error,
           created_at, updated_at, started_at, finished_at)
         VALUES (?, ?, ?, 'pending', 0, 0, NULL, NULL, ?, ?, NULL, NULL)`,
      ).run(id, owner.slice(0, 64), clean, now, now)
      const insertStep = db.prepare(
        `INSERT INTO goal_steps (goal_id, step_index, kind, task_name, status, attempts, last_error, started_at, finished_at)
         VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL)`,
      )
      steps.forEach((step, index) => insertStep.run(id, index, step.kind, step.taskName ?? null))
      db.exec('COMMIT')
      return this.get(id)!
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  get (id: string): Goal | null {
    const db = this.requireDb()
    const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as unknown as GoalRow | undefined
    if (!row) return null
    return this.toGoal(row)
  }

  list (limit = 20): Goal[] {
    const db = this.requireDb()
    const rows = db.prepare('SELECT * FROM goals ORDER BY updated_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(50, Math.floor(limit)))) as unknown as GoalRow[]
    return rows.map(row => this.toGoal(row))
  }

  update (id: string, patch: Partial<Pick<Goal, 'status' | 'currentStep' | 'attempts' | 'lastFailureKind' | 'lastError' | 'startedAt' | 'finishedAt'>>): void {
    const db = this.requireDb()
    const current = this.get(id)
    if (!current) throw new Error('goal_not_found')
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
    db.prepare(
      `UPDATE goals SET status = ?, current_step = ?, attempts = ?, last_failure_kind = ?, last_error = ?,
         updated_at = ?, started_at = ?, finished_at = ? WHERE id = ?`,
    ).run(
      next.status,
      next.currentStep,
      next.attempts,
      next.lastFailureKind,
      next.lastError === null ? null : next.lastError.slice(0, MAX_ERROR_CHARS),
      next.updatedAt,
      next.startedAt,
      next.finishedAt,
      id,
    )
  }

  updateStep (goalId: string, index: number, patch: Partial<Pick<GoalStep, 'status' | 'attempts' | 'lastError' | 'startedAt' | 'finishedAt'>>): void {
    const db = this.requireDb()
    const step = this.stepsOf(goalId).find(item => item.index === index)
    if (!step) throw new Error('goal_step_not_found')
    const next = { ...step, ...patch }
    db.prepare(
      `UPDATE goal_steps SET status = ?, attempts = ?, last_error = ?, started_at = ?, finished_at = ?
       WHERE goal_id = ? AND step_index = ?`,
    ).run(
      next.status,
      next.attempts,
      next.lastError === null ? null : next.lastError.slice(0, MAX_ERROR_CHARS),
      next.startedAt,
      next.finishedAt,
      goalId,
      index,
    )
  }

  private stepsOf (goalId: string): GoalStep[] {
    const db = this.requireDb()
    const rows = db.prepare('SELECT * FROM goal_steps WHERE goal_id = ? ORDER BY step_index ASC')
      .all(goalId) as unknown as StepRow[]
    return rows.map(row => ({
      index: row.step_index,
      kind: row.kind,
      taskName: row.task_name,
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
      startedAt: row.started_at,
      finishedAt: row.finished_at
    }))
  }

  private toGoal (row: GoalRow): Goal {
    if (!isGoalStatus(row.status)) throw new Error('goal_status_invalid')
    return {
      id: row.id,
      owner: row.owner,
      objective: row.objective,
      status: row.status,
      currentStep: row.current_step,
      attempts: row.attempts,
      lastFailureKind: row.last_failure_kind,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      steps: this.stepsOf(row.id)
    }
  }

  private requireDb (): DatabaseSync {
    if (!this.db) throw new Error('goal_store_not_initialized')
    return this.db
  }
}
