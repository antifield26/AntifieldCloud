/**
 * QQ 官方 Bot 适配器回归：Ed25519 验签/op=13 回调校验、C2C/群/频道事件解析、入站图片、
 * 命令/Chat、被动回复 msg_id、长文本分段与 partial、access_token 缓存、连接自检、ignored 事件 ID、配置校验。
 * 测试不访问真实 QQ 网络，全部使用注入的 fetch 夹具与固定密钥；不打印或断言密钥内容。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { QqAdapter } from '../src/bot/adapters/qq.ts'
import { BotPlatformError } from '../src/bot/adapters/http.ts'
import type { BotHealthCheck, BotSecret, BotTargetRow, InboundVerification } from '../src/bot/types.ts'

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const VALIDATION_SECRET = 'qq-validation-app-secret-fixed-0001'
const FIXED_TIME = new Date('2026-10-22T08:00:00.000Z')

interface Captured {
  url: string
  init?: RequestInit
}

type FetchHandler = (url: string, init?: RequestInit) => Response

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
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

function bodyOf(captured: Captured): Record<string, unknown> {
  return JSON.parse(String(captured.init?.body)) as Record<string, unknown>
}

/** 按适配器同一规则（UTF-8 重复/截断到 32 字节）从 AppSecret 派生 Ed25519 密钥。 */
function deriveKeyPair(appSecret: string) {
  const raw = Buffer.from(appSecret, 'utf8')
  const seed = Buffer.alloc(32)
  for (let index = 0; index < seed.length; index += 1) {
    seed[index] = raw[index % raw.length]!
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  })
  return { privateKey, publicKey: createPublicKey(privateKey) }
}

function signHeaders(privateKey: ReturnType<typeof deriveKeyPair>['privateKey'], timestamp: string, body: Buffer) {
  return {
    'x-signature-ed25519': sign(
      null,
      Buffer.concat([Buffer.from(timestamp, 'utf8'), body]),
      privateKey,
    ).toString('hex'),
    'x-signature-timestamp': timestamp,
    'content-type': 'application/json',
  }
}

function timestampAt(date: Date): string {
  return String(Math.floor(date.getTime() / 1000))
}

/** 构造已签名的事件回调并交给适配器验签解析。 */
async function verifyEvent(
  adapter: QqAdapter,
  privateKey: ReturnType<typeof deriveKeyPair>['privateKey'],
  eventType: string,
  d: Record<string, unknown>,
  timestamp = timestampAt(FIXED_TIME),
  op = 0,
): Promise<InboundVerification> {
  const body = Buffer.from(JSON.stringify({ op, t: eventType, d }))
  return adapter.verifyInbound({
    botId: 'bot-1',
    headers: signHeaders(privateKey, timestamp, body),
    body,
  })
}

function credentials(tag: string): { appId: string; secret: BotSecret } {
  return {
    appId: `102345${tag.padStart(3, '0')}`,
    secret: { token: `qq-app-secret-${tag}-${'z'.repeat(16)}` },
  }
}

function targetRow(kind: 'channel' | 'user' | 'group', externalId: string): BotTargetRow {
  return {
    id: `target-${kind}`,
    bot_id: 'bot-1',
    external_id: externalId,
    label: kind,
    kind,
    allow_commands: 1,
    allow_notifications: 1,
    allow_chat: 1,
    quiet_start_minute: null,
    quiet_end_minute: null,
    created_at: '2026-01-01T00:00:00.000Z',
  }
}

function chatOf(result: InboundVerification): Extract<InboundVerification, { kind: 'chat' }> {
  assert.equal(result.kind, 'chat')
  if (result.kind !== 'chat') throw new Error('expected chat')
  return result
}

const IMAGE_URL = 'https://gchat.qpic.cn/gchatpic_new/0/0-0-abc/0?term=2'

/* --------------------------- 回调地址校验与验签 --------------------------- */

