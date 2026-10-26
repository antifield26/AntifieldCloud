import type { Bot } from 'mineflayer'
import type { AuditLogger } from '../audit.ts'
import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'
import type { TaskController } from '../tasks/types.ts'
import { TaskError } from '../tasks/types.ts'
import { ChatSender } from './chat.ts'
import { MovementError, MovementManager } from './movement.ts'
import { buildStatusLines } from './status.ts'

export type CommandName = 'status' | 'come' | 'follow' | 'stop' | 'look' | 'wave' | 'help' | 'fish' | 'farm' | 'stopTask' | 'home' | 'deposit'

export interface ParsedCommand {
  name: CommandName
  target?: string
}

const COMMAND_PATTERNS: Array<{ name: CommandName, pattern: RegExp }> = [
  { name: 'stopTask', pattern: /^(收工|停止任务|别干了|不干了|stop\s*task)/i },
  { name: 'stop', pattern: /^(停下|停止|停一下|停|别动|别跟了|别跟|取消|stop|halt)/i },
  { name: 'home', pattern: /^(回家|回基地|home)/i },
  { name: 'deposit', pattern: /^(存东西|存箱|存一下|deposit)/i },
  { name: 'fish', pattern: /^(去钓鱼|钓鱼|开始钓鱼|fish)/i },
  { name: 'farm', pattern: /^(去种田|种田|收菜|开始种田|farm)/i },
  { name: 'follow', pattern: /^(跟随|跟着我|跟着|跟好|follow|跟)\s*(我|[A-Za-z0-9_]{1,16})?/i },
  { name: 'come', pattern: /^(过来|来我身边|来我这|来这边|到这里|come)\s*([A-Za-z0-9_]{1,16})?/i },
  { name: 'look', pattern: /^(看我|看过来|看向我|look)/i },
  { name: 'wave', pattern: /^(挥手|挥挥手|打招呼|wave)/i },
  { name: 'status', pattern: /^(状态|报告|你在哪|血量|你的位置|status)/i },
  { name: 'help', pattern: /^(帮助|help|你会什么|能做什么|指令)/i }
]

const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/

export function normalizeCommandText (text: string): string {
  return text
    .replace(/^[\s,，:：、.!！?？~～\-—]+/, '')
    .replace(/[\s,，:：、.!！?？~～\-—]+$/, '')
    .trim()
}

export function parseCommand (text: string): ParsedCommand | null {
  const normalized = normalizeCommandText(text)
  if (normalized === '') return null
  for (const entry of COMMAND_PATTERNS) {
    const match = entry.pattern.exec(normalized)
    if (!match) continue
    if (entry.name === 'stop' || entry.name === 'status' || entry.name === 'help' || entry.name === 'look' || entry.name === 'wave' ||
      entry.name === 'fish' || entry.name === 'farm' || entry.name === 'stopTask' || entry.name === 'home' || entry.name === 'deposit') {
      return { name: entry.name }
    }
    const rawTarget = match[2]?.trim()
    if (rawTarget && rawTarget !== '我' && PLAYER_NAME.test(rawTarget)) {
      return { name: entry.name, target: rawTarget }
    }
    return { name: entry.name }
  }
  return null
}

export interface CommandDeps {
  config: Config
  logger: Logger
  chatSender: ChatSender
  movement: MovementManager
  tasks: TaskController
  audit?: AuditLogger
  getBot: () => Bot | null
}

const HIGH_RISK_COMMANDS = new Set<CommandName>(['fish', 'farm', 'stopTask', 'home', 'deposit', 'come', 'follow', 'stop'])

export class CommandExecutor {
  private readonly deps: CommandDeps

  constructor (deps: CommandDeps) {
    this.deps = deps
  }

  isAuthorized (username: string): boolean {
    const lower = username.toLowerCase()
    return this.deps.config.commandAllowlist.some(name => name.toLowerCase() === lower)
  }

  async execute (command: ParsedCommand, username: string): Promise<void> {
    if (!this.isAuthorized(username)) {
      this.deps.logger.warn('unauthorized command blocked', { username, command: command.name })
      return
    }
    if (this.deps.config.httpOnlyHighRisk && HIGH_RISK_COMMANDS.has(command.name)) {
      this.deps.audit?.append({
        event: 'command.denied',
        source: 'chat',
        actor: username,
        action: command.name,
        result: 'denied',
        details: { reason: 'http_only_high_risk' }
      })
      await this.safeSay('这个动作现在需要从面板操作哦。')
      return
    }
    if (HIGH_RISK_COMMANDS.has(command.name)) {
      this.deps.audit?.append({
        event: 'command.accepted',
        source: 'chat',
        actor: username,
        action: command.name,
        result: 'accepted'
      })
    }
    const bot = this.deps.getBot()
    if (!bot || !bot.entity) {
      await this.safeSay('我还没完全加载好，稍等一下。')
      return
    }
    try {
      switch (command.name) {
        case 'status': {
          const lines = buildStatusLines(bot, this.deps.movement, this.deps.tasks.snapshot())
          for (const line of lines) await this.deps.chatSender.say(line, 'command:status')
          return
        }
        case 'fish':
          await this.deps.tasks.start('fishing', username)
          return
        case 'farm':
          await this.deps.tasks.start('farming', username)
          return
        case 'stopTask':
          this.deps.tasks.requestStop('user')
          return
        case 'home':
          await this.deps.tasks.stopAndWait('home')
          await this.deps.movement.home()
          await this.safeSay('我回家啦。')
          return
        case 'deposit':
          await this.deps.tasks.depositNow()
          return
        case 'come': {
          const target = command.target ?? username
          this.deps.movement.stop('replace')
          await this.safeSay(`好，我过来了。`)
          const result = await this.deps.movement.comeTo(target)
          if (result === 'arrived') await this.safeSay('到了。')
          return
        }
        case 'follow': {
          const target = command.target ?? username
          this.deps.movement.stop('replace')
          this.deps.movement.follow(target)
          await this.safeSay(`好，我跟着${target === username ? '你' : ` ${target} `}。`)
          return
        }
        case 'stop':
          this.deps.movement.stop('user')
          await this.safeSay('停下了。')
          return
        case 'look':
          await this.deps.movement.lookAt(username)
          await this.safeSay('看着你呢。')
          return
        case 'wave':
          await this.deps.movement.wave()
          await this.safeSay('嗨～')
          return
        case 'help':
          await this.safeSay('你可以说：Lofii 状态 / 去钓鱼 / 去种田 / 收工 / 回家 / 存东西 / 过来 / 跟随我 / 停下 / 看我 / 挥手 / 帮助')
          return
      }
    } catch (error) {
      if (error instanceof TaskError || error instanceof MovementError) {
        this.deps.logger.info('command failed with friendly error', { command: command.name, reason: error.message })
        await this.safeSay(`抱歉，${error.message}`)
        return
      }
      this.deps.logger.error('command failed', { command: command.name, error: error instanceof Error ? error.message : String(error) })
      await this.safeSay('我这边出了点小问题，稍后再试。')
    }
  }

  private async safeSay (text: string): Promise<void> {
    try {
      await this.deps.chatSender.say(text, 'command')
    } catch {
      // Disconnected while replying; ignore.
    }
  }
}
