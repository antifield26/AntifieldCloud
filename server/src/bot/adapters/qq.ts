/**
 * QQ 官方 Bot 适配器：Webhook Ed25519 验签、op=13 回调地址校验、命令/普通消息解析、文本发送与被动回复。
 * 安全边界：AppSecret 只用于本地派生 Ed25519 私钥与换取 access_token，不进入 URL、日志或错误信息；
 * 仅支持文本，发送与回复统一截断到 QQ 的 2000 字符上限。
 */
import { createHash, createPrivateKey, createPublicKey, randomInt, sign, verify } from 'node:crypto'
import type { BotAdapter, BotSecret, BotTargetRow, InboundVerification, OutboundContent, SendResult } from '../types.ts'
import { BotPlatformError, fetchJson, headerValue, parseJsonBody } from './http.ts'

const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const QQ_API_BASE = 'https://api.sgroup.qq.com'
const TEXT_LIMIT = 2000
const CLOCK_SKEW_SECONDS = 300
const TOKEN_EXPIRY_MARGIN_SECONDS = 60
const DEFAULT_TOKEN_TTL_SECONDS = 7200
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
/** QQ 要求事件回调必须返回的确认体。 */
const QQ_ACK_BODY = { opcode: 12 }

interface AccessTokenCacheEntry {
  token: string
  expiresAt: number
}

interface QqTarget {
  external_id: string
  kind: 'channel' | 'user' | 'group'
}

/** 按 AppID + AppSecret 的哈希缓存 access_token；进程内共享，避免每次发送都换取令牌。 */
const accessTokenCache = new Map<string, AccessTokenCacheEntry>()

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 将 AppSecret 的 UTF-8 字节重复/截断为 32 字节，作为 Ed25519 seed。 */
function deriveSeed(appSecret: string): Buffer {
  const raw = Buffer.from(appSecret, 'utf8')
  const seed = Buffer.alloc(32)
  if (raw.length === 0) return seed
  for (let index = 0; index < seed.length; index += 1) {
    seed[index] = raw[index % raw.length]!
  }
  return seed
}

function privateKeyFromSecret(appSecret: string) {
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, deriveSeed(appSecret)]),
    format: 'der',
    type: 'pkcs8',
  })
}

function truncate(text: string): string {
  return text.slice(0, TEXT_LIMIT)
}

/** HTTP 头在框架层通常已小写；直接调用适配器时允许按文档中的大小写传入。 */
function signatureHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const direct = headerValue(headers, name)
  if (direct !== null) return direct
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue
    if (Array.isArray(value)) return value[0] ?? null
    return typeof value === 'string' ? value : null
  }
  return null
}

/** 去掉群/频道消息开头的 <@!id> 或 @昵称 mention 前缀，保留正文。 */
function stripMentionPrefix(text: string): string {
  let value = text.trim()
  value = value.replace(/^(?:<@!?[^>\s]+>\s*)+/u, '')
  value = value.replace(/^@[^\s]+\s+/u, '')
  return value.trim()
}

function messageUrl(target: QqTarget): string {
  const externalId = encodeURIComponent(target.external_id)
  switch (target.kind) {
    case 'user':
      return `${QQ_API_BASE}/v2/users/${externalId}/messages`
    case 'group':
      return `${QQ_API_BASE}/v2/groups/${externalId}/messages`
    case 'channel':
      return `${QQ_API_BASE}/channels/${externalId}/messages`
  }
}

function responseExternalId(body: unknown): string | null {
  const record = asRecord(body)
  if (!record) return null
  const raw = record.id ?? record.message_id
  if (typeof raw === 'string' && raw) return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return null
}

export class QqAdapter implements BotAdapter {
  readonly platform = 'qq' as const
  private readonly config: Record<string, unknown>
  private readonly secret: BotSecret
  private readonly fetchImpl?: typeof fetch
  private readonly now: () => Date

  constructor(
    config: Record<string, unknown>,
    secret: BotSecret,
    deps: { fetch?: typeof fetch; now?: () => Date } = {},
  ) {
    this.config = config
    this.secret = secret
    this.fetchImpl = deps.fetch
    this.now = deps.now ?? (() => new Date())
  }

  validate(config: Record<string, unknown>, secret: BotSecret): string[] {
    const errors: string[] = []
    const appId = typeof config.appId === 'string' ? config.appId.trim() : ''
    if (!/^\d{5,32}$/.test(appId)) errors.push('qq_app_id_invalid')
    if (typeof secret.token !== 'string' || secret.token.length < 16) errors.push('qq_secret_invalid')
    return errors
  }

