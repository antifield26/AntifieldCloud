/**
 * v0.5.7 平台适配器契约测试（一）：长回复分段、Telegram parse_mode、群聊 all 触发策略、
 * Discord Gateway messageId/图片透传、ignored 事件 eventId。
 * 全部使用注入 fetch / 假 WebSocket 与进程内夹具，不访问真实平台网络，不打印或断言任何密钥内容。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { TelegramAdapter } from '../src/bot/adapters/telegram.ts'
import { DiscordAdapter } from '../src/bot/adapters/discord.ts'
import { SlackAdapter } from '../src/bot/adapters/slack.ts'
import { BotPlatformError } from '../src/bot/adapters/http.ts'
import {
  DiscordGatewayManager,
  type DiscordGatewayBot,
  type DiscordGatewayMessage,
  type WebSocketLike,
} from '../src/bot/discord-gateway.ts'
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

function payloadOf(captured: Captured): Record<string, unknown> {
  return JSON.parse(String(captured.init?.body)) as Record<string, unknown>
}

/** 断言没有错误对象把平台凭据/URL 带进消息。 */
function assertNoSecret(error: unknown, secrets: string[]): void {
  const text = error instanceof Error ? error.message : String(error)
  for (const secret of secrets) assert.ok(!text.includes(secret), '错误信息不应包含凭据')
}

/* ------------------------------- Telegram ------------------------------- */

const TG_TOKEN = `123456789:${'A'.repeat(35)}`
const TG_WEBHOOK_SECRET = 'telegram-webhook-secret-1234'

function tgHeaders(secret = TG_WEBHOOK_SECRET) {
  return { 'x-telegram-bot-api-secret-token': secret, 'content-type': 'application/json' }
}

function tgSecret(): BotSecret {
  return { token: TG_TOKEN, webhookSecret: TG_WEBHOOK_SECRET }
}

function tgMessage(overrides: Record<string, unknown>, updateId = 1): Buffer {
  return Buffer.from(JSON.stringify({ update_id: updateId, message: overrides }))
}

function tgGroupText(text: string, messageId: number, updateId = 1): Buffer {
  return tgMessage(
    {
      message_id: messageId,
      text,
      entities: [{ type: 'mention', offset: 0, length: '@MyBot'.length }],
      chat: { id: 200, type: 'group' },
      from: { id: 8, username: 'bob' },
    },
    updateId,
  )
}

function chatResult(result: InboundVerification): Extract<InboundVerification, { kind: 'chat' }> {
  assert.equal(result.kind, 'chat')
  if (result.kind !== 'chat') throw new Error('expected chat')
  return result
}

test('Telegram：长文本按 4096 分段，按钮只在末段、引用只在首段', async () => {
  let calls = 0
  const { fetchImpl, captured } = makeFetch(() => {
    calls += 1
    return jsonResponse({ ok: true, result: { message_id: 500 + calls } })
  })
  const adapter = new TelegramAdapter({ botUsername: 'MyBot' }, tgSecret(), { fetch: fetchImpl })
  const result = chatResult(
    await adapter.verifyInbound({ botId: 'bot-1', headers: tgHeaders(), body: tgGroupText('@MyBot 你好', 31) }),
  )
  const long = '长'.repeat(9000)
  await result.reply(long, { buttons: [{ id: 'refresh_status', label: '刷新状态' }] })

  assert.equal(captured.length, 3)
  const payloads = captured.map(payloadOf)
  for (const payload of payloads) {
    assert.ok(String(payload.text).length <= 4096, '每段不超过 Telegram 上限')
  }
  assert.ok(!String(payloads[0]?.text).startsWith('（续'))
  assert.match(String(payloads[1]?.text), /^（续 2\/3）/)
  assert.match(String(payloads[2]?.text), /^（续 3\/3）/)
  // 引用回复只挂在首段；按钮只挂在末段。
  assert.equal(payloads[0]?.reply_to_message_id, 31)
  assert.equal(payloads[1]?.reply_to_message_id, undefined)
  assert.equal(payloads[2]?.reply_to_message_id, undefined)
  assert.equal(payloads[0]?.reply_markup, undefined)
  assert.equal(payloads[1]?.reply_markup, undefined)
  const markup = payloads[2]?.reply_markup as { inline_keyboard: Array<Array<Record<string, unknown>>> } | undefined
  assert.equal(markup?.inline_keyboard[0]?.[0]?.callback_data, 'refresh_status')
})

