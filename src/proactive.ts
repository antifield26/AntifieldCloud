import type { Bot } from 'mineflayer'
import type { Config } from './config.ts'
import type { Logger } from './logger.ts'
import type { ChatSender } from './minecraft/chat.ts'

const GREET_COOLDOWN_MS = 10 * 60 * 1000
const EVENT_COOLDOWN_MS = 5 * 60 * 1000

export class ProactiveManager {
  private readonly config: Config
  private readonly logger: Logger
  private readonly chatSender: ChatSender
  private bot: Bot | null = null
  private readonly lastGreetAt = new Map<string, number>()
  private readonly lastEventAt = new Map<string, number>()
  private lastNightDay = -1
  private wasRaining = false
  private handlers: {
    playerJoined: (player: { username: string }) => void
    death: () => void
    entityDead: (entity: { username?: string }) => void
    time: () => void
    rain: () => void
  } | null = null

  constructor (config: Config, logger: Logger, chatSender: ChatSender) {
    this.config = config
    this.logger = logger
    this.chatSender = chatSender
  }

  attach (bot: Bot | null): void {
    if (!bot || this.bot === bot) return
    this.detach()
    this.bot = bot
    this.wasRaining = bot.isRaining
    this.lastNightDay = bot.time.isDay ? -1 : bot.time.day
    const handlers = {
      playerJoined: (player: { username: string }): void => {
        if (!this.config.proactiveEnabled || !this.config.proactiveGreeting) return
        if (player.username.toLowerCase() !== this.owner().toLowerCase()) return
        this.event('greeting', () => `${this.owner()}，回来啦～`, GREET_COOLDOWN_MS)
      },
      death: (): void => {
        if (!this.config.proactiveEnabled || !this.config.proactiveEvents) return
        this.event('death', () => '我先回家补个状态。', EVENT_COOLDOWN_MS)
      },
      entityDead: (entity: { username?: string }): void => {
        if (!this.config.proactiveEnabled || !this.config.proactiveEvents) return
        if (!entity.username || entity.username.toLowerCase() !== this.owner().toLowerCase()) return
        this.event('owner-death', () => '你还好吗？需要我过去吗？', EVENT_COOLDOWN_MS)
      },
      time: (): void => {
        if (!this.config.proactiveEnabled || !this.config.proactiveEvents) return
        const active = this.bot
        if (!active || active.time.isDay) return
        if (this.lastNightDay === active.time.day) return
        this.lastNightDay = active.time.day
        this.event('night', () => '天黑了，要睡觉吗？', EVENT_COOLDOWN_MS)
      },
      rain: (): void => {
        if (!this.config.proactiveEnabled || !this.config.proactiveEvents) return
        const active = this.bot
        if (!active) return
        const raining = active.isRaining
        if (raining === this.wasRaining) return
        this.wasRaining = raining
        if (raining) this.event('rain', () => '下雨了，记得收衣服～', EVENT_COOLDOWN_MS)
      }
    }
    this.handlers = handlers
    bot.on('playerJoined', handlers.playerJoined)
    bot.on('death', handlers.death)
    bot.on('entityDead', handlers.entityDead)
    bot.on('time', handlers.time)
    bot.on('rain', handlers.rain)
    this.logger.info('proactive attached', { owner: this.owner() })
  }

  detach (): void {
    const bot = this.bot
    const handlers = this.handlers
    if (bot && handlers) {
      bot.removeListener('playerJoined', handlers.playerJoined)
      bot.removeListener('death', handlers.death)
      bot.removeListener('entityDead', handlers.entityDead)
      bot.removeListener('time', handlers.time)
      bot.removeListener('rain', handlers.rain)
    }
    this.bot = null
    this.handlers = null
  }

  private owner (): string {
    return this.config.commandAllowlist[0] ?? 'Antifield'
  }

  private event (key: string, text: () => string, cooldownMs: number): void {
    const now = Date.now()
    const last = this.lastEventAt.get(key) ?? 0
    if (now - last < cooldownMs) return
    this.lastEventAt.set(key, now)
    const message = text()
    void this.chatSender.say(message, `proactive:${key}`).catch((error: unknown) => {
      this.logger.debug('proactive message failed', {
        key,
        error: error instanceof Error ? error.message : String(error)
      })
    })
  }
}
