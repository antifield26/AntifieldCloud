import mineflayer, { type Bot } from 'mineflayer'
import pathfinderPackage from 'mineflayer-pathfinder'
import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'
import type { RuntimeState } from '../state.ts'
import type { MovementManager } from './movement.ts'
import { buildPlayerSnapshot } from './status.ts'
import { extractChatMessage, type ChatLike, type ParsedChatMessage } from './chat.ts'

const { pathfinder } = pathfinderPackage

function normalizeReason (reason: unknown): string {
  if (typeof reason === 'string') return reason
  if (reason && typeof reason === 'object') {
    const value = (reason as { value?: unknown }).value
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(reason)
    } catch {
      return String(reason)
    }
  }
  return String(reason)
}

export interface MinecraftClientDeps {
  config: Config
  logger: Logger
  state: RuntimeState
  movement: MovementManager
}

export interface BotController {
  start: () => Promise<void>
  stop: (reason: string) => Promise<void>
  isConnected: () => boolean
  getBot: () => Bot | null
  getOtherPlayers: () => string[]
  setChatHandler: (handler: (message: ParsedChatMessage) => void) => void
  setDisconnectHandler: (handler: (reason: string) => void) => void
}

const PLAYER_STATE_THROTTLE_MS = 500

export class MinecraftClient implements BotController {
  private readonly deps: MinecraftClientDeps
  private bot: Bot | null = null
  private spawned = false
  private starting = false
  private manualStop = false
  private loginTimer: NodeJS.Timeout | null = null
  private startPromise: Promise<void> | null = null
  private startResolve: (() => void) | null = null
  private startReject: ((error: Error) => void) | null = null
  private lastPlayerStateAt = 0
  private chatHandler: ((message: ParsedChatMessage) => void) | null = null
  private disconnectHandler: ((reason: string) => void) | null = null
  private lastKickReason: string | null = null
  private stopping: Promise<void> | null = null

  constructor (deps: MinecraftClientDeps) {
    this.deps = deps
  }

  setChatHandler (handler: (message: ParsedChatMessage) => void): void {
    this.chatHandler = handler
  }

  setDisconnectHandler (handler: (reason: string) => void): void {
    this.disconnectHandler = handler
  }

  getBot (): Bot | null {
    return this.bot
  }

  isConnected (): boolean {
    return this.spawned && this.bot !== null && this.bot.entity !== undefined && this.bot.entity !== null
  }

  getOtherPlayers (): string[] {
    const bot = this.bot
    if (!bot) return []
    return Object.keys(bot.players).filter(name => name !== bot.username)
  }

