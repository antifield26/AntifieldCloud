import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TaskName, TaskProgress } from '../state.ts'
import type { Logger } from '../logger.ts'

export interface PersistedTask {
  taskId: string
  name: TaskName
  startedAt: number
  deadline: number
  progress: TaskProgress
  failures: number
  savedAt: number
}

export interface PersistedQueueTask {
  taskId: string
  name: TaskName
  requestedBy: string
  requestedAt: string
}

export interface PersistedTaskState {
  version: 2
  active: PersistedTask | null
  queue: PersistedQueueTask[]
  savedAt: number
}

function isBaseProgress (value: unknown): value is { fishCaught: number, wheatHarvested: number, planted: number, deposited: number } {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return ['fishCaught', 'wheatHarvested', 'planted', 'deposited']
    .every(key => typeof record[key] === 'number' && Number.isFinite(record[key]))
}

function normalizeProgress (value: unknown): TaskProgress {
  const record = value as Record<string, unknown>
  return {
    fishCaught: record.fishCaught as number,
    wheatHarvested: record.wheatHarvested as number,
    planted: record.planted as number,
    deposited: record.deposited as number,
    treesChopped: typeof record.treesChopped === 'number' && Number.isFinite(record.treesChopped) ? record.treesChopped : 0,
    logsChopped: typeof record.logsChopped === 'number' && Number.isFinite(record.logsChopped) ? record.logsChopped : 0,
    saplingsPlanted: typeof record.saplingsPlanted === 'number' && Number.isFinite(record.saplingsPlanted) ? record.saplingsPlanted : 0,
    mobsKilled: typeof record.mobsKilled === 'number' && Number.isFinite(record.mobsKilled) ? record.mobsKilled : 0
  }
}

function isProgress (value: unknown): value is TaskProgress {
  if (!isBaseProgress(value)) return false
  const record = value as unknown as Record<string, unknown>
  return ['treesChopped', 'logsChopped', 'saplingsPlanted', 'mobsKilled']
    .every(key => typeof record[key] === 'number' && Number.isFinite(record[key]))
}

function isName (value: unknown): value is TaskName {
  return value === 'fishing' || value === 'farming' || value === 'woodcutting'
}

function isActive (value: unknown): value is PersistedTask {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.taskId === 'string' &&
    isName(record.name) &&
    typeof record.startedAt === 'number' && Number.isFinite(record.startedAt) &&
    typeof record.deadline === 'number' && Number.isFinite(record.deadline) &&
    typeof record.failures === 'number' && Number.isFinite(record.failures) &&
    typeof record.savedAt === 'number' && Number.isFinite(record.savedAt) &&
    (isProgress(record.progress) || isBaseProgress(record.progress))
}

function isQueueTask (value: unknown): value is PersistedQueueTask {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.taskId === 'string' &&
    isName(record.name) &&
    typeof record.requestedBy === 'string' &&
    typeof record.requestedAt === 'string'
}

export class TaskStore {
  private readonly file: string
  private readonly logger: Logger
  private queue: Promise<void> = Promise.resolve()

  constructor (file: string, logger: Logger) {
    this.file = file
    this.logger = logger
  }

  async load (): Promise<PersistedTaskState | null> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return null
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed.version === 2) {
        const active = parsed.active === null ? null : parsed.active
        if (active !== null && !isActive(active)) throw new Error('invalid active task')
        if (!Array.isArray(parsed.queue) || !parsed.queue.every(isQueueTask)) throw new Error('invalid queue')
        if (typeof parsed.savedAt !== 'number' || !Number.isFinite(parsed.savedAt)) throw new Error('invalid savedAt')
        return {
          version: 2,
          active: active === null ? null : { ...active, progress: normalizeProgress(active.progress) },
          queue: (parsed.queue as PersistedQueueTask[]).map(item => ({ ...item })),
          savedAt: parsed.savedAt
        }
      }
      // v0.2/v0.3 single-active file migration.
      if (!isActive(parsed)) throw new Error('invalid task state')
      return {
        version: 2,
        active: { ...parsed, progress: normalizeProgress(parsed.progress) },
        queue: [],
        savedAt: parsed.savedAt
      }
    } catch (error) {
      this.logger.warn('task state corrupt; quarantining', {
        error: error instanceof Error ? error.message : String(error)
      })
      await rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {})
      return null
    }
  }

  save (state: PersistedTaskState): Promise<void> {
    this.queue = this.queue.then(() => this.write(state)).catch(error => {
      this.logger.warn('task state save failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    })
    return this.queue
  }

  clear (): Promise<void> {
    this.queue = this.queue.then(() => unlink(this.file)).catch(() => {})
    return this.queue
  }

  private async write (state: PersistedTaskState): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.tmp-${process.pid}`
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 })
    await chmod(temp, 0o600)
    await rename(temp, this.file)
  }
}
