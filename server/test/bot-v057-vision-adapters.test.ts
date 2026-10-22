/**
 * v0.5.7 平台适配器契约测试（四）：入站图片提取与 loadImage 下载。
 * Telegram photo/document、Discord 附件、Slack files 提取为 BotInboundImage；
 * loadImage 只允许固定平台域名，校验 mime 白名单与大小上限，错误固定为 BotPlatformError 错误码。
 * 全部使用注入 fetch 与二进制夹具，不访问真实平台网络。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, createPrivateKey, sign } from 'node:crypto'
import { TelegramAdapter } from '../src/bot/adapters/telegram.ts'
import { DiscordAdapter } from '../src/bot/adapters/discord.ts'
import { SlackAdapter } from '../src/bot/adapters/slack.ts'
import { QqAdapter } from '../src/bot/adapters/qq.ts'
import { BotPlatformError } from '../src/bot/adapters/http.ts'
import {
  DiscordGatewayManager,
  type DiscordGatewayBot,
  type DiscordGatewayMessage,
  type WebSocketLike,
} from '../src/bot/discord-gateway.ts'
import type { BotAdapter, BotInboundImage, BotSecret, InboundVerification } from '../src/bot/types.ts'

interface Captured {
  url: string
  init?: RequestInit
}

type FetchHandler = (url: string, init?: RequestInit) => Response

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function binaryResponse(data: string, contentLength = Buffer.byteLength(data)): Response {
  return new Response(Buffer.from(data), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(contentLength) },
  })
}

function makeFetch(handler: FetchHandler) {
  const captured: Captured[] = []
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    captured.push({ url, init })
    return handler(url, init)
  }
  return { fetchImpl: fetchImpl as typeof fetch, captured }
}

function chatOf(result: InboundVerification): Extract<InboundVerification, { kind: 'chat' }> {
  assert.equal(result.kind, 'chat')
  if (result.kind !== 'chat') throw new Error('expected chat')
  return result
}

function assertPlatformError(error: unknown, code: string): boolean {
  assert.ok(error instanceof BotPlatformError)
  assert.equal((error as BotPlatformError).code, code)
  return true
}

/* ------------------------------- Telegram ------------------------------- */

const TG_TOKEN = `123456789:${'A'.repeat(35)}`
const TG_WEBHOOK_SECRET = 'telegram-webhook-secret-1234'

function tgAdapter(fetchImpl?: typeof fetch): TelegramAdapter {
  return new TelegramAdapter({ token: TG_TOKEN, webhookSecret: TG_WEBHOOK_SECRET }, { fetch: fetchImpl })
}

function tgHeaders() {
  return { 'x-telegram-bot-api-secret-token': TG_WEBHOOK_SECRET, 'content-type': 'application/json' }
}

function tgBody(message: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({ update_id: 7, message }))
}

test('Telegram：photo 取最大尺寸，仅图片私聊也产出 chat(direct)', async () => {
  const adapter = tgAdapter()
  const result = chatOf(
    await adapter.verifyInbound({
      botId: 'bot-1',
      headers: tgHeaders(),
      body: tgBody({
        message_id: 61,
        chat: { id: 100, type: 'private' },
        from: { id: 7 },
        photo: [
          { file_id: 'small', width: 90, height: 90, file_size: 1000 },
          { file_id: 'large', width: 800, height: 600, file_size: 5000 },
        ],
      }),
    }),
  )
  assert.equal(result.text, '')
  assert.equal(result.isDirect, true)
  assert.equal(result.chatTrigger, 'direct')
  assert.deepEqual(result.image, { ref: 'large', mime: 'image/jpeg', name: 'photo.jpg', size: 5000 })
})