test('QQ：固定 AppSecret 生成 Ed25519 密钥，op=13 校验签名可被同密钥验签', async () => {
  const { publicKey } = deriveKeyPair(VALIDATION_SECRET)
  const adapter = new QqAdapter({ appId: '102345001' }, { token: VALIDATION_SECRET })
  const body = Buffer.from(
    JSON.stringify({ op: 13, d: { plain_token: 'plain-token-abc', event_ts: '1725442341' } }),
  )
  const result = await adapter.verifyInbound({ botId: 'bot-1', headers: {}, body })
  assert.equal(result.kind, 'challenge')
  if (result.kind !== 'challenge') throw new Error('expected challenge')
  const challenge = result.body as { plain_token: string; signature: string }
  assert.equal(challenge.plain_token, 'plain-token-abc')
  assert.match(challenge.signature, /^[0-9a-f]{128}$/)
  assert.equal(
    verify(
      null,
      Buffer.from('1725442341plain-token-abc', 'utf8'),
      publicKey,
      Buffer.from(challenge.signature, 'hex'),
    ),
    true,
  )
  assert.equal(
    verify(
      null,
      Buffer.from('different-payload', 'utf8'),
      publicKey,
      Buffer.from(challenge.signature, 'hex'),
    ),
    false,
  )

  // event_ts 为数字时也按字符串拼接签名，且历史时间戳不影响 op=13 校验。
  const numericBody = Buffer.from(
    JSON.stringify({ op: 13, d: { plain_token: 'plain-token-num', event_ts: 1725442341 } }),
  )
  const numeric = await adapter.verifyInbound({ botId: 'bot-1', headers: {}, body: numericBody })
  assert.equal(numeric.kind, 'challenge')
  if (numeric.kind !== 'challenge') throw new Error('expected challenge')
  const numericChallenge = numeric.body as { plain_token: string; signature: string }
  assert.equal(
    verify(
      null,
      Buffer.from('1725442341plain-token-num', 'utf8'),
      publicKey,
      Buffer.from(numericChallenge.signature, 'hex'),
    ),
    true,
  )
})

test('QQ：C2C/群/频道命令解析出字段、确认体与回退事件 ID', async () => {
  const appSecret = 'qq-events-app-secret-fixed-0002'
  const { privateKey } = deriveKeyPair(appSecret)
  const adapter = new QqAdapter({ appId: '102345002' }, { token: appSecret }, { now: () => FIXED_TIME })

  const c2c = await verifyEvent(adapter, privateKey, 'C2C_MESSAGE_CREATE', {
    id: 'c2c-msg-1',
    content: '  /status  ',
    timestamp: '1725442341',
    author: { user_openid: 'user-openid-1' },
  })
  assert.equal(c2c.kind, 'command')
  if (c2c.kind !== 'command') throw new Error('expected command')
  assert.equal(c2c.eventId, 'c2c-msg-1')
  assert.equal(c2c.targetExternalId, 'user-openid-1')
  assert.equal(c2c.targetKind, 'user')
  assert.equal(c2c.userId, 'user-openid-1')
  assert.equal(c2c.text, '/status')
  assert.equal(c2c.isDirect, true)
  assert.equal(c2c.userName, null)
  assert.deepEqual(c2c.ackBody, { opcode: 12 })

  const group = await verifyEvent(adapter, privateKey, 'GROUP_AT_MESSAGE_CREATE', {
    id: 'group-msg-1',
    content: '<@!102345002> /files 报告',
    group_openid: 'group-openid-1',
    author: { member_openid: 'member-openid-1' },
  })
  assert.equal(group.kind, 'command')
  if (group.kind !== 'command') throw new Error('expected command')
  assert.equal(group.eventId, 'group-msg-1')
  assert.equal(group.targetExternalId, 'group-openid-1')
  assert.equal(group.targetKind, 'group')
  assert.equal(group.userId, 'member-openid-1')
  assert.equal(group.text, '/files 报告')
  assert.equal(group.isDirect, false)
  assert.deepEqual(group.ackBody, { opcode: 12 })

  const channel = await verifyEvent(adapter, privateKey, 'AT_MESSAGE_CREATE', {
    id: 'channel-msg-1',
    content: '/mc',
    channel_id: 'channel-openid-1',
    author: { id: 'guild-user-1', username: '测试用户' },
  })
  assert.equal(channel.kind, 'command')
  if (channel.kind !== 'command') throw new Error('expected command')
  assert.equal(channel.eventId, 'channel-msg-1')
  assert.equal(channel.targetExternalId, 'channel-openid-1')
  assert.equal(channel.targetKind, 'channel')
  assert.equal(channel.userId, 'guild-user-1')
  assert.equal(channel.userName, '测试用户')
  assert.equal(channel.isDirect, false)

  // 非斜杠文本在 C2C 中进入 chat(direct)，仍需返回 opcode 12 确认。
  const chat = chatOf(
    await verifyEvent(adapter, privateKey, 'C2C_MESSAGE_CREATE', {
      id: 'c2c-msg-2',
      content: ' 你好 ',
      author: { user_openid: 'user-openid-1' },
    }),
  )
  assert.equal(chat.eventId, 'c2c-msg-2')
  assert.equal(chat.targetExternalId, 'user-openid-1')
  assert.equal(chat.targetKind, 'user')
  assert.equal(chat.text, '你好')
  assert.equal(chat.isDirect, true)
  assert.equal(chat.chatTrigger, 'direct')
  assert.deepEqual(chat.ackBody, { opcode: 12 })

  // 缺少 d.id 时使用稳定回退事件 ID。
  const fallback = await verifyEvent(adapter, privateKey, 'C2C_MESSAGE_CREATE', {
    content: '/help',
    timestamp: '1725000000',
    author: { user_openid: 'user-openid-2' },
  })
  assert.equal(fallback.kind, 'command')
  if (fallback.kind !== 'command') throw new Error('expected command')
  assert.equal(fallback.eventId, 'qq:user-openid-2:1725000000')
  assert.equal(fallback.text, '/help')
})

