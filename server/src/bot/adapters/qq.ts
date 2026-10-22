/**
 * QQ 官方 Bot 适配器：Webhook Ed25519 验签、op=13 回调地址校验、C2C/群@/频道事件解析、
 * 命令与普通消息 Chat、被动回复 msg_id、长文本分段发送、入站图片元数据与白名单下载、access_token 自检。
 * 安全边界：AppSecret 只用于本地派生 Ed25519 私钥与换取 access_token，不进入 URL、日志或错误信息；
 * 只支持文本发送；入站图片只保存平台 URL 元数据，由 loadImage 在内存下载后交给 AI，不落盘。
 * 群/频道只有 @Bot 事件进入 Bot（平台限制），C2C 私聊直接进入 Chat。
 */
import { createHash, createPrivateKey, createPublicKey, randomInt, sign, verify } from 'node:crypto'
import type {
  BotAdapter,
  BotHealthCheck,
  BotHealthItem,
  BotInboundImage,
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
  parseJsonBody,
} from './http.ts'

const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const QQ_API_BASE = 'https://api.sgroup.qq.com'
const TEXT_LIMIT = 2000
const CLOCK_SKEW_SECONDS = 300
const TOKEN_EXPIRY_MARGIN_SECONDS = 60
const DEFAULT_TOKEN_TTL_SECONDS = 7200
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
/** QQ 要求事件回调必须返回的确认体。 */
const QQ_ACK_BODY = { opcode: 12 }
/** 入站图片允许下载的 QQ CDN 域名后缀；后缀前导点保证完整 DNS 标签边界。 */
const QQ_IMAGE_HOST_SUFFIXES = ['.qpic.cn', '.qq.com', '.qq.com.cn', '.gtimg.cn'] as const

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

/** 从事件 d.attachments 取首个 image/* 附件；字段不完整时跳过。 */
function extractInboundImage(d: Record<string, unknown>): BotInboundImage | undefined {
  const attachments = d.attachments
  if (!Array.isArray(attachments)) return undefined
  for (const raw of attachments) {
    const attachment = asRecord(raw)
    if (!attachment) continue
    const mime = typeof attachment.content_type === 'string' ? attachment.content_type.trim().toLowerCase() : ''
    const rawUrl = typeof attachment.url === 'string' ? attachment.url.trim() : ''
    if (!mime.startsWith('image/') || !rawUrl) continue
    // QQ 文档示例存在协议相对 URL（//host/path），统一补成 https 后再交给下载白名单校验。
    const url = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl
    const image: BotInboundImage = { ref: url, mime }
    const name = typeof attachment.filename === 'string' ? attachment.filename.trim() : ''
    if (name) image.name = name
    const size = Number(attachment.size)
    if (Number.isFinite(size) && size > 0) image.size = size
    return image
  }
  return undefined
}

