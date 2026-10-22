/**
 * Discord 适配器：Interactions Endpoint（Ed25519）、命令与消息组件交互、deferred 响应、频道文本分段/多附件发送。
 * 安全边界：验证原始 body 签名与时间戳；Bot Token 仅用于 Authorization，不记录；交互 follow-up 只用 interaction token。
 * 普通频道消息的 Gateway 入站由独立模块处理，本适配器只覆盖 HTTP Interactions；
 * Telegram 之外的平台不解释 parse_mode，textMode 一律忽略。
 */
import { createPublicKey, verify as verifySignature } from 'node:crypto'
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
  InboundVerification,
  OutboundContent,
  SendResult,
} from '../types.ts'
import { splitForPlatform } from '../text.ts'
import {
  BotPlatformError,
  downloadImage,
  fetchJson,
  headerValue,
  markPartialError,
  normalizeImageMime,
  parseJsonBody,
} from './http.ts'

const DISCORD_API = 'https://discord.com/api/v10'
const TEXT_LIMIT = 2000
const COMMAND_TEXT_MAX = 2048
const MAX_MEDIA_FILES = 5
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
/** 入站图片允许下载的固定 CDN 域名。 */
const DISCORD_IMAGE_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'] as const

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function publicKeyFromHex(hex: string) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new BotPlatformError(400, 'invalid_public_key')
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, 'hex')]),
    format: 'der',
    type: 'spki',
  })
}

function optionsText(options: unknown): string {
  if (!Array.isArray(options)) return ''
  return options
    .map((option) => {
      if (!option || typeof option !== 'object') return ''
      const record = option as Record<string, unknown>
      return typeof record.value === 'string' ? record.value : ''
    })
    .filter(Boolean)
    .join(' ')
}

function actionFromCustomId(customId: string): BotAction | null {
  return customId === 'refresh_status' || customId === 'help' ? customId : null
}

function messageId(body: unknown): string | null {
  const record = asRecord(body)
  if (!record) return null
  const id = record.id
  if (typeof id === 'string') return id
  return null
}

/** 多附件消息的 externalIds 优先取附件 ID，夹具未返回时退化为消息 ID。 */
function attachmentIds(body: unknown, count: number, fallback: string | null): string[] {
  const record = asRecord(body)
  const attachments = record?.attachments
  if (Array.isArray(attachments)) {
    const ids = attachments
      .map((item) => {
        const entry = asRecord(item)
        return entry && typeof entry.id === 'string' ? entry.id : ''
      })
      .filter((id) => id.length > 0)
    if (ids.length > 0) return ids
  }
  if (!fallback) return []
  return Array.from({ length: count }, () => fallback)
}

/** ignored 事件的诊断 ID：交互事件 ID（拿不到则不带）。 */
function ignoredEvent(payload: Record<string, unknown>): InboundVerification {
  const id = typeof payload.id === 'string' ? payload.id.trim() : ''
  return id ? { kind: 'ignored', eventId: `dc:${id}` } : { kind: 'ignored' }
}

/** 连接自检失败时使用的固定脱敏错误码。 */
function discordHealthError(error: unknown): string {
  const status = error instanceof BotPlatformError ? error.status : 0
  if (status === 0) return 'network_error'
  if (status === 401 || status === 403) return 'discord_unauthorized'
  const text = `${error instanceof BotPlatformError ? error.code : ''}`.toLowerCase()
  if (text.includes('unauthorized') || text.includes('401')) return 'discord_unauthorized'
  return 'discord_api_error'
}

/** 引用回复失效（被引用消息已删除/不可见）时平台返回 400/404。 */
function isReferenceRejected(error: unknown): boolean {
  return error instanceof BotPlatformError && (error.status === 400 || error.status === 404)
}

export class DiscordAdapter implements BotAdapter {
  readonly platform = 'discord' as const
  private readonly config: Record<string, unknown>
  private readonly secret: BotSecret
  private readonly fetchImpl?: typeof fetch

  constructor(config: Record<string, unknown>, secret: BotSecret, deps: { fetch?: typeof fetch } = {}) {
    this.config = config
    this.secret = secret
    this.fetchImpl = deps.fetch
  }

