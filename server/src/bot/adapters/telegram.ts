/**
 * Telegram Bot API 适配器：Webhook 密钥头校验、命令/普通消息解析、文本分段与多附件发送、内联按钮与回调。
 * 安全边界：Bot Token 只出现在请求 URL 中，不进入日志或错误响应；Webhook 必须配置 secret_token。
 * 群/频道普通消息只有 @Bot、回复 Bot、或该目标策略为“全部消息”时才进入 Chat，避免把无关消息交给上层；
 * 长文本按平台上限分段（按钮只在末段），引用回复仅在群/频道使用，被引用消息失效时降级为无引用重发一次。
 */
import { createHash } from 'node:crypto'
import type {
  BotAction,
  BotAdapter,
  BotButton,
  BotHealthCheck,
  BotHealthItem,
  BotInboundImage,
  BotReplyOptions,
  BotSecret,
  BotTargetRow,
  ChatTrigger,
  InboundVerification,
  OutboundContent,
  OutboundMedia,
  SendResult,
} from '../types.ts'
import { BOT_TEXT_LIMITS, MAX_MESSAGE_PARTS, splitForPlatform, type MessagePart } from '../text.ts'
import { safeEqualString } from '../../util/ids.ts'
import {
  BotPlatformError,
  downloadImage,
  fetchJson,
  headerValue,
  markPartialError,
  normalizeImageMime,
  parseJsonBody,
} from './http.ts'

const TELEGRAM_CAPTION_LIMIT = 1024
const MAX_MEDIA_FILES = 5
const BOT_USERNAME_CACHE_TTL_MS = 60 * 60 * 1000
const BOT_USERNAME_FAILURE_TTL_MS = 30 * 1000

interface TelegramAdapterDeps {
  fetch?: typeof fetch
  /** 公开配置可携带 botUsername；Service 未传入时通过 getMe 惰性解析。 */
  config?: Record<string, unknown>
  /** 兼容直接注入 botUsername 的调用方。 */
  botUsername?: string
}

interface BotUsernameCacheEntry {
  username: string
  expiresAt: number
}

/** 按 token 哈希缓存 getMe 结果，避免每条群消息都请求平台。 */
const botUsernameCache = new Map<string, BotUsernameCacheEntry>()

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function telegramApi(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`
}

function tokenCacheKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function extractCommand(text: string): { command: string; args: string[] } | null {
  const match = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]{1,64})?(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  return { command: match[1]!.toLowerCase(), args: (match[2] ?? '').trim().split(/\s+/).filter(Boolean) }
}

function chatKind(chatType: string): BotTargetRow['kind'] {
  if (chatType === 'private') return 'user'
  if (chatType === 'channel') return 'channel'
  return 'group'
}

function isImageMedia(media: OutboundMedia): boolean {
  return /^image\/(jpeg|png|webp|gif)$/i.test(media.mime)
}

function blobOf(media: OutboundMedia): Blob {
  return new Blob([media.data as unknown as ArrayBuffer], { type: media.mime })
}

function messageId(body: unknown): string | null {
  const record = asRecord(body)
  if (!record) return null
  const result = asRecord(record.result) ?? record
  const raw = result.id ?? result.message_id
  if (typeof raw === 'string' && raw) return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return null
}

/** 把按钮编码为 Telegram inline_keyboard；空数组或缺省时不携带 reply_markup。 */
function inlineKeyboard(buttons?: BotButton[]): Record<string, unknown> | null {
  if (!buttons || buttons.length === 0) return null
  const row = buttons
    .filter((button) => typeof button.id === 'string' && typeof button.label === 'string')
    .slice(0, 8)
    .map((button) => ({
      text: button.label.slice(0, 64) || button.id,
      callback_data: button.id.slice(0, 64),
    }))
  if (row.length === 0) return null
  return { inline_keyboard: [row] }
}

function actionFromCallbackData(data: string): BotAction | null {
  return data === 'refresh_status' || data === 'help' ? data : null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasMentionEntity(entities: unknown): boolean {
  if (!Array.isArray(entities)) return false
  return entities.some((entity) => {
    const record = asRecord(entity)
    return record !== null && (record.type === 'mention' || record.type === 'text_mention')
  })
}

/** 判断消息是否在文本或 entity 中提到了指定用户名。 */
function mentionsUsername(text: string, entities: unknown, username: string): boolean {
  if (!username) return false
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])@${escapeRegExp(username)}(?![A-Za-z0-9_])`, 'i')
  if (pattern.test(text)) return true
  if (!Array.isArray(entities)) return false
  const target = `@${username}`.toLowerCase()
  for (const entity of entities) {
    const record = asRecord(entity)
    if (!record) continue
    if (record.type === 'mention') {
      const offset = Number(record.offset)
      const length = Number(record.length)
      if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length <= 0) continue
      if (text.slice(offset, offset + length).toLowerCase() === target) return true
    }
    if (record.type === 'text_mention') {
      const user = asRecord(record.user)
      if (user && typeof user.username === 'string' && user.username.toLowerCase() === username.toLowerCase()) {
        return true
      }
    }
  }
  return false
}

