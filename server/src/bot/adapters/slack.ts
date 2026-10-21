/**
 * Slack 适配器：Events API / Slash Command 的 HMAC 签名校验、URL challenge、消息与文件上传。
 * 安全边界：Signing Secret 只用于验签；Bot Token 只进 Authorization；response_url 只做一次性回复。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { BotAdapter, BotSecret, BotTargetRow, InboundVerification, OutboundContent, SendResult } from '../types.ts'
import { BotPlatformError, fetchJson, headerValue, parseJsonBody } from './http.ts'

const SLACK_API = 'https://slack.com/api'
const TEXT_LIMIT = 4000

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

export class SlackAdapter implements BotAdapter {
  readonly platform = 'slack' as const
  private readonly secret: BotSecret
  private readonly fetchImpl?: typeof fetch

  constructor(secret: BotSecret, deps: { fetch?: typeof fetch } = {}) {
    this.secret = secret
    this.fetchImpl = deps.fetch
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
        'Event Subscriptions 开启并填上面地址，订阅 message.channels/message.im（按需）。',
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
      const form = formBody(input.body)
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
        !(/^\/(services|commands)\//.test(responseHost.pathname))
      ) {
        return { kind: 'rejected', status: 400, code: 'invalid_response_url' }
      }
      return {
        kind: 'command',
        eventId,
        targetExternalId: channelId,
        userId,
        userName: form.get('user_name'),
        text,
        isDirect: channelId.startsWith('D'),
        reply: async (replyText: string) => {
          if (responseUrl) {
            await fetchJson(
              responseUrl,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text: replyText.slice(0, TEXT_LIMIT), response_type: 'in_channel' }),
              },
              { fetch: this.fetchImpl },
            )
            return
          }
          await this.sendMessage(channelId, replyText.slice(0, TEXT_LIMIT))
        },
      }
    }
    const payload = parseJsonBody(input.body)
    if (!payload) return { kind: 'rejected', status: 400, code: 'invalid_payload' }
    if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
      return { kind: 'challenge', body: { challenge: payload.challenge } }
    }
    if (payload.type !== 'event_callback') return { kind: 'ignored' }
    const event = payload.event as Record<string, unknown> | undefined
    if (!event || (event.type !== 'message' && event.type !== 'app_mention')) return { kind: 'ignored' }
    if (event.subtype || typeof event.bot_id === 'string') return { kind: 'ignored' }
    const command = extractCommand(typeof event.text === 'string' ? event.text : '')
    if (!command) return { kind: 'ignored' }
    const channelId = typeof event.channel === 'string' ? event.channel : ''
    const userId = typeof event.user === 'string' ? event.user : ''
    if (!channelId || !userId) return { kind: 'rejected', status: 400, code: 'missing_fields' }
    const eventId = typeof payload.event_id === 'string' && payload.event_id ? payload.event_id : typeof event.client_msg_id === 'string' ? event.client_msg_id : ''
    if (!eventId) return { kind: 'rejected', status: 400, code: 'missing_event_id' }
    return {
      kind: 'command',
      eventId: `slack:${eventId}`,
      targetExternalId: channelId,
      userId,
      userName: null,
      text: `/${command.name}${command.args.length ? ` ${command.args.join(' ')}` : ''}`.slice(0, 512),
      isDirect: channelId.startsWith('D'),
      reply: async (replyText: string) => {
        await this.sendMessage(channelId, replyText.slice(0, TEXT_LIMIT))
      },
    }
  }

  async send(target: BotTargetRow, content: OutboundContent): Promise<SendResult> {
    if (!content.media) {
      const result = await this.sendMessage(target.external_id, content.text.slice(0, TEXT_LIMIT))
      return result
    }
    const upload = await fetchJson(
      `${SLACK_API}/files.getUploadURLExternal?filename=${encodeURIComponent(content.media.filename)}&length=${content.media.data.length}`,
      { method: 'POST', headers: { authorization: `Bearer ${this.secret.token}` } },
      { fetch: this.fetchImpl },
    )
    const uploadBody = upload.body as Record<string, unknown> | null
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
      body: content.media.data,
      signal: AbortSignal.timeout(15_000),
    })
    if (!uploadResponse.ok) throw new BotPlatformError(uploadResponse.status, 'slack_upload_failed')
    const complete = await fetchJson(
      `${SLACK_API}/files.completeUploadExternal`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.secret.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          files: [{ id: uploadBody.file_id, title: content.media.filename }],
          channel_id: target.external_id,
          initial_comment: content.text.slice(0, TEXT_LIMIT),
        }),
      },
      { fetch: this.fetchImpl },
    )
    const completeBody = complete.body as Record<string, unknown> | null
    if (!completeBody || completeBody.ok !== true) throw new BotPlatformError(200, slackError(completeBody))
    return { externalId: uploadBody.file_id }
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
    const record = body as Record<string, unknown> | null
    if (!record || record.ok !== true) throw new BotPlatformError(200, slackError(record))
    return { externalId: typeof record.ts === 'string' ? record.ts : null }
  }
}

function slackError(body: Record<string, unknown> | null): string {
  if (body && typeof body.error === 'string') return body.error.slice(0, 80)
  return 'slack_error'
}