  validate(config: Record<string, unknown>, secret: BotSecret): string[] {
    const errors: string[] = []
    if (!secret.token || secret.token.length < 20) errors.push('discord_token_invalid')
    if (typeof config.applicationId !== 'string' || !/^\d{5,32}$/.test(config.applicationId)) {
      errors.push('discord_application_id_invalid')
    }
    if (typeof config.publicKey !== 'string' || !/^[0-9a-f]{64}$/i.test(config.publicKey)) {
      errors.push('discord_public_key_invalid')
    }
    return errors
  }

  setup(botId: string, appOrigin: string): { webhookUrl: string; steps: string[] } {
    const webhookUrl = `${appOrigin}/api/bot/webhook/${botId}`
    return {
      webhookUrl,
      steps: [
        '在 Discord Developer Portal 创建 Application/Bot，取得 Bot Token、Application ID 与 Public Key。',
        'Interactions Endpoint URL 填上面复制的地址（保存时 Discord 会发送 PING，服务端会返回 PONG）。',
        '邀请 Bot 到测试服务器并授予“发送消息/附件”权限。',
        '在目标频道右键复制频道 ID，在“目标”中登记并开启命令/通知权限。',
        '如需斜杠命令，在 Developer Portal 或 API 注册 /help、/status、/backup、/world、/mc、/files；另注册 /role（字符串选项 action/name/prompt），该命令在私聊对全部用户开放。',
      ],
    }
  }

