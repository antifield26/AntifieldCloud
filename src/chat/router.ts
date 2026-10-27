import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'
import type { RuntimeState } from '../state.ts'
import type { AiChatService } from '../ai/queue.ts'
import type { IntentClassifier } from '../ai/intent.ts'
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
}

const REFUSAL_INTERVAL_MS = 10000

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
      void commands.execute(parsed, message.username).catch(error => {
        logger.error('command execution failed', { username: message.username, error: error instanceof Error ? error.message : String(error) })
      })
      return
    }
    if (commands.isAuthorized(message.username) && this.deps.intent.shouldClassify(text)) {
      void this.handleIntent(text, message.username)
      return
    }
    logger.debug('ai chat requested', { username: message.username, chars: text.length })
    ai.ask(message.username, text)
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