test('Telegram：群图片消息受触发策略约束，document 图片用 caption 作为文本', async () => {
  const adapter = tgAdapter()
  const groupBody = tgBody({
    message_id: 62,
    chat: { id: 200, type: 'group' },
    from: { id: 8 },
    photo: [{ file_id: 'photo-1', width: 100, height: 100 }],
  })
  const ignored = await adapter.verifyInbound({ botId: 'bot-1', headers: tgHeaders(), body: groupBody })
  assert.deepEqual(ignored, { kind: 'ignored', eventId: 'tg:update:7' })

  const all = chatOf(
    await adapter.verifyInbound({
      botId: 'bot-1',
      headers: tgHeaders(),
      body: groupBody,
      chatTriggerFor: () => 'all',
    }),
  )
  assert.equal(all.chatTrigger, 'message')
  assert.equal(all.image?.ref, 'photo-1')

  const document = chatOf(
    await adapter.verifyInbound({
      botId: 'bot-1',
      headers: tgHeaders(),
      body: tgBody({
        message_id: 63,
        caption: '  看这张图  ',
        chat: { id: 100, type: 'private' },
        from: { id: 7 },
        document: { file_id: 'doc-1', mime_type: 'image/png', file_name: 'shot.png', file_size: 2048 },
      }),
    }),
  )
  assert.equal(document.text, '看这张图')
  assert.deepEqual(document.image, {
    ref: 'doc-1',
    mime: 'image/png',
    name: 'shot.png',
    size: 2048,
  })

  // 非图片 document 且无文本：忽略。
  const pdf = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: tgHeaders(),
    body: tgBody({
      message_id: 64,
      chat: { id: 100, type: 'private' },
      from: { id: 7 },
      document: { file_id: 'doc-2', mime_type: 'application/pdf', file_name: 'a.pdf' },
    }),
  })
  assert.deepEqual(pdf, { kind: 'ignored', eventId: 'tg:update:7' })
})

test('Telegram loadImage：getFile→固定域名下载，白名单/上限/路径校验错误码固定', async () => {
  const { fetchImpl, captured } = makeFetch((url) => {
    if (url.endsWith('/getFile')) return jsonResponse({ ok: true, result: { file_path: 'photos/file_1.jpg' } })
    if (url.startsWith('https://api.telegram.org/file/bot')) return binaryResponse('JPEGDATA')
    return jsonResponse({ ok: false, description: 'unexpected' }, 404)
  })
  const adapter = tgAdapter(fetchImpl)
  const image: BotInboundImage = { ref: 'file-large', mime: 'image/jpeg', size: 8 }
  const loaded = await adapter.loadImage(image, { maxBytes: 1024 })
  assert.equal(loaded.mime, 'image/jpeg')
  assert.equal(loaded.data.toString('utf8'), 'JPEGDATA')
  assert.match(
    captured.at(-1)?.url ?? '',
    /^https:\/\/api\.telegram\.org\/file\/bot[^/]+\/photos\/file_1\.jpg$/,
  )
  // 原始入站图片引用不应被修改。
  assert.equal(image.ref, 'file-large')

  // 声明大小超限。
  await assert.rejects(
    () => adapter.loadImage({ ref: 'big', mime: 'image/jpeg', size: 4096 }, { maxBytes: 1024 }),
    (error) => assertPlatformError(error, 'image_too_large'),
  )

  // 实际响应超限（content-length 已超）。
  await assert.rejects(
    () => adapter.loadImage({ ref: 'file-1', mime: 'image/jpeg' }, { maxBytes: 4 }),
    (error) => assertPlatformError(error, 'image_too_large'),
  )

  // mime 白名单外：直接拒绝，不请求平台。
  const before = captured.length
  await assert.rejects(
    () => adapter.loadImage({ ref: 'file-1', mime: 'image/bmp' }, { maxBytes: 1024 }),
    (error) => assertPlatformError(error, 'image_unsupported'),
  )
  assert.equal(captured.length, before)

  // 平台返回的 file_path 含路径穿越：拒绝，不下载。
  const traversal = makeFetch(() => jsonResponse({ ok: true, result: { file_path: '../other/file.jpg' } }))
  await assert.rejects(
    () => tgAdapter(traversal.fetchImpl).loadImage({ ref: 'bad', mime: 'image/jpeg' }, { maxBytes: 1024 }),
    (error) => assertPlatformError(error, 'image_unsupported'),
  )
  assert.equal(traversal.captured.length, 1)

  // 下载网络失败。
  const offline = makeFetch((url) => {
    if (url.endsWith('/getFile')) return jsonResponse({ ok: true, result: { file_path: 'photos/a.jpg' } })
    throw new Error('socket hang up')
  })
  await assert.rejects(
    () => tgAdapter(offline.fetchImpl).loadImage({ ref: 'file-1', mime: 'image/jpeg' }, { maxBytes: 1024 }),
    (error) => assertPlatformError(error, 'image_download_failed'),
  )
})

