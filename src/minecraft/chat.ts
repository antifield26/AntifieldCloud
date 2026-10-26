import type { Bot } from 'mineflayer'
import type { Logger } from '../logger.ts'
import { NotConnectedError } from '../errors.ts'

export interface ChatLike {
  toString: () => string
  json?: unknown
}

export interface PlayerIdentity {
  uuid?: string
}

export interface ParsedChatMessage {
  username: string
  message: string
}

const WAKE_PATTERN = /(^|[^a-z0-9])@?lofii(?![a-z0-9])/i
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g
const COLOR_CODES = /§./g

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function renderComponent (value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(renderComponent).join('')
  if (!isRecord(value)) return ''
  const text = typeof value.text === 'string' ? value.text : ''
  const extra = Array.isArray(value.extra) ? value.extra.map(renderComponent).join('') : ''
  return text + extra
}

function findNameByUuid (players: Record<string, PlayerIdentity>, sender: string | null | undefined): string | null {
  if (!sender) return null
  const wanted = sender.toLowerCase()
  for (const [name, player] of Object.entries(players)) {
    if (typeof player.uuid === 'string' && player.uuid.toLowerCase() === wanted) return name
  }
  return null
}

function extractNameFromRendered (rendered: string): string | null {
  const angle = /^<([^>]{1,40})>\s?(.*)$/s.exec(rendered)
  const angleName = angle?.[1]
  if (angleName) return angleName.trim()
  const legacy = /^(\w{1,16})\s?[>:\-»\])~]+\s?(.*)$/s.exec(rendered)
  const legacyName = legacy?.[1]
  if (legacyName) return legacyName
  return null
}

export function extractChatMessage (
  jsonMsg: ChatLike,
  position: string,
  sender: string | null | undefined,
  players: Record<string, PlayerIdentity>
): ParsedChatMessage | null {
  if (position !== 'chat') return null

  const json = jsonMsg.json
  const withParts = isRecord(json) && Array.isArray(json.with) ? json.with : []
  const rendered = jsonMsg.toString()
  const parsedName = extractNameFromRendered(rendered)

  let username = findNameByUuid(players, sender)
  if (!username && withParts.length > 0) {
    const display = renderComponent(withParts[0]).trim()
    if (/^[A-Za-z0-9_]{3,16}$/.test(display)) {
      const known = Object.keys(players).find(name => name.toLowerCase() === display.toLowerCase())
      if (known) username = known
    }
  }
  if (!username && parsedName) {
    const known = Object.keys(players).find(name => name.toLowerCase() === parsedName.toLowerCase())
    if (known) username = known
  }
  if (!username) return null

  let message = ''
  if (withParts.length >= 2) {
    message = renderComponent(withParts[1])
  }
  if (message.trim() === '') {
    if (parsedName) {
      const index = rendered.indexOf(parsedName)
      const after = index >= 0 ? rendered.slice(index + parsedName.length) : rendered
      message = after.replace(/^[>:\-»\])~]+\s?/, '')
    } else {
      message = rendered
    }
  }
  message = message.trim()
  if (message === '') return null
  return { username, message }
}

export function sanitizeInput (text: string, maxChars: number): string {
  const cleaned = text
    .replace(COLOR_CODES, '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const codePoints = Array.from(cleaned)
  return codePoints.length <= maxChars ? cleaned : codePoints.slice(0, maxChars).join('')
}

export function hasWakeWord (text: string): boolean {
  return WAKE_PATTERN.test(text)
}

export function stripWakeWord (text: string): string {
  const match = WAKE_PATTERN.exec(text)
  if (!match) return text.trim()
  const matched = match[0]
  const index = text.indexOf(matched)
  const rest = text.slice(index + matched.length)
  return rest
    .replace(/^[\s,:，：、.!！?？~～\-—]+/, '')
    .trim()
}

export function sanitizeOutgoing (text: string): string {
  let cleaned = text
    .replace(COLOR_CODES, '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.startsWith('/')) {
    cleaned = `／${cleaned.slice(1)}`
  }
  return cleaned
}

export function splitOutgoing (text: string, maxChars: number, maxLines: number): string[] {
  const cleaned = sanitizeOutgoing(text)
  if (cleaned === '') return []
  const codePoints = Array.from(cleaned)
  const lines: string[] = []
  for (let index = 0; index < codePoints.length && lines.length < maxLines; index += maxChars) {
    lines.push(codePoints.slice(index, index + maxChars).join(''))
  }
  const consumed = lines.length * maxChars
  const lastLine = lines[lines.length - 1]
  if (consumed < codePoints.length && lastLine !== undefined) {
    const last = Array.from(lastLine)
    while (last.length > 0 && Array.from(`${last.join('')}…`).length > maxChars) last.pop()
    lines[lines.length - 1] = `${last.join('')}…`
  }
  return lines.filter(line => line.trim() !== '')
}

export interface ChatSenderOptions {
  maxLineChars: number
  maxLines: number
  gapMs: number
  onSay?: (event: { text: string, lines: string[], source: string }) => void
}

export class ChatSender {
  private readonly getBot: () => Bot | null
  private readonly logger: Logger
  private readonly options: ChatSenderOptions
  private tail: Promise<void> = Promise.resolve()
  private lastSent = 0

  constructor (getBot: () => Bot | null, logger: Logger, options: ChatSenderOptions) {
    this.getBot = getBot
    this.logger = logger
    this.options = options
  }

  async say (text: string, source = 'bot'): Promise<string[]> {
    const lines = splitOutgoing(text, this.options.maxLineChars, this.options.maxLines)
    if (lines.length === 0) return []
    if (!this.isConnected()) throw new NotConnectedError()
    this.tail = this.tail.then(async () => {
      for (const line of lines) {
        const bot = this.getBot()
        if (!bot) throw new NotConnectedError()
        const wait = Math.max(0, this.options.gapMs - (Date.now() - this.lastSent))
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
        bot.chat(line)
        this.lastSent = Date.now()
        this.logger.debug('chat sent', { source, length: line.length })
      }
    })
    try {
      await this.tail
      try {
        this.options.onSay?.({ text, lines, source })
      } catch {
        // observers must not break chat delivery
      }
      return lines
    } catch (error) {
      this.logger.warn('chat send failed', { source, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  isConnected (): boolean {
    const bot = this.getBot()
    return bot !== null && bot.entity !== undefined && bot.entity !== null
  }
}