test('QQ：篡改签名、过期时间戳与异常载荷均被拒绝', async () => {
  const appSecret = 'qq-reject-app-secret-fixed-0003'
  const { privateKey } = deriveKeyPair(appSecret)
  const adapter = new QqAdapter({ appId: '102345003' }, { token: appSecret }, { now: () => FIXED_TIME })
  const timestamp = timestampAt(FIXED_TIME)
  const body = Buffer.from(
    JSON.stringify({
      op: 0,
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'c2c-msg-3', content: '/status', author: { user_openid: 'user-openid-3' } },
    }),
  )
  const headers = signHeaders(privateKey, timestamp, body)

  const tampered = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: { ...headers, 'x-signature-ed25519': '00'.repeat(64) },
    body,
  })
  assert.deepEqual(tampered, { kind: 'rejected', status: 401, code: 'invalid_signature' })

  const missing = await adapter.verifyInbound({ botId: 'bot-1', headers: {}, body })
  assert.deepEqual(missing, { kind: 'rejected', status: 401, code: 'invalid_signature' })

  const staleTimestamp = String(Math.floor(FIXED_TIME.getTime() / 1000) - 301)
  const stale = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: signHeaders(privateKey, staleTimestamp, body),
    body,
  })
  assert.deepEqual(stale, { kind: 'rejected', status: 401, code: 'stale_signature' })

  const malformed = await adapter.verifyInbound({ botId: 'bot-1', headers, body: Buffer.from('not-json') })
  assert.deepEqual(malformed, { kind: 'rejected', status: 400, code: 'invalid_payload' })

  const missingFieldsBody = Buffer.from(
    JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'x', content: '/status' } }),
  )
  const missingFields = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: signHeaders(privateKey, timestamp, missingFieldsBody),
    body: missingFieldsBody,
  })
  assert.deepEqual(missingFields, { kind: 'rejected', status: 400, code: 'missing_fields' })

  const incompleteValidation = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: {},
    body: Buffer.from(JSON.stringify({ op: 13, d: { plain_token: 'only-token' } })),
  })
  assert.deepEqual(incompleteValidation, { kind: 'rejected', status: 400, code: 'invalid_payload' })
})

/* ----------------------------- 入站图片解析 ------------------------------ */

test('QQ：C2C 仅图片消息也产出 chat(direct)，图片元数据取首个 image/* 附件', async () => {
  const appSecret = 'qq-image-app-secret-fixed-0011'
  const { privateKey } = deriveKeyPair(appSecret)
  const adapter = new QqAdapter({ appId: '102345011' }, { token: appSecret }, { now: () => FIXED_TIME })

  const result = chatOf(
    await verifyEvent(adapter, privateKey, 'C2C_MESSAGE_CREATE', {
      id: 'c2c-image-1',
      content: '',
      timestamp: '1725442341',
      author: { user_openid: 'user-openid-image' },
      attachments: [
        { content_type: 'text/plain', filename: 'a.txt', size: 10, url: 'https://gchat.qpic.cn/a.txt' },
        { content_type: 'image/png', filename: 'photo.png', size: 2048, url: IMAGE_URL },
        { content_type: 'image/jpeg', filename: 'other.jpg', size: 4096, url: 'https://gchat.qpic.cn/other.jpg' },
      ],
    }),
  )
  assert.equal(result.text, '')
  assert.equal(result.isDirect, true)
  assert.equal(result.chatTrigger, 'direct')
  assert.equal(result.targetKind, 'user')
  assert.deepEqual(result.image, {
    ref: IMAGE_URL,
    mime: 'image/png',
    name: 'photo.png',
    size: 2048,
  })
  assert.deepEqual(result.ackBody, { opcode: 12 })
})

