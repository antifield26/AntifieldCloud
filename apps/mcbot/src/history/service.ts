import type { Logger } from '../logger.ts'
import type { RuntimeState } from '../state.ts'
import type { HistoryStore } from './store.ts'

export interface HistoryServiceDeps {
  store: HistoryStore | null
  state: RuntimeState
  logger: Logger
  sampleMs: number
  enabled: boolean
}

export class HistoryService {
  private readonly deps: HistoryServiceDeps
  private timer: NodeJS.Timeout | null = null
  private cleanupTimer: NodeJS.Timeout | null = null

  constructor (deps: HistoryServiceDeps) {
    this.deps = deps
  }

  start (): void {
    if (!this.deps.enabled) return
    this.stop()
    this.sampleNow()
    this.timer = setInterval(() => this.sampleNow(), this.deps.sampleMs)
    this.timer.unref?.()
    this.cleanupTimer = setInterval(() => this.deps.store?.cleanup(), 24 * 60 * 60 * 1000)
    this.cleanupTimer.unref?.()
  }

  stop (): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  sampleNow (): void {
    try {
      const store = this.deps.store
      if (!store) return
      const snapshot = this.deps.state.snapshot()
      const usage = process.memoryUsage()
      store.insertSample({
        ts: new Date().toISOString(),
        connected: snapshot.minecraft.connected,
        state: snapshot.state,
        taskName: snapshot.task.name,
        taskState: snapshot.task.state,
        health: snapshot.player.health,
        food: snapshot.player.food,
        memoryMb: Math.round((usage.heapUsed / (1024 * 1024)) * 10) / 10,
        tps: snapshot.admin.tps.one,
        queueLen: snapshot.task.queue.length,
        rssMb: Math.round((usage.rss / (1024 * 1024)) * 10) / 10
      })
    } catch (error) {
      this.deps.logger.warn('history: sample failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