function repliesToBot(message: Record<string, unknown>): boolean {
  const reply = asRecord(message.reply_to_message)
  if (!reply) return false
  const from = asRecord(reply.from)
  return from !== null && from.is_bot === true
}

/** 去掉群/频道消息开头的 @BotUsername，保留其余文本。 */
function stripLeadingMention(text: string, username: string): string {
  let value = text.trim()
  if (!username) return value
  const pattern = new RegExp(`^@${escapeRegExp(username)}\\s*`, 'i')
  while (pattern.test(value)) {
    value = value.replace(pattern, '')
  }
  return value.trim()
}

function numericSize(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/** 提取入站图片：photo 取最大尺寸，document 仅接受 image/*；其余返回 undefined。 */
function extractInboundImage(message: Record<string, unknown>): BotInboundImage | undefined {
  const photos = message.photo
  if (Array.isArray(photos) && photos.length > 0) {
    let best: Record<string, unknown> | null = null
    let bestArea = -1
    for (const raw of photos) {
      const photo = asRecord(raw)
      if (!photo || typeof photo.file_id !== 'string' || !photo.file_id) continue
      const width = Number(photo.width)
      const height = Number(photo.height)
      const area = Number.isFinite(width) && Number.isFinite(height) ? width * height : 0
      if (area > bestArea) {
        best = photo
        bestArea = area
      }
    }
    if (best) {
      const image: BotInboundImage = { ref: String(best.file_id), mime: 'image/jpeg', name: 'photo.jpg' }
      const size = numericSize(best.file_size)
      if (size !== undefined) image.size = size
      return image
    }
  }
  const document = asRecord(message.document)
  if (!document || typeof document.file_id !== 'string' || !document.file_id) return undefined
  const mime = typeof document.mime_type === 'string' ? document.mime_type.trim().toLowerCase() : ''
  if (!mime.startsWith('image/')) return undefined
  const image: BotInboundImage = { ref: document.file_id, mime }
  if (typeof document.file_name === 'string' && document.file_name) image.name = document.file_name
  else image.name = 'image'
  const size = numericSize(document.file_size)
  if (size !== undefined) image.size = size
  return image
}

/** ignored 事件的诊断 ID：优先 update_id，其次 message_id。 */
function ignoredEventId(payload: Record<string, unknown>, message?: Record<string, unknown>): string | undefined {
  const updateId = payload.update_id
  if (typeof updateId === 'number' && Number.isFinite(updateId)) return `tg:update:${updateId}`
  if (typeof updateId === 'string' && updateId) return `tg:update:${updateId}`
  const messageId = message?.message_id
  if (typeof messageId === 'number' && Number.isFinite(messageId)) return `tg:message:${messageId}`
  return undefined
}

function ignoredResult(eventId: string | undefined): InboundVerification {
  return eventId ? { kind: 'ignored', eventId } : { kind: 'ignored' }
}

/** 被引用的消息被删除/不可见时，平台返回的描述包含这些片段。 */
function isMissingReplyTargetError(error: unknown): boolean {
  const code = error instanceof BotPlatformError ? error.code : ''
  const message = error instanceof Error ? error.message : ''
  const text = `${code} ${message}`.toLowerCase()
  return text.includes('message to be replied') || text.includes('not found')
}

/** 连接自检失败时使用的固定脱敏错误码。 */
function telegramHealthError(error: unknown): string {
  const status = error instanceof BotPlatformError ? error.status : 0
  if (status === 0) return 'network_error'
  const text = `${error instanceof BotPlatformError ? error.code : ''} ${
    error instanceof Error ? error.message : ''
  }`.toLowerCase()
  if (status === 401 || status === 403 || text.includes('unauthorized') || text.includes('invalid token')) {
    return 'telegram_unauthorized'
  }
  return 'telegram_api_error'
}

/* -------------------- HTML 标签安全分段（parse_mode=HTML） -------------------- */

/** 续段前缀预留空间（`（续 4/4）` 最多 7 字符，预留 10 保证不超限）。 */
const HTML_CONTINUATION_RESERVE = 10
/** 不参与标签栈的空元素；format.ts 不产出，仅作防御。 */
const HTML_VOID_TAGS = new Set(['br', 'hr', 'img'])

interface HtmlTagToken {
  kind: 'tag'
  raw: string
  name: string
  closing: boolean
}

interface HtmlTextToken {
  kind: 'text'
  raw: string
}

type HtmlToken = HtmlTagToken | HtmlTextToken

interface OpenHtmlTag {
  name: string
  /** 下一段开头重新打开用的原始标签（a 保留原 href）。 */
  reopen: string
  /** 当前段结尾闭合用的标签。 */
  close: string
}

interface HtmlPartBody {
  content: string
  reopen: OpenHtmlTag[]
  closing: OpenHtmlTag[]
}

const HTML_TAG_PATTERN = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)(?:\s[^>]*)?\s*\/?>$/

