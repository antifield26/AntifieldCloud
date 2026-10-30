import type { Config, PresenceMode } from '../config.ts'
import type { Logger } from '../logger.ts'
import type { PresenceModeSource, RuntimeState } from '../state.ts'
import type { BotController } from '../minecraft/bot.ts'
import { pingServer, type SlpResult } from './slp.ts'
import type { PresenceStore } from './store.ts'

export interface PresenceDeps {
  config: Config
  logger: Logger
  state: RuntimeState
  controller: BotController
  keepOnline?: () => boolean
  ping?: () => Promise<SlpResult>
  /** 持久化存储；未提供时只在内存中切换模式。 */
  store?: PresenceStore
  initialMode?: PresenceMode
  initialSource?: PresenceModeSource
  initialUpdatedAt?: string | null
}

export interface PresenceModeChange {
  ok: boolean
  code?: 'presence_busy' | 'invalid_mode' | 'presence_persist_failed'
  mode: PresenceMode
}

type PingFn = () => Promise<SlpResult>

const LONG_COOLDOWN_MS = 300000

function isFatalLoginReason (reason: string): boolean {
  return /whitelist|not white.?listed|server is full|full|unsupported|incompatible|version/i.test(reason)
}

export class PresenceManager {
  private readonly deps: PresenceDeps
  private readonly ping: PingFn
  private mode: PresenceMode
  private modeSource: PresenceModeSource
  private modeUpdatedAt: string | null
  private started = false
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private connecting = false
  private connectedAt = 0
  private lastOthersAt = Date.now()
  private backoffMs: number
  private probeBackoffMs: number
  private lastQuitAt = 0
  private lastProbeAt = 0

  constructor (deps: PresenceDeps) {
    this.deps = deps
    this.ping = deps.ping ?? (() => pingServer({
      host: deps.config.mcHost,
      port: deps.config.mcPort,
      timeoutMs: 3000
    }))
    this.mode = deps.initialMode ??
      (!deps.config.presenceEnabled || deps.config.forceOnline ? 'always' : deps.config.presenceMode)
    this.modeSource = deps.initialSource ?? (deps.initialMode ? 'persisted' : 'default')
    this.modeUpdatedAt = deps.initialUpdatedAt ?? null
    this.backoffMs = deps.config.reconnectMinMs
    this.probeBackoffMs = deps.config.presencePollMs
    this.deps.state.setPresenceMode(this.mode, this.modeSource, this.modeUpdatedAt)
  }

  /** 当前模式与来源，供 /status 与 /presence 使用。 */
  presenceInfo (): { mode: PresenceMode, source: PresenceModeSource, updatedAt: string | null } {
    return { mode: this.mode, source: this.modeSource, updatedAt: this.modeUpdatedAt }
  }

  /**
   * 切换在线模式。off 在任务/自主会话保持在线时拒绝，避免把正在执行的任务直接断线。
   * 持久化成功后才更新内存状态；切换后立即唤醒 presence loop。
   */
  setMode (mode: PresenceMode, actor: string): PresenceModeChange {
    if (mode !== 'auto' && mode !== 'always' && mode !== 'off') {
      return { ok: false, code: 'invalid_mode', mode: this.mode }
    }
    if (mode === 'off' && this.keepOnline()) {
      return { ok: false, code: 'presence_busy', mode: this.mode }
    }
    const updatedAt = new Date().toISOString()
    try {
      this.deps.store?.save({ mode, updatedAt, updatedBy: actor.slice(0, 64) })
    } catch (error) {
      this.deps.logger.warn('presence: mode persist failed', {
        error: error instanceof Error ? error.message : String(error)
      })
      return { ok: false, code: 'presence_persist_failed', mode: this.mode }
    }
    this.mode = mode
    this.modeSource = 'persisted'
    this.modeUpdatedAt = updatedAt
    this.deps.state.setPresenceMode(mode, 'persisted', updatedAt)
    this.deps.logger.info('presence: mode changed', { mode, actor })
    this.clearTimer()
    if (this.started && !this.stopped) this.schedule(0)
    return { ok: true, mode }
  }

  start (): void {
    this.stopped = false
    this.started = true
    this.lastOthersAt = Date.now()
    this.deps.controller.setDisconnectHandler(reason => this.onUnexpectedDisconnect(reason))
    this.deps.logger.info('presence started', {
      mode: this.mode,
      modeSource: this.modeSource,
      pollMs: this.deps.config.presencePollMs,
      graceMs: this.deps.config.presenceGraceMs
    })
    if (this.mode === 'always') {
      void this.connectNow()
    }
    this.schedule(0)
  }

