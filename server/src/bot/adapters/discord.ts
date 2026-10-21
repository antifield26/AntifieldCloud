/**
 * Discord 适配器：Interactions Endpoint（Ed25519）、命令与消息组件交互、deferred 响应、频道文本/多附件发送。
 * 安全边界：验证原始 body 签名与时间戳；Bot Token 仅用于 Authorization，不记录；交互 follow-up 只用 interaction token。
 * 普通频道消息的 Gateway 入站由独立模块处理，本适配器只覆盖 HTTP Interactions。
 */
import { createPublicKey, verify as verifySignature } from 'node:crypto'
import type {
  BotAction,
  BotAdapter,
  BotButton,
  BotReplyOptions,
  BotSecret,
  BotTargetRow,
  InboundVerification,
  OutboundContent,
  SendResult,
} from '../types.ts'
import { BotPlatformError, fetchJson, headerValue, parseJsonBody } from './http.ts'

const DISCORD_API = 'https://discord.com/api/v10'
const TEXT_LIMIT = 2000
const MAX_MEDIA_FILES = 5
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

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
        '如需斜杠命令，在 Developer Portal 或 API 注册 /help、/status、/backup、/world、/mc、/files。',
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
    return { kind: 'ignored' }
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
      text: `/${command}${options ? ` ${options}` : ''}`.slice(0, 512),
      isDirect: false,
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
    if (!action) return { kind: 'ignored' }
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
    const media = content.media ?? []
    if (media.length === 0) {
      const { body } = await fetchJson(
        `${DISCORD_API}/channels/${encodeURIComponent(target.external_id)}/messages`,
        {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ content: content.text.slice(0, TEXT_LIMIT) }),
        },
        { fetch: this.fetchImpl },
      )
      return { externalId: messageId(body) }
    }
    if (media.length > MAX_MEDIA_FILES) throw new BotPlatformError(400, 'too_many_media')
    const form = new FormData()
    form.set('payload_json', JSON.stringify({ content: content.text.slice(0, TEXT_LIMIT) }))
    media.forEach((item, index) => {
      form.set(`files[${index}]`, new Blob([item.data as unknown as ArrayBuffer], { type: item.mime }), item.filename)
    })
    const { body } = await fetchJson(
      `${DISCORD_API}/channels/${encodeURIComponent(target.external_id)}/messages`,
      { method: 'POST', headers: auth, body: form },
      { fetch: this.fetchImpl },
    )
    const externalId = messageId(body)
    if (media.length === 1) return { externalId }
    return { externalId, externalIds: attachmentIds(body, media.length, externalId) }
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

  private async interactionFollowUp(
    applicationId: string,
    interactionToken: string,
    text: string,
    options?: BotReplyOptions,
  ): Promise<void> {
    if (!applicationId || !interactionToken) return
    const payload: Record<string, unknown> = { content: text.slice(0, TEXT_LIMIT) }
    const components = this.buttonComponents(options?.buttons)
    if (components) payload.components = components
    await fetchJson(
      `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
      { fetch: this.fetchImpl },
    )
  }
}