/** 把富文本切成“标签 / 文本”token；无法识别的尖括号按文本保留，避免丢失正文。 */
function tokenizeHtml(text: string): HtmlToken[] {
  const tokens: HtmlToken[] = []
  let buffer = ''
  let index = 0
  const flushText = (): void => {
    if (!buffer) return
    tokens.push({ kind: 'text', raw: buffer })
    buffer = ''
  }
  while (index < text.length) {
    if (text[index] !== '<') {
      buffer += text[index]
      index += 1
      continue
    }
    const end = text.indexOf('>', index + 1)
    const raw = end >= 0 ? text.slice(index, end + 1) : ''
    const match = raw ? HTML_TAG_PATTERN.exec(raw) : null
    if (!match) {
      buffer += '<'
      index += 1
      continue
    }
    flushText()
    tokens.push({ kind: 'tag', raw, name: match[2]!.toLowerCase(), closing: match[1] === '/' })
    index = end + 1
  }
  flushText()
  return tokens
}

/** 把一个标签应用到打开标签栈；不匹配的闭合标签视为普通文本（不改变栈）。 */
function applyHtmlTag(stack: readonly OpenHtmlTag[], token: HtmlTagToken): OpenHtmlTag[] {
  if (token.closing) {
    const top = stack[stack.length - 1]
    if (!top || top.name !== token.name) return stack.slice()
    return stack.slice(0, -1)
  }
  if (HTML_VOID_TAGS.has(token.name) || token.raw.endsWith('/>')) return stack.slice()
  return [...stack, { name: token.name, reopen: token.raw, close: `</${token.name}>` }]
}

function htmlClosingLength(stack: readonly OpenHtmlTag[]): number {
  let total = 0
  for (const tag of stack) total += tag.close.length
  return total
}

function htmlReopenLength(stack: readonly OpenHtmlTag[]): number {
  let total = 0
  for (const tag of stack) total += tag.reopen.length
  return total
}

function continuationText(index: number, total: number): string {
  return `（续 ${index}/${total}）`
}

/** 在预算内选择文本切点：优先自然边界，且不切断 HTML 实体（&...;）或代理对。 */
function safeHtmlTextCut(text: string, maxChars: number): number {
  if (maxChars <= 0) return 0
  if (maxChars >= text.length) return text.length
  let cut = maxChars
  const last = text.charCodeAt(cut - 1)
  // 高代理项后截断：退一位，让两个码元留在同一段。
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1
  // 实体（如 &amp;）不能被切开：切点落在实体内部时退到实体起点。
  const amp = text.lastIndexOf('&', cut - 1)
  if (amp >= 0) {
    const semicolon = text.indexOf(';', amp)
    if (semicolon >= cut && semicolon - amp <= 10) cut = amp
  }
  if (cut <= 0) return 0
  const window = text.slice(0, cut)
  const paragraph = window.lastIndexOf('\n\n')
  if (paragraph > cut * 0.5) return paragraph + 2
  const line = window.lastIndexOf('\n')
  if (line > cut * 0.5) return line + 1
  const space = window.lastIndexOf(' ')
  if (space > cut * 0.7) return space + 1
  return cut
}

function stripHtmlTokens(tokens: readonly HtmlToken[]): string {
  return tokens.map((token) => (token.kind === 'text' ? token.raw : '')).join('')
}

/** 超过最大段数时末段追加的截断标记（与 text.ts 语义一致）。 */
const HTML_TRUNCATED_MARKER = '…（内容过长已截断）'

/**
 * Telegram HTML 分段：只在标签边界切分；跨段时在段尾按逆序补闭合标签、下一段开头按原顺序重开
 * （a 保留原 href）。续段前缀放在重开标签之前，避免前缀落入链接文字或代码块。
 * 每段总长（含前缀与补的标签）不超过 limit，且不切断标签/实体；超过最大段数时末段追加截断标记。
 */
