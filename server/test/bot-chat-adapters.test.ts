/**
 * v0.5.2 Bot 平台适配器 Chat/按钮/多附件回归：Telegram、Discord、Slack。
 * 全部使用注入 fetch 与进程内夹具，不访问真实平台网络；不打印或断言任何密钥内容。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { TelegramAdapter } from '../src/bot/adapters/telegram.ts'
import { DiscordAdapter } from '../src/bot/adapters/discord.ts'
import { SlackAdapter } from '../src/bot/adapters/slack.ts'
import { BotPlatformError } from '../src/bot/adapters/http.ts'
import type { BotSecret, BotTargetRow, OutboundMedia } from '../src/bot/types.ts'

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
    quiet_start_minute: null,
    quiet_end_minute: null,
    created_at: '2026-01-01T00:00:00.000Z',
  }
}

function media(filename: string, mime: string, data: string): OutboundMedia {
  return { filename, mime, data: Buffer.from(data) }
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

function tgMessage(overrides: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({ update_id: 1, message: overrides }))
}

test('Telegram：私聊普通文本进入 chat(direct)，回复走 sendMessage', async () => {
  const { fetchImpl, captured } = makeFetch(() => jsonResponse({ ok: true, result: { message_id: 101 } }))
  const adapter = new TelegramAdapter(tgSecret(), { fetch: fetchImpl })
  const result = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: tgHeaders(),
    body: tgMessage({
      message_id: 31,
      text: '  你好  ',
      chat: { id: 100, type: 'private' },
      from: { id: 7, username: 'alice', first_name: 'Alice' },
    }),
  })
  assert.equal(result.kind, 'chat')
  if (result.kind !== 'chat') throw new Error('expected chat')
  assert.equal(result.eventId, 'tg:100:31')
  assert.equal(result.targetExternalId, '100')
  assert.equal(result.targetKind, 'user')
  assert.equal(result.userId, '7')
  assert.equal(result.userName, 'alice')
  assert.equal(result.text, '你好')
  assert.equal(result.isDirect, true)
  assert.equal(result.chatTrigger, 'direct')

  await result.reply('收到')
  const reply = captured.at(-1)!
  assert.match(reply.url, /\/sendMessage$/)
  const payload = JSON.parse(String(reply.init?.body)) as Record<string, unknown>
  assert.equal(payload.chat_id, '100')
  assert.equal(payload.text, '收到')
  assert.equal(payload.reply_markup, undefined)
})

test('Telegram：群 @Bot（entity/纯文本）进入 chat(mention)，按钮编码 inline_keyboard', async () => {
  const { fetchImpl, captured } = makeFetch(() => jsonResponse({ ok: true, result: { message_id: 102 } }))
  const adapter = new TelegramAdapter({ botUsername: 'MyBot' }, tgSecret(), { fetch: fetchImpl })
  const viaEntity = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: tgHeaders(),
    body: tgMessage({
      message_id: 32,
      text: '@MyBot 你好',
      entities: [{ type: 'mention', offset: 0, length: 6 }],
      chat: { id: 200, type: 'group' },
      from: { id: 8, username: 'bob' },
    }),
  })
  assert.equal(viaEntity.kind, 'chat')
  if (viaEntity.kind !== 'chat') throw new Error('expected chat')
  assert.equal(viaEntity.text, '你好')
  assert.equal(viaEntity.targetKind, 'group')
  assert.equal(viaEntity.isDirect, false)
  assert.equal(viaEntity.chatTrigger, 'mention')

  await viaEntity.reply('状态正常', {
    buttons: [
      { id: 'refresh_status', label: '刷新状态' },
      { id: 'help', label: '帮助' },
    ],
  })
  const reply = captured.at(-1)!
  const payload = JSON.parse(String(reply.init?.body)) as Record<string, unknown>
  const markup = payload.reply_markup as { inline_keyboard: Array<Array<Record<string, unknown>>> }
  assert.equal(markup.inline_keyboard[0]?.[0]?.text, '刷新状态')
  assert.equal(markup.inline_keyboard[0]?.[0]?.callback_data, 'refresh_status')
  assert.equal(markup.inline_keyboard[0]?.[1]?.callback_data, 'help')

  const viaText = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: tgHeaders(),
    body: tgMessage({
      message_id: 33,
      text: '请 @mybot 看一下',
      chat: { id: 200, type: 'group' },
      from: { id: 8 },
    }),
  })
  assert.equal(viaText.kind, 'chat')
  if (viaText.kind !== 'chat') throw new Error('expected chat')
  assert.equal(viaText.chatTrigger, 'mention')
  assert.equal(viaText.text, '请 @mybot 看一下')
})

test('Telegram：群回复 Bot 进入 chat(reply)，无关消息与空 @ 消息忽略', async () => {
  const { fetchImpl } = makeFetch(() => jsonResponse({ ok: true, result: { message_id: 103 } }))
  const adapter = new TelegramAdapter({ botUsername: 'MyBot' }, tgSecret(), { fetch: fetchImpl })
  const replied = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: tgHeaders(),
    body: tgMessage({
      message_id: 34,
      text: '继续',
      chat: { id: 200, type: 'group' },
      from: { id: 8 },
      reply_to_message: { message_id: 1, from: { id: 999, is_bot: true } },
    }),
  })
  assert.equal(replied.kind, 'chat')
  if (replied.kind !== 'chat') throw new Error('expected chat')
  assert.equal(replied.chatTrigger, 'reply')
  assert.equal(replied.text, '继续')

  const unrelated = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: tgHeaders(),
    body: tgMessage({
      message_id: 35,
      text: '大家随便聊聊',
      chat: { id: 200, type: 'group' },
      from: { id: 8 },
    }),
  })
  assert.deepEqual(unrelated, { kind: 'ignored' })

  const otherMention = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: tgHeaders(),
    body: tgMessage({
      message_id: 36,
      text: '@Other hi',
      chat: { id: 200, type: 'group' },
      from: { id: 8 },
    }),
  })
  assert.deepEqual(otherMention, { kind: 'ignored' })

  const emptyMention = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: tgHeaders(),
    body: tgMessage({
      message_id: 37,
      text: '@MyBot',
      entities: [{ type: 'mention', offset: 0, length: 6 }],
      chat: { id: 200, type: 'group' },
      from: { id: 8 },
    }),
  })
  assert.deepEqual(emptyMention, { kind: 'ignored' })
})

test('Telegram：未配置用户名时通过 getMe 缓存解析 @Bot', async () => {
  const token = `987654321:${'B'.repeat(35)}`
  let getMeCalls = 0
  const { fetchImpl } = makeFetch((url) => {
    if (url.endsWith('/getMe')) {
      getMeCalls += 1
      return jsonResponse({ ok: true, result: { username: 'AutoBot' } })
    }
    return jsonResponse({ ok: true, result: { message_id: 104 } })
  })
  const adapter = new TelegramAdapter({ token, webhookSecret: TG_WEBHOOK_SECRET }, { fetch: fetchImpl })
  const body = tgMessage({
    message_id: 38,
    text: '@AutoBot 在吗',
    entities: [{ type: 'mention', offset: 0, length: 8 }],
    chat: { id: 200, type: 'group' },
    from: { id: 8 },
  })
  const first = await adapter.verifyInbound({ botId: 'bot-1', headers: tgHeaders(), body })
  assert.equal(first.kind, 'chat')
  const second = await adapter.verifyInbound({ botId: 'bot-1', headers: tgHeaders(), body })
  assert.equal(second.kind, 'chat')
  assert.equal(getMeCalls, 1)
})

test('Telegram：callback_query 映射 action，reply 携带按钮；未知 data 忽略', async () => {
  const { fetchImpl, captured } = makeFetch(() => jsonResponse({ ok: true, result: { message_id: 105 } }))
  const adapter = new TelegramAdapter(tgSecret(), { fetch: fetchImpl })
  const result = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: tgHeaders(),
    body: Buffer.from(
      JSON.stringify({
        update_id: 9,
        callback_query: {
          id: 'cb-1',
          from: { id: 7, username: 'alice' },
          data: 'refresh_status',
          message: { message_id: 55, chat: { id: 100, type: 'private' } },
        },
      }),
    ),
  })
  assert.equal(result.kind, 'action')
  if (result.kind !== 'action') throw new Error('expected action')
  assert.equal(result.action, 'refresh_status')
  assert.equal(result.targetExternalId, '100')
  assert.equal(result.targetKind, 'user')
  assert.equal(result.userId, '7')
  assert.equal(result.isDirect, true)

  await result.reply('已刷新', { buttons: [{ id: 'help', label: '帮助' }] })
  const replyPayload = JSON.parse(String(captured.at(-1)?.init?.body)) as Record<string, unknown>
  const markup = replyPayload.reply_markup as { inline_keyboard: Array<Array<Record<string, unknown>>> }
  assert.equal(markup.inline_keyboard[0]?.[0]?.callback_data, 'help')

  const unknown = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: tgHeaders(),
    body: Buffer.from(
      JSON.stringify({
        update_id: 10,
        callback_query: {
          id: 'cb-2',
          from: { id: 7 },
          data: 'delete_everything',
          message: { chat: { id: 100, type: 'private' } },
        },
      }),
    ),
  })
  assert.deepEqual(unknown, { kind: 'ignored' })

  const badSecret = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: tgHeaders('wrong'),
    body: Buffer.from('{}'),
  })
  assert.deepEqual(badSecret, { kind: 'rejected', status: 401, code: 'invalid_signature' })
})

test('Telegram：多附件相册/逐文件发送、单附件与部分失败', async () => {
  let mode: 'album' | 'sequential' | 'fail' = 'album'
  let call = 0
  const { fetchImpl, captured } = makeFetch((url) => {
    call += 1
    if (mode === 'album') {
      assert.match(url, /\/sendMediaGroup$/)
      return jsonResponse({ ok: true, result: [{ message_id: 201 }, { message_id: 202 }] })
    }
    if (mode === 'fail' && call > 1) return jsonResponse({ ok: false, description: 'boom' })
    return jsonResponse({ ok: true, result: { message_id: 200 + call } })
  })
  const adapter = new TelegramAdapter(tgSecret(), { fetch: fetchImpl })
  const groupTarget = target('group', '200')

  const album = await adapter.send(groupTarget, {
    text: '相册',
    media: [media('a.png', 'image/png', 'a'), media('b.png', 'image/png', 'b')],
  })
  assert.deepEqual(album, { externalId: '201', externalIds: ['201', '202'] })
  assert.equal(captured.length, 1)
  const albumForm = captured[0]!.init?.body as FormData
  const items = JSON.parse(String(albumForm.get('media'))) as Array<Record<string, string>>
  assert.equal(items[0]?.media, 'attach://file0')
  assert.equal(items[1]?.media, 'attach://file1')
  assert.equal(items[0]?.caption, '相册')
  assert.equal((albumForm.get('file0') as File).name, 'a.png')

  mode = 'sequential'
  call = 0
  captured.length = 0
  const sequential = await adapter.send(groupTarget, {
    text: '说明',
    media: [media('a.png', 'image/png', 'a'), media('b.txt', 'text/plain', 'b')],
  })
  assert.deepEqual(sequential, { externalId: '201', externalIds: ['201', '202'] })
  assert.equal(captured.length, 2)
  assert.match(captured[0]!.url, /\/sendPhoto$/)
  assert.match(captured[1]!.url, /\/sendDocument$/)
  assert.equal((captured[0]!.init?.body as FormData).get('caption'), '说明')
  assert.equal((captured[1]!.init?.body as FormData).get('caption'), null)

  mode = 'fail'
  call = 0
  captured.length = 0
  await assert.rejects(
    () =>
      adapter.send(groupTarget, {
        text: '失败',
        media: [media('a.png', 'image/png', 'a'), media('b.txt', 'text/plain', 'b')],
      }),
    (error: unknown) => {
      assert.ok(error instanceof BotPlatformError)
      assert.equal((error as unknown as { sentExternalIds?: string[] }).sentExternalIds?.[0], '201')
      return true
    },
  )

  mode = 'sequential'
  call = 0
  captured.length = 0
  const single = await adapter.send(groupTarget, {
    text: '',
    media: [media('c.png', 'image/png', 'c')],
  })
  assert.equal(single.externalId, '201')
  assert.equal(single.externalIds, undefined)
  assert.match(captured.at(-1)!.url, /\/sendPhoto$/)

  const textOnly = await adapter.send(groupTarget, { text: '纯文本', media: [] })
  assert.equal(textOnly.externalId, '202')
  assert.match(captured.at(-1)!.url, /\/sendMessage$/)

  const long = await adapter.send(groupTarget, { text: '长'.repeat(5000) })
  assert.equal(long.externalId, '203')
  const longPayload = JSON.parse(String(captured.at(-1)?.init?.body)) as Record<string, unknown>
  assert.equal(String(longPayload.text).length, 4096)
})

/* -------------------------------- Discord ------------------------------- */

function discordKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
  return { rawPublic, privateKey }
}

function discordHeaders(
  privateKey: ReturnType<typeof discordKeys>['privateKey'],
  timestamp: string,
  body: Buffer,
) {
  return {
    'x-signature-ed25519': sign(null, Buffer.concat([Buffer.from(timestamp), body]), privateKey).toString('hex'),
    'x-signature-timestamp': timestamp,
    'content-type': 'application/json',
  }
}

function discordAdapter(
  fetchImpl: typeof fetch,
  keys: ReturnType<typeof discordKeys>,
): DiscordAdapter {
  return new DiscordAdapter(
    { applicationId: '123456789012345678', publicKey: keys.rawPublic },
    { token: 'x'.repeat(40) },
    { fetch: fetchImpl },
  )
}

test('Discord：MESSAGE_COMPONENT 映射 action，deferred update 与按钮 follow-up', async () => {
  const keys = discordKeys()
  const { fetchImpl, captured } = makeFetch(() => jsonResponse({ id: 'webhook-msg' }))
  const adapter = discordAdapter(fetchImpl, keys)
  const body = Buffer.from(
    JSON.stringify({
      type: 3,
      id: 'interaction-1',
      token: 'interaction-token',
      channel_id: 'channel-1',
      guild_id: 'guild-1',
      member: { user: { id: 'user-1', username: 'alice' } },
      data: { custom_id: 'refresh_status', component_type: 2 },
    }),
  )
  const timestamp = String(Math.floor(Date.now() / 1000))
  const result = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: discordHeaders(keys.privateKey, timestamp, body),
    body,
  })
  assert.equal(result.kind, 'action')
  if (result.kind !== 'action') throw new Error('expected action')
  assert.equal(result.action, 'refresh_status')
  assert.equal(result.targetExternalId, 'channel-1')
  assert.equal(result.targetKind, 'channel')
  assert.equal(result.userId, 'user-1')
  assert.equal(result.isDirect, false)
  assert.deepEqual(result.immediateResponse, { type: 6 })

  await result.reply('状态已刷新', {
    buttons: [
      { id: 'refresh_status', label: '刷新状态' },
      { id: 'help', label: '帮助' },
    ],
  })
  const reply = captured.at(-1)!
  assert.match(reply.url, /\/webhooks\/123456789012345678\/interaction-token$/)
  const payload = JSON.parse(String(reply.init?.body)) as Record<string, unknown>
  assert.equal(payload.content, '状态已刷新')
  const components = payload.components as Array<{ type: number; components: Array<Record<string, unknown>> }>
  assert.equal(components[0]?.type, 1)
  assert.equal(components[0]?.components[0]?.type, 2)
  assert.equal(components[0]?.components[0]?.style, 2)
  assert.equal(components[0]?.components[0]?.custom_id, 'refresh_status')
  assert.equal(components[0]?.components[1]?.custom_id, 'help')

  const unknownBody = Buffer.from(
    JSON.stringify({
      type: 3,
      id: 'interaction-2',
      token: 'interaction-token',
      channel_id: 'channel-1',
      member: { user: { id: 'user-1' } },
      data: { custom_id: 'not_an_action' },
    }),
  )
  const unknown = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: discordHeaders(keys.privateKey, timestamp, unknownBody),
    body: unknownBody,
  })
  assert.deepEqual(unknown, { kind: 'ignored' })
})

