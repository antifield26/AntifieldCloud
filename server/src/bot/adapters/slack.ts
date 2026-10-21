/**
 * Slack 适配器：Events API / Slash Command 的 HMAC 签名校验、URL challenge、普通消息 Chat 与多文件上传。
 * 安全边界：Signing Secret 只用于验签；Bot Token 只进 Authorization；response_url 仅允许 hooks.slack.com。
 * 普通频道消息仅在 app_mention 或明确 <@BOTID> 时进入 Chat，DM 直接进入 Chat；Bot 自身消息一律忽略。
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type {
  BotAdapter,
  BotSecret,
  BotTargetRow,
  InboundVerification,
  OutboundContent,
  OutboundMedia,
  SendResult,
} from '../types.ts'
import { BotPlatformError, fetchJson, headerValue, parseJsonBody } from './http.ts'

const SLACK_API = 'https://slack.com/api'
const TEXT_LIMIT = 4000
const BOT_USER_CACHE_TTL_MS = 60 * 60 * 1000
const BOT_USER_FAILURE_TTL_MS = 30 * 1000

interface SlackAdapterDeps {
  fetch?: typeof fetch
  /** 公开配置可携带 botUserId；Service 未传入时从 authorizations 或 auth.test 解析。 */
  config?: Record<string, unknown>
  /** 兼容直接注入 botUserId 的调用方。 */
  botUserId?: string
}

interface BotUserCacheEntry {
  userId: string
  expiresAt: number
}

/** 按 token 哈希缓存 auth.test 的 bot user_id，避免每条频道消息都请求平台。 */
const botUserCache = new Map<string, BotUserCacheEntry>()

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex')
}

function safeHexEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

function extractCommand(text: string): { name: string; args: string[] } | null {
  const match = /^\/([A-Za-z0-9_]{1,32})(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  return { name: match[1]!.toLowerCase(), args: (match[2] ?? '').trim().split(/\s+/).filter(Boolean) }
}

function formBody(body: Buffer): URLSearchParams {
  return new URLSearchParams(body.toString('utf8'))
}

function tokenCacheKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function botUserIdFromAuthorizations(authorizations: unknown): string {
  if (!Array.isArray(authorizations)) return ''
  for (const item of authorizations) {
    const record = asRecord(item)
    if (record && typeof record.user_id === 'string' && record.user_id) return record.user_id
  }
  return ''
}

function containsBotMention(text: string, botUserId: string): boolean {
  if (!botUserId) return false
  const escaped = botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`<@${escaped}(?:\\|[^>]*)?>`, 'i').test(text)
}

/** 去掉开头的 <@U123> 形式的 mention，保留正文。 */
function stripLeadingMentions(text: string): string {
  let value = text.trim()
  const pattern = /^(?:<@[^>]+>\s*)+/u
  while (pattern.test(value)) value = value.replace(pattern, '')
  return value.trim()
}

function slackError(body: Record<string, unknown> | null): string {
  if (body && typeof body.error === 'string') return body.error.slice(0, 80)
  return 'slack_error'
}

export class SlackAdapter implements BotAdapter {
  readonly platform = 'slack' as const
  private readonly config: Record<string, unknown>
  private readonly secret: BotSecret
  private readonly fetchImpl?: typeof fetch

  constructor(secret: BotSecret, deps?: SlackAdapterDeps)
  constructor(config: Record<string, unknown>, secret: BotSecret, deps?: { fetch?: typeof fetch })
  constructor(
    configOrSecret: Record<string, unknown> | BotSecret,
    secretOrDeps: BotSecret | SlackAdapterDeps = {},
    deps: { fetch?: typeof fetch } = {},
  ) {
    if (typeof (configOrSecret as BotSecret).token === 'string') {
      const options = secretOrDeps as SlackAdapterDeps
      this.secret = configOrSecret as BotSecret
      this.config = options.config ?? (typeof options.botUserId === 'string' ? { botUserId: options.botUserId } : {})
      this.fetchImpl = options.fetch
    } else {
      this.config = configOrSecret as Record<string, unknown>
      this.secret = secretOrDeps as BotSecret
      this.fetchImpl = deps.fetch
    }
  }