function splitHtmlMessage(text: string, limit: number, maxParts: number): MessagePart[] {
  return packHtmlParts(text, limit, maxParts, 0)
}

/**
 * 分段打包实现。depth=0 为正常入口；极端的单个标签超过一段容量时，先去标签按纯文本重试（depth=1，
 * 仍保持实体安全），再不行才退回通用分段，避免递归。
 */
function packHtmlParts(text: string, limit: number, maxParts: number, depth: number): MessagePart[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (!normalized) return []
  const tokens = tokenizeHtml(normalized)
  const hasTags = tokens.some((token) => token.kind === 'tag')
  // 无标签且无实体：纯文本直接走通用分段，保持自然断句。
  if (!hasTags && !normalized.includes('&')) return splitForPlatform('telegram', normalized, maxParts)
  const fallback = (): MessagePart[] =>
    depth === 0
      ? packHtmlParts(stripHtmlTokens(tokens), limit, maxParts, 1)
      : splitForPlatform('telegram', stripHtmlTokens(tokens), maxParts)

  const parts: HtmlPartBody[] = []
  let content = ''
  let stack: OpenHtmlTag[] = []
  let reopen: OpenHtmlTag[] = []
  let truncated = false
  const flush = (): void => {
    parts.push({ content, reopen: reopen.slice(), closing: stack.slice() })
    content = ''
    reopen = stack.slice()
  }
  /** 当前段开销：续段前缀 + 重开标签；最后一允许段预留截断标记空间。 */
  const partOverhead = (): number =>
    (parts.length === 0 ? 0 : HTML_CONTINUATION_RESERVE) +
    htmlReopenLength(reopen) +
    (parts.length === maxParts - 1 ? HTML_TRUNCATED_MARKER.length : 0)
  const canFlush = (): boolean => parts.length < maxParts

  tokenLoop: for (const token of tokens) {
    if (token.kind === 'tag') {
      const nextStack = applyHtmlTag(stack, token)
      if (content.length + token.raw.length + htmlClosingLength(nextStack) <= limit - partOverhead()) {
        stack = nextStack
        content += token.raw
        continue
      }
      // 空段仍放不下：单个标签超过一段容量，退化为纯文本。
      if (content === '') return fallback()
      if (!canFlush()) {
        truncated = true
        break
      }
      flush()
      const retryStack = applyHtmlTag(stack, token)
      if (token.raw.length + htmlClosingLength(retryStack) > limit - partOverhead()) return fallback()
      stack = retryStack
      content += token.raw
      continue
    }
    let rest = token.raw
    while (rest.length > 0) {
      const budget = limit - partOverhead() - htmlClosingLength(stack)
      const available = budget - content.length
      const cut = available > 0 ? safeHtmlTextCut(rest, available) : 0
      if (cut <= 0) {
        if (content === '') return fallback()
        if (!canFlush()) {
          truncated = true
          break tokenLoop
        }
        flush()
        continue
      }
      content += rest.slice(0, cut)
      rest = rest.slice(cut)
      if (rest.length > 0) {
        if (!canFlush()) {
          truncated = true
          break tokenLoop
        }
        flush()
      }
    }
  }
  // 截断时丢弃当前未完成段，只保留已闭合的 maxParts 段。
  if (content !== '' && parts.length >= maxParts) truncated = true
  if (!truncated && (content !== '' || parts.length === 0)) {
    parts.push({ content, reopen: reopen.slice(), closing: stack.slice() })
  }
  if (parts.length === 0) return []

  const total = parts.length
  const rendered = parts.map((part, index) => {
    const prefix = index === 0 ? '' : continuationText(index + 1, total)
    const reopenText = part.reopen.map((tag) => tag.reopen).join('')
    const closingText = part.closing
      .slice()
      .reverse()
      .map((tag) => tag.close)
      .join('')
    const suffix = truncated && index === total - 1 ? HTML_TRUNCATED_MARKER : ''
    return { text: `${prefix}${reopenText}${part.content}${closingText}${suffix}`, index: index + 1, total }
  })
  // 防御：渲染后若仍超限（理论上不会），退化为纯文本分段，绝不把超长段发给平台。
  if (rendered.some((part) => part.text.length > limit)) return fallback()
  return rendered
}

export class TelegramAdapter implements BotAdapter {
  readonly platform = 'telegram' as const
  private readonly config: Record<string, unknown>
  private readonly secret: BotSecret
  private readonly fetchImpl?: typeof fetch