/* -------------------------------- Discord ------------------------------- */

class FakeSocket implements WebSocketLike {
  readonly url: string
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null

  constructor(url: string) {
    this.url = url
  }

  send(): void {}

  close(): void {}

  open(): void {
    this.onopen?.()
  }

  dispatch(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
}

function gatewaySetup(chatTriggerFor?: (botId: string, targetExternalId: string) => 'mention' | 'all') {
  const sockets: FakeSocket[] = []
  const messages: DiscordGatewayMessage[] = []
  const bots: DiscordGatewayBot[] = [{ botId: 'bot-1', token: 'discord-token-1', enabled: true }]
  const manager = new DiscordGatewayManager({
    enabled: true,
    getBots: () => bots,
    log: () => {},
    onMessage: (event) => {
      messages.push(event)
    },
    chatTriggerFor,
    webSocketFactory: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
  })
  return { manager, sockets, messages }
}

function gatewayReady(socket: FakeSocket): void {
  socket.open()
  socket.dispatch({ op: 10, d: { heartbeat_interval: 60_000 } })
  socket.dispatch({
    op: 0,
    t: 'READY',
    s: 1,
    d: { session_id: 'sess-1', resume_gateway_url: 'wss://resume.discord.gg', user: { id: 'bot-user' } },
  })
}

function gatewayMessage(socket: FakeSocket, id: string, fields: Record<string, unknown>): void {
  socket.dispatch({
    op: 0,
    t: 'MESSAGE_CREATE',
    s: 2,
    d: {
      id,
      channel_id: 'chan-1',
      guild_id: 'guild-1',
      content: '',
      author: { id: 'user-1', username: 'alice', bot: false },
      mentions: [],
      ...fields,
    },
  })
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function discordImageAdapter(fetchImpl?: typeof fetch): DiscordAdapter {
  return new DiscordAdapter({}, { token: 'x'.repeat(40) }, { fetch: fetchImpl })
}

test('Discord Gateway：附件按 content_type 或扩展名提取图片，仅图片消息也 dispatch', async () => {
  const { manager, sockets, messages } = gatewaySetup((_botId, targetExternalId) =>
    targetExternalId === 'chan-all' ? 'all' : 'mention',
  )
  try {
    manager.start()
    const socket = sockets[0]!
    gatewayReady(socket)
    gatewayMessage(socket, 'msg-all-image', {
      channel_id: 'chan-all',
      content: '',
      attachments: [
        {
          id: 'att-1',
          url: 'https://cdn.discordapp.com/attachments/1/2/photo.png',
          filename: 'photo.png',
          content_type: 'image/png',
          size: 2048,
        },
      ],
    })
    gatewayMessage(socket, 'msg-dm-ext', {
      channel_id: 'dm-1',
      guild_id: undefined,
      content: '',
      attachments: [
        {
          id: 'att-2',
          url: 'https://media.discordapp.net/attachments/3/4/raw.jpg',
          filename: 'raw.jpg',
          size: 4096,
        },
      ],
    })
    gatewayMessage(socket, 'msg-no-image', { channel_id: 'chan-all', content: '', attachments: [] })
    await flush()

    assert.equal(messages.length, 2)
    const byId = new Map(messages.map((event) => [event.eventId, event]))
    assert.deepEqual(byId.get('dc_msg:msg-all-image')?.image, {
      ref: 'https://cdn.discordapp.com/attachments/1/2/photo.png',
      mime: 'image/png',
      name: 'photo.png',
      size: 2048,
    })
    assert.equal(byId.get('dc_msg:msg-all-image')?.chatTrigger, 'message')
    assert.deepEqual(byId.get('dc_msg:msg-dm-ext')?.image, {
      ref: 'https://media.discordapp.net/attachments/3/4/raw.jpg',
      mime: 'image/jpeg',
      name: 'raw.jpg',
      size: 4096,
    })
    assert.equal(byId.has('dc_msg:msg-no-image'), false)
  } finally {
    manager.stop()
  }
})

test('Discord loadImage：只允许 CDN 域名，超限与网络错误码固定', async () => {
  const { fetchImpl, captured } = makeFetch(() => binaryResponse('PNGDATA'))
  const adapter = discordImageAdapter(fetchImpl)
  const loaded = await adapter.loadImage(
    { ref: 'https://cdn.discordapp.com/attachments/1/2/a.png', mime: 'image/png', size: 7 },
    { maxBytes: 1024 },
  )
  assert.equal(loaded.mime, 'image/png')
  assert.equal(loaded.data.toString('utf8'), 'PNGDATA')
  assert.equal(captured.length, 1)

  const media = await adapter.loadImage(
    { ref: 'https://media.discordapp.net/attachments/1/2/a.jpg', mime: 'image/jpeg' },
    { maxBytes: 1024 },
  )
  assert.equal(media.data.toString('utf8'), 'PNGDATA')

  await assert.rejects(
    () => adapter.loadImage({ ref: 'https://evil.example.com/a.png', mime: 'image/png' }, { maxBytes: 1024 }),
    (error) => assertPlatformError(error, 'image_unsupported'),
  )
  await assert.rejects(
    () => adapter.loadImage({ ref: 'http://cdn.discordapp.com/a.png', mime: 'image/png' }, { maxBytes: 1024 }),
    (error) => assertPlatformError(error, 'image_unsupported'),
  )
  await assert.rejects(
    () => adapter.loadImage({ ref: 'https://cdn.discordapp.com/a.png', mime: 'image/png' }, { maxBytes: 3 }),
    (error) => assertPlatformError(error, 'image_too_large'),
  )

  const offline = makeFetch(() => {
    throw new Error('network down')
  })
  await assert.rejects(
    () =>
      discordImageAdapter(offline.fetchImpl).loadImage(
        { ref: 'https://cdn.discordapp.com/a.png', mime: 'image/png' },
        { maxBytes: 1024 },
      ),
    (error) => assertPlatformError(error, 'image_download_failed'),
  )
})

/* --------------------------------- Slack -------------------------------- */

const SLACK_SIGNING_SECRET = 'slack-signing-secret-123456'

function slackSecret(): BotSecret {
  return { token: 'xoxb-slack-token-123456', signingSecret: SLACK_SIGNING_SECRET }
}

function slackHeaders(body: Buffer): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = `v0=${createHmac('sha256', SLACK_SIGNING_SECRET).update(`v0:${timestamp}:${body.toString('utf8')}`).digest('hex')}`
  return {
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': signature,
    'content-type': 'application/json',
  }
}

function slackEvent(event: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({ type: 'event_callback', event_id: 'Ev-image', event }))
}