test('QQ：群/频道图片消息进入 chat(mention)，文本与图片可同时携带', async () => {
  const appSecret = 'qq-image-app-secret-fixed-0012'
  const { privateKey } = deriveKeyPair(appSecret)
  const adapter = new QqAdapter({ appId: '102345012' }, { token: appSecret }, { now: () => FIXED_TIME })

  const groupImageOnly = chatOf(
    await verifyEvent(adapter, privateKey, 'GROUP_AT_MESSAGE_CREATE', {
      id: 'group-image-1',
      content: '<@!102345012>',
      group_openid: 'group-openid-image',
      author: { member_openid: 'member-openid-image' },
      attachments: [{ content_type: 'image/jpeg', filename: 'pic.jpg', size: 1024, url: IMAGE_URL }],
    }),
  )
  assert.equal(groupImageOnly.text, '')
  assert.equal(groupImageOnly.isDirect, false)
  assert.equal(groupImageOnly.chatTrigger, 'mention')
  assert.equal(groupImageOnly.targetKind, 'group')
  assert.equal(groupImageOnly.image?.mime, 'image/jpeg')
  assert.equal(groupImageOnly.image?.name, 'pic.jpg')
  assert.equal(groupImageOnly.image?.size, 1024)

  const channelWithText = chatOf(
    await verifyEvent(adapter, privateKey, 'AT_MESSAGE_CREATE', {
      id: 'channel-image-1',
      content: '@测试机器人 看看这张图',
      channel_id: 'channel-openid-image',
      author: { id: 'guild-user-image', username: '图片用户' },
      attachments: [{ content_type: 'image/webp', url: IMAGE_URL }],
    }),
  )
  assert.equal(channelWithText.text, '看看这张图')
  assert.equal(channelWithText.targetKind, 'channel')
  assert.equal(channelWithText.chatTrigger, 'mention')
  assert.equal(channelWithText.userName, '图片用户')
  // 附件缺少 filename/size 时只保留必要字段。
  assert.deepEqual(channelWithText.image, { ref: IMAGE_URL, mime: 'image/webp' })

  // QQ 文档存在协议相对 URL（//host/path）：解析时补成 https，仍受下载白名单约束。
  const relativeUrl = chatOf(
    await verifyEvent(adapter, privateKey, 'C2C_MESSAGE_CREATE', {
      id: 'c2c-image-relative',
      content: '',
      author: { user_openid: 'user-openid-image' },
      attachments: [{ content_type: 'image/png', url: '//gchat.qpic.cn/x.png' }],
    }),
  )
  assert.equal(relativeUrl.image?.ref, 'https://gchat.qpic.cn/x.png')

  // 命令优先级高于图片：/status 仍按命令处理，不携带 image。
  const command = await verifyEvent(adapter, privateKey, 'C2C_MESSAGE_CREATE', {
    id: 'c2c-image-command',
    content: '/status',
    author: { user_openid: 'user-openid-image' },
    attachments: [{ content_type: 'image/png', url: IMAGE_URL }],
  })
  assert.equal(command.kind, 'command')
  assert.equal('image' in command, false)
})

test('QQ：无图片来源（非图片附件/缺字段/空正文）按 ignored 处理并带事件 ID', async () => {
  const appSecret = 'qq-image-app-secret-fixed-0013'
  const { privateKey } = deriveKeyPair(appSecret)
  const adapter = new QqAdapter({ appId: '102345013' }, { token: appSecret }, { now: () => FIXED_TIME })

  const pdfOnly = await verifyEvent(adapter, privateKey, 'C2C_MESSAGE_CREATE', {
    id: 'c2c-pdf-1',
    content: '',
    author: { user_openid: 'user-openid-pdf' },
    attachments: [{ content_type: 'application/pdf', filename: 'a.pdf', size: 100, url: 'https://gchat.qpic.cn/a.pdf' }],
  })
  assert.deepEqual(pdfOnly, {
    kind: 'ignored',
    eventId: 'c2c-pdf-1',
    ackBody: { opcode: 12 },
    detail: 'qq:event:empty_content',
  })

  const brokenAttachments = await verifyEvent(adapter, privateKey, 'C2C_MESSAGE_CREATE', {
    id: 'c2c-broken-1',
    content: '',
    author: { user_openid: 'user-openid-pdf' },
    attachments: [null, 'oops', { content_type: 'image/png' }, { content_type: 'image/jpeg', url: '' }],
  })
  assert.equal(brokenAttachments.kind, 'ignored')

  const empty = await verifyEvent(adapter, privateKey, 'GROUP_AT_MESSAGE_CREATE', {
    id: 'group-empty-1',
    content: '<@!102345013>',
    group_openid: 'group-openid-empty',
    author: { member_openid: 'member-openid-empty' },
  })
  assert.equal(empty.kind, 'ignored')
  if (empty.kind !== 'ignored') throw new Error('expected ignored')
  assert.equal(empty.eventId, 'group-empty-1')
  assert.deepEqual(empty.ackBody, { opcode: 12 })
})

