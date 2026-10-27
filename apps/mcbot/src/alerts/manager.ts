import type { Bot } from 'mineflayer'
import type { Config } from '../config.ts'
import type { EventBus } from '../events/bus.ts'
import type { HistoryStore } from '../history/store.ts'
import type { Logger } from '../logger.ts'
import type { RuntimeState } from '../state.ts'

export type AlertType = 'low_health' | 'task_failed' | 'disconnected' | 'chest_full' | 'defense_retreat'
export type AlertSeverity = 'warning' | 'error'

export interface AlertEvent {
  type: AlertType
  severity: AlertSeverity
  message: string
  details: Record<string, unknown>
  ts: string
}

export interface AlertManagerDeps {
  config: Config
  logger: Logger
  state: RuntimeState
  events: EventBus
  store: HistoryStore | null
  getBot: () => Bot | null
}

const HEALTH_CHECK_MS = 5000

export class AlertManager {
  private readonly deps: AlertManagerDeps
  private readonly logger: Logger
  private readonly lastSent = new Map<AlertType, number>()
  private timer: NodeJS.Timeout | null = null
  private startedAt = 0

  constructor (deps: AlertManagerDeps) {
    this.deps = deps
    this.logger = deps.logger
  }

  start (): void {
    if (!this.deps.config.alerts.enabled) return
    this.stop()
    this.startedAt = Date.now()
    this.timer = setInterval(() => this.checkHealth(), HEALTH_CHECK_MS)
    this.timer.unref?.()
  }

  stop (): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  raise (type: AlertType, message: string, details: Record<string, unknown> = {}, severity: AlertSeverity = 'warning'): void {
    if (!this.deps.config.alerts.enabled) return
    const now = Date.now()
    const last = this.lastSent.get(type) ?? 0
    if (now - last < this.deps.config.alerts.cooldownMs) return
    this.lastSent.set(type, now)
    const event: AlertEvent = {
      type,
      severity,
      message: message.slice(0, 500),
      details,
      ts: new Date().toISOString()
    }
    this.deps.store?.insertAlert(event)
    this.deps.events.emit('alert', event)
    this.logger.warn('alert', { type, severity, message: event.message })
  }

  private checkHealth (): void {
    if (Date.now() - this.startedAt < 10000) return
    if (!this.deps.config.alerts.enabled) return
    const bot = this.deps.getBot()
    if (!bot?.entity || !this.deps.state.minecraft.connected) return
    const health = this.deps.state.player.health ?? bot.health
    if (health === null || !Number.isFinite(health)) return
    if (health <= this.deps.config.alerts.healthThreshold) {
      this.raise('low_health', `Lofii 血量偏低：${Math.round(health)}/20`, {
        health,
        threshold: this.deps.config.alerts.healthThreshold
      }, 'warning')
    }
  }
}