  private async refreshServerInfo (): Promise<void> {
    try {
      const result = await this.ping()
      const current = this.deps.state.server
      this.deps.state.setServer({
        ...current,
        reachable: true,
        max: result.max,
        versionName: result.versionName,
        motd: result.motd,
        latencyMs: result.latencyMs,
        lastPingAt: new Date().toISOString()
      })
    } catch (error) {
      this.deps.logger.debug('presence: server info refresh failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  async stop (): Promise<void> {
    this.stopped = true
    this.clearTimer()
    if (this.deps.controller.isConnected()) {
      await this.deps.controller.stop('shutdown')
    }
    this.deps.state.setState('idle', 'stopped')
  }

  notifyTaskEnded (): void {
    this.lastOthersAt = Date.now()
    if (this.mode === 'off' && this.started && !this.stopped) {
      this.clearTimer()
      this.schedule(0)
    }
  }

  private keepOnline (): boolean {
    try {
      return this.deps.keepOnline?.() === true
    } catch {
      return false
    }
  }

  private schedule (ms: number): void {
    if (this.stopped) return
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.loop()
    }, Math.max(0, ms))
  }

  private clearTimer (): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async loop (): Promise<void> {
    if (this.stopped) return
    const { state } = this.deps
    if (state.state === 'connected') {
      const active = await this.checkConnected()
      if (active) this.schedule(this.deps.config.presenceCheckMs)
      return
    }
    if (state.state === 'connecting' || this.connecting) {
      this.schedule(500)
      return
    }
    if (this.mode === 'off') {
      state.setState('idle', 'presence off')
      state.setPresence(0, 'presence off')
      this.schedule(this.deps.config.presencePollMs)
      return
    }
    if (this.mode === 'always') {
      if (!this.deps.controller.isConnected()) void this.connectNow()
      this.schedule(1000)
      return
    }
    this.lastProbeAt = Date.now()
    let result: SlpResult
    try {
      result = await this.ping()
    } catch (error) {
      if (this.stopped) return
      const message = error instanceof Error ? error.message : String(error)
      this.deps.state.setServer({
        reachable: false,
        online: 0,
        max: 0,
        versionName: null,
        motd: null,
        latencyMs: null,
        lastPingAt: new Date().toISOString()
      })
      this.deps.state.setPresence(0, `server unreachable: ${message}`)
      this.deps.state.setState('idle', `server unreachable: ${message}`)
      this.deps.logger.warn('server unreachable', { error: message })
      this.probeBackoffMs = Math.min(60000, Math.max(this.deps.config.presencePollMs, this.probeBackoffMs * 2))
      this.schedule(this.probeBackoffMs)
      return
    }
    this.probeBackoffMs = this.deps.config.presencePollMs
    const otherPlayers = this.countOtherPlayers(result)
    this.deps.state.setServer({
      reachable: true,
      online: result.online,
      max: result.max,
      versionName: result.versionName,
      motd: result.motd,
      latencyMs: result.latencyMs,
      lastPingAt: new Date().toISOString()
    })
    this.deps.state.setPresence(otherPlayers, otherPlayers > 0 ? `players online: ${otherPlayers}` : 'idle: no players')
    if (otherPlayers > 0 || this.keepOnline()) {
      if (otherPlayers === 0) {
        this.deps.state.setPresence(0, 'task active: staying online')
      }
      void this.connectNow()
      this.schedule(500)
      return
    }
    this.deps.state.setState('idle', 'idle: no players')
    this.schedule(this.deps.config.presencePollMs)
  }

  private countOtherPlayers (result: SlpResult): number {
    const botName = this.deps.config.botUsername.toLowerCase()
    if (result.sampleNames.length > 0) {
      return result.sampleNames.filter(name => name.toLowerCase() !== botName).length
    }
    if (result.online <= 0) return 0
    if (result.online === 1 && Date.now() - this.lastQuitAt < 30000) return 0
    return result.online
  }