/** 连接自检失败时使用的固定脱敏错误码（绝不返回 token）。 */
function qqHealthError(error: unknown): string {
  if (error instanceof BotPlatformError) {
    if (error.status === 0) return 'network_error'
    if (error.code === 'qq_credentials_missing') return 'qq_credentials_missing'
  }
  return 'qq_access_token_failed'
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
        '在“目标”中登记用户 openid、群 openid 或频道 ID，并开启命令/通知权限；群/频道消息需 @Bot 才会触发。',
        '将机器人加入测试群或频道，发送 /help 验证；回复依赖入站消息的 msg_id，主动通知不带 msg_id。',
        '如需图片理解，在部署环境开启 BOT_AI_VISION_ENABLED，并使用支持图片输入的模型。',
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
        {
          // 未知事件类型也尽量给出诊断 ID：消息 id 优先，其次事件类型:时间戳。
          const rawId = textValue(d.id)
          const rawTs = textValue(d.timestamp)
          const detail = `qq:event:${eventType || 'unknown'}`
          const ignoredId = rawId || (rawTs ? `${eventType || 'unknown'}:${rawTs}` : '')
          return ignoredId
            ? { kind: 'ignored', eventId: ignoredId, ackBody: QQ_ACK_BODY, detail }
            : { kind: 'ignored', ackBody: QQ_ACK_BODY, detail }
        }
    }
    const { targetExternalId, userId, kind, isDirect } = route
    if (!targetExternalId || !userId) {
      return { kind: 'rejected', status: 400, code: 'missing_fields' }
    }

    const rawContent = typeof d.content === 'string' ? d.content.trim() : ''
    // C2C 不包含平台 mention 前缀；群/频道先剥离开头的 @Bot 再判断命令或 Chat。
    const content = isDirect ? rawContent : stripMentionPrefix(rawContent)
    const image = extractInboundImage(d)
    const messageId = textValue(d.id)
    const eventTs = textValue(d.timestamp) || String(Math.floor(this.now().getTime() / 1000))
    const eventId = messageId || `qq:${targetExternalId}:${eventTs}`
    // 空消息也必须确认，避免 QQ 反复重推同一事件；仅图片无正文时仍进入 Chat。
    if (!content && !image) {
      return { kind: 'ignored', eventId, ackBody: QQ_ACK_BODY, detail: 'qq:event:empty_content' }
    }

    const replyTarget: QqTarget = { external_id: targetExternalId, kind }
    const userName =
      author && typeof author.username === 'string'
        ? author.username
        : author && typeof author.nickname === 'string'
          ? author.nickname
          : null
    const reply = async (replyText: string): Promise<void> => {
      await this.sendTextParts(replyTarget, replyText, messageId || null)
    }
    if (content.startsWith('/')) {
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
    const chat: Extract<InboundVerification, { kind: 'chat' }> = {
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
    if (image) chat.image = image
    return chat
  }

  async send(target: BotTargetRow, content: OutboundContent): Promise<SendResult> {
    return this.sendTextParts({ external_id: target.external_id, kind: target.kind }, content.text)
  }

  /** 文本分段发送；中途失败时把已发送消息 ID 挂到错误对象，避免重复外发。 */
  private async sendTextParts(
    target: QqTarget,
    text: string,
    messageId: string | null = null,
  ): Promise<SendResult> {
    const parts = splitForPlatform('qq', text)
    if (parts.length === 0) return { externalId: null }
    const ids: string[] = []
    try {
      for (const part of parts) {
        const result = await this.sendMessage(target, part.text, messageId)
        if (result.externalId) ids.push(result.externalId)
      }
    } catch (error) {
      throw markPartialError(error, ids)
    }
    if (ids.length === 0) return { externalId: null }
    if (ids.length === 1) return { externalId: ids[0] ?? null }
    return { externalId: ids[0] ?? null, externalIds: ids }
  }

  /** 连接自检：换取 access_token 成功即视为可用；detail 固定文案，绝不返回 token。 */
  async check(_input: { botId: string; appOrigin: string }): Promise<BotHealthCheck> {
    const items: BotHealthItem[] = []
    try {
      await this.accessToken()
      items.push({ name: 'access_token', ok: true, detail: 'access_token 已获取' })
    } catch (error) {
      items.push({ name: 'access_token', ok: false, detail: qqHealthError(error) })
      return { ok: false, items }
    }
    return { ok: true, items }
  }

  /** 下载入站图片：只允许 QQ CDN 域名后缀，内存返回 Buffer，不落盘。 */
  async loadImage(
    image: BotInboundImage,
    options: { maxBytes: number; timeoutMs?: number },
  ): Promise<{ mime: string; data: Buffer }> {
    return downloadImage({
      image,
      maxBytes: options.maxBytes,
      timeoutMs: options.timeoutMs,
      fetch: this.fetchImpl,
      allowedHostSuffixes: QQ_IMAGE_HOST_SUFFIXES,
    })
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