  setup(botId: string, appOrigin: string): { webhookUrl: string; steps: string[] } {
    const webhookUrl = `${appOrigin}/api/bot/webhook/${botId}`
    return {
      webhookUrl,
      steps: [
        '在 QQ 开放平台（q.qq.com）创建机器人，取得 AppID 与 AppSecret；AppID 填入公开配置，AppSecret 填入“Token”字段。',
        `在“开发设置 → 回调地址”填上面复制的地址（${webhookUrl}），平台会发送 op=13 验证请求，服务端自动返回签名。`,
        '在事件订阅中勾选 C2C_MESSAGE_CREATE、GROUP_AT_MESSAGE_CREATE、AT_MESSAGE_CREATE（按使用场景选择）。',
        '在“目标”中登记用户 openid、群 openid 或频道 ID，并开启命令/通知权限。',
        '将机器人加入测试群或频道，发送 /help 验证；回复依赖入站消息的 msg_id，主动通知不带 msg_id。',
      ],
    }
  }

  async verifyInbound(input: {
    botId: string
    headers: Record<string, string | string[] | undefined>
    body: Buffer
  }): Promise<InboundVerification> {
    const payload = parseJsonBody(input.body)
    if (!payload) return { kind: 'rejected', status: 400, code: 'invalid_payload' }
    const op = Number(payload.op)
    // op=13 是开放平台的回调地址校验，请求不带签名头，响应体必须包含明文与签名。
    if (op === 13) return this.validationResponse(payload)
    // 仅处理事件推送 op=0；其余操作码无需平台重试确认。
    if (op !== 0) return { kind: 'ignored' }
    return this.verifyEvent(payload, input.headers, input.body)
  }

  private validationResponse(payload: Record<string, unknown>): InboundVerification {
    const d = asRecord(payload.d)
    const plainToken = d ? textValue(d.plain_token) : ''
    const eventTs = d ? textValue(d.event_ts) : ''
    if (!plainToken || !eventTs) return { kind: 'rejected', status: 400, code: 'invalid_payload' }
    if (!this.secret.token) return { kind: 'rejected', status: 401, code: 'invalid_signature' }
    try {
      const signature = sign(
        null,
        Buffer.from(`${eventTs}${plainToken}`, 'utf8'),
        privateKeyFromSecret(this.secret.token),
      ).toString('hex')
      return { kind: 'challenge', body: { plain_token: plainToken, signature } }
    } catch {
      return { kind: 'rejected', status: 401, code: 'invalid_signature' }
    }
  }