  private async checkConnected (): Promise<boolean> {
    const { state, controller } = this.deps
    if (!controller.isConnected()) {
      this.handleUnexpectedDisconnect('connection lost')
      return false
    }
    const others = controller.getOtherPlayers()
    state.setPresence(others.length, others.length > 0 ? `connected: ${others.length} other player(s)` : 'connected: alone')
    state.setServer({
      ...state.server,
      reachable: true,
      online: others.length + 1,
      lastPingAt: state.server.lastPingAt
    })
    if (Date.now() - this.connectedAt > 60000) {
      this.backoffMs = this.deps.config.reconnectMinMs
    }
    if (this.mode === 'always') return true
    if (this.mode === 'off') {
      if (this.keepOnline()) {
        state.setPresence(0, 'presence off: task active')
        return true
      }
      await this.quitForPresence('presence off')
      return false
    }
    if (others.length > 0) {
      this.lastOthersAt = Date.now()
      return true
    }
    if (this.keepOnline()) {
      state.setPresence(0, 'connected: task active')
      return true
    }
    if (Date.now() - this.lastOthersAt < this.deps.config.presenceGraceMs) return true
    await this.quitForPresence('no other players')
    return false
  }

  private async quitForPresence (reason: string): Promise<void> {
    const { state, controller, logger, config } = this.deps
    logger.info('presence: leaving', { reason, graceMs: config.presenceGraceMs })
    state.setState('cooldown', `${reason}; leaving`)
    state.setPresence(0, `${reason}; leaving`)
    state.setServer({ ...state.server, online: 0 })
    this.lastQuitAt = Date.now()
    try {
      await controller.stop('no players')
    } catch (error) {
      logger.warn('presence: stop failed', { error: error instanceof Error ? error.message : String(error) })
    }
    state.clearPlayer()
    state.setState('cooldown', 'cooldown after leaving')
    this.schedule(config.presenceQuitCooldownMs)
  }

  private async connectNow (): Promise<void> {
    if (this.stopped || this.connecting || this.deps.controller.isConnected()) return
    this.connecting = true
    this.deps.state.setState('connecting', 'connecting')
    try {
      await this.deps.controller.start()
      if (this.stopped) return
      if (!this.deps.controller.isConnected()) throw new Error('disconnected immediately after spawn')
      this.connectedAt = Date.now()
      this.lastOthersAt = Date.now()
      this.backoffMs = this.deps.config.reconnectMinMs
      this.deps.state.setState('connected', 'connected')
      this.deps.state.setPresence(this.deps.controller.getOtherPlayers().length, 'connected')
      this.deps.logger.info('presence: connected')
      void this.refreshServerInfo()
      this.schedule(this.deps.config.presenceCheckMs)
    } catch (error) {
      if (this.stopped) return
      const message = error instanceof Error ? error.message : String(error)
      this.deps.logger.warn('presence: connect failed', { error: message })
      this.deps.state.setPresence(0, `connect failed: ${message}`)
      this.scheduleBackoff(`connect failed: ${message}`, isFatalLoginReason(message))
    } finally {
      this.connecting = false
    }
  }

  private onUnexpectedDisconnect (reason: string): void {
    if (this.stopped) return
    if (this.deps.state.state === 'connecting') return
    this.handleUnexpectedDisconnect(reason)
  }

  private handleUnexpectedDisconnect (reason: string): void {
    if (this.stopped) return
    if (this.deps.state.state !== 'connected') return
    this.lastQuitAt = Date.now()
    this.deps.state.recordDisconnect(reason)
    this.deps.state.clearPlayer()
    this.deps.state.setPresence(0, `disconnected: ${reason}`)
    this.deps.state.setServer({ ...this.deps.state.server, online: 0 })
    this.deps.state.setState('backoff', `disconnected: ${reason}`)
    this.deps.logger.warn('presence: unexpected disconnect', { reason })
    this.scheduleBackoff(`disconnected: ${reason}`, isFatalLoginReason(reason))
  }

  private scheduleBackoff (reason: string, fatal: boolean): void {
    const delay = fatal ? LONG_COOLDOWN_MS : this.backoffMs
    this.backoffMs = Math.min(this.deps.config.reconnectMaxMs, Math.round(this.backoffMs * 2 + Math.random() * 1000))
    this.deps.state.setState('backoff', reason)
    this.deps.logger.info('presence: backoff', { delay, fatal })
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.stopped) return
      this.deps.state.setState('idle', 'backoff finished')
      this.schedule(0)
    }, Math.max(delay, 1))
  }
}
