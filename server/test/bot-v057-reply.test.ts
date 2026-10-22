/**
 * v0.5.7 平台适配器契约测试（二）：引用/线程回复与失效降级。
 * Telegram 群/频道 reply_to_message_id、Slack thread_ts、Discord message_reference；
 * 平台报被引用消息/线程不存在时降级一次无引用重发。全部使用注入 fetch 夹具，不访问真实平台。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync } from 'node:crypto'
import { TelegramAdapter } from '../src/bot/adapters/telegram.ts'
import { DiscordAdapter } from '../src/bot/adapters/discord.ts'
import { SlackAdapter } from '../src/bot/adapters/slack.ts'
import type { BotSecret, BotTargetRow, InboundVerification } from '../src/bot/types.ts'

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

function payloadOf(item: Captured): Record<string, unknown> {
  return JSON.parse(String(item.init?.body)) as Record<string, unknown>
}

function target(kind: 'channel' | 'user' | 'group', externalId: string): BotTargetRow {
  return {
    id: `target-${kind}`,
    bot_id: 'bot-1',
    external_id: externalId,
    label: kind,
    kind,
    allow_commands: 1,
    allow_notifications: 1,
    allow_chat: 1,
    chat_trigger: 'mention',
    quiet_start_minute: null,
    quiet_end_minute: null,
    created_at: '2026-01-01T00:00:00.000Z',
  }
}

/* ------------------------------- Telegram ------------------------------- */

const TG_TOKEN = `123456789:${'A'.repeat(35)}`
const TG_WEBHOOK_SECRET = 'telegram-webhook-secret-1234'

function tgSecret(): BotSecret {
  return { token: TG_TOKEN, webhookSecret: TG_WEBHOOK_SECRET }
}

function tgHeaders() {
  return { 'x-telegram-bot-api-secret-token': TG_WEBHOOK_SECRET, 'content-type': 'application/json' }
}

function tgBody(message: Record<string, unknown>, updateId = 1): Buffer {
  return Buffer.from(JSON.stringify({ update_id: updateId, message }))
}

test('Telegram：群/频道 chat 与 command 回复带 reply_to_message_id，私聊不带', async () => {
  const { fetchImpl, captured } = makeFetch(() => jsonResponse({ ok: true, result: { message_id: 901 } }))
  const adapter = new TelegramAdapter({ botUsername: 'MyBot' }, tgSecret(), { fetch: fetchImpl })

  const groupChat = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: tgHeaders(),
    body: tgBody({
      message_id: 31,
      text: '@MyBot 你好',
      entities: [{ type: 'mention', offset: 0, length: 6 }],
      chat: { id: 200, type: 'group' },
      from: { id: 8 },
    }),
  })
  assert.equal(groupChat.kind, 'chat')
  if (groupChat.kind !== 'chat') throw new Error('expected chat')
  await groupChat.reply('收到')
  assert.equal(payloadOf(captured.at(-1)!).reply_to_message_id, 31)

  const groupCommand = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: tgHeaders(),
    body: tgBody({
      message_id: 32,
      text: '/status',
      chat: { id: 200, type: 'group' },
      from: { id: 8 },
    }),
  })
  assert.equal(groupCommand.kind, 'command')
  if (groupCommand.kind !== 'command') throw new Error('expected command')
  await groupCommand.reply('状态正常')
  assert.equal(payloadOf(captured.at(-1)!).reply_to_message_id, 32)

  // 私聊不引用入站消息。
  const directChat = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: tgHeaders(),
    body: tgBody({
      message_id: 33,
      text: '你好',
      chat: { id: 100, type: 'private' },
      from: { id: 7 },
    }),
  })
  assert.equal(directChat.kind, 'chat')
  if (directChat.kind !== 'chat') throw new Error('expected chat')
  await directChat.reply('收到')
  assert.equal(payloadOf(captured.at(-1)!).reply_to_message_id, undefined)

  // 频道（channel）也属于群组语义：使用入站 message_id 引用。
  const channelChat = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: tgHeaders(),
    body: tgBody({
      message_id: 34,
      text: '频道消息',
      chat: { id: -1001, type: 'channel' },
      from: { id: 9 },
      reply_to_message: { message_id: 1, from: { id: 88, is_bot: true } },
    }),
  })
  assert.equal(channelChat.kind, 'chat')
  if (channelChat.kind !== 'chat') throw new Error('expected chat')
  await channelChat.reply('频道回复')
  assert.equal(payloadOf(captured.at(-1)!).reply_to_message_id, 34)
})