  start (): Promise<void> {
    if (this.starting) return this.startPromise ?? Promise.resolve()
    if (this.isConnected()) return Promise.resolve()
    this.starting = true
    this.manualStop = false
    this.lastKickReason = null
    const { config, logger, state, movement } = this.deps
    logger.info('minecraft connecting', {
      host: config.mcHost,
      port: config.mcPort,
      username: config.botUsername,
      version: config.mcVersion
    })
    state.setState('connecting', 'connecting')
    const promise = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve
      this.startReject = reject
    })
    this.startPromise = promise
    try {
      const bot = mineflayer.createBot({
        host: config.mcHost,
        port: config.mcPort,
        username: config.botUsername,
        auth: config.mcAuth,
        version: config.mcVersion === false ? undefined : config.mcVersion,
        viewDistance: 'short',
        chatLengthLimit: 256,
        physicsEnabled: true,
        checkTimeoutInterval: 60000,
        hideErrors: false
      })
      this.bot = bot
      bot.loadPlugin(pathfinder)

      this.loginTimer = setTimeout(() => {
        if (this.spawned) return
        logger.warn('minecraft login timeout', { timeoutMs: config.loginTimeoutMs })
        try {
          bot.end('login timeout')
        } catch {
          // ignore
        }
        this.failStart(new Error('login timeout'))
      }, config.loginTimeoutMs)

      bot.once('spawn', () => {
        this.spawned = true
        this.clearLoginTimer()
        this.lastPlayerStateAt = 0
        state.setMinecraftConnected(true, bot.version)
        state.setPlayer(buildPlayerSnapshot(bot))
        try {
          movement.attach(bot)
        } catch (error) {
          logger.error('pathfinder attach failed', { error: error instanceof Error ? error.message : String(error) })
        }
        logger.info('minecraft spawned', {
          position: bot.entity?.position,
          dimension: bot.game.dimension,
          version: bot.version
        })
        this.startResolve?.()
        this.clearStartHandles()
      })

      bot.on('message', ((jsonMsg: ChatLike, position: string, sender?: string | null) => {
        const parsed = extractChatMessage(jsonMsg, position, sender ?? null, bot.players)
        if (!parsed) return
        if (parsed.username === bot.username) return
        try {
          this.chatHandler?.(parsed)
        } catch (error) {
          logger.error('chat handler failed', { error: error instanceof Error ? error.message : String(error) })
        }
      }) as (jsonMsg: ChatLike, position: string) => void)

      bot.on('death', () => {
        logger.info('minecraft death', { position: bot.entity?.position })
        movement.stop('death')
        setTimeout(() => {
          if (this.bot && this.spawned) {
            try {
              this.bot.respawn()
            } catch (error) {
              logger.warn('respawn failed', { error: error instanceof Error ? error.message : String(error) })
            }
          }
        }, 1000)
      })

      bot.on('kicked', (reason: string) => {
        this.lastKickReason = normalizeReason(reason)
        logger.warn('minecraft kicked', { reason: this.lastKickReason })
      })

      bot.on('error', (error: Error) => {
        logger.warn('minecraft error', { error: error.message })
      })

      bot.on('end', (reason: unknown) => {
        const finalReason = this.lastKickReason ?? normalizeReason(reason)
        const wasManual = this.manualStop
        const wasSpawned = this.spawned
        const wasStarting = this.starting
        const reject = this.startReject
        this.cleanupConnection()
        if (!wasStarting || wasSpawned) {
          logger.info('minecraft disconnected', { reason: finalReason, manual: wasManual })
        }
        state.setMinecraftConnected(false)
        state.clearPlayer()
        movement.detach()
        if (wasStarting) {
          reject?.(new Error(finalReason))
        }
        if (!wasManual && this.disconnectHandler) {
          this.disconnectHandler(finalReason)
        }
      })

      bot.on('health', () => this.updatePlayerState(false))
      bot.on('move', () => this.updatePlayerState(true))
    } catch (error) {
      this.failStart(error instanceof Error ? error : new Error(String(error)))
    }
    return promise
  }

  private updatePlayerState (throttle: boolean): void {
    const now = Date.now()
    if (throttle && now - this.lastPlayerStateAt < PLAYER_STATE_THROTTLE_MS) return
    this.lastPlayerStateAt = now
    if (!this.bot) return
    this.deps.state.setPlayer(buildPlayerSnapshot(this.bot))
  }

  private clearLoginTimer (): void {
    if (this.loginTimer) {
      clearTimeout(this.loginTimer)
      this.loginTimer = null
    }
  }

  private clearStartHandles (): void {
    this.startResolve = null
    this.startReject = null
    this.starting = false
  }

  private failStart (error: Error): void {
    if (!this.starting) return
    this.clearLoginTimer()
    const reject = this.startReject
    this.clearStartHandles()
    reject?.(error)
  }

  private cleanupConnection (): void {
    this.clearLoginTimer()
    this.spawned = false
    this.starting = false
    this.startPromise = null
    this.startResolve = null
    this.startReject = null
    this.bot = null
    this.stopping = null
  }

  async stop (reason: string): Promise<void> {
    const bot = this.bot
    if (!bot) return
    if (this.stopping) return this.stopping
    this.manualStop = true
    this.deps.logger.info('minecraft stopping', { reason })
    this.stopping = new Promise<void>(resolve => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        resolve()
      }
      bot.once('end', finish)
      try {
        bot.quit(reason)
      } catch {
        // ignore
      }
      const timeout = setTimeout(() => {
        try {
          bot.end(reason)
        } catch {
          // ignore
        }
        finish()
      }, 5000)
      timeout.unref?.()
    })
    await this.stopping
    this.stopping = null
  }
}