test('Telegram：textMode=html 时分段每段都带 parse_mode=HTML', async () => {
  let calls = 0
  const { fetchImpl, captured } = makeFetch(() => {
    calls += 1
    return jsonResponse({ ok: true, result: { message_id: 600 + calls } })
  })
  const adapter = new TelegramAdapter(tgSecret(), { fetch: fetchImpl })
  const result = await adapter.send(target('channel', '200'), { text: '<b>粗</b>'.repeat(2000), textMode: 'html' })
  assert.ok(captured.length >= 2)
  for (const item of captured) {
    assert.equal(payloadOf(item).parse_mode, 'HTML')
  }
  assert.deepEqual(result.externalIds, captured.map((_item, index) => String(601 + index)))
})

test('Telegram：首段失败直接抛错，中途失败带 sentExternalIds 与 botPartialKind', async () => {
  let calls = 0
  const { fetchImpl } = makeFetch(() => {
    calls += 1
    if (calls === 2) return jsonResponse({ ok: false, description: 'boom' })
    return jsonResponse({ ok: true, result: { message_id: 700 + calls } })
  })
  const adapter = new TelegramAdapter(tgSecret(), { fetch: fetchImpl })
  await assert.rejects(
    () => adapter.send(target('group', '200'), { text: '长'.repeat(9000) }),
    (error: unknown) => {
      assert.ok(error instanceof BotPlatformError)
      assert.deepEqual((error as unknown as { sentExternalIds?: string[] }).sentExternalIds, ['701'])
      assert.equal((error as unknown as { botPartialKind?: string }).botPartialKind, 'text')
      assertNoSecret(error, [TG_TOKEN])
      return true
    },
  )

  const strict = makeFetch(() => jsonResponse({ ok: false, description: 'boom' }))
  const strictAdapter = new TelegramAdapter(tgSecret(), { fetch: strict.fetchImpl })
  await assert.rejects(
    () => strictAdapter.send(target('group', '200'), { text: '短文本' }),
    (error: unknown) => {
      assert.ok(error instanceof BotPlatformError)
      assert.equal((error as unknown as { sentExternalIds?: string[] }).sentExternalIds, undefined)
      assert.equal((error as unknown as { botPartialKind?: string }).botPartialKind, 'text')
      return true
    },
  )
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

function discordInteractionBody(id: string, type: number, data: Record<string, unknown>): Buffer {
  return Buffer.from(
    JSON.stringify({
      type,
      id,
      token: 'interaction-token',
      channel_id: 'channel-1',
      guild_id: 'guild-1',
      member: { user: { id: 'user-1', username: 'alice' } },
      data,
    }),
  )
}

function discordHeaders(privateKey: ReturnType<typeof discordKeys>['privateKey'], body: Buffer) {
  const timestamp = String(Math.floor(Date.now() / 1000))
  return {
    'x-signature-ed25519': sign(null, Buffer.concat([Buffer.from(timestamp), body]), privateKey).toString('hex'),
    'x-signature-timestamp': timestamp,
    'content-type': 'application/json',
  }
}

test('Discord：交互 follow-up 长回复分段，按钮只在末段', async () => {
  const keys = discordKeys()
  let calls = 0
  const { fetchImpl, captured } = makeFetch(() => {
    calls += 1
    return jsonResponse({ id: `webhook-${calls}` })
  })
  const adapter = discordAdapter(fetchImpl, keys)
  const body = discordInteractionBody('interaction-long', 2, { name: 'status', options: [] })
  const result = await adapter.verifyInbound({ botId: 'bot-1', headers: discordHeaders(keys.privateKey, body), body })
  assert.equal(result.kind, 'command')
  if (result.kind !== 'command') throw new Error('expected command')
  await result.reply('回'.repeat(5000), { buttons: [{ id: 'help', label: '帮助' }] })

  assert.equal(captured.length, 3)
  const payloads = captured.map(payloadOf)
  for (const payload of payloads) assert.ok(String(payload.content).length <= 2000)
  assert.equal(payloads[0]?.components, undefined)
  assert.equal(payloads[1]?.components, undefined)
  const components = payloads[2]?.components as Array<{ components: Array<Record<string, unknown>> }> | undefined
  assert.equal(components?.[0]?.components[0]?.custom_id, 'help')
  assert.deepEqual(
    captured.map((item) => item.url),
    ['https://discord.com/api/v10/webhooks/123456789012345678/interaction-token',
      'https://discord.com/api/v10/webhooks/123456789012345678/interaction-token',
      'https://discord.com/api/v10/webhooks/123456789012345678/interaction-token'],
  )
})

test('Discord：follow-up 中途失败带已发送消息 ID；send 长文本分段返回 externalIds', async () => {
  const keys = discordKeys()
  let calls = 0
  const failFetch = makeFetch(() => {
    calls += 1
    if (calls === 2) return jsonResponse({ message: 'server error' }, 500)
    return jsonResponse({ id: `webhook-${calls}` })
  })
  const failing = discordAdapter(failFetch.fetchImpl, keys)
  const body = discordInteractionBody('interaction-partial', 2, { name: 'status', options: [] })
  const result = await failing.verifyInbound({ botId: 'bot-1', headers: discordHeaders(keys.privateKey, body), body })
  if (result.kind !== 'command') throw new Error('expected command')
  await assert.rejects(
    () => result.reply('回'.repeat(5000)),
    (error: unknown) => {
      assert.deepEqual((error as unknown as { sentExternalIds?: string[] }).sentExternalIds, ['webhook-1'])
      assert.equal((error as unknown as { botPartialKind?: string }).botPartialKind, 'text')
      return true
    },
  )

  let next = 0
  const sendFetch = makeFetch(() => {
    next += 1
    return jsonResponse({ id: `msg-${next}` })
  })
  const adapter = discordAdapter(sendFetch.fetchImpl, keys)
  const sent = await adapter.send(target('channel', 'channel-1'), { text: '文'.repeat(5000) })
  assert.equal(sent.externalId, 'msg-1')
  assert.deepEqual(sent.externalIds, ['msg-1', 'msg-2', 'msg-3'])
})

/* --------------------------------- Slack -------------------------------- */

const SLACK_SIGNING_SECRET = 'slack-signing-secret-123456'

function slackHeaders(body: Buffer): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = `v0=${createHmac('sha256', SLACK_SIGNING_SECRET).update(`v0:${timestamp}:${body.toString('utf8')}`).digest('hex')}`
  return {
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': signature,
    'content-type': 'application/json',
  }
}

function slackSecret(): BotSecret {
  return { token: 'x'.repeat(40), signingSecret: SLACK_SIGNING_SECRET }
}

function slackEvent(event: Record<string, unknown>, extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ type: 'event_callback', event_id: 'Ev-1', event, ...extra }))
}