test('Slack：files 中 image/* 提取为图片，仅图片 DM 也进入 chat(direct)', async () => {
  const { fetchImpl } = makeFetch(() => jsonResponse({ ok: true, ts: '1700000000.000100' }))
  const adapter = new SlackAdapter(slackSecret(), { fetch: fetchImpl })
  const body = slackEvent({
    type: 'message',
    channel: 'D1',
    channel_type: 'im',
    user: 'U1',
    text: '',
    ts: '1700000000.000100',
    files: [
      { mimetype: 'application/pdf', url_private: 'https://files.slack.com/files-pri/T1-F0/a.pdf', size: 10 },
      {
        mimetype: 'image/png',
        url_private: 'https://files.slack.com/files-pri/T1-F1/download.png',
        name: 'download.png',
        size: 2048,
      },
    ],
  })
  const result = chatOf(await adapter.verifyInbound({ botId: 'bot-1', headers: slackHeaders(body), body }))
  assert.equal(result.text, '')
  assert.equal(result.chatTrigger, 'direct')
  assert.equal(result.image?.ref, 'https://files.slack.com/files-pri/T1-F1/download.png')
  assert.equal(result.image?.mime, 'image/png')
  assert.equal(result.image?.name, 'download.png')
  assert.equal(result.image?.size, 2048)

  const channelBody = slackEvent({
    type: 'message',
    channel: 'C1',
    channel_type: 'channel',
    user: 'U1',
    text: '',
    ts: '1700000000.000200',
    files: [{ mimetype: 'image/jpeg', url_private: 'https://files.slack.com/files-pri/T1-F2/photo.jpg', size: 1024 }],
  })
  const all = chatOf(
    await adapter.verifyInbound({
      botId: 'bot-1',
      headers: slackHeaders(channelBody),
      body: channelBody,
      chatTriggerFor: () => 'all',
    }),
  )
  assert.equal(all.chatTrigger, 'message')
  assert.equal(all.image?.mime, 'image/jpeg')
})

