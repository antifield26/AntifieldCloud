import type { Bot } from 'mineflayer'
import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'
import type { RuntimeState } from '../state.ts'
import type { MemoryStore } from '../memory/store.ts'
import type { ChatSender } from '../minecraft/chat.ts'
import { OpenCodeClient, AiError } from './opencode.ts'
import { AI_DISABLED_REPLY, FALLBACK_REPLY, buildGameContext, buildPrompt, buildSummaryPrompt, sanitizeAiOutput } from './prompt.ts'
import { buildAiToolContext } from './tools.ts'

interface QueueItem {
  username: string
  message: string
  enqueuedAt: number
}

export interface AiChatDeps {
  config: Config
  logger: Logger
  state: RuntimeState
  memory: MemoryStore
  client: OpenCodeClient
  chatSender: ChatSender
  getBot: () => Bot | null
}

export class AiChatService {
  private readonly deps: AiChatDeps
  private readonly queue: QueueItem[] = []
  private readonly cooldownUntil = new Map<string, number>()
  private readonly hourly = new Map<string, number[]>()
  private readonly fallbackAt = new Map<string, number>()
  private readonly summaryInFlight = new Set<string>()
  private readonly summaryRetryAt = new Map<string, number>()
  private inFlight = false
  private stopped = false
  private active: AbortController | null = null

  constructor (deps: AiChatDeps) {
    this.deps = deps
  }

  ask (username: string, message: string): void {
    const { config, state, logger } = this.deps
    if (this.stopped) return
    if (!config.aiEnabled) {
      this.safeFallback(username, AI_DISABLED_REPLY)
      return
    }
    const now = Date.now()
    const cooldown = this.cooldownUntil.get(username) ?? 0
    if (now < cooldown) {
      logger.debug('ai cooldown active', { username, remainingMs: cooldown - now })
      return
    }
    const recent = (this.hourly.get(username) ?? []).filter(at => now - at < 60 * 60 * 1000)
    if (recent.length >= config.aiRatePerHour) {
      logger.warn('ai hourly rate limit', { username, limit: config.aiRatePerHour })
      this.safeFallback(username, '我今天说得有点多了，让我休息一会儿吧。')
      return
    }
    if (this.queue.length >= config.aiQueueMax) {
      logger.warn('ai queue full', { username, queued: this.queue.length })
      return
    }
    recent.push(now)
    this.hourly.set(username, recent)
    this.cooldownUntil.set(username, now + config.aiCooldownMs)
    this.queue.push({ username, message, enqueuedAt: now })
    state.setAi({ queued: this.queue.length })
    void this.pump()
  }

  private pump (): void {
    if (this.stopped || this.inFlight || this.queue.length === 0) return
    const item = this.queue.shift()
    if (!item) return
    this.inFlight = true
    this.deps.state.setAi({ inFlight: 1, queued: this.queue.length })
    void this.process(item)
      .catch(error => {
        this.deps.logger.error('ai processing crashed', { error: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => {
        this.inFlight = false
        this.deps.state.setAi({ inFlight: 0, queued: this.queue.length })
        this.pump()
      })
  }

  private async process (item: QueueItem): Promise<void> {
    const { config, logger, state, memory, client, chatSender, getBot } = this.deps
    const bot = getBot()
    if (!bot || !bot.entity) {
      logger.debug('ai request dropped: bot disconnected', { username: item.username })
      return
    }
    const player = bot.players[item.username]
    const uuid = player?.uuid ?? item.username
    const turns = memory.load(item.username, uuid)
    const summary = memory.summary(item.username, uuid)
    const context = [
      buildGameContext(bot),
      buildAiToolContext(config, { bot, task: state.task })
    ].filter(Boolean).join('\n')
    const prompt = buildPrompt({
      player: item.username,
      message: item.message,
      context,
      turns,
      summary: summary?.text ?? null,
      maxChars: config.aiMaxPromptChars
    })
    if (config.logAiPrompt) logger.debug('ai prompt', { username: item.username, prompt })

    const controller = new AbortController()
    this.active = controller
    try {
      const result = await client.generate(prompt, { signal: controller.signal })
      if (this.stopped) return
      const text = sanitizeAiOutput(result.text)
      if (text === '') {
        state.recordAiFailure('empty output')
        this.safeFallback(item.username, FALLBACK_REPLY)
        return
      }
      await chatSender.say(text, 'ai')
      await memory.append(item.username, uuid, item.message, text)
      state.setMemory(memory.stats())
      state.setAi({ lastLatencyMs: result.latencyMs, lastError: null })
      this.maybeSummarize(item.username, uuid)
      logger.info('ai reply sent', { username: item.username, latencyMs: result.latencyMs, chars: text.length })
    } catch (error) {
      if (this.stopped || (error instanceof AiError && error.kind === 'aborted')) {
        logger.debug('ai request aborted', { username: item.username })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      state.recordAiFailure(message.slice(0, 200))
      logger.warn('ai request failed', { username: item.username, error: message })
      this.safeFallback(item.username, FALLBACK_REPLY)
    } finally {
      this.active = null
    }
  }

  private maybeSummarize (username: string, uuid: string): void {
    const { config, logger, memory } = this.deps
    if (this.stopped || !config.memorySummaryEnabled || !config.aiEnabled) return
    if (!memory.summaryDue(username, uuid, config.memorySummaryTurns)) return
    const retryAt = this.summaryRetryAt.get(username) ?? 0
    if (Date.now() < retryAt) return
    if (this.summaryInFlight.has(username)) return
    const turns = memory.load(username, uuid)
    if (turns.length === 0) return
    this.summaryInFlight.add(username)
    void this.summarize(username, uuid, turns)
      .catch(error => {
        this.summaryRetryAt.set(username, Date.now() + 5 * 60 * 1000)
        logger.warn('memory summary failed', {
          username,
          error: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => {
        this.summaryInFlight.delete(username)
      })
  }

  private async summarize (username: string, uuid: string, turns: ReturnType<MemoryStore['load']>): Promise<void> {
    const { config, memory, client, state } = this.deps
    const previous = memory.summary(username, uuid)
    const prompt = buildSummaryPrompt(
      username,
      previous?.text ?? null,
      turns,
      config.memorySummaryMaxChars
    )
    const result = await client.generate(prompt)
    if (this.stopped) return
    const text = sanitizeAiOutput(result.text).slice(0, config.memorySummaryMaxChars).trim()
    if (text === '') throw new Error('empty summary')
    await memory.applySummary(username, uuid, text, Math.max(1, Math.floor(turns.length / 2)))
    state.setMemory(memory.stats())
    this.deps.logger.info('memory summary updated', {
      username,
      chars: text.length,
      coveredTurns: turns.length
    })
  }

  private safeFallback (username: string, text: string): void {
    const now = Date.now()
    const last = this.fallbackAt.get(username) ?? 0
    if (now - last < 30000) return
    this.fallbackAt.set(username, now)
    void this.deps.chatSender.say(text, 'ai-fallback').catch(() => {})
  }

  stop (): void {
    this.stopped = true
    this.queue.length = 0
    this.deps.state.setAi({ queued: 0, inFlight: 0 })
    this.active?.abort()
    this.active = null
  }
}