/* ------------------------- access_token 与文本发送 ------------------------ */

test('QQ：换取 access_token、C2C 被动回复与群/频道主动发送（含长文本分段）', async () => {
  const { appId, secret } = credentials('004')
  const { privateKey } = deriveKeyPair(secret.token)
  let tokenCalls = 0
  let channelCalls = 0
  const { fetchImpl, captured } = makeFetch((url) => {
    if (url === TOKEN_URL) {
      tokenCalls += 1
      return jsonResponse({ access_token: 'qq-access-token-1', expires_in: 7200 })
    }
    if (url.includes('/v2/users/')) return jsonResponse({ id: 'out-c2c-1' })
    if (url.includes('/v2/groups/')) return jsonResponse({ id: 'out-group-1' })
    if (url.includes('/channels/')) {
      channelCalls += 1
      return jsonResponse({ message_id: `out-channel-${channelCalls}` })
    }
    return jsonResponse({ message: 'unexpected url' }, 500)
  })
  const adapter = new QqAdapter({ appId }, secret, { fetch: fetchImpl, now: () => FIXED_TIME })

  const c2cCommand = await verifyEvent(adapter, privateKey, 'C2C_MESSAGE_CREATE', {
    id: 'c2c-msg-reply',
    content: '/status',
    author: { user_openid: 'user-openid-4' },
  })
  assert.equal(c2cCommand.kind, 'command')
  if (c2cCommand.kind !== 'command') throw new Error('expected command')
  await c2cCommand.reply('已收到')

  const tokenRequest = captured.find((item) => item.url === TOKEN_URL)
  assert.ok(tokenRequest)
  assert.equal(tokenRequest.init?.method, 'POST')
  assert.ok(!tokenRequest.url.includes(secret.token))
  const tokenPayload = bodyOf(tokenRequest)
  assert.equal(tokenPayload.appId, appId)
  assert.equal(tokenPayload.clientSecret, secret.token)

  const replyRequest = captured.find((item) => item.url.includes('/messages'))
  assert.ok(replyRequest)
  assert.equal(replyRequest.url, 'https://api.sgroup.qq.com/v2/users/user-openid-4/messages')
  const replyHeaders = replyRequest.init?.headers as Record<string, string>
  assert.equal(replyHeaders.authorization, 'QQBot qq-access-token-1')
  const replyPayload = bodyOf(replyRequest)
  assert.equal(replyPayload.content, '已收到')
  assert.equal(replyPayload.msg_type, 0)
  assert.equal(replyPayload.msg_id, 'c2c-msg-reply')
  assert.equal(typeof replyPayload.msg_seq, 'number')
  assert.ok(Number(replyPayload.msg_seq) >= 1 && Number(replyPayload.msg_seq) <= 10_000)

  const groupResult = await adapter.send(targetRow('group', 'group-openid-4'), { text: '群通知' })
  assert.deepEqual(groupResult, { externalId: 'out-group-1' })
  const groupRequest = captured.at(-1)!
  assert.equal(groupRequest.url, 'https://api.sgroup.qq.com/v2/groups/group-openid-4/messages')
  assert.equal((groupRequest.init?.headers as Record<string, string>).authorization, 'QQBot qq-access-token-1')
  const groupPayload = bodyOf(groupRequest)
  assert.equal(groupPayload.content, '群通知')
  assert.equal(groupPayload.msg_type, 0)
  assert.equal(groupPayload.msg_id, undefined)

  // 长文本按 2000 上限分段，返回按顺序拼接的 externalIds。
  const channelResult = await adapter.send(targetRow('channel', 'channel-4'), { text: '长'.repeat(2500) })
  assert.deepEqual(channelResult, {
    externalId: 'out-channel-1',
    externalIds: ['out-channel-1', 'out-channel-2'],
  })
  const channelRequests = captured.filter(
    (item) => item.url === 'https://api.sgroup.qq.com/channels/channel-4/messages',
  )
  assert.equal(channelRequests.length, 2)
  const channelPayloads = channelRequests.map(bodyOf)
  assert.equal(String(channelPayloads[0]?.content).length, 2000)
  assert.match(String(channelPayloads[1]?.content), /^（续 2\/2）/)
  for (const payload of channelPayloads) {
    assert.ok(String(payload.content).length <= 2000)
    assert.equal(payload.msg_id, undefined)
  }

  // access_token 按 AppID + AppSecret 缓存，多次发送只换取一次。
  assert.equal(tokenCalls, 1)
  assert.ok(captured.every((item) => !item.url.includes(secret.token)))
})