test('Discord：命令回复支持按钮 components', async () => {
  const keys = discordKeys()
  const { fetchImpl, captured } = makeFetch(() => jsonResponse({ id: 'webhook-msg' }))
  const adapter = discordAdapter(fetchImpl, keys)
  const body = Buffer.from(
    JSON.stringify({
      type: 2,
      id: 'interaction-3',
      token: 'interaction-token',
      channel_id: 'channel-1',
      member: { user: { id: 'user-1', username: 'alice' } },
      data: { name: 'status', options: [] },
    }),
  )
  const timestamp = String(Math.floor(Date.now() / 1000))
  const result = await adapter.verifyInbound({
    botId: 'bot-1',
    headers: discordHeaders(keys.privateKey, timestamp, body),
    body,
  })
  assert.equal(result.kind, 'command')
  if (result.kind !== 'command') throw new Error('expected command')
  assert.equal(result.targetKind, 'channel')
  await result.reply('/status 结果', { buttons: [{ id: 'help', label: '帮助' }] })
  const payload = JSON.parse(String(captured.at(-1)?.init?.body)) as Record<string, unknown>
  const components = payload.components as Array<{ components: Array<Record<string, unknown>> }>
  assert.equal(components[0]?.components[0]?.custom_id, 'help')
})

test('Discord：多附件一次 multipart，返回 externalIds；单附件保持 externalId', async () => {
  const keys = discordKeys()
  let handler: FetchHandler = () =>
    jsonResponse({ id: 'msg-1', attachments: [{ id: 'att-1' }, { id: 'att-2' }] })
  const { fetchImpl, captured } = makeFetch((url, init) => handler(url, init))
  const adapter = discordAdapter(fetchImpl, keys)

  const result = await adapter.send(target('channel', 'channel-1'), {
    text: '两个附件',
    media: [media('a.png', 'image/png', 'a'), media('b.txt', 'text/plain', 'b')],
  })
  assert.deepEqual(result, { externalId: 'msg-1', externalIds: ['att-1', 'att-2'] })
  assert.equal(captured.length, 1)
  const form = captured[0]!.init?.body as FormData
  assert.deepEqual(JSON.parse(String(form.get('payload_json'))), { content: '两个附件' })
  assert.equal((form.get('files[0]') as File).name, 'a.png')
  assert.equal((form.get('files[1]') as File).name, 'b.txt')

  handler = () => jsonResponse({ id: 'msg-2' })
  const single = await adapter.send(target('channel', 'channel-1'), {
    text: '',
    media: [media('c.png', 'image/png', 'c')],
  })
  assert.deepEqual(single, { externalId: 'msg-2' })
  const singleForm = captured.at(-1)!.init?.body as FormData
  assert.equal((singleForm.get('files[0]') as File).name, 'c.png')
})