  async verifyInbound(input: {
    botId: string
    headers: Record<string, string | string[] | undefined>
    body: Buffer
  }): Promise<InboundVerification> {
    const signature = headerValue(input.headers, 'x-signature-ed25519')
    const timestamp = headerValue(input.headers, 'x-signature-timestamp')
    const publicKey = typeof this.config.publicKey === 'string' ? this.config.publicKey : ''
    if (!signature || !timestamp || !publicKey) {
      return { kind: 'rejected', status: 401, code: 'invalid_signature' }
    }
    const ts = Number(timestamp)
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
      return { kind: 'rejected', status: 401, code: 'stale_signature' }
    }
    const valid = (() => {
      try {
        return verifySignature(
          null,
          Buffer.concat([Buffer.from(timestamp, 'utf8'), input.body]),
          publicKeyFromHex(publicKey),
          Buffer.from(signature, 'hex'),
        )
      } catch {
        return false
      }
    })()
    if (!valid) return { kind: 'rejected', status: 401, code: 'invalid_signature' }
    const payload = parseJsonBody(input.body)
    if (!payload) return { kind: 'rejected', status: 400, code: 'invalid_payload' }
    const type = payload.type
    if (type === 1) return { kind: 'challenge', body: { type: 1 } }
    if (type === 2) return this.parseCommand(payload)
    if (type === 3) return this.parseComponent(payload)
    return ignoredEvent(payload)
  }

  private parseCommand(payload: Record<string, unknown>): InboundVerification {
    const data = asRecord(payload.data)
    const member = asRecord(payload.member)
    const user = asRecord(payload.user)
    const author = user ?? (member ? asRecord(member.user) : null)
    const command = typeof data?.name === 'string' ? data.name.toLowerCase() : ''
    const options = optionsText(data?.options)
    if (!command || !author || typeof payload.channel_id !== 'string' || typeof payload.id !== 'string') {
      return { kind: 'rejected', status: 400, code: 'missing_fields' }
    }
    const applicationId = String(this.config.applicationId ?? '')
    const interactionToken = typeof payload.token === 'string' ? payload.token : ''
    return {
      kind: 'command',
      eventId: `dc:${payload.id}`,
      targetExternalId: payload.channel_id,
      targetKind: 'channel',
      userId: String(author.id ?? ''),
      userName: typeof author.username === 'string' ? author.username : null,
      text: `/${command}${options ? ` ${options}` : ''}`.slice(0, COMMAND_TEXT_MAX),
      isDirect: typeof payload.guild_id !== 'string',
      immediateResponse: { type: 5 },
      reply: async (replyText: string, replyOptions?: BotReplyOptions) => {
        await this.interactionFollowUp(applicationId, interactionToken, replyText, replyOptions)
      },
    }
  }

  /** 消息组件（按钮）交互：返回 deferred update，随后通过 interaction token 发送 follow-up。 */
  private parseComponent(payload: Record<string, unknown>): InboundVerification {
    const data = asRecord(payload.data)
    const member = asRecord(payload.member)
    const user = asRecord(payload.user)
    const author = user ?? (member ? asRecord(member.user) : null)
    const customId = data && typeof data.custom_id === 'string' ? data.custom_id : ''
    const action = actionFromCustomId(customId)
    if (!action) return ignoredEvent(payload)
    if (!author || typeof payload.channel_id !== 'string' || typeof payload.id !== 'string') {
      return { kind: 'rejected', status: 400, code: 'missing_fields' }
    }
    const applicationId = String(this.config.applicationId ?? '')
    const interactionToken = typeof payload.token === 'string' ? payload.token : ''
    const channel = asRecord(payload.channel)
    const isDirect =
      channel !== null ? channel.type === 1 || channel.type === 3 : typeof payload.guild_id !== 'string'
    return {
      kind: 'action',
      eventId: `dc:${payload.id}`,
      targetExternalId: payload.channel_id,
      targetKind: 'channel',
      userId: String(author.id ?? ''),
      userName: typeof author.username === 'string' ? author.username : null,
      action,
      isDirect,
      immediateResponse: { type: 6 },
      reply: async (replyText: string, replyOptions?: BotReplyOptions) => {
        await this.interactionFollowUp(applicationId, interactionToken, replyText, replyOptions)
      },
    }
  }

  async send(target: BotTargetRow, content: OutboundContent): Promise<SendResult> {
    const auth = { authorization: `Bot ${this.secret.token}` }
    let channelId = target.external_id
    if (target.kind === 'user') {
      // DM 目标存用户 ID；先打开 DM 频道，再发送。普通频道目标不受影响。
      const { body } = await fetchJson(
        `${DISCORD_API}/users/@me/channels`,
        {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ recipient_id: target.external_id }),
        },
        { fetch: this.fetchImpl },
      )
      const opened = asRecord(body)
      if (typeof opened?.id !== 'string' || !opened.id) throw new BotPlatformError(200, 'discord_dm_channel_missing')
      channelId = opened.id
    }
    // 私聊不引用入站消息；频道引用失败时降级一次无引用重发。
    const replyTo = content.replyTo && target.kind !== 'user' ? content.replyTo : undefined
    const media = content.media ?? []
    if (media.length === 0) return this.sendText(channelId, content.text, replyTo, auth)
    if (media.length > MAX_MEDIA_FILES) throw new BotPlatformError(400, 'too_many_media')
    const firstPayload: Record<string, unknown> = { content: content.text.slice(0, TEXT_LIMIT) }
    if (replyTo) firstPayload.message_reference = { message_id: replyTo, fail_if_not_exists: false }
    const buildForm = (payload: Record<string, unknown>): FormData => {
      const form = new FormData()
      form.set('payload_json', JSON.stringify(payload))
      media.forEach((item, index) => {
        form.set(`files[${index}]`, new Blob([item.data as unknown as ArrayBuffer], { type: item.mime }), item.filename)
      })
      return form
    }
    const postMessage = async (payload: Record<string, unknown>): Promise<unknown> => {
      const { body } = await fetchJson(
        `${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages`,
        { method: 'POST', headers: auth, body: buildForm(payload) },
        { fetch: this.fetchImpl },
      )
      return body
    }
    let body: unknown
    try {
      body = await postMessage(firstPayload)
    } catch (error) {
      if (!replyTo || !isReferenceRejected(error)) throw error
      body = await postMessage({ content: content.text.slice(0, TEXT_LIMIT) })
    }
    const externalId = messageId(body)
    if (media.length === 1) return { externalId }
    return { externalId, externalIds: attachmentIds(body, media.length, externalId) }
  }

  /** 文本分段发送：引用只挂在首段，失败降级一次无引用重发；中途失败带已发送 ID。 */
  private async sendText(
    channelId: string,
    text: string,
    replyTo: string | undefined,
    auth: Record<string, string>,
  ): Promise<SendResult> {
    const parts = splitForPlatform('discord', text)
    if (parts.length === 0) return { externalId: null }
    const ids: string[] = []
    let reference = replyTo
    try {
      for (const part of parts) {
        const post = async (withReference: boolean): Promise<unknown> => {
          const payload: Record<string, unknown> = { content: part.text }
          if (withReference && reference) {
            payload.message_reference = { message_id: reference, fail_if_not_exists: false }
          }
          const { body } = await fetchJson(
            `${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages`,
            {
              method: 'POST',
              headers: { ...auth, 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            },
            { fetch: this.fetchImpl },
          )
          return body
        }
        let body: unknown
        try {
          body = await post(true)
        } catch (error) {
          if (!reference || !isReferenceRejected(error)) throw error
          reference = undefined
          body = await post(false)
        }
        const id = messageId(body)
        if (id) ids.push(id)
      }
    } catch (error) {
      throw markPartialError(error, ids, 'text')
    }
    if (ids.length === 0) return { externalId: null }
    if (ids.length === 1) return { externalId: ids[0] ?? null }
    return { externalId: ids[0] ?? null, externalIds: ids }
  }

  /** 按钮编码为 Discord action row（type 1），按钮为 secondary（style 2）。 */
  private buttonComponents(buttons?: BotButton[]): Array<Record<string, unknown>> | null {
    if (!buttons || buttons.length === 0) return null
    const row = buttons
      .filter((button) => typeof button.id === 'string' && typeof button.label === 'string')
      .slice(0, 5)
      .map((button) => ({
        type: 2,
        style: 2,
        label: button.label.slice(0, 80) || button.id,
        custom_id: button.id.slice(0, 100),
      }))
    if (row.length === 0) return null
    return [{ type: 1, components: row }]
  }

  /** follow-up 文本按 Discord 上限分段，按钮只在最后一段；中途失败带已发送 ID。 */
  private async interactionFollowUp(
    applicationId: string,
    interactionToken: string,
    text: string,
    options?: BotReplyOptions,
  ): Promise<void> {
    if (!applicationId || !interactionToken) return
    const parts = splitForPlatform('discord', text)
    if (parts.length === 0) return
    const ids: string[] = []
    try {
      for (const part of parts) {
        const payload: Record<string, unknown> = { content: part.text }
        if (part.index === part.total) {
          const components = this.buttonComponents(options?.buttons)
          if (components) payload.components = components
        }
        const { body } = await fetchJson(
          `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          },
          { fetch: this.fetchImpl },
        )
        const id = messageId(body)
        if (id) ids.push(id)
      }
    } catch (error) {
      throw markPartialError(error, ids, 'text')
    }
  }

  /** 连接自检：GET /users/@me 校验 Bot Token。不抛原始异常，也不回显 Token。 */
  async check(_input: { botId: string; appOrigin: string }): Promise<BotHealthCheck> {
    const items: BotHealthItem[] = []
    try {
      const { body } = await fetchJson(
        `${DISCORD_API}/users/@me`,
        { method: 'GET', headers: { authorization: `Bot ${this.secret.token}` } },
        { fetch: this.fetchImpl },
      )
      const record = asRecord(body)
      const username = record && typeof record.username === 'string' ? record.username : ''
      const id = record && typeof record.id === 'string' ? record.id : ''
      if (!username && !id) throw new BotPlatformError(200, 'invalid_response')
      items.push({
        name: 'Bot 账号',
        ok: true,
        detail: username ? `@${username}${id ? `（${id}）` : ''}` : id,
      })
    } catch (error) {
      items.push({ name: 'Bot 账号', ok: false, detail: discordHealthError(error) })
      return { ok: false, items }
    }
    return { ok: true, items }
  }

  /** 下载入站图片：只允许 Discord CDN 固定域名，mime 与大小上限由调用方传入。 */
  async loadImage(
    image: BotInboundImage,
    options: { maxBytes: number; timeoutMs?: number },
  ): Promise<{ mime: string; data: Buffer }> {
    if (!normalizeImageMime(image.mime)) throw new BotPlatformError(400, 'image_unsupported')
    return downloadImage({
      image,
      maxBytes: options.maxBytes,
      timeoutMs: options.timeoutMs,
      fetch: this.fetchImpl,
      allowedHosts: DISCORD_IMAGE_HOSTS,
    })
  }
}
