/**
 * Discord 适配器：Interactions Endpoint（Ed25519）、deferred 响应与频道消息/媒体发送。
 * 安全边界：验证原始 body 签名与时间戳；Bot Token 仅用于 Authorization，不记录。
 */
import { createPublicKey, verify as verifySignature } from 'node:crypto'
import type { BotAdapter, BotSecret, BotTargetRow, InboundVerification, OutboundContent, SendResult } from '../types.ts'
import { BotPlatformError, fetchJson, headerValue, parseJsonBody } from './http.ts'

const DISCORD_API = 'https://discord.com/api/v10'
const TEXT_LIMIT = 2000
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

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
    if (type !== 2) return { kind: 'ignored' }
    const data = payload.data as Record<string, unknown> | undefined
    const member = payload.member as Record<string, unknown> | undefined
    const user = payload.user as Record<string, unknown> | undefined
    const author = user ?? (member?.user as Record<string, unknown> | undefined)
    const command = typeof data?.name === 'string' ? data.name.toLowerCase() : ''
    if (!command || !author || typeof payload.channel_id !== 'string' || typeof payload.id !== 'string') {
      return { kind: 'rejected', status: 400, code: 'missing_fields' }
    }
    const applicationId = String(this.config.applicationId ?? '')
    const interactionToken = typeof payload.token === 'string' ? payload.token : ''
    const text = `/${command}${optionsText(data?.options) ? ` ${optionsText(data?.options)}` : ''}`.slice(0, 512)
    return {
      kind: 'command',
      eventId: `dc:${payload.id}`,
      targetExternalId: payload.channel_id,
      userId: String(author.id ?? ''),
      userName: typeof author.username === 'string' ? author.username : null,
      text,
      isDirect: false,
      immediateResponse: { type: 5 },
      reply: async (replyText: string) => {
        if (!applicationId || !interactionToken) return
        await fetchJson(
          `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: replyText.slice(0, TEXT_LIMIT) }),
          },
          { fetch: this.fetchImpl },
        )
      },
    }
  }

  async send(target: BotTargetRow, content: OutboundContent): Promise<SendResult> {
    const auth = { authorization: `Bot ${this.secret.token}` }
    if (!content.media) {
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
    const form = new FormData()
    form.set('payload_json', JSON.stringify({ content: content.text.slice(0, TEXT_LIMIT) }))
    form.set('files[0]', new Blob([content.media.data as unknown as ArrayBuffer], { type: content.media.mime }), content.media.filename)
    const { body } = await fetchJson(
      `${DISCORD_API}/channels/${encodeURIComponent(target.external_id)}/messages`,
      { method: 'POST', headers: auth, body: form },
      { fetch: this.fetchImpl },
    )
    return { externalId: messageId(body) }
  }
}

function messageId(body: unknown): string | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const id = (body as Record<string, unknown>).id
    if (typeof id === 'string') return id
  }
  return null
}