/* -------------------------------- Slack --------------------------------- */

const SLACK_SIGNING_SECRET = 'slack-signing-secret-123456'

function slackHeaders(body: Buffer, secret = SLACK_SIGNING_SECRET) {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body.toString('utf8')}`).digest('hex')}`
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

test('Slack：DM 普通消息进入 chat(direct)，回复走 chat.postMessage', async () => {
  const { fetchImpl, captured } = makeFetch(() => jsonResponse({ ok: true, ts: '1700000000.000100' }))
  const adapter = new SlackAdapter(slackSecret(), { fetch: fetchImpl })
  const body = slackEvent({
    type: 'message',
    channel: 'D1',
    channel_type: 'im',
    user: 'U1',
    text: '你好',
    client_msg_id: 'cm1',
  })
  const result = await adapter.verifyInbound({ botId: 'bot-1', headers: slackHeaders(body), body })
  assert.equal(result.kind, 'chat')
  if (result.kind !== 'chat') throw new Error('expected chat')
  assert.equal(result.eventId, 'slack:Ev-1')
  assert.equal(result.targetExternalId, 'D1')
  assert.equal(result.targetKind, 'channel')
  assert.equal(result.userId, 'U1')
  assert.equal(result.text, '你好')
  assert.equal(result.isDirect, true)
  assert.equal(result.chatTrigger, 'direct')

  await result.reply('收到')
  const reply = captured.at(-1)!
  assert.match(reply.url, /\/chat\.postMessage$/)
  const payload = JSON.parse(String(reply.init?.body)) as Record<string, unknown>
  assert.equal(payload.channel, 'D1')
  assert.equal(payload.text, '收到')
})

