/**
 * Telegram Bot API 适配器：Webhook 密钥头校验、命令解析、文本/图片/文件发送。
 * 安全边界：Bot Token 只在构造函数的 URL 中使用，不进入日志/错误；Webhook 必须配置 secret_token。
 */
import type { BotAdapter, BotSecret, BotTargetRow, InboundVerification, OutboundContent, SendResult } from '../types.ts'
import { safeEqualString } from '../../util/ids.ts'
import { BotPlatformError, fetchJson, headerValue, parseJsonBody } from './http.ts'

const TELEGRAM_TEXT_LIMIT = 4096

interface TelegramConfig {
  [key: string]: unknown
}

function telegramApi(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`
}

function extractCommand(text: string): { command: string; args: string[] } | null {
  const match = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]{1,64})?(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  return { command: match[1]!.toLowerCase(), args: (match[2] ?? '').trim().split(/\s+/).filter(Boolean) }
}

export class TelegramAdapter implements BotAdapter {
  readonly platform = 'telegram' as const
  private readonly secret: BotSecret
  private readonly fetchImpl?: typeof fetch

  constructor(secret: BotSecret, deps: { fetch?: typeof fetch } = {}) {
    this.secret = secret
    this.fetchImpl = deps.fetch
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
        `设置 Webhook：curl -X POST "https://api.telegram.org/bot$TELEGRAM_TOKEN/setWebhook" -d "url=${webhookUrl}" -d "secret_token=$WEBHOOK_SECRET" -d "allowed_updates=[\\"message\\"]"。`,
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
    const message = payload.message
    if (!message || typeof message !== 'object' || Array.isArray(message)) return { kind: 'ignored' }
    const record = message as Record<string, unknown>
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    const command = extractCommand(text)
    if (!command) return { kind: 'ignored' }
    const chat = record.chat as Record<string, unknown> | undefined
    const from = record.from as Record<string, unknown> | undefined
    if (!chat || !from) return { kind: 'rejected', status: 400, code: 'missing_fields' }
    const chatId = String(chat.id ?? '')
    const userId = String(from.id ?? '')
    if (!chatId || !userId) return { kind: 'rejected', status: 400, code: 'missing_fields' }
    const eventId = `tg:${chatId}:${String(record.message_id ?? payload.update_id ?? '')}`
    return {
      kind: 'command',
      eventId,
      targetExternalId: chatId,
      userId,
      userName: typeof from.username === 'string' ? from.username : typeof from.first_name === 'string' ? from.first_name : null,
      text: `/${command.command}${command.args.length ? ` ${command.args.join(' ')}` : ''}`,
      isDirect: chat.type === 'private',
      reply: async (replyText: string) => {
        await this.sendMessage(chatId, replyText.slice(0, TELEGRAM_TEXT_LIMIT))
      },
    }
  }

  async send(target: BotTargetRow, content: OutboundContent): Promise<SendResult> {
    const text = content.text.slice(0, TELEGRAM_TEXT_LIMIT)
    if (!content.media) return this.sendMessage(target.external_id, text)
    const isPhoto = /^image\/(jpeg|png|webp|gif)$/i.test(content.media.mime)
    const form = new FormData()
    form.set('chat_id', target.external_id)
    form.set('caption', text)
    form.set(isPhoto ? 'photo' : 'document', new Blob([content.media.data as unknown as ArrayBuffer], { type: content.media.mime }), content.media.filename)
    const body = await this.requestJson(telegramApi(this.secret.token, isPhoto ? 'sendPhoto' : 'sendDocument'), {
      method: 'POST',
      body: form,
    })
    const result = body.result as Record<string, unknown> | undefined
    return { externalId: result ? String(result.message_id ?? '') || null : null }
  }

  private async sendMessage(chatId: string, text: string): Promise<SendResult> {
    const body = await this.requestJson(telegramApi(this.secret.token, 'sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    })
    const result = body.result as Record<string, unknown> | undefined
    return { externalId: result ? String(result.message_id ?? '') || null : null }
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

export type { TelegramConfig }