test('Slack：长文本按 4000 分段发送并返回 externalIds', async () => {
  let calls = 0
  const { fetchImpl, captured } = makeFetch(() => {
    calls += 1
    return jsonResponse({ ok: true, ts: `1700000000.000${calls}` })
  })
  const adapter = new SlackAdapter(slackSecret(), { fetch: fetchImpl })
  const result = await adapter.send(target('channel', 'C1'), { text: '文'.repeat(9000) })
  assert.equal(captured.length, 3)
  const payloads = captured.map(payloadOf)
  for (const payload of payloads) assert.ok(String(payload.text).length <= 4000)
  assert.match(String(payloads[1]?.text), /^（续 2\/3）/)
  assert.equal(result.externalId, '1700000000.0001')
  assert.deepEqual(result.externalIds, ['1700000000.0001', '1700000000.0002', '1700000000.0003'])

  // 任意失败时抛错并带已发送 ts。
  let failCalls = 0
  const fail = makeFetch(() => {
    failCalls += 1
    if (failCalls === 2) return jsonResponse({ ok: false, error: 'ratelimited' })
    return jsonResponse({ ok: true, ts: `ts-${failCalls}` })
  })
  const failing = new SlackAdapter(slackSecret(), { fetch: fail.fetchImpl })
  await assert.rejects(
    () => failing.send(target('channel', 'C1'), { text: '文'.repeat(9000) }),
    (error: unknown) => {
      assert.deepEqual((error as unknown as { sentExternalIds?: string[] }).sentExternalIds, ['ts-1'])
      assert.equal((error as unknown as { botPartialKind?: string }).botPartialKind, 'text')
      return true
    },
  )
})

