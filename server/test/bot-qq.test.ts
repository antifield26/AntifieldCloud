/**
 * QQ 官方 Bot 适配器回归：Ed25519 验签/回调地址校验、C2C/群/频道事件解析、access_token 缓存与文本发送。
 * 测试不访问真实 QQ 网络，全部使用注入的 fetch 夹具与固定密钥。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { QqAdapter } from '../src/bot/adapters/qq.ts'
import { BotPlatformError } from '../src/bot/adapters/http.ts'
import type { BotSecret, BotTargetRow } from '../src/bot/types.ts'

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const VALIDATION_SECRET = 'qq-validation-app-secret-fixed-0001'

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

test('QQ：C2C/群事件签名解析出命令、字段与确认体', async () => {
  const appSecret = 'qq-events-app-secret-fixed-0002'
  const { privateKey } = deriveKeyPair(appSecret)
  const now = new Date('2026-10-21T08:00:00.000Z')
  const timestamp = String(Math.floor(now.getTime() / 1000))
  const adapter = new QqAdapter({ appId: '102345002' }, { token: appSecret }, { now: () => now })

  const c2cBody = Buffer.from(
    JSON.stringify({
      op: 0,
      t: 'C2C_MESSAGE_CREATE',
      d: {
        id: 'c2c-msg-1',
        content: '  /status  ',
        timestamp: '1725442341',
        author: { user_openid: 'user-openid-1' },
      },
    }),
  )
  const c2c = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: signHeaders(privateKey, timestamp, c2cBody),
    body: c2cBody,
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

  const groupBody = Buffer.from(
    JSON.stringify({
      op: 0,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'group-msg-1',
        content: '/files 报告',
        group_openid: 'group-openid-1',
        author: { member_openid: 'member-openid-1' },
      },
    }),
  )
  const group = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: signHeaders(privateKey, timestamp, groupBody),
    body: groupBody,
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

  const channelBody = Buffer.from(
    JSON.stringify({
      op: 0,
      t: 'AT_MESSAGE_CREATE',
      d: {
        id: 'channel-msg-1',
        content: '/mc',
        channel_id: 'channel-openid-1',
        author: { id: 'guild-user-1', username: '测试用户' },
      },
    }),
  )
  const channel = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: {
      'X-Signature-Ed25519': signHeaders(privateKey, timestamp, channelBody)['x-signature-ed25519'],
      'X-Signature-Timestamp': timestamp,
      'Content-Type': 'application/json',
    },
    body: channelBody,
  })
  assert.equal(channel.kind, 'command')
  if (channel.kind !== 'command') throw new Error('expected command')
  assert.equal(channel.eventId, 'channel-msg-1')
  assert.equal(channel.targetExternalId, 'channel-openid-1')
  assert.equal(channel.targetKind, 'channel')
  assert.equal(channel.userId, 'guild-user-1')
  assert.equal(channel.userName, '测试用户')
  assert.equal(channel.isDirect, false)
  assert.deepEqual(channel.ackBody, { opcode: 12 })

  // 非斜杠文本在 C2C 中进入 chat(direct)，仍需返回 opcode 12 确认。
  const plainBody = Buffer.from(
    JSON.stringify({
      op: 0,
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'c2c-msg-2', content: ' 你好 ', author: { user_openid: 'user-openid-1' } },
    }),
  )
  const chat = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: signHeaders(privateKey, timestamp, plainBody),
    body: plainBody,
  })
  assert.equal(chat.kind, 'chat')
  if (chat.kind !== 'chat') throw new Error('expected chat')
  assert.equal(chat.eventId, 'c2c-msg-2')
  assert.equal(chat.targetExternalId, 'user-openid-1')
  assert.equal(chat.targetKind, 'user')
  assert.equal(chat.text, '你好')
  assert.equal(chat.isDirect, true)
  assert.equal(chat.chatTrigger, 'direct')
  assert.deepEqual(chat.ackBody, { opcode: 12 })

  // 缺少 d.id 时使用稳定回退事件 ID。
  const fallbackBody = Buffer.from(
    JSON.stringify({
      op: 0,
      t: 'C2C_MESSAGE_CREATE',
      d: {
        content: '/help',
        timestamp: '1725000000',
        author: { user_openid: 'user-openid-2' },
      },
    }),
  )
  const fallback = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: signHeaders(privateKey, timestamp, fallbackBody),
    body: fallbackBody,
  })
  assert.equal(fallback.kind, 'command')
  if (fallback.kind !== 'command') throw new Error('expected command')
  assert.equal(fallback.eventId, 'qq:user-openid-2:1725000000')
  assert.equal(fallback.text, '/help')
})

test('QQ：篡改签名、过期时间戳与异常载荷均被拒绝', async () => {
  const appSecret = 'qq-reject-app-secret-fixed-0003'
  const { privateKey } = deriveKeyPair(appSecret)
  const now = new Date('2026-10-21T08:00:00.000Z')
  const timestamp = String(Math.floor(now.getTime() / 1000))
  const adapter = new QqAdapter({ appId: '102345003' }, { token: appSecret }, { now: () => now })
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

  const staleTimestamp = String(Math.floor(now.getTime() / 1000) - 301)
  const stale = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: signHeaders(privateKey, staleTimestamp, body),
    body,
  })
  assert.deepEqual(stale, { kind: 'rejected', status: 401, code: 'stale_signature' })

  const malformed = await adapter.verifyInbound({
    botId: 'bot-1',
    headers,
    body: Buffer.from('not-json'),
  })
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

  const unknownEventBody = Buffer.from(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', d: {} }))
  const unknown = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: signHeaders(privateKey, timestamp, unknownEventBody),
    body: unknownEventBody,
  })
  assert.equal(unknown.kind, 'ignored')
  if (unknown.kind !== 'ignored') throw new Error('expected ignored')
  assert.deepEqual(unknown.ackBody, { opcode: 12 })

  const otherOp = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: {},
    body: Buffer.from(JSON.stringify({ op: 12 })),
  })
  assert.deepEqual(otherOp, { kind: 'ignored' })

  const incompleteValidation = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: {},
    body: Buffer.from(JSON.stringify({ op: 13, d: { plain_token: 'only-token' } })),
  })
  assert.deepEqual(incompleteValidation, { kind: 'rejected', status: 400, code: 'invalid_payload' })
})

test('QQ：换取 access_token、C2C 被动回复与群/频道主动发送', async () => {
  const { appId, secret } = credentials('004')
  const now = new Date('2026-10-21T08:00:00.000Z')
  const timestamp = String(Math.floor(now.getTime() / 1000))
  const { privateKey } = deriveKeyPair(secret.token)
  let tokenCalls = 0
  const { fetchImpl, captured } = makeFetch((url) => {
    if (url === TOKEN_URL) {
      tokenCalls += 1
      return jsonResponse({ access_token: 'qq-access-token-1', expires_in: 7200 })
    }
    if (url.includes('/v2/users/')) return jsonResponse({ id: 'out-c2c-1' })
    if (url.includes('/v2/groups/')) return jsonResponse({ id: 'out-group-1' })
    if (url.includes('/channels/')) return jsonResponse({ message_id: 'out-channel-1' })
    return jsonResponse({ message: 'unexpected url' }, 500)
  })
  const adapter = new QqAdapter({ appId }, secret, { fetch: fetchImpl, now: () => now })

  const inbound = Buffer.from(
    JSON.stringify({
      op: 0,
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'c2c-msg-reply', content: '/status', author: { user_openid: 'user-openid-4' } },
    }),
  )
  const verified = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: signHeaders(privateKey, timestamp, inbound),
    body: inbound,
  })
  assert.equal(verified.kind, 'command')
  if (verified.kind !== 'command') throw new Error('expected command')
  await verified.reply('已收到')

  const tokenRequest = captured.find((item) => item.url === TOKEN_URL)
  assert.ok(tokenRequest)
  assert.equal(tokenRequest.init?.method, 'POST')
  assert.ok(!tokenRequest.url.includes(secret.token))
  const tokenPayload = JSON.parse(String(tokenRequest.init?.body)) as Record<string, unknown>
  assert.equal(tokenPayload.appId, appId)
  assert.equal(tokenPayload.clientSecret, secret.token)

  const replyRequest = captured.find((item) => item.url.includes('/messages'))
  assert.ok(replyRequest)
  assert.equal(replyRequest.url, `https://api.sgroup.qq.com/v2/users/user-openid-4/messages`)
  const replyHeaders = replyRequest.init?.headers as Record<string, string>
  assert.equal(replyHeaders.authorization, 'QQBot qq-access-token-1')
  const replyPayload = JSON.parse(String(replyRequest.init?.body)) as Record<string, unknown>
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
  const groupPayload = JSON.parse(String(groupRequest.init?.body)) as Record<string, unknown>
  assert.equal(groupPayload.content, '群通知')
  assert.equal(groupPayload.msg_type, 0)
  assert.equal(groupPayload.msg_id, undefined)

  const longText = '长'.repeat(2500)
  const channelResult = await adapter.send(targetRow('channel', 'channel-4'), { text: longText })
  assert.deepEqual(channelResult, { externalId: 'out-channel-1' })
  const channelRequest = captured.at(-1)!
  assert.equal(channelRequest.url, 'https://api.sgroup.qq.com/channels/channel-4/messages')
  const channelPayload = JSON.parse(String(channelRequest.init?.body)) as Record<string, unknown>
  assert.equal(String(channelPayload.content).length, 2000)
  assert.equal(channelPayload.msg_id, undefined)

  // access_token 按 AppID + AppSecret 缓存，三次发送只换取一次。
  assert.equal(tokenCalls, 1)
  assert.ok(captured.every((item) => !item.url.includes(secret.token)))
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
  const now = new Date('2026-10-21T08:00:00.000Z')
  const timestamp = String(Math.floor(now.getTime() / 1000))
  const { privateKey } = deriveKeyPair(appSecret)
  const { fetchImpl, captured } = makeFetch((url) => {
    if (url === TOKEN_URL) return jsonResponse({ access_token: 'qq-chat-token', expires_in: 7200 })
    if (url.includes('/v2/groups/')) return jsonResponse({ id: 'group-chat-out-1' })
    if (url.includes('/channels/')) return jsonResponse({ message_id: 'channel-chat-out-1' })
    return jsonResponse({ message: 'unexpected url' }, 500)
  })
  const adapter = new QqAdapter({ appId: '102345009' }, { token: appSecret }, { fetch: fetchImpl, now: () => now })

  const groupBody = Buffer.from(
    JSON.stringify({
      op: 0,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'group-chat-msg-1',
        content: '<@!102345009> 你好',
        group_openid: 'group-openid-9',
        author: { member_openid: 'member-openid-9' },
      },
    }),
  )
  const group = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: signHeaders(privateKey, timestamp, groupBody),
    body: groupBody,
  })
  assert.equal(group.kind, 'chat')
  if (group.kind !== 'chat') throw new Error('expected chat')
  assert.equal(group.targetExternalId, 'group-openid-9')
  assert.equal(group.targetKind, 'group')
  assert.equal(group.text, '你好')
  assert.equal(group.isDirect, false)
  assert.equal(group.chatTrigger, 'mention')
  assert.deepEqual(group.ackBody, { opcode: 12 })
  await group.reply('收到')
  const groupReply = captured.find((item) => item.url.includes('/v2/groups/'))
  assert.ok(groupReply)
  const groupPayload = JSON.parse(String(groupReply.init?.body)) as Record<string, unknown>
  assert.equal(groupPayload.content, '收到')
  assert.equal(groupPayload.msg_id, 'group-chat-msg-1')

  const channelBody = Buffer.from(
    JSON.stringify({
      op: 0,
      t: 'AT_MESSAGE_CREATE',
      d: {
        id: 'channel-chat-msg-1',
        content: '@测试机器人 状态',
        channel_id: 'channel-openid-9',
        author: { id: 'guild-user-9', username: '测试用户' },
      },
    }),
  )
  const channel = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: signHeaders(privateKey, timestamp, channelBody),
    body: channelBody,
  })
  assert.equal(channel.kind, 'chat')
  if (channel.kind !== 'chat') throw new Error('expected chat')
  assert.equal(channel.targetKind, 'channel')
  assert.equal(channel.text, '状态')
  assert.equal(channel.chatTrigger, 'mention')
  assert.equal(channel.userName, '测试用户')

  const emptyBody = Buffer.from(
    JSON.stringify({
      op: 0,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'group-chat-msg-2',
        content: '<@!102345009>',
        group_openid: 'group-openid-9',
        author: { member_openid: 'member-openid-9' },
      },
    }),
  )
  const empty = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: signHeaders(privateKey, timestamp, emptyBody),
    body: emptyBody,
  })
  assert.equal(empty.kind, 'ignored')
  if (empty.kind !== 'ignored') throw new Error('expected ignored')
  assert.deepEqual(empty.ackBody, { opcode: 12 })
})

test('QQ：validate 与 setup 输出平台配置要求', () => {
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
  assert.ok(setup.steps.every((step) => !step.includes('x'.repeat(16))))
})

test('QQ：仅支持文本，媒体内容明确拒绝', async () => {
  const { appId, secret } = credentials('008')
  const adapter = new QqAdapter({ appId }, secret)
  await assert.rejects(
    () =>
      adapter.send(targetRow('group', 'group-openid-8'), {
        text: '带附件',
        media: [{ filename: 'a.txt', mime: 'text/plain', data: Buffer.from('x') }],
      }),
    (error: unknown) => error instanceof BotPlatformError && error.code === 'qq_media_unsupported',
  )
})