test('Slack：app_mention 与消息内 <@BOTID> 进入 chat(mention)，无关消息与 Bot 消息忽略', async () => {
  const { fetchImpl, captured } = makeFetch(() => jsonResponse({ ok: true, ts: '1700000000.000200' }))
  const adapter = new SlackAdapter({ botUserId: 'UBOT' }, slackSecret(), { fetch: fetchImpl })

  const mentionBody = slackEvent({
    type: 'app_mention',
    channel: 'C1',
    user: 'U2',
    text: '<@UBOT> 状态如何',
  })
  const mention = await adapter.verifyInbound({ botId: 'bot-1', headers: slackHeaders(mentionBody), body: mentionBody })
  assert.equal(mention.kind, 'chat')
  if (mention.kind !== 'chat') throw new Error('expected chat')
  assert.equal(mention.text, '状态如何')
  assert.equal(mention.targetKind, 'channel')
  assert.equal(mention.isDirect, false)
  assert.equal(mention.chatTrigger, 'mention')

  const messageBody = slackEvent({
    type: 'message',
    channel: 'C1',
    channel_type: 'channel',
    user: 'U3',
    text: '<@UBOT> 帮我看下',
  })
  const message = await adapter.verifyInbound({ botId: 'bot-1', headers: slackHeaders(messageBody), body: messageBody })
  assert.equal(message.kind, 'chat')
  if (message.kind !== 'chat') throw new Error('expected chat')
  assert.equal(message.text, '帮我看下')
  assert.equal(message.chatTrigger, 'mention')

  const unrelatedBody = slackEvent({
    type: 'message',
    channel: 'C1',
    channel_type: 'channel',
    user: 'U3',
    text: '普通聊天',
  })
  const unrelated = await adapter.verifyInbound({ botId: 'bot-1', headers: slackHeaders(unrelatedBody), body: unrelatedBody })
  assert.deepEqual(unrelated, { kind: 'ignored' })

  const botBody = slackEvent({
    type: 'message',
    channel: 'C1',
    channel_type: 'channel',
    bot_id: 'B1',
    user: 'U3',
    text: '<@UBOT> 机器人自己',
  })
  const botMessage = await adapter.verifyInbound({ botId: 'bot-1', headers: slackHeaders(botBody), body: botBody })
  assert.deepEqual(botMessage, { kind: 'ignored' })

  // 无公开配置时使用事件 authorizations 中的 Bot user_id。
  const authorizedBody = slackEvent(
    {
      type: 'message',
      channel: 'C2',
      channel_type: 'channel',
      user: 'U4',
      text: '<@UAUTH> 在吗',
    },
    { authorizations: [{ user_id: 'UAUTH' }] },
  )
  const unconfigured = new SlackAdapter(slackSecret(), { fetch: fetchImpl })
  const authorized = await unconfigured.verifyInbound({
    botId: 'bot-1',
    headers: slackHeaders(authorizedBody),
    body: authorizedBody,
  })
  assert.equal(authorized.kind, 'chat')
  if (authorized.kind !== 'chat') throw new Error('expected chat')
  assert.equal(authorized.text, '在吗')
  assert.equal(captured.length, 0)
})

