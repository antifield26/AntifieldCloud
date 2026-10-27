import type { Bot } from 'mineflayer'
import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'
import type { RuntimeState, TaskName, TaskProgress, TaskSnapshot } from '../state.ts'
import type { ChatSender } from '../minecraft/chat.ts'
import type { MovementManager } from '../minecraft/movement.ts'

export class TaskError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'TaskError'
  }
}

export class TaskStopError extends TaskError {
  constructor (message = 'task stopped') {
    super(message)
    this.name = 'TaskStopError'
  }
}

export interface TaskContext {
  config: Config
  logger: Logger
  state: RuntimeState
  chatSender: ChatSender
  movement: MovementManager
  getBot: () => Bot | null
  signal: AbortSignal
  deadline: number
  progress: TaskProgress
  say: (text: string) => Promise<void>
  updateProgress: (patch: Partial<TaskProgress>) => void
  requestDeposit: () => void
  depositRequested: () => boolean
  clearDepositRequest: () => void
  defend: () => Promise<'none' | 'cleared'>
}

export type TaskStartStatus = 'started' | 'queued' | 'rejected'

export function requireBot (ctx: TaskContext): Bot {
  const bot = ctx.getBot()
  if (!bot || !bot.entity) throw new TaskError('我还没连上服务器')
  return bot
}

export function isExpired (ctx: TaskContext): boolean {
  return Date.now() >= ctx.deadline
}

export function sleep (ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TaskStopError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new TaskStopError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function stopSignal (signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new TaskStopError())
      return
    }
    signal.addEventListener('abort', () => reject(new TaskStopError()), { once: true })
  })
}

export interface TaskStartResult {
  status: TaskStartStatus
  position?: number
  reason?: string
}

export interface TaskController {
  start: (name: TaskName, username: string) => Promise<TaskStartResult>
  requestStop: (reason: string) => void
  stopAndWait: (reason: string) => Promise<void>
  depositNow: () => Promise<void>
  confirmResume: (taskId?: string) => Promise<void>
  discardPending: (reason: string) => Promise<void>
  snapshot: () => TaskSnapshot
  keepOnline: () => boolean
  isActive: () => boolean
}
