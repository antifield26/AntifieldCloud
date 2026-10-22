import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'
import type { RuntimeState } from '../state.ts'
import type { AiChatService } from '../ai/queue.ts'
import type { ChatSender } from '../minecraft/chat.ts'
import type { CommandExecutor } from '../minecraft/commands.ts'
import {
  hasWakeWord,
  sanitizeInput,
  stripWakeWord,
  type ParsedChatMessage
} from '../minecraft/chat.ts'
import { parseCommand } from '../minecraft/commands.ts'

export interface ChatRouterDeps {
  config: Config
  logger: Logger
  state: RuntimeState
  chatSender: ChatSender
  commands: CommandExecutor
  ai: AiChatService
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
    logger.debug('ai chat requested', { username: message.username, chars: text.length })
    ai.ask(message.username, text)
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