  constructor(secret: BotSecret, deps?: TelegramAdapterDeps)
  constructor(config: Record<string, unknown>, secret: BotSecret, deps?: { fetch?: typeof fetch })
  constructor(
    configOrSecret: Record<string, unknown> | BotSecret,
    secretOrDeps: BotSecret | TelegramAdapterDeps = {},
    deps: { fetch?: typeof fetch } = {},
  ) {
    if (typeof (configOrSecret as BotSecret).token === 'string') {
      const options = secretOrDeps as TelegramAdapterDeps
      this.secret = configOrSecret as BotSecret
      this.config =
        options.config ??
        (typeof options.botUsername === 'string' ? { botUsername: options.botUsername } : {})
      this.fetchImpl = options.fetch
    } else {
      this.config = configOrSecret as Record<string, unknown>
      this.secret = secretOrDeps as BotSecret
      this.fetchImpl = deps.fetch
    }
  }

  validate(_config: Record<string, unknown>, secret: BotSecret): string[] {
    const errors: string[] = []
    if (!secret.token || secret.token.length < 20) errors.push('telegram_token_invalid')
    if (!secret.webhookSecret || secret.webhookSecret.length < 16) errors.push('telegram_webhook_secret_required')
    return errors
  }

  setup(botId: string, appOrigin: string): { webhookUrl: string; steps: string[] } {
    const webhookUrl = `${appOrigin}/api/bot/webhook/${botId}`
    return {
      webhookUrl,
      steps: [
        '在 BotFather 创建/选择 Bot 并取得 token。',
        '生成一个至少 16 位的 webhook secret，填入本页“Webhook Secret”。',
        `设置 Webhook：curl -X POST "https://api.telegram.org/bot$TELEGRAM_TOKEN/setWebhook" -d "url=${webhookUrl}" -d "secret_token=$WEBHOOK_SECRET" -d "allowed_updates=[\\"message\\",\\"callback_query\\"]"。`,
        '群聊需在 BotFather 关闭隐私模式或让成员通过 @Bot 触发；私聊可直接对话。',
        '在 Telegram 私聊或群组中发送 /help 验证。',
      ],
    }
  }

  async verifyInbound(input: {
    botId: string
    headers: Record<string, string | string[] | undefined>
    body: Buffer
    chatTriggerFor?: (targetExternalId: string) => 'mention' | 'all'
  }): Promise<InboundVerification> {
    const header = headerValue(input.headers, 'x-telegram-bot-api-secret-token')
    if (!this.secret.webhookSecret || !header || !safeEqualString(header, this.secret.webhookSecret)) {
      return { kind: 'rejected', status: 401, code: 'invalid_signature' }
    }
    const payload = parseJsonBody(input.body)
    if (!payload) return { kind: 'rejected', status: 400, code: 'invalid_payload' }
    const callback = asRecord(payload.callback_query)
    if (callback) return this.parseCallbackQuery(payload, callback)
    const message = asRecord(payload.message)
    if (!message) return ignoredResult(ignoredEventId(payload))
    return this.parseMessage(payload, message, input.chatTriggerFor)
  }

  async send(target: BotTargetRow, content: OutboundContent): Promise<SendResult> {
    const media = content.media ?? []
    if (media.length === 0) {
      return this.sendMessage(
        target.external_id,
        content.text,
        { textMode: content.textMode },
        content.replyTo ?? null,
      )
    }
    const text = content.text
    if (media.length > MAX_MEDIA_FILES) throw new BotPlatformError(400, 'too_many_media')
    if (media.length === 1) return this.sendOneMedia(target.external_id, text, media[0]!)
    if (media.length >= 2 && media.every(isImageMedia)) {
      return this.sendMediaGroup(target.external_id, text, media)
    }
    return this.sendSequentially(target.external_id, text, media)
  }

