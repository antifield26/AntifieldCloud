/**
 * Telegram Bot API 适配器：Webhook 密钥头校验、命令/普通消息解析、文本与多附件发送、内联按钮与回调。
 * 安全边界：Bot Token 只出现在请求 URL 中，不进入日志或错误响应；Webhook 必须配置 secret_token。
 * 群/频道普通消息只有明确 @Bot 或回复 Bot 时才进入 Chat，避免把无关消息交给上层。
 */
import { createHash } from 'node:crypto'
import type {
  BotAction,
  BotAdapter,
  BotButton,
  BotReplyOptions,
  BotSecret,
  BotTargetRow,
  ChatTrigger,
  InboundVerification,
  OutboundContent,
  OutboundMedia,
  SendResult,
} from '../types.ts'
import { safeEqualString } from '../../util/ids.ts'
import { BotPlatformError, fetchJson, headerValue, parseJsonBody } from './http.ts'

const TELEGRAM_TEXT_LIMIT = 4096
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
    if (!message) return { kind: 'ignored' }
    return this.parseMessage(payload, message)
  }

  async send(target: BotTargetRow, content: OutboundContent): Promise<SendResult> {
    const text = content.text.slice(0, TELEGRAM_TEXT_LIMIT)
    const media = content.media ?? []
    if (media.length === 0) return this.sendMessage(target.external_id, text)
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
  ): Promise<InboundVerification> {
    const chat = asRecord(message.chat)
    const from = asRecord(message.from)
    const text = typeof message.text === 'string' ? message.text.trim() : ''
    if (!text) return { kind: 'ignored' }
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
    const reply = async (replyText: string, options?: BotReplyOptions): Promise<void> => {
      await this.sendMessage(chatId, replyText, options)
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
    if (isDirect) {
      return {
        kind: 'chat',
        eventId,
        targetExternalId: chatId,
        targetKind,
        userId,
        userName,
        text,
        isDirect: true,
        chatTrigger: 'direct',
        reply,
      }
    }
    const entities = message.entities
    const username =
      text.includes('@') || hasMentionEntity(entities) ? await this.resolveBotUsername() : ''
    const mentioned = mentionsUsername(text, entities, username)
    const replied = repliesToBot(message)
    if (!mentioned && !replied) return { kind: 'ignored' }
    const body = stripLeadingMention(text, username)
    if (!body) return { kind: 'ignored' }
    const chatTrigger: ChatTrigger = mentioned ? 'mention' : 'reply'
    return {
      kind: 'chat',
      eventId,
      targetExternalId: chatId,
      targetKind,
      userId,
      userName,
      text: body,
      isDirect: false,
      chatTrigger,
      reply,
    }
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
    if (!action) return { kind: 'ignored' }
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
      if (error && typeof error === 'object') {
        ;(error as { sentExternalIds?: string[] }).sentExternalIds = ids
      }
      throw error
    }
    return { externalId: ids[0] ?? null, externalIds: ids }
  }

  private async sendMessage(chatId: string, text: string, options?: BotReplyOptions): Promise<SendResult> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: text.slice(0, TELEGRAM_TEXT_LIMIT),
      disable_web_page_preview: true,
    }
    const replyMarkup = inlineKeyboard(options?.buttons)
    if (replyMarkup) payload.reply_markup = replyMarkup
    const body = await this.requestJson(telegramApi(this.secret.token, 'sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return { externalId: messageId(body) }
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