test('QQ：长回复分段被动回复，每段都带 msg_id 且按序发送', async () => {
  const { appId, secret } = credentials('014')
  const { privateKey } = deriveKeyPair(secret.token)
  const { fetchImpl, captured } = makeFetch((url) => {
    if (url === TOKEN_URL) return jsonResponse({ access_token: 'qq-token-long', expires_in: 7200 })
    return jsonResponse({ id: 'out-long-1' })
  })
  const adapter = new QqAdapter({ appId }, secret, { fetch: fetchImpl, now: () => FIXED_TIME })

  const chat = chatOf(
    await verifyEvent(adapter, privateKey, 'C2C_MESSAGE_CREATE', {
      id: 'c2c-long-reply',
      content: '继续',
      author: { user_openid: 'user-openid-long' },
    }),
  )
  await chat.reply('文'.repeat(2500))

  const requests = captured.filter((item) => item.url.includes('/messages'))
  assert.equal(requests.length, 2)
  for (const request of requests) {
    const payload = bodyOf(request)
    assert.equal(payload.msg_id, 'c2c-long-reply')
    assert.equal(typeof payload.msg_seq, 'number')
    assert.ok(String(payload.content).length <= 2000)
  }
  assert.match(String(bodyOf(requests[1]!).content), /^（续 2\/2）/)
})

test('QQ：分段发送中途失败带已发送消息 ID 与 botPartialKind=text，首段失败不带 ID', async () => {
  const { appId, secret } = credentials('015')
  let messageCalls = 0
  const { fetchImpl } = makeFetch((url) => {
    if (url === TOKEN_URL) return jsonResponse({ access_token: 'qq-token-partial', expires_in: 7200 })
    messageCalls += 1
    if (messageCalls === 2) return jsonResponse({ message: 'server error' }, 500)
    return jsonResponse({ id: 'out-partial-1' })
  })
  const adapter = new QqAdapter({ appId }, secret, { fetch: fetchImpl })
  await assert.rejects(
    () => adapter.send(targetRow('group', 'group-openid-partial'), { text: '长'.repeat(2500) }),
    (error: unknown) => {
      assert.ok(error instanceof BotPlatformError)
      assert.deepEqual((error as unknown as { sentExternalIds?: string[] }).sentExternalIds, ['out-partial-1'])
      assert.equal((error as unknown as { botPartialKind?: string }).botPartialKind, 'text')
      assert.ok(!error.message.includes(secret.token))
      return true
    },
  )

  const failing = makeFetch((url) => {
    if (url === TOKEN_URL) return jsonResponse({ access_token: 'qq-token-partial-2', expires_in: 7200 })
    return jsonResponse({ message: 'server error' }, 500)
  })
  const strict = new QqAdapter({ appId }, secret, { fetch: failing.fetchImpl })
  await assert.rejects(
    () => strict.send(targetRow('group', 'group-openid-partial'), { text: '短文本' }),
    (error: unknown) => {
      assert.ok(error instanceof BotPlatformError)
      assert.equal((error as unknown as { sentExternalIds?: string[] }).sentExternalIds, undefined)
      assert.equal((error as unknown as { botPartialKind?: string }).botPartialKind, 'text')
      return true
    },
  )
})

test('QQ：access_token 换取失败不泄漏 AppSecret，且凭证缺失直接失败', async () => {
  const { appId, secret } = credentials('005')
  const { fetchImpl, captured } = makeFetch(() =>
    jsonResponse({ message: `invalid clientSecret ${secret.token}` }, 401),
  )
  const adapter = new QqAdapter({ appId }, secret, { fetch: fetchImpl })
  await assert.rejects(
    () => adapter.send(targetRow('user', 'user-openid-5'), { text: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof BotPlatformError)
      assert.equal(error.status, 401)
      assert.equal(error.code, 'qq_access_token_failed')
      assert.ok(!error.message.includes(secret.token))
      return true
    },
  )
  assert.ok(captured.every((item) => !item.url.includes(secret.token)))

  const missing = new QqAdapter({ appId: '' }, { token: '' }, { fetch: fetchImpl })
  await assert.rejects(
    () => missing.send(targetRow('group', 'group-openid-5'), { text: 'x' }),
    (error: unknown) => error instanceof BotPlatformError && error.code === 'qq_credentials_missing',
  )
})