test('Telegram：被引用消息不存在时降级一次无引用重发，正文与按钮保留', async () => {
  let calls = 0
  const { fetchImpl, captured } = makeFetch(() => {
    calls += 1
    if (calls === 1) {
      return jsonResponse({ ok: false, description: 'Bad Request: message to be replied not found' })
    }
    return jsonResponse({ ok: true, result: { message_id: 902 } })
  })
  const adapter = new TelegramAdapter({ botUsername: 'MyBot' }, tgSecret(), { fetch: fetchImpl })
  const result = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: tgHeaders(),
    body: tgBody({
      message_id: 35,
      text: '@MyBot 帮我看看',
      entities: [{ type: 'mention', offset: 0, length: 6 }],
      chat: { id: 200, type: 'group' },
      from: { id: 8 },
    }),
  })
  assert.equal(result.kind, 'chat')
  if (result.kind !== 'chat') throw new Error('expected chat')
  await result.reply('已处理', { buttons: [{ id: 'refresh_status', label: '刷新状态' }] })

  assert.equal(captured.length, 2)
  const first = payloadOf(captured[0]!)
  assert.equal(first.reply_to_message_id, 35)
  const second = payloadOf(captured[1]!)
  assert.equal(second.reply_to_message_id, undefined)
  const markup = second.reply_markup as { inline_keyboard: Array<Array<Record<string, unknown>>> } | undefined
  assert.equal(markup?.inline_keyboard[0]?.[0]?.callback_data, 'refresh_status')

  // 非引用相关错误不重试。
  let attempts = 0
  const plain = makeFetch(() => {
    attempts += 1
    return jsonResponse({ ok: false, description: 'chat not found' })
  })
  const failing = new TelegramAdapter(tgSecret(), { fetch: plain.fetchImpl })
  await assert.rejects(() => failing.send(target('group', '200'), { text: '文本', replyTo: '35' }))
  // `not found` 属于被引用消息失效的描述，适配器会降级一次；两次都失败后仍抛出。
  assert.equal(attempts, 2)
})

/* --------------------------------- Slack -------------------------------- */

const SLACK_SIGNING_SECRET = 'slack-signing-secret-123456'

function slackSecret(): BotSecret {
  return { token: 'x'.repeat(40), signingSecret: SLACK_SIGNING_SECRET }
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

function slackEvent(event: Record<string, unknown>, extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ type: 'event_callback', event_id: 'Ev-reply', event, ...extra }))
}

function chatOf(result: InboundVerification): Extract<InboundVerification, { kind: 'chat' }> {
  assert.equal(result.kind, 'chat')
  if (result.kind !== 'chat') throw new Error('expected chat')
  return result
}

test('Slack：频道/线程回复带 thread_ts，私聊不带', async () => {
  const { fetchImpl, captured } = makeFetch(() => jsonResponse({ ok: true, ts: '1700000000.000300' }))
  const adapter = new SlackAdapter({ botUserId: 'UBOT' }, slackSecret(), { fetch: fetchImpl })

  const channelBody = slackEvent({
    type: 'message',
    channel: 'C1',
    channel_type: 'channel',
    user: 'U1',
    text: '<@UBOT> 帮我看下',
    ts: '1700000000.000100',
  })
  const channel = chatOf(await adapter.verifyInbound({ botId: 'bot-1', headers: slackHeaders(channelBody), body: channelBody }))
  await channel.reply('收到')
  assert.equal(payloadOf(captured.at(-1)!).thread_ts, '1700000000.000100')

  const directBody = slackEvent({
    type: 'message',
    channel: 'D1',
    channel_type: 'im',
    user: 'U1',
    text: '你好',
    ts: '1700000000.000200',
  })
  const direct = chatOf(await adapter.verifyInbound({ botId: 'bot-1', headers: slackHeaders(directBody), body: directBody }))
  await direct.reply('收到')
  assert.equal(payloadOf(captured.at(-1)!).thread_ts, undefined)

  const mentionBody = slackEvent({
    type: 'app_mention',
    channel: 'C2',
    user: 'U2',
    text: '<@UBOT> 状态',
    ts: '1700000000.000400',
  })
  const mention = chatOf(await adapter.verifyInbound({ botId: 'bot-1', headers: slackHeaders(mentionBody), body: mentionBody }))
  await mention.reply('正常')
  assert.equal(payloadOf(captured.at(-1)!).thread_ts, '1700000000.000400')

  // 命令回复同样留在频道线程内。
  const commandBody = slackEvent({
    type: 'message',
    channel: 'C1',
    channel_type: 'channel',
    user: 'U1',
    text: '/status',
    ts: '1700000000.000500',
  })
  const command = await adapter.verifyInbound({ botId: 'bot-1', headers: slackHeaders(commandBody), body: commandBody })
  assert.equal(command.kind, 'command')
  if (command.kind !== 'command') throw new Error('expected command')
  await command.reply('状态正常')
  assert.equal(payloadOf(captured.at(-1)!).thread_ts, '1700000000.000500')
})