test('Slack loadImage：只用 files.slack.com 与 Bearer token，超限/域名错误码固定', async () => {
  const { fetchImpl, captured } = makeFetch(() => binaryResponse('SLACKIMG'))
  const adapter = new SlackAdapter(slackSecret(), { fetch: fetchImpl })
  const loaded = await adapter.loadImage(
    { ref: 'https://files.slack.com/files-pri/T1-F1/download', mime: 'image/png', size: 8 },
    { maxBytes: 1024 },
  )
  assert.equal(loaded.data.toString('utf8'), 'SLACKIMG')
  const headers = captured[0]?.init?.headers as Record<string, string>
  assert.equal(headers.authorization, `Bearer ${slackSecret().token}`)

  await assert.rejects(
    () =>
      adapter.loadImage(
        { ref: 'https://evil.example.com/files-pri/T1-F1/download', mime: 'image/png' },
        { maxBytes: 1024 },
      ),
    (error) => assertPlatformError(error, 'image_unsupported'),
  )
  await assert.rejects(
    () =>
      adapter.loadImage({ ref: 'https://files.slack.com/files-pri/T1-F1/download', mime: 'image/png' }, { maxBytes: 4 }),
    (error) => assertPlatformError(error, 'image_too_large'),
  )
})

/* ---------------------------------- QQ ---------------------------------- */

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

/** 按适配器同一规则（UTF-8 重复/截断到 32 字节）从 AppSecret 派生 Ed25519 私钥。 */
function qqPrivateKey(appSecret: string) {
  const raw = Buffer.from(appSecret, 'utf8')
  const seed = Buffer.alloc(32)
  for (let index = 0; index < seed.length; index += 1) {
    seed[index] = raw[index % raw.length]!
  }
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' })
}

test('QQ：不支持入站图片，也没有 loadImage 实现', async () => {
  const appSecret = 'qq-image-app-secret-fixed-0001'
  const adapter = new QqAdapter({ appId: '102345901' }, { token: appSecret })
  const botAdapter: BotAdapter = adapter
  assert.equal(botAdapter.loadImage, undefined)
  assert.equal(typeof botAdapter.check, 'function')

  const body = Buffer.from(
    JSON.stringify({
      op: 0,
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'c2c-image-1', content: '', author: { user_openid: 'user-openid-1' } },
    }),
  )
  const timestamp = String(Math.floor(Date.now() / 1000))
  const headers = {
    'x-signature-ed25519': sign(null, Buffer.concat([Buffer.from(timestamp), body]), qqPrivateKey(appSecret)).toString(
      'hex',
    ),
    'x-signature-timestamp': timestamp,
    'content-type': 'application/json',
  }
  const result = await adapter.verifyInbound({ botId: 'bot-1', headers, body })
  // 图片消息没有文本：按现有行为忽略，但补事件 ID 便于诊断。
  assert.deepEqual(result, {
    kind: 'ignored',
    eventId: 'c2c-image-1',
    ackBody: { opcode: 12 },
    detail: 'qq:event:empty_content',
  })
})