  private verifyEvent(
    payload: Record<string, unknown>,
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): InboundVerification {
    const signature = signatureHeader(headers, 'x-signature-ed25519')
    const timestamp = signatureHeader(headers, 'x-signature-timestamp')
    if (!this.secret.token || !signature || !timestamp || !/^[0-9a-f]{128}$/i.test(signature)) {
      return { kind: 'rejected', status: 401, code: 'invalid_signature' }
    }
    const ts = Number(timestamp)
    if (!Number.isFinite(ts) || Math.abs(this.now().getTime() / 1000 - ts) > CLOCK_SKEW_SECONDS) {
      return { kind: 'rejected', status: 401, code: 'stale_signature' }
    }
    const valid = (() => {
      try {
        return verify(
          null,
          Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]),
          createPublicKey(privateKeyFromSecret(this.secret.token)),
          Buffer.from(signature, 'hex'),
        )
      } catch {
        return false
      }
    })()
    if (!valid) return { kind: 'rejected', status: 401, code: 'invalid_signature' }
    return this.parseEvent(payload)
  }

  private parseEvent(payload: Record<string, unknown>): InboundVerification {
    const eventType = typeof payload.t === 'string' ? payload.t : ''
    const d = asRecord(payload.d)
    if (!d) return { kind: 'ignored', ackBody: QQ_ACK_BODY, detail: `qq:event:${eventType || 'unknown'}` }
    const author = asRecord(d.author)

    let route: { targetExternalId: string; userId: string; kind: QqTarget['kind']; isDirect: boolean }
    switch (eventType) {
      case 'C2C_MESSAGE_CREATE': {
        const openid = author ? textValue(author.user_openid) : ''
        route = { targetExternalId: openid, userId: openid, kind: 'user', isDirect: true }
        break
      }
      case 'GROUP_AT_MESSAGE_CREATE':
        route = {
          targetExternalId: textValue(d.group_openid),
          userId: author ? textValue(author.member_openid) : '',
          kind: 'group',
          isDirect: false,
        }
        break
      case 'AT_MESSAGE_CREATE':
        route = {
          targetExternalId: textValue(d.channel_id),
          userId: author ? textValue(author.id) : '',
          kind: 'channel',
          isDirect: false,
        }
        break
      default:
        return { kind: 'ignored', ackBody: QQ_ACK_BODY, detail: `qq:event:${eventType || 'unknown'}` }
    }
    const { targetExternalId, userId, kind, isDirect } = route
    if (!targetExternalId || !userId) {
      return { kind: 'rejected', status: 400, code: 'missing_fields' }
    }

    const rawContent = typeof d.content === 'string' ? d.content.trim() : ''
    // C2C 不包含平台 mention 前缀；群/频道先剥离开头的 @Bot 再判断命令或 Chat。
    const content = isDirect ? rawContent : stripMentionPrefix(rawContent)
    // 空消息也必须确认，避免 QQ 反复重推同一事件。
    if (!content) return { kind: 'ignored', ackBody: QQ_ACK_BODY, detail: 'qq:event:empty_content' }

    const messageId = textValue(d.id)
    const eventTs = textValue(d.timestamp) || String(Math.floor(this.now().getTime() / 1000))
    const eventId = messageId || `qq:${targetExternalId}:${eventTs}`
    const replyTarget: QqTarget = { external_id: targetExternalId, kind }
    const userName =
      author && typeof author.username === 'string'
        ? author.username
        : author && typeof author.nickname === 'string'
          ? author.nickname
          : null
    // QQ 不支持交互按钮；reply 的第二个参数由上层传入，这里只发送文本。
    const reply = async (replyText: string): Promise<void> => {
      await this.sendMessage(replyTarget, replyText, messageId || null)
    }
    if (!content.startsWith('/')) {
      return {
        kind: 'chat',
        eventId,
        targetExternalId,
        targetKind: kind,
        userId,
        userName,
        text: content,
        isDirect,
        chatTrigger: isDirect ? 'direct' : 'mention',
        ackBody: QQ_ACK_BODY,
        reply,
      }
    }
    return {
      kind: 'command',
      eventId,
      targetExternalId,
      targetKind: kind,
      userId,
      userName,
      text: content,
      isDirect,
      ackBody: QQ_ACK_BODY,
      reply,
    }
  }

  async send(target: BotTargetRow, content: OutboundContent): Promise<SendResult> {
    if ((content.media ?? []).length > 0) throw new BotPlatformError(400, 'qq_media_unsupported')
    return this.sendMessage({ external_id: target.external_id, kind: target.kind }, content.text)
  }

  private async sendMessage(target: QqTarget, text: string, messageId: string | null = null): Promise<SendResult> {
    const accessToken = await this.accessToken()
    const body: Record<string, unknown> = { content: truncate(text), msg_type: 0 }
    if (messageId) {
      body.msg_id = messageId
      body.msg_seq = randomInt(1, 10_001)
    }
    const response = await fetchJson(
      messageUrl(target),
      {
        method: 'POST',
        headers: { authorization: `QQBot ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      { fetch: this.fetchImpl },
    )
    return { externalId: responseExternalId(response.body) }
  }

  private async accessToken(): Promise<string> {
    const appId = this.appId()
    if (!appId || !this.secret.token) throw new BotPlatformError(400, 'qq_credentials_missing')
    const cacheKey = createHash('sha256').update(`${appId}\u0000${this.secret.token}`, 'utf8').digest('hex')
    const nowMs = this.now().getTime()
    const cached = accessTokenCache.get(cacheKey)
    if (cached && cached.expiresAt > nowMs) return cached.token

    let responseBody: unknown
    try {
      const response = await fetchJson(
        QQ_TOKEN_URL,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ appId, clientSecret: this.secret.token }),
        },
        { fetch: this.fetchImpl },
      )
      responseBody = response.body
    } catch (error) {
      // 固定错误码，避免平台错误体或请求 URL 把 AppSecret 带入日志/重试记录。
      const status = error instanceof BotPlatformError ? error.status : 0
      throw new BotPlatformError(status, 'qq_access_token_failed')
    }

    const record = asRecord(responseBody)
    const token = record && typeof record.access_token === 'string' ? record.access_token : ''
    if (!token) throw new BotPlatformError(502, 'qq_access_token_invalid')
    const expiresIn = record ? Number(record.expires_in) : Number.NaN
    const ttlSeconds =
      Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_TOKEN_TTL_SECONDS
    accessTokenCache.set(cacheKey, {
      token,
      expiresAt: nowMs + Math.max(0, ttlSeconds - TOKEN_EXPIRY_MARGIN_SECONDS) * 1000,
    })
    return token
  }

  private appId(): string {
    return typeof this.config.appId === 'string' ? this.config.appId.trim() : ''
  }
}