  private async parseMessage(
    payload: Record<string, unknown>,
    message: Record<string, unknown>,
    chatTriggerFor?: (targetExternalId: string) => 'mention' | 'all',
  ): Promise<InboundVerification> {
    const chat = asRecord(message.chat)
    const from = asRecord(message.from)
    const image = extractInboundImage(message)
    const rawText = typeof message.text === 'string' ? message.text.trim() : ''
    // 仅图片无正文时用 caption 作为文本；两者都没有则忽略。
    const text = rawText || (typeof message.caption === 'string' ? message.caption.trim() : '')
    if (!text && !image) return ignoredResult(ignoredEventId(payload, message))
    if (!chat || !from) return { kind: 'rejected', status: 400, code: 'missing_fields' }
    const chatId = String(chat.id ?? '')
    const userId = String(from.id ?? '')
    if (!chatId || !userId) return { kind: 'rejected', status: 400, code: 'missing_fields' }
    const chatType = typeof chat.type === 'string' ? chat.type : ''
    const isDirect = chatType === 'private'
    const targetKind = chatKind(chatType)
    const userName =
      typeof from.username === 'string' ? from.username : typeof from.first_name === 'string' ? from.first_name : null
    const eventId = `tg:${chatId}:${String(message.message_id ?? payload.update_id ?? '')}`
    const messageId = message.message_id
    const quoteId =
      !isDirect && (typeof messageId === 'number' || (typeof messageId === 'string' && messageId))
        ? String(messageId)
        : null
    const reply = async (replyText: string, options?: BotReplyOptions): Promise<void> => {
      await this.sendMessage(chatId, replyText, options, quoteId)
    }
    const command = extractCommand(text)
    if (command) {
      return {
        kind: 'command',
        eventId,
        targetExternalId: chatId,
        targetKind,
        userId,
        userName,
        text: `/${command.command}${command.args.length ? ` ${command.args.join(' ')}` : ''}`,
        isDirect,
        reply,
      }
    }
    const chatResult = (body: string, chatTrigger: ChatTrigger): InboundVerification => {
      const result: Extract<InboundVerification, { kind: 'chat' }> = {
        kind: 'chat',
        eventId,
        targetExternalId: chatId,
        targetKind,
        userId,
        userName,
        text: body,
        isDirect,
        chatTrigger,
        reply,
      }
      if (image) result.image = image
      return result
    }
    if (isDirect) return chatResult(text, 'direct')
    const entities = message.entities
    const username =
      text.includes('@') || hasMentionEntity(entities) ? await this.resolveBotUsername() : ''
    const mentioned = mentionsUsername(text, entities, username)
    const replied = repliesToBot(message)
    if (!mentioned && !replied) {
      // 目标策略为“全部消息”时，未 @Bot 的群/频道普通消息也进入 Chat。
      if (chatTriggerFor?.(chatId) === 'all') return chatResult(text, 'message')
      return ignoredResult(ignoredEventId(payload, message))
    }
    const body = stripLeadingMention(text, username)
    if (!body && !image) return ignoredResult(ignoredEventId(payload, message))
    return chatResult(body, mentioned ? 'mention' : 'reply')
  }

  private parseCallbackQuery(
    payload: Record<string, unknown>,
    callback: Record<string, unknown>,
  ): InboundVerification {
    const message = asRecord(callback.message)
    const chat = message ? asRecord(message.chat) : null
    const from = asRecord(callback.from)
    if (!message || !chat || !from) {
      return { kind: 'rejected', status: 400, code: 'missing_fields' }
    }
    const chatId = String(chat.id ?? '')
    const userId = String(from.id ?? '')
    if (!chatId || !userId) return { kind: 'rejected', status: 400, code: 'missing_fields' }
    const action = actionFromCallbackData(typeof callback.data === 'string' ? callback.data.trim() : '')
    if (!action) return ignoredResult(ignoredEventId(payload))
    const callbackId = String(callback.id ?? payload.update_id ?? '')
    const chatType = typeof chat.type === 'string' ? chat.type : ''
    return {
      kind: 'action',
      eventId: `tg:${chatId}:cb:${callbackId}`,
      targetExternalId: chatId,
      targetKind: chatKind(chatType),
      userId,
      userName:
        typeof from.username === 'string'
          ? from.username
          : typeof from.first_name === 'string'
            ? from.first_name
            : null,
      action,
      isDirect: chatType === 'private',
      reply: async (replyText: string, options?: BotReplyOptions): Promise<void> => {
        await this.sendMessage(chatId, replyText, options)
      },
    }
  }

  /** 优先使用公开配置中的 botUsername；否则按 token 缓存 getMe 结果。 */
  private async resolveBotUsername(): Promise<string> {
    const configured = typeof this.config.botUsername === 'string' ? this.config.botUsername.trim() : ''
    if (configured) return configured.replace(/^@/, '')
    const key = tokenCacheKey(this.secret.token)
    const cached = botUsernameCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.username
    try {
      const body = await this.requestJson(telegramApi(this.secret.token, 'getMe'), { method: 'POST' })
      const result = asRecord(body.result)
      const username = result && typeof result.username === 'string' ? result.username.replace(/^@/, '').trim() : ''
      if (!username) throw new BotPlatformError(200, 'invalid_response')
      botUsernameCache.set(key, { username, expiresAt: Date.now() + BOT_USERNAME_CACHE_TTL_MS })
      return username
    } catch {
      // getMe 失败只影响本轮 @ 识别；缓存短失败窗口避免每条消息重试。
      botUsernameCache.set(key, { username: '', expiresAt: Date.now() + BOT_USERNAME_FAILURE_TTL_MS })
      return ''
    }
  }