test('QQ：access_token 提前 60 秒过期并重新换取', async () => {
  const { appId, secret } = credentials('006')
  let clock = new Date('2026-10-21T00:00:00.000Z')
  let tokenCalls = 0
  const { fetchImpl, captured } = makeFetch((url) => {
    if (url === TOKEN_URL) {
      tokenCalls += 1
      return jsonResponse({ access_token: `qq-token-${tokenCalls}`, expires_in: 120 })
    }
    return jsonResponse({ id: `msg-${tokenCalls}` })
  })
  const adapter = new QqAdapter({ appId }, secret, { fetch: fetchImpl, now: () => clock })
  const target = targetRow('group', 'group-openid-6')

  await adapter.send(target, { text: '第一次' })
  await adapter.send(target, { text: '第二次' })
  assert.equal(tokenCalls, 1)

  clock = new Date(clock.getTime() + 61_000)
  await adapter.send(target, { text: '第三次' })
  assert.equal(tokenCalls, 2)
  const last = captured.at(-1)!
  assert.equal((last.init?.headers as Record<string, string>).authorization, 'QQBot qq-token-2')
})

test('QQ：群/频道非命令文本进入 chat(mention)，剥离 mention 前缀并确认', async () => {
  const appSecret = 'qq-chat-app-secret-fixed-0009'
  const { privateKey } = deriveKeyPair(appSecret)
  const { fetchImpl, captured } = makeFetch((url) => {
    if (url === TOKEN_URL) return jsonResponse({ access_token: 'qq-chat-token', expires_in: 7200 })
    if (url.includes('/v2/groups/')) return jsonResponse({ id: 'group-chat-out-1' })
    if (url.includes('/channels/')) return jsonResponse({ message_id: 'channel-chat-out-1' })
    return jsonResponse({ message: 'unexpected url' }, 500)
  })
  const adapter = new QqAdapter({ appId: '102345009' }, { token: appSecret }, { fetch: fetchImpl, now: () => FIXED_TIME })

  const group = chatOf(
    await verifyEvent(adapter, privateKey, 'GROUP_AT_MESSAGE_CREATE', {
      id: 'group-chat-msg-1',
      content: '<@!102345009> 你好',
      group_openid: 'group-openid-9',
      author: { member_openid: 'member-openid-9' },
    }),
  )
  assert.equal(group.targetExternalId, 'group-openid-9')
  assert.equal(group.targetKind, 'group')
  assert.equal(group.text, '你好')
  assert.equal(group.isDirect, false)
  assert.equal(group.chatTrigger, 'mention')
  assert.deepEqual(group.ackBody, { opcode: 12 })
  await group.reply('收到')
  const groupReply = captured.find((item) => item.url.includes('/v2/groups/'))
  assert.ok(groupReply)
  assert.equal(bodyOf(groupReply).content, '收到')
  assert.equal(bodyOf(groupReply).msg_id, 'group-chat-msg-1')

  const channel = chatOf(
    await verifyEvent(adapter, privateKey, 'AT_MESSAGE_CREATE', {
      id: 'channel-chat-msg-1',
      content: '@测试机器人 状态',
      channel_id: 'channel-openid-9',
      author: { id: 'guild-user-9', username: '测试用户' },
    }),
  )
  assert.equal(channel.targetKind, 'channel')
  assert.equal(channel.text, '状态')
  assert.equal(channel.chatTrigger, 'mention')
  assert.equal(channel.userName, '测试用户')
})

/* ------------------------------ 连接自检 -------------------------------- */