/* ------------------------------ 群聊 all 策略 ---------------------------- */

test('Telegram：chatTriggerFor=all 时未 @Bot 群消息进入 chat(message)，否则保持 ignored', async () => {
  const { fetchImpl } = makeFetch(() => jsonResponse({ ok: true, result: { message_id: 1 } }))
  const adapter = new TelegramAdapter({ botUsername: 'MyBot' }, tgSecret(), { fetch: fetchImpl })
  const body = tgMessage({
    message_id: 41,
    text: '大家聊聊天',
    chat: { id: 200, type: 'group' },
    from: { id: 8 },
  })
  const all = chatResult(
    await adapter.verifyInbound({ botId: 'bot-1', headers: tgHeaders(), body, chatTriggerFor: () => 'all' }),
  )
  assert.equal(all.chatTrigger, 'message')
  assert.equal(all.text, '大家聊聊天')
  assert.equal(all.isDirect, false)

  const mentionOnly = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: tgHeaders(),
    body,
    chatTriggerFor: () => 'mention',
  })
  assert.equal(mentionOnly.kind, 'ignored')
  if (mentionOnly.kind !== 'ignored') throw new Error('expected ignored')
  assert.equal(mentionOnly.eventId, 'tg:update:1')

  // 私聊与命令不受触发策略影响。
  const direct = chatResult(
    await adapter.verifyInbound({
      botId: 'bot-1',
      headers: tgHeaders(),
      body: tgMessage({
        message_id: 42,
        text: '私聊',
        chat: { id: 100, type: 'private' },
        from: { id: 7 },
      }),
      chatTriggerFor: () => 'mention',
    }),
  )
  assert.equal(direct.chatTrigger, 'direct')
})

test('Slack：chatTriggerFor=all 时未 mention 频道消息进入 chat(message)，app_mention 仍为 mention', async () => {
  const { fetchImpl } = makeFetch(() => jsonResponse({ ok: true, ts: '1700000000.000900' }))
  const adapter = new SlackAdapter({ botUserId: 'UBOT' }, slackSecret(), { fetch: fetchImpl })
  const plain = slackEvent({
    type: 'message',
    channel: 'C9',
    channel_type: 'channel',
    user: 'U9',
    text: '普通频道消息',
    ts: '1700000000.000100',
  })
  const all = chatResult(
    await adapter.verifyInbound({ botId: 'bot-1', headers: slackHeaders(plain), body: plain, chatTriggerFor: () => 'all' }),
  )
  assert.equal(all.chatTrigger, 'message')
  assert.equal(all.text, '普通频道消息')

  const ignored = await adapter.verifyInbound({ botId: 'bot-1', headers: slackHeaders(plain), body: plain })
  assert.deepEqual(ignored, { kind: 'ignored', eventId: 'slack:Ev-1' })

  const mentionBody = slackEvent({
    type: 'app_mention',
    channel: 'C9',
    user: 'U9',
    text: '<@UBOT> 在吗',
    ts: '1700000000.000200',
  })
  const mention = chatResult(
    await adapter.verifyInbound({
      botId: 'bot-1',
      headers: slackHeaders(mentionBody),
      body: mentionBody,
      chatTriggerFor: () => 'all',
    }),
  )
  assert.equal(mention.chatTrigger, 'mention')
})