test('Slack：多附件逐文件上传后一次完成，返回 externalIds；部分失败抛错', async () => {
  let mode: 'multi' | 'single' | 'fail' = 'multi'
  let uploads = 0
  const { fetchImpl, captured } = makeFetch((url) => {
    if (url.includes('files.getUploadURLExternal')) {
      uploads += 1
      if (mode === 'fail' && uploads === 2) return jsonResponse({ ok: false, error: 'ratelimited' })
      return jsonResponse({
        ok: true,
        upload_url: `https://files.slack.com/upload/${uploads}`,
        file_id: `F${uploads}`,
      })
    }
    if (url.startsWith('https://files.slack.com/upload/')) return new Response('', { status: 200 })
    if (url.includes('files.completeUploadExternal')) {
      return jsonResponse({ ok: true, files: [{ id: 'F1' }, { id: 'F2' }] })
    }
    return jsonResponse({ ok: false, error: 'unexpected' })
  })
  const adapter = new SlackAdapter(slackSecret(), { fetch: fetchImpl })

  const multi = await adapter.send(target('channel', 'C1'), {
    text: '两个附件',
    media: [media('a.png', 'image/png', 'a'), media('b.txt', 'text/plain', 'b')],
  })
  assert.deepEqual(multi, { externalId: 'F1', externalIds: ['F1', 'F2'] })
  const complete = captured.find((item) => item.url.includes('files.completeUploadExternal'))
  assert.ok(complete)
  const completePayload = JSON.parse(String(complete.init?.body)) as Record<string, unknown>
  assert.equal((completePayload.files as unknown[]).length, 2)
  assert.equal(completePayload.channel_id, 'C1')
  assert.equal(completePayload.initial_comment, '两个附件')

  mode = 'single'
  uploads = 0
  captured.length = 0
  const single = await adapter.send(target('channel', 'C1'), {
    text: '',
    media: [media('c.png', 'image/png', 'c')],
  })
  assert.equal(single.externalId, 'F1')
  assert.equal(single.externalIds, undefined)

  mode = 'fail'
  uploads = 0
  captured.length = 0
  await assert.rejects(
    () =>
      adapter.send(target('channel', 'C1'), {
        text: '',
        media: [media('a.png', 'image/png', 'a'), media('b.png', 'image/png', 'b')],
      }),
    (error: unknown) => {
      assert.ok(error instanceof BotPlatformError)
      assert.equal((error as unknown as { sentExternalIds?: string[] }).sentExternalIds?.[0], 'F1')
      return true
    },
  )
})