test('QQ：check 换取 access_token 成功只返回固定文案，失败返回固定错误码', async () => {
  const appSecret = 'qq-health-app-secret-fixed-0016'
  const okFetch = makeFetch(() => jsonResponse({ access_token: 'qq-health-token-secret', expires_in: 7200 }))
  const okResult: BotHealthCheck = await new QqAdapter(
    { appId: '102345016' },
    { token: appSecret },
    { fetch: okFetch.fetchImpl },
  ).check({ botId: 'bot-1', appOrigin: 'https://app.example.com' })
  assert.equal(okResult.ok, true)
  assert.deepEqual(okResult.items, [{ name: 'access_token', ok: true, detail: 'access_token 已获取' }])
  assert.equal(okFetch.captured[0]?.url, TOKEN_URL)
  assert.ok(!JSON.stringify(okResult).includes('qq-health-token-secret'))
  assert.ok(!JSON.stringify(okResult).includes(appSecret))

  const unauthorizedFetch = makeFetch(() => jsonResponse({ message: 'invalid secret' }, 401))
  const unauthorized = await new QqAdapter(
    { appId: '102345017' },
    { token: 'qq-health-app-secret-fixed-0017' },
    { fetch: unauthorizedFetch.fetchImpl },
  ).check({ botId: 'bot-1', appOrigin: 'https://app.example.com' })
  assert.equal(unauthorized.ok, false)
  assert.equal(unauthorized.items[0]?.detail, 'qq_access_token_failed')

  const offlineFetch = makeFetch(() => {
    throw new Error('connect ETIMEDOUT')
  })
  const offline = await new QqAdapter(
    { appId: '102345018' },
    { token: 'qq-health-app-secret-fixed-0018' },
    { fetch: offlineFetch.fetchImpl },
  ).check({ botId: 'bot-1', appOrigin: 'https://app.example.com' })
  assert.equal(offline.ok, false)
  assert.equal(offline.items[0]?.detail, 'network_error')

  const missing = await new QqAdapter({}, { token: '' }, { fetch: unauthorizedFetch.fetchImpl }).check({
    botId: 'bot-1',
    appOrigin: 'https://app.example.com',
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.items[0]?.detail, 'qq_credentials_missing')
})

/* --------------------------- ignored 事件 ID ---------------------------- */

test('QQ：ignored 事件尽量补平台事件 ID（消息 id 或 <事件类型>:<时间戳>）', async () => {
  const appSecret = 'qq-ignored-app-secret-fixed-0010'
  const { privateKey } = deriveKeyPair(appSecret)
  const adapter = new QqAdapter({ appId: '102345010' }, { token: appSecret }, { now: () => FIXED_TIME })

  // 未知事件类型 + 消息 id。
  const unknownWithId = await verifyEvent(adapter, privateKey, 'MESSAGE_CREATE', { id: 'unknown-1' })
  assert.deepEqual(unknownWithId, {
    kind: 'ignored',
    eventId: 'unknown-1',
    ackBody: { opcode: 12 },
    detail: 'qq:event:MESSAGE_CREATE',
  })

  // 未知事件类型 + 只有时间戳：用 <事件类型>:<时间戳> 作为诊断 ID。
  const unknownWithTs = await verifyEvent(adapter, privateKey, 'MESSAGE_REACTION_CREATE', { timestamp: '1725000000' })
  assert.deepEqual(unknownWithTs, {
    kind: 'ignored',
    eventId: 'MESSAGE_REACTION_CREATE:1725000000',
    ackBody: { opcode: 12 },
    detail: 'qq:event:MESSAGE_REACTION_CREATE',
  })

  // 空 d 与未知操作码不携带事件 ID。
  const emptyD = await verifyEvent(adapter, privateKey, 'MESSAGE_CREATE', {})
  assert.deepEqual(emptyD, {
    kind: 'ignored',
    ackBody: { opcode: 12 },
    detail: 'qq:event:MESSAGE_CREATE',
  })
  const otherOp = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: {},
    body: Buffer.from(JSON.stringify({ op: 12 })),
  })
  assert.deepEqual(otherOp, { kind: 'ignored' })
})

/* ------------------------------ 配置校验 -------------------------------- */

test('QQ：validate 与 setup 输出 QQ 平台配置要求', () => {
  const adapter = new QqAdapter({}, { token: '' })
  const invalid = adapter.validate({ appId: 'abc' }, { token: '' })
  assert.ok(invalid.includes('qq_app_id_invalid'))
  assert.ok(invalid.includes('qq_secret_invalid'))

  const tooShort = adapter.validate({ appId: '1234' }, { token: '123456789012345' })
  assert.deepEqual(tooShort, ['qq_app_id_invalid', 'qq_secret_invalid'])

  const tooLong = adapter.validate({ appId: '1'.repeat(33) }, { token: 'x'.repeat(16) })
  assert.deepEqual(tooLong, ['qq_app_id_invalid'])

  assert.deepEqual(adapter.validate({ appId: '102345007' }, { token: 'x'.repeat(16) }), [])

  const setup = adapter.setup('bot-1', 'https://app.example.com')
  assert.equal(setup.webhookUrl, 'https://app.example.com/api/bot/webhook/bot-1')
  assert.ok(setup.steps.some((step) => step.includes('AppSecret')))
  assert.ok(setup.steps.some((step) => step.includes('op=13')))
  assert.ok(setup.steps.some((step) => step.includes('图片理解')))
  assert.ok(setup.steps.every((step) => !step.includes('x'.repeat(16))))
  assert.ok(setup.steps.every((step) => !/Telegram|Discord|Slack/i.test(step)))
})