/* ---------------------------- Discord Gateway --------------------------- */

class FakeSocket implements WebSocketLike {
  readonly url: string
  readonly sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null

  constructor(url: string) {
    this.url = url
  }

  send(data: string): void {
    this.sent.push(data)
  }

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
    now: () => new Date('2026-10-22T12:00:00.000Z'),
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
      channel_id: 'chan-all',
      guild_id: 'guild-1',
      content: 'hello',
      author: { id: 'user-1', username: 'alice', bot: false },
      mentions: [],
      ...fields,
    },
  })
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test('Discord Gateway：chatTriggerFor=all 时普通频道消息 dispatch，messageId 与图片附件透传', async () => {
  const { manager, sockets, messages } = gatewaySetup((_botId, targetExternalId) =>
    targetExternalId === 'chan-all' ? 'all' : 'mention',
  )
  try {
    manager.start()
    const socket = sockets[0]!
    gatewayReady(socket)

    gatewayMessage(socket, 'msg-all', { content: '普通消息' })
    gatewayMessage(socket, 'msg-other', { channel_id: 'chan-other', content: '另一个频道' })
    gatewayMessage(socket, 'msg-dm-image', {
      channel_id: 'dm-1',
      guild_id: undefined,
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
    await flush()

    assert.equal(messages.length, 2)
    const byId = new Map(messages.map((event) => [event.eventId, event]))
    const all = byId.get('dc_msg:msg-all')
    assert.equal(all?.chatTrigger, 'message')
    assert.equal(all?.messageId, 'msg-all')
    assert.equal(all?.image, undefined)
    assert.equal(byId.has('dc_msg:msg-other'), false)

    const dm = byId.get('dc_msg:msg-dm-image')
    assert.equal(dm?.isDirect, true)
    assert.equal(dm?.chatTrigger, 'direct')
    assert.equal(dm?.text, '')
    assert.deepEqual(dm?.image, {
      ref: 'https://cdn.discordapp.com/attachments/1/2/photo.png',
      mime: 'image/png',
      name: 'photo.png',
      size: 2048,
    })
  } finally {
    manager.stop()
  }
})

test('Discord Gateway：默认策略下普通频道消息不 dispatch，mention 消息带 messageId', async () => {
  const { manager, sockets, messages } = gatewaySetup()
  try {
    manager.start()
    const socket = sockets[0]!
    gatewayReady(socket)
    gatewayMessage(socket, 'msg-plain', { content: '普通消息' })
    gatewayMessage(socket, 'msg-mention', { content: '在吗', mentions: [{ id: 'bot-user' }] })
    await flush()
    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.eventId, 'dc_msg:msg-mention')
    assert.equal(messages[0]?.messageId, 'msg-mention')
    assert.equal(messages[0]?.chatTrigger, 'mention')
  } finally {
    manager.stop()
  }
})

/* ---------------------------- ignored eventId --------------------------- */

test('ignored 事件补 eventId：Telegram update_id、Discord interaction id、Slack event_id', async () => {
  const tgFetch = makeFetch(() => jsonResponse({ ok: true, result: { message_id: 1 } }))
  const telegram = new TelegramAdapter({ botUsername: 'MyBot' }, tgSecret(), { fetch: tgFetch.fetchImpl })
  const tgIgnored = await telegram.verifyInbound({
    botId: 'bot-1',
    headers: tgHeaders(),
    body: tgMessage({ message_id: 51, text: '无关', chat: { id: 200, type: 'group' }, from: { id: 8 } }, 99),
  })
  assert.deepEqual(tgIgnored, { kind: 'ignored', eventId: 'tg:update:99' })

  const keys = discordKeys()
  const dcFetch = makeFetch(() => jsonResponse({}))
  const discord = discordAdapter(dcFetch.fetchImpl, keys)
  const dcBody = Buffer.from(JSON.stringify({ type: 4, id: 'app-command-1' }))
  const dcIgnored = await discord.verifyInbound({
    botId: 'bot-1',
    headers: discordHeaders(keys.privateKey, dcBody),
    body: dcBody,
  })
  assert.deepEqual(dcIgnored, { kind: 'ignored', eventId: 'dc:app-command-1' })

  const slackFetch = makeFetch(() => jsonResponse({}))
  const slack = new SlackAdapter(slackSecret(), { fetch: slackFetch.fetchImpl })
  const slackBody = Buffer.from(
    JSON.stringify({ type: 'event_callback', event_id: 'Ev-ignore', event: { type: 'reaction_added', user: 'U1' } }),
  )
  const slackIgnored = await slack.verifyInbound({
    botId: 'bot-1',
    headers: slackHeaders(slackBody),
    body: slackBody,
  })
  assert.deepEqual(slackIgnored, { kind: 'ignored', eventId: 'slack:Ev-ignore' })
})

/* ------------------------ Telegram HTML 安全分段 ------------------------ */

const TG_HTML_LIMIT = 4096

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

/** 标签必须成对且按栈嵌套；不匹配立即失败。 */
function assertBalancedHtml(html: string): void {
  const stack: string[] = []
  const pattern = /<(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)(?:\s[^>]*)?\s*\/?>/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    const name = match[2]!.toLowerCase()
    if (match[1] === '/') {
      assert.equal(stack.pop(), name, `标签闭合顺序错误：${html}`)
    } else {
      stack.push(name)
    }
  }
  assert.deepEqual(stack, [], `存在未闭合标签：${html}`)
}

