import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'
import type { RuntimeState } from '../state.ts'
import type { AiChatService } from '../ai/queue.ts'
import type { IntentClassifier } from '../ai/intent.ts'
import type { AutonomyService } from '../autonomy/service.ts'
import type { AuditLogger } from '../audit.ts'
import type { ChatSender } from '../minecraft/chat.ts'
import type { CommandExecutor, CommandName } from '../minecraft/commands.ts'
import type { EventBus } from '../events/bus.ts'
import { parseCommand } from '../minecraft/commands.ts'
import {
  hasWakeWord,
  sanitizeInput,
  stripWakeWord,
  type ParsedChatMessage
} from '../minecraft/chat.ts'

export interface ChatRouterDeps {
  config: Config
  logger: Logger
  state: RuntimeState
  chatSender: ChatSender
  commands: CommandExecutor
  intent: IntentClassifier
  ai: AiChatService
  events: EventBus
  audit?: AuditLogger
  autonomy?: AutonomyService
}

const REFUSAL_INTERVAL_MS = 10000

function normalizeAutonomyText (text: string): string {
  return text
    .replace(/^[\s,，:：、.!！?？~～\-—]+/, '')
    .replace(/[\s,，:：、.!！?？~～\-—]+$/, '')
    .trim()
}

export class ChatRouter {
  private readonly deps: ChatRouterDeps
  private readonly refusalAt = new Map<string, number>()

  constructor (deps: ChatRouterDeps) {
    this.deps = deps
  }

  handle (message: ParsedChatMessage): void {
    const { config, logger, chatSender, commands, ai } = this.deps
    const input = sanitizeInput(message.message, config.chatMaxInputChars)
    if (!hasWakeWord(input)) return
    this.deps.events.emit('chat', {
      direction: 'in',
      username: message.username,
      message: input,
      source: 'chat'
    })
    const text = stripWakeWord(input)
    if (text === '') {
      void chatSender.say('我在。', 'wake').catch(() => {})
      return
    }
    const parsed = parseCommand(text)
    if (parsed) {
      if (!commands.isAuthorized(message.username)) {
        logger.debug('unauthorized command-like message', { username: message.username, command: parsed.name })
        this.refuse(message.username)
        return
      }
      // 手动任务/移动指令优先并终止自主会话，避免 AI 与主人同时操作任务状态。
      if (this.deps.autonomy?.isActive()) this.deps.autonomy.interrupt('manual_command')
      void commands.execute(parsed, message.username).catch(error => {
        logger.error('command execution failed', { username: message.username, error: error instanceof Error ? error.message : String(error) })
      })
      return
    }
    if (commands.isAuthorized(message.username)) {
      const stopAutonomy = /^(停止自主|结束自主|别自主了|停止自主模式)$/.test(normalizeAutonomyText(text))
      if (stopAutonomy) {
        if (!this.deps.autonomy?.isActive()) {
          void chatSender.say('现在没有进行中的自主会话。', 'autonomy').catch(() => {})
          return
        }
        void this.deps.autonomy.stop('manual_chat').then(() => {
          void chatSender.say('好，自主会话已停止。', 'autonomy').catch(() => {})
        }).catch(() => {})
        return
      }
      const start = /^(自主行动|自主模式|开始自主|自主安排)(?:\s+(.+))?$/.exec(normalizeAutonomyText(text))
      if (start) {
        void this.handleAutonomyStart(start[2]?.trim() || null, message.username)
        return
      }
    }
    if (commands.isAuthorized(message.username) && this.deps.intent.shouldClassify(text)) {
      void this.handleIntent(text, message.username)
      return
    }
    logger.debug('ai chat requested', { username: message.username, chars: text.length })
    ai.ask(message.username, text)
  }

  private async handleAutonomyStart (goal: string | null, username: string): Promise<void> {
    const autonomy = this.deps.autonomy
    if (!autonomy || !autonomy.enabled) {
      await this.deps.chatSender.say('自主模式还没开启。', 'autonomy').catch(() => {})
      return
    }
    if (autonomy.isActive()) {
      await this.deps.chatSender.say('已经在自主行动中，先停止或等结束。', 'autonomy').catch(() => {})
      return
    }
    const result = await autonomy.start(goal, username)
    if (result.ok) {
      await this.deps.chatSender.say('好，我开始自主安排。', 'autonomy').catch(() => {})
      return
    }
    const message = result.code === 'autonomy_busy'
      ? '现在有任务或其它自主会话，先收尾。'
      : result.code === 'invalid_goal'
        ? '目标不太合适，换一句简单的吧。'
        : '自主模式暂时不可用。'
    await this.deps.chatSender.say(message, 'autonomy').catch(() => {})
  }

  private async handleIntent (text: string, username: string): Promise<void> {
    const { logger, commands, intent, ai } = this.deps
    const result = await intent.classify(text)
    if (!result || result.action === 'chat') {
      ai.ask(username, text)
      return
    }
    const map: Record<string, CommandName> = {
      fish: 'fish',
      farm: 'farm',
      woodcutting: 'woodcutting',
      mining: 'mining',
      forest: 'forest',
      sleep: 'sleep',
      patrol: 'patrol',
      stopTask: 'stopTask',
      home: 'home',
      deposit: 'deposit',
      status: 'status'
    }
    const command = map[result.action]
    if (!command) {
      ai.ask(username, text)
      return
    }
    logger.info('intent: mapped to command', { username, action: result.action, confidence: result.confidence })
    this.deps.audit?.append({
      event: 'command.ai_intent',
      source: 'ai_intent',
      actor: username,
      action: command,
      result: 'accepted',
      details: { confidence: result.confidence }
    })
    void commands.execute({ name: command }, username).catch(error => {
      logger.error('intent command failed', { username, action: result.action, error: error instanceof Error ? error.message : String(error) })
    })
  }

  private refuse (username: string): void {
    const now = Date.now()
    const last = this.refusalAt.get(username) ?? 0
    if (now - last < REFUSAL_INTERVAL_MS) return
    this.refusalAt.set(username, now)
    const owner = this.deps.config.commandAllowlist[0] ?? 'Antifield'
    void this.deps.chatSender.say(`抱歉，只有 ${owner} 可以指挥我行动。`, 'refusal').catch(() => {})
  }
}