  private async sendOneMedia(chatId: string, text: string, media: OutboundMedia): Promise<SendResult> {
    const photo = isImageMedia(media)
    const form = new FormData()
    form.set('chat_id', chatId)
    if (text) form.set('caption', text.slice(0, TELEGRAM_CAPTION_LIMIT))
    form.set(photo ? 'photo' : 'document', blobOf(media), media.filename)
    const body = await this.requestJson(telegramApi(this.secret.token, photo ? 'sendPhoto' : 'sendDocument'), {
      method: 'POST',
      body: form,
    })
    return { externalId: messageId(body) }
  }

  /** 2-5 张图片合并为一次相册消息，返回每个消息的 ID。 */
  private async sendMediaGroup(chatId: string, text: string, media: OutboundMedia[]): Promise<SendResult> {
    const form = new FormData()
    form.set('chat_id', chatId)
    const items = media.map((item, index) => ({
      type: 'photo',
      media: `attach://file${index}`,
      ...(index === 0 && text ? { caption: text.slice(0, TELEGRAM_CAPTION_LIMIT) } : {}),
    }))
    form.set('media', JSON.stringify(items))
    media.forEach((item, index) => {
      form.set(`file${index}`, blobOf(item), item.filename)
    })
    const body = await this.requestJson(telegramApi(this.secret.token, 'sendMediaGroup'), {
      method: 'POST',
      body: form,
    })
    const result = body.result
    if (!Array.isArray(result)) throw new BotPlatformError(200, 'invalid_response')
    const ids = result
      .map((entry) => messageId({ result: entry }))
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
    if (ids.length !== media.length) throw new BotPlatformError(200, 'invalid_response')
    return { externalId: ids[0] ?? null, externalIds: ids }
  }

  /** 非全图片或附件混排时逐个发送；任一失败立即抛错并附上已发送的 ID。 */
  private async sendSequentially(chatId: string, text: string, media: OutboundMedia[]): Promise<SendResult> {
    const ids: string[] = []
    try {
      for (const [index, item] of media.entries()) {
        const result = await this.sendOneMedia(chatId, index === 0 ? text : '', item)
        if (result.externalId) ids.push(result.externalId)
      }
    } catch (error) {
      throw markPartialError(error, ids, 'media')
    }
    return { externalId: ids[0] ?? null, externalIds: ids }
  }

  /**
   * 文本发送：按 Telegram 上限分段，按钮只在最后一段；首段可带引用回复。
   * 中途失败时把已发送的消息 ID 挂到错误对象，避免上层自动重试造成重复外发。
   */
  private async sendMessage(
    chatId: string,
    text: string,
    options?: BotReplyOptions,
    replyTo?: string | null,
  ): Promise<SendResult> {
    // HTML 模式必须按标签安全分段，避免切断 <b>/<pre>/<a> 等标签或实体导致平台 400。
    const parts =
      options?.textMode === 'html'
        ? splitHtmlMessage(text, BOT_TEXT_LIMITS.telegram, MAX_MESSAGE_PARTS)
        : splitForPlatform('telegram', text)
    if (parts.length === 0) return { externalId: null }
    const ids: string[] = []
    try {
      for (const part of parts) {
        const partOptions: BotReplyOptions = {
          ...(options?.textMode === 'html' ? { textMode: 'html' as const } : {}),
          ...(part.index === part.total && options?.buttons ? { buttons: options.buttons } : {}),
        }
        const externalId = await this.sendTextPart(chatId, part.text, partOptions, part.index === 1 ? replyTo ?? null : null)
        if (externalId) ids.push(externalId)
      }
    } catch (error) {
      throw markPartialError(error, ids, 'text')
    }
    if (ids.length === 0) return { externalId: null }
    if (ids.length === 1) return { externalId: ids[0] ?? null }
    return { externalId: ids[0] ?? null, externalIds: ids }
  }