/** 文本中的 &...; 实体必须完整（段尾不能出现半个实体）。 */
function assertEntitiesIntact(html: string): void {
  const text = stripHtmlTags(html)
  let index = text.indexOf('&')
  while (index >= 0) {
    const semicolon = text.indexOf(';', index + 1)
    assert.ok(semicolon > index && semicolon - index <= 10, `HTML 实体被切断：${text.slice(index, index + 12)}`)
    assert.match(text.slice(index + 1, semicolon), /^[a-zA-Z#0-9]+$/)
    index = text.indexOf('&', semicolon + 1)
  }
}

function collectHtmlReply(
  captured: Captured[],
): { texts: string[]; payloads: Array<Record<string, unknown>> } {
  const payloads = captured.map((item) => payloadOf(item))
  return { texts: payloads.map((payload) => String(payload.text)), payloads }
}

test('Telegram：HTML 长回复按标签边界分段（粗体/代码块/链接跨段、实体与文本完整）', async () => {
  let calls = 0
  const { fetchImpl, captured } = makeFetch(() => {
    calls += 1
    return jsonResponse({ ok: true, result: { message_id: 900 + calls } })
  })
  const adapter = new TelegramAdapter({ botUsername: 'MyBot' }, tgSecret(), { fetch: fetchImpl })
  const result = chatResult(
    await adapter.verifyInbound({ botId: 'bot-1', headers: tgHeaders(), body: tgGroupText('@MyBot 你好', 71) }),
  )

  const html =
    `<b>${'粗'.repeat(4500)}</b>\n\n` +
    `<pre>${'const line = 1\n'.repeat(334)}</pre>` +
    `<a href="https://example.com/page">${'链接'.repeat(100)}</a>` +
    `尾${'&amp;文本'.repeat(200)}`
  await result.reply(html, { textMode: 'html' })

  assert.ok(captured.length > 1, 'HTML 长回复应分段发送')
  const { texts, payloads } = collectHtmlReply(captured)
  for (const [index, text] of texts.entries()) {
    assert.ok(text.length <= TG_HTML_LIMIT, `第 ${index + 1} 段超限：${text.length}`)
    assertBalancedHtml(text)
    assertEntitiesIntact(text)
    // 标签不能被切成半个：去掉完整标签后不应残留尖括号。
    assert.equal(stripHtmlTags(text).includes('<'), false)
    assert.equal(stripHtmlTags(text).includes('>'), false)
  }
  for (const payload of payloads) assert.equal(payload.parse_mode, 'HTML')

  // 粗体跨段：某段以 </b> 收尾，下一段（跳过续段前缀）以 <b> 重开。
  let boldCrossed = false
  for (let index = 0; index < texts.length - 1; index += 1) {
    if (!texts[index]!.endsWith('</b>')) continue
    const next = texts[index + 1]!.replace(/^（续 \d+\/\d+）/, '')
    if (next.startsWith('<b>')) boldCrossed = true
  }
  assert.equal(boldCrossed, true, '粗体应跨段闭合并重开')

  // 链接跨段时保留原 href（重开标签不能丢属性）。
  assert.ok(texts.some((text) => text.includes('<a href="https://example.com/page">')))
  // 代码块跨段：<pre> 与 </pre> 各自成对出现。
  assert.ok(texts.some((text) => text.includes('<pre>')))
  assert.ok(texts.some((text) => text.includes('</pre>')))

  // 文本无丢失：去掉补的标签与续段前缀后逐字符一致。
  const expected = stripHtmlTags(html)
  const actual = texts.map((text) => stripHtmlTags(text).replace(/（续 \d+\/\d+）/g, '')).join('')
  assert.equal(actual, expected)
})

test('Telegram：HTML 模式下无标签但含实体的长文本也不切断实体', async () => {
  const { fetchImpl, captured } = makeFetch(() =>
    jsonResponse({ ok: true, result: { message_id: 560 } }),
  )
  const adapter = new TelegramAdapter({ botUsername: 'MyBot' }, tgSecret(), { fetch: fetchImpl })
  const result = chatResult(
    await adapter.verifyInbound({ botId: 'bot-1', headers: tgHeaders(), body: tgGroupText('@MyBot 实体', 77) }),
  )
  const raw = '&amp;'.repeat(2000)
  await result.reply(raw, { textMode: 'html' })

  assert.ok(captured.length > 1)
  const { texts } = collectHtmlReply(captured)
  for (const text of texts) {
    assert.ok(text.length <= TG_HTML_LIMIT)
    assertEntitiesIntact(text)
    // 无标签文本不应被额外包裹标签。
    assert.equal(text.includes('<'), false)
  }
  const actual = texts.map((text) => text.replace(/（续 \d+\/\d+）/g, '')).join('')
  assert.equal(actual, raw)
})

test('Telegram：链接跨段时重开标签保留原 href', async () => {
  let calls = 0
  const { fetchImpl, captured } = makeFetch(() => {
    calls += 1
    return jsonResponse({ ok: true, result: { message_id: 650 + calls } })
  })
  const adapter = new TelegramAdapter({ botUsername: 'MyBot' }, tgSecret(), { fetch: fetchImpl })
  const result = chatResult(
    await adapter.verifyInbound({ botId: 'bot-1', headers: tgHeaders(), body: tgGroupText('@MyBot 链接', 75) }),
  )
  const href = 'https://example.com/long'
  const html = `<a href="${href}">${'链'.repeat(5000)}</a>`
  await result.reply(html, { textMode: 'html' })

  assert.equal(captured.length, 2)
  const { texts } = collectHtmlReply(captured)
  for (const text of texts) {
    assert.ok(text.length <= TG_HTML_LIMIT)
    assertBalancedHtml(text)
  }
  assert.ok(texts[0]!.endsWith('</a>'))
  assert.ok(texts[1]!.includes(`<a href="${href}">`), '续段必须带原 href 重开链接')
  const actual = texts.map((text) => stripHtmlTags(text).replace(/（续 \d+\/\d+）/g, '')).join('')
  assert.equal(actual, '链'.repeat(5000))
})

test('Telegram：超过最大段数时末段带截断标记，且每段仍合法', async () => {
  const { fetchImpl, captured } = makeFetch(() =>
    jsonResponse({ ok: true, result: { message_id: 600 } }),
  )
  const adapter = new TelegramAdapter({ botUsername: 'MyBot' }, tgSecret(), { fetch: fetchImpl })
  const result = chatResult(
    await adapter.verifyInbound({ botId: 'bot-1', headers: tgHeaders(), body: tgGroupText('@MyBot 超长', 76) }),
  )
  // 20000 字超过 4 段容量，必然触发截断。
  await result.reply(`<b>${'长'.repeat(20000)}</b>`, { textMode: 'html' })

  assert.equal(captured.length, 4)
  const { texts } = collectHtmlReply(captured)
  for (const text of texts) {
    assert.ok(text.length <= TG_HTML_LIMIT)
    assertBalancedHtml(text)
  }
  assert.ok(texts.at(-1)!.endsWith('…（内容过长已截断）'), '末段应带截断标记')
})

test('Telegram：代码块整体跨段时每段 <pre> 成对闭合且内容完整', async () => {
  let calls = 0
  const { fetchImpl, captured } = makeFetch(() => {
    calls += 1
    return jsonResponse({ ok: true, result: { message_id: 800 + calls } })
  })
  const adapter = new TelegramAdapter({ botUsername: 'MyBot' }, tgSecret(), { fetch: fetchImpl })
  const result = chatResult(
    await adapter.verifyInbound({ botId: 'bot-1', headers: tgHeaders(), body: tgGroupText('@MyBot 代码', 72) }),
  )
  const code = Array.from({ length: 400 }, (_value, index) => `const v${index} = ${index}`).join('\n')
  const html = `<pre>${code}</pre>`
  await result.reply(html, { textMode: 'html' })

  assert.ok(captured.length > 1, '代码块应跨段')
  const { texts } = collectHtmlReply(captured)
  for (const [index, text] of texts.entries()) {
    assert.ok(text.length <= TG_HTML_LIMIT, `第 ${index + 1} 段超限：${text.length}`)
    assertBalancedHtml(text)
    // 每段都以 <pre> 开头（首段直接、续段在前缀之后）并以 </pre> 收尾。
    assert.match(text, index === 0 ? /^<pre>/ : /^（续 \d+\/\d+）<pre>/)
    assert.ok(text.endsWith('</pre>'), `第 ${index + 1} 段未闭合代码块`)
  }
  const actual = texts.map((text) => stripHtmlTags(text).replace(/（续 \d+\/\d+）/g, '')).join('')
  assert.equal(actual, code)
})

test('Telegram：HTML 短消息保持原样单段发送，不额外添加标签', async () => {
  const { fetchImpl, captured } = makeFetch(() =>
    jsonResponse({ ok: true, result: { message_id: 700 } }),
  )
  const adapter = new TelegramAdapter(tgSecret(), { fetch: fetchImpl })
  const result = chatResult(
    await adapter.verifyInbound({
      botId: 'bot-1',
      headers: tgHeaders(),
      body: tgMessage({
        message_id: 73,
        text: '你好',
        chat: { id: 100, type: 'private' },
        from: { id: 7 },
      }),
    }),
  )
  const html = '<b>粗体</b> 与 <a href="https://example.com">链接</a>'
  await result.reply(html, { textMode: 'html' })

  assert.equal(captured.length, 1)
  const payload = payloadOf(captured[0]!)
  assert.equal(payload.text, html)
  assert.equal(payload.parse_mode, 'HTML')
})