  validate(_config: Record<string, unknown>, secret: BotSecret): string[] {
    const errors: string[] = []
    if (!secret.token || secret.token.length < 20) errors.push('slack_token_invalid')
    if (!secret.signingSecret || secret.signingSecret.length < 16) errors.push('slack_signing_secret_required')
    return errors
  }

  setup(botId: string, appOrigin: string): { webhookUrl: string; steps: string[] } {
    const webhookUrl = `${appOrigin}/api/bot/webhook/${botId}`
    return {
      webhookUrl,
      steps: [
        '在 api.slack.com/apps 创建 App，取得 Bot Token（xoxb-…）与 Signing Secret。',
        'Event Subscriptions 开启并填上面地址，订阅 message.channels、message.im、app_mention（按需）。',
        'Slash Commands 的 Request URL 填同一地址，创建 /help、/status、/backup、/world、/mc、/files。',
        '安装 App 到测试 workspace，邀请 Bot 到测试频道并复制频道 ID 登记目标。',
      ],
    }
  }

  async verifyInbound(input: {
    botId: string
    headers: Record<string, string | string[] | undefined>
    body: Buffer
  }): Promise<InboundVerification> {
    const timestamp = headerValue(input.headers, 'x-slack-request-timestamp')
    const signature = headerValue(input.headers, 'x-slack-signature')
    if (!this.secret.signingSecret || !timestamp || !signature) {
      return { kind: 'rejected', status: 401, code: 'invalid_signature' }
    }
    const ts = Number(timestamp)
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
      return { kind: 'rejected', status: 401, code: 'stale_signature' }
    }
    const expected = `v0=${hmacHex(this.secret.signingSecret, `v0:${timestamp}:${input.body.toString('utf8')}`)}`
    if (!safeHexEqual(signature.replace(/^v0=/, ''), expected.replace(/^v0=/, ''))) {
      return { kind: 'rejected', status: 401, code: 'invalid_signature' }
    }
    const contentType = headerValue(input.headers, 'content-type') ?? ''
    if (contentType.includes('application/x-www-form-urlencoded')) {
      return this.parseSlashCommand(formBody(input.body))
    }
    const payload = parseJsonBody(input.body)
    if (!payload) return { kind: 'rejected', status: 400, code: 'invalid_payload' }
    if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
      return { kind: 'challenge', body: { challenge: payload.challenge } }
    }
    if (payload.type !== 'event_callback') return { kind: 'ignored' }
    return this.parseEvent(payload)
  }

  private parseSlashCommand(form: URLSearchParams): InboundVerification {
    const command = extractCommand(form.get('command') ?? '')
    if (!command) return { kind: 'ignored' }
    const responseUrl = form.get('response_url') ?? ''
    const channelId = form.get('channel_id') ?? ''
    const userId = form.get('user_id') ?? ''
    if (!channelId || !userId) return { kind: 'rejected', status: 400, code: 'missing_fields' }
    const text = `/${command.name}${command.args.length ? ` ${command.args.join(' ')}` : ''}`.slice(0, 512)
    const eventId = `slack:${form.get('trigger_id') ?? ''}`
    if (!form.get('trigger_id')) return { kind: 'rejected', status: 400, code: 'missing_trigger_id' }
    const responseHost = (() => {
      try {
        return new URL(responseUrl)
      } catch {
        return null
      }
    })()
    if (
      !responseHost ||
      responseHost.protocol !== 'https:' ||
      responseHost.hostname !== 'hooks.slack.com' ||
      !/^\/(services|commands)\//.test(responseHost.pathname)
    ) {
      return { kind: 'rejected', status: 400, code: 'invalid_response_url' }
    }
    return {
      kind: 'command',
      eventId,
      targetExternalId: channelId,
      targetKind: 'channel',
      userId,
      userName: form.get('user_name'),
      text,
      isDirect: channelId.startsWith('D'),
      reply: async (replyText: string) => {
        await fetchJson(
          responseUrl,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: replyText.slice(0, TEXT_LIMIT), response_type: 'in_channel' }),
          },
          { fetch: this.fetchImpl },
        )
      },
    }
  }

  private async parseEvent(payload: Record<string, unknown>): Promise<InboundVerification> {
    const event = asRecord(payload.event)
    if (!event || (event.type !== 'message' && event.type !== 'app_mention')) return { kind: 'ignored' }
    if (event.subtype || typeof event.bot_id === 'string') return { kind: 'ignored' }
    const rawText = typeof event.text === 'string' ? event.text.trim() : ''
    const channelId = typeof event.channel === 'string' ? event.channel : ''
    const userId = typeof event.user === 'string' ? event.user : ''
    if (!channelId || !userId) return { kind: 'rejected', status: 400, code: 'missing_fields' }
    const eventId =
      typeof payload.event_id === 'string' && payload.event_id
        ? payload.event_id
        : typeof event.client_msg_id === 'string'
          ? event.client_msg_id
          : ''
    if (!eventId) return { kind: 'rejected', status: 400, code: 'missing_event_id' }
    const channelType = typeof event.channel_type === 'string' ? event.channel_type : ''
    const isDirect = channelType === 'im' || channelId.startsWith('D')
    const command = event.type === 'message' ? extractCommand(rawText) : null
    if (command) {
      return {
        kind: 'command',
        eventId: `slack:${eventId}`,
        targetExternalId: channelId,
        targetKind: 'channel',
        userId,
        userName: null,
        text: `/${command.name}${command.args.length ? ` ${command.args.join(' ')}` : ''}`.slice(0, 512),
        isDirect,
        reply: async (replyText: string) => {
          await this.sendMessage(channelId, replyText.slice(0, TEXT_LIMIT))
        },
      }
    }
    if (event.type === 'app_mention') {
      const text = stripLeadingMentions(rawText)
      if (!text) return { kind: 'ignored' }
      return this.chatResult(channelId, userId, eventId, text, false, 'mention')
    }
    if (isDirect) {
      const text = stripLeadingMentions(rawText)
      if (!text) return { kind: 'ignored' }
      return this.chatResult(channelId, userId, eventId, text, true, 'direct')
    }
    const botUserId = await this.resolveBotUserId(payload)
    if (!containsBotMention(rawText, botUserId)) return { kind: 'ignored' }
    const text = stripLeadingMentions(rawText)
    if (!text) return { kind: 'ignored' }
    return this.chatResult(channelId, userId, eventId, text, false, 'mention')
  }

  private chatResult(
    channelId: string,
    userId: string,
    eventId: string,
    text: string,
    isDirect: boolean,
    chatTrigger: 'direct' | 'mention',
  ): InboundVerification {
    return {
      kind: 'chat',
      eventId: `slack:${eventId}`,
      targetExternalId: channelId,
      targetKind: 'channel',
      userId,
      userName: null,
      text,
      isDirect,
      chatTrigger,
      reply: async (replyText: string) => {
        await this.sendMessage(channelId, replyText.slice(0, TEXT_LIMIT))
      },
    }
  }

  /** 优先公开配置；其次事件 authorizations；最后按 token 缓存 auth.test 结果。 */
  private async resolveBotUserId(payload: Record<string, unknown>): Promise<string> {
    const configured =
      typeof this.config.botUserId === 'string'
        ? this.config.botUserId.trim()
        : typeof this.config.bot_user_id === 'string'
          ? this.config.bot_user_id.trim()
          : ''
    if (configured) return configured
    const authorized = botUserIdFromAuthorizations(payload.authorizations)
    if (authorized) return authorized
    const key = tokenCacheKey(this.secret.token)
    const cached = botUserCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.userId
    try {
      const { body } = await fetchJson(
        `${SLACK_API}/auth.test`,
        { method: 'POST', headers: { authorization: `Bearer ${this.secret.token}` } },
        { fetch: this.fetchImpl },
      )
      const record = asRecord(body)
      const userId = record && record.ok === true && typeof record.user_id === 'string' ? record.user_id : ''
      if (!userId) throw new BotPlatformError(200, 'invalid_response')
      botUserCache.set(key, { userId, expiresAt: Date.now() + BOT_USER_CACHE_TTL_MS })
      return userId
    } catch {
      botUserCache.set(key, { userId: '', expiresAt: Date.now() + BOT_USER_FAILURE_TTL_MS })
      return ''
    }
  }

  async send(target: BotTargetRow, content: OutboundContent): Promise<SendResult> {
    const media = content.media ?? []
    if (media.length === 0) {
      return this.sendMessage(target.external_id, content.text.slice(0, TEXT_LIMIT))
    }
    const text = content.text.slice(0, TEXT_LIMIT)
    const fileIds: string[] = []
    try {
      for (const item of media) {
        fileIds.push(await this.uploadFile(item))
      }
      const completed = await this.completeUpload(fileIds, media, target.external_id, text)
      if (media.length === 1) return { externalId: fileIds[0] ?? null }
      return { externalId: fileIds[0] ?? null, externalIds: completed ?? fileIds }
    } catch (error) {
      if (error && typeof error === 'object') {
        ;(error as { sentExternalIds?: string[] }).sentExternalIds = fileIds
      }
      throw error
    }
  }

  /** 走 files.getUploadURLExternal 两步上传，返回平台 file_id。 */
  private async uploadFile(media: OutboundMedia): Promise<string> {
    const upload = await fetchJson(
      `${SLACK_API}/files.getUploadURLExternal?filename=${encodeURIComponent(media.filename)}&length=${media.data.length}`,
      { method: 'POST', headers: { authorization: `Bearer ${this.secret.token}` } },
      { fetch: this.fetchImpl },
    )
    const uploadBody = asRecord(upload.body)
    if (!uploadBody || uploadBody.ok !== true || typeof uploadBody.upload_url !== 'string' || typeof uploadBody.file_id !== 'string') {
      throw new BotPlatformError(200, slackError(uploadBody))
    }
    let uploadUrl: URL
    try {
      uploadUrl = new URL(uploadBody.upload_url)
    } catch {
      throw new BotPlatformError(400, 'invalid_upload_url')
    }
    if (uploadUrl.protocol !== 'https:' || !/(^|\.)slack\.com$/i.test(uploadUrl.hostname)) {
      throw new BotPlatformError(400, 'invalid_upload_url')
    }
    const uploadResponse = await (this.fetchImpl ?? fetch)(uploadUrl.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: media.data,
      signal: AbortSignal.timeout(15_000),
    })
    if (!uploadResponse.ok) throw new BotPlatformError(uploadResponse.status, 'slack_upload_failed')
    return uploadBody.file_id
  }

  /** 完成上传并挂到频道；返回平台响应中的文件 ID（若存在）。 */
  private async completeUpload(
    fileIds: string[],
    media: OutboundMedia[],
    channelId: string,
    text: string,
  ): Promise<string[] | null> {
    const complete = await fetchJson(
      `${SLACK_API}/files.completeUploadExternal`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.secret.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          files: fileIds.map((id, index) => ({ id, title: media[index]?.filename ?? 'file' })),
          channel_id: channelId,
          initial_comment: text,
        }),
      },
      { fetch: this.fetchImpl },
    )
    const completeBody = asRecord(complete.body)
    if (!completeBody || completeBody.ok !== true) throw new BotPlatformError(200, slackError(completeBody))
    const files = completeBody.files
    if (!Array.isArray(files)) return null
    const ids = files
      .map((item) => {
        const record = asRecord(item)
        return record && typeof record.id === 'string' ? record.id : ''
      })
      .filter((id) => id.length > 0)
    return ids.length === fileIds.length ? ids : null
  }

  private async sendMessage(channelId: string, text: string): Promise<SendResult> {
    const { body } = await fetchJson(
      `${SLACK_API}/chat.postMessage`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.secret.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ channel: channelId, text, unfurl_links: false }),
      },
      { fetch: this.fetchImpl },
    )
    const record = asRecord(body)
    if (!record || record.ok !== true) throw new BotPlatformError(200, slackError(record))
    return { externalId: typeof record.ts === 'string' ? record.ts : null }
  }
}