  /** 单段文本发送；引用消息已失效时降级一次无引用重发。 */
  private async sendTextPart(
    chatId: string,
    text: string,
    options: BotReplyOptions | undefined,
    replyTo: string | null,
  ): Promise<string | null> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }
    if (options?.textMode === 'html') payload.parse_mode = 'HTML'
    const replyMarkup = inlineKeyboard(options?.buttons)
    if (replyMarkup) payload.reply_markup = replyMarkup
    if (replyTo) {
      const numeric = Number(replyTo)
      payload.reply_to_message_id = Number.isSafeInteger(numeric) && numeric > 0 ? numeric : replyTo
    }
    const call = async (): Promise<Record<string, unknown>> =>
      this.requestJson(telegramApi(this.secret.token, 'sendMessage'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    try {
      return messageId(await call())
    } catch (error) {
      if (!replyTo || !isMissingReplyTargetError(error)) throw error
      // 被引用消息可能已删除或对 Bot 不可见：去掉引用重发一次，正文与按钮保持不变。
      delete payload.reply_to_message_id
      return messageId(await call())
    }
  }

  /** 连接自检：getMe 校验 Token，getWebhookInfo 对比回到底座的 Webhook URL。不抛原始异常。 */
  async check(input: { botId: string; appOrigin: string }): Promise<BotHealthCheck> {
    const items: BotHealthItem[] = []
    try {
      const body = await this.requestJson(telegramApi(this.secret.token, 'getMe'), { method: 'POST' })
      const result = asRecord(body.result)
      const username = result && typeof result.username === 'string' ? result.username.replace(/^@/, '').trim() : ''
      if (!username) throw new BotPlatformError(200, 'invalid_response')
      items.push({ name: 'Bot 账号', ok: true, detail: `@${username}` })
    } catch (error) {
      items.push({ name: 'Bot 账号', ok: false, detail: telegramHealthError(error) })
      return { ok: false, items }
    }

    const expected = `${input.appOrigin.replace(/\/+$/, '')}/api/bot/webhook/${encodeURIComponent(input.botId)}`
    try {
      const body = await this.requestJson(telegramApi(this.secret.token, 'getWebhookInfo'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const info = asRecord(body.result) ?? {}
      const url = typeof info.url === 'string' ? info.url.trim() : ''
      const pending = Number(info.pending_update_count)
      const matched = url === expected
      items.push({
        name: 'Webhook',
        ok: matched,
        detail: matched
          ? `已设置（待处理 ${Number.isFinite(pending) && pending > 0 ? pending : 0} 条）`
          : 'webhook_url_mismatch',
      })
    } catch (error) {
      items.push({ name: 'Webhook', ok: false, detail: telegramHealthError(error) })
    }
    return { ok: items.every((item) => item.ok), items }
  }

  /** 下载入站图片：getFile 得到 file_path 后从固定域名下载，只接受图片 mime 与大小上限。 */
  async loadImage(
    image: BotInboundImage,
    options: { maxBytes: number; timeoutMs?: number },
  ): Promise<{ mime: string; data: Buffer }> {
    if (!normalizeImageMime(image.mime)) throw new BotPlatformError(400, 'image_unsupported')
    // 平台声明大小已超限时直接拒绝，避免多余的 getFile 请求。
    if (Number.isFinite(Number(image.size)) && Number(image.size) > options.maxBytes) {
      throw new BotPlatformError(413, 'image_too_large')
    }
    const filePath = await this.fetchFilePath(image.ref)
    // file_path 由平台返回，仍限制字符集并拒绝路径穿越，避免拼接出其它端点。
    if (!filePath || !/^[A-Za-z0-9._\-/]+$/.test(filePath) || filePath.includes('..') || filePath.startsWith('/')) {
      throw new BotPlatformError(400, 'image_unsupported')
    }
    return downloadImage({
      image: { ...image, ref: `https://api.telegram.org/file/bot${this.secret.token}/${filePath}` },
      maxBytes: options.maxBytes,
      timeoutMs: options.timeoutMs,
      fetch: this.fetchImpl,
      allowedHosts: ['api.telegram.org'],
    })
  }

  /** 换取图片 file_path；失败统一为 image_download_failed，不泄露平台响应正文。 */
  private async fetchFilePath(fileId: string): Promise<string> {
    try {
      const body = await this.requestJson(telegramApi(this.secret.token, 'getFile'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_id: fileId }),
      })
      const result = asRecord(body.result)
      return result && typeof result.file_path === 'string' ? result.file_path.trim() : ''
    } catch {
      throw new BotPlatformError(0, 'image_download_failed')
    }
  }

  private async requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const { body } = await fetchJson(url, init, { fetch: this.fetchImpl })
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BotPlatformError(200, 'invalid_response')
    }
    const record = body as Record<string, unknown>
    if (record.ok === false) {
      throw new BotPlatformError(200, typeof record.description === 'string' ? record.description.slice(0, 80) : 'telegram_error')
    }
    return record
  }
}
