import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TaskName, TaskProgress } from '../state.ts'
import type { Logger } from '../logger.ts'

export interface PersistedTask {
  version: 1
  taskId: string
  name: TaskName
  startedAt: number
  deadline: number
  progress: TaskProgress
  failures: number
  savedAt: number
}

function isProgress (value: unknown): value is TaskProgress {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return ['fishCaught', 'wheatHarvested', 'planted', 'deposited'].every(key => Number.isFinite(record[key]))
}

export class TaskStore {
  private readonly file: string
  private readonly logger: Logger
  private queue: Promise<void> = Promise.resolve()

  constructor (file: string, logger: Logger) {
    this.file = file
    this.logger = logger
  }

  async load (): Promise<PersistedTask | null> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return null
    }
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedTask>
      if (parsed.version !== 1 ||
        typeof parsed.taskId !== 'string' ||
        (parsed.name !== 'fishing' && parsed.name !== 'farming') ||
        !Number.isFinite(parsed.startedAt) ||
        !Number.isFinite(parsed.deadline) ||
        !Number.isFinite(parsed.savedAt) ||
        !Number.isFinite(parsed.failures) ||
        !isProgress(parsed.progress)) {
        throw new Error('invalid task state')
      }
      return parsed as PersistedTask
    } catch (error) {
      this.logger.warn('task state corrupt; quarantining', {
        error: error instanceof Error ? error.message : String(error)
      })
      await rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {})
      return null
    }
  }

  save (task: PersistedTask): Promise<void> {
    this.queue = this.queue.then(() => this.write(task)).catch(error => {
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

  private async write (task: PersistedTask): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.tmp-${process.pid}`
    await writeFile(temp, JSON.stringify(task), { mode: 0o600 })
    await chmod(temp, 0o600)
    await rename(temp, this.file)
  }
}