test('Slack：线程失效时降级一次无 thread_ts 重发', async () => {
  let calls = 0
  const { fetchImpl, captured } = makeFetch(() => {
    calls += 1
    if (calls === 1) return jsonResponse({ ok: false, error: 'thread_not_found' })
    return jsonResponse({ ok: true, ts: '1700000000.000600' })
  })
  const adapter = new SlackAdapter({ botUserId: 'UBOT' }, slackSecret(), { fetch: fetchImpl })
  const body = slackEvent({
    type: 'message',
    channel: 'C1',
    channel_type: 'channel',
    user: 'U1',
    text: '<@UBOT> 测试降级',
    ts: '1700000000.000700',
  })
  const result = chatOf(await adapter.verifyInbound({ botId: 'bot-1', headers: slackHeaders(body), body }))
  await result.reply('已降级')

  assert.equal(captured.length, 2)
  assert.equal(payloadOf(captured[0]!).thread_ts, '1700000000.000700')
  assert.equal(payloadOf(captured[1]!).thread_ts, undefined)
})

/* -------------------------------- Discord ------------------------------- */

function discordKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
  return { rawPublic, privateKey }
}

function discordAdapter(fetchImpl: typeof fetch, keys: ReturnType<typeof discordKeys>): DiscordAdapter {
  return new DiscordAdapter(
    { applicationId: '123456789012345678', publicKey: keys.rawPublic },
    { token: 'x'.repeat(40) },
    { fetch: fetchImpl },
  )
}

test('Discord：频道引用回复带 message_reference，DM 目标不带', async () => {
  let calls = 0
  const { fetchImpl, captured } = makeFetch((url) => {
    if (url.endsWith('/users/@me/channels')) return jsonResponse({ id: 'dm-channel-1' })
    calls += 1
    return jsonResponse({ id: `msg-${calls}` })
  })
  const keys = discordKeys()
  const adapter = discordAdapter(fetchImpl, keys)

  const channelResult = await adapter.send(target('channel', 'channel-1'), {
    text: '频道回复',
    replyTo: 'inbound-msg-1',
  })
  assert.deepEqual(channelResult, { externalId: 'msg-1' })
  assert.deepEqual(payloadOf(captured[0]!).message_reference, {
    message_id: 'inbound-msg-1',
    fail_if_not_exists: false,
  })

  // user 目标（DM）：先开频道，再发送且不带引用。
  const userResult = await adapter.send(target('user', 'user-9'), { text: '私聊回复', replyTo: 'inbound-msg-2' })
  assert.deepEqual(userResult, { externalId: 'msg-2' })
  assert.match(captured.at(-1)!.url, /\/channels\/dm-channel-1\/messages$/)
  assert.equal(payloadOf(captured.at(-1)!).message_reference, undefined)
})

test('Discord：引用回复 400 时降级一次无引用重发', async () => {
  let calls = 0
  const { fetchImpl, captured } = makeFetch(() => {
    calls += 1
    if (calls === 1) return jsonResponse({ message: 'Unknown Message', code: 10008 }, 400)
    return jsonResponse({ id: 'msg-ok' })
  })
  const keys = discordKeys()
  const adapter = discordAdapter(fetchImpl, keys)
  const result = await adapter.send(target('channel', 'channel-1'), {
    text: '引用回复',
    replyTo: 'deleted-msg',
  })
  assert.deepEqual(result, { externalId: 'msg-ok' })
  assert.equal(captured.length, 2)
  assert.ok(payloadOf(captured[0]!).message_reference)
  assert.equal(payloadOf(captured[1]!).message_reference, undefined)

  // 无引用的 400 不重试。
  let attempts = 0
  const plain = makeFetch(() => {
    attempts += 1
    return jsonResponse({ message: 'Bad Request' }, 400)
  })
  const failing = discordAdapter(plain.fetchImpl, keys)
  await assert.rejects(() => failing.send(target('channel', 'channel-1'), { text: '普通文本' }))
  assert.equal(attempts, 1)
})
