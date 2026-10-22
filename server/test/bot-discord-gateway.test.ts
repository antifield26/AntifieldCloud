/**
 * Discord Gateway 管理器回归：使用注入的假 WebSocket 覆盖连接、IDENTIFY、心跳、消息解析、
 * 停止、RECONNECT/RESUME 与不可重试关闭码。
 * 测试不访问真实 Discord，也不读写数据库/文件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DISCORD_GATEWAY_INTENTS,
  DISCORD_GATEWAY_URL,
  DiscordGatewayManager,
} from '../src/bot/discord-gateway.ts'
import type {
  DiscordGatewayBot,
  DiscordGatewayLogLevel,
  DiscordGatewayMessage,
  WebSocketCloseEventLike,
  WebSocketLike,
} from '../src/bot/discord-gateway.ts'

interface CapturedLog {
  level: DiscordGatewayLogLevel
  message: string
  detail?: Record<string, unknown>
}

class FakeSocket implements WebSocketLike {
  readonly url: string
  readonly sent: string[] = []
  readonly closeCalls: Array<{ code?: number; reason?: string }> = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: WebSocketCloseEventLike) => void) | null = null

  constructor(url: string) {
    this.url = url
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason })
  }

  open(): void {
    this.onopen?.()
  }

  dispatch(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }

  dispatchRaw(data: unknown): void {
    this.onmessage?.({ data })
  }

  closeFromServer(code: number, reason = ''): void {
    this.onclose?.({ code, reason, wasClean: false })
  }

  payloads(): Array<Record<string, unknown>> {
    return this.sent.map((item) => JSON.parse(item) as Record<string, unknown>)
  }

  findOperation(op: number): Record<string, unknown> | undefined {
    return this.payloads().find((payload) => payload.op === op)
  }

  heartbeats(): Array<Record<string, unknown>> {
    return this.payloads().filter((payload) => payload.op === 1)
  }
}

function setup(
  options: {
    bots?: DiscordGatewayBot[]
    enabled?: boolean
    onMessage?: (event: DiscordGatewayMessage) => void
    now?: () => Date
  } = {},
) {
  const sockets: FakeSocket[] = []
  const logs: CapturedLog[] = []
  const messages: DiscordGatewayMessage[] = []
  const bots: DiscordGatewayBot[] = options.bots ?? [
    { botId: 'bot-1', token: 'discord-token-1', enabled: true },
  ]
  const manager = new DiscordGatewayManager({
    enabled: options.enabled ?? true,
    getBots: () => bots,
    log: (level, message, detail) => {
      logs.push({ level, message, detail })
    },
    onMessage:
      options.onMessage ??
      ((event) => {
        messages.push(event)
      }),
    webSocketFactory: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    now: options.now ?? (() => new Date('2026-10-21T12:00:00.000Z')),
  })
  return { manager, sockets, logs, messages, bots }
}

/** 模拟一次完整握手：OPEN → HELLO → READY。 */
function ready(
  socket: FakeSocket,
  options: {
    userId?: string
    sessionId?: string
    resumeUrl?: string
    heartbeatInterval?: number
    seq?: number
  } = {},
): void {
  socket.open()
  socket.dispatch({ op: 10, d: { heartbeat_interval: options.heartbeatInterval ?? 60_000 } })
  socket.dispatch({
    op: 0,
    t: 'READY',
    s: options.seq ?? 1,
    d: {
      session_id: options.sessionId ?? 'sess-1',
      resume_gateway_url: options.resumeUrl ?? 'wss://resume.discord.gg',
      user: { id: options.userId ?? 'bot-user' },
    },
  })
}

function dispatchMessage(
  socket: FakeSocket,
  id: string,
  fields: Record<string, unknown> = {},
  seq = 1,
): void {
  socket.dispatch({
    op: 0,
    t: 'MESSAGE_CREATE',
    s: seq,
    d: {
      id,
      channel_id: 'chan-1',
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

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('Discord Gateway：start 仅连接启用且带 Token 的 Discord Bot', () => {
  const { manager, sockets, logs } = setup({
    bots: [
      { botId: 'bot-enabled', token: 'token-enabled-value', enabled: true },
      { botId: 'bot-disabled', token: 'token-disabled-value', enabled: false },
      { botId: 'bot-no-token', token: '', enabled: true },
    ],
  })
  try {
    manager.start()
    assert.equal(sockets.length, 1)
    assert.equal(sockets[0]?.url, DISCORD_GATEWAY_URL)
    assert.deepEqual(manager.status('bot-enabled'), { state: 'connecting', lastError: null })
    assert.deepEqual(manager.status('bot-disabled'), { state: 'disabled', lastError: null })
    assert.deepEqual(manager.status('bot-no-token'), { state: 'disabled', lastError: null })
    assert.deepEqual(manager.status('unknown-bot'), { state: 'disabled', lastError: null })
    // 日志不得包含 Token。
    assert.ok(!JSON.stringify(logs).includes('token-enabled-value'))
    assert.ok(!JSON.stringify(logs).includes('token-disabled-value'))
  } finally {
    manager.stop()
  }
})

test('Discord Gateway：HELLO 后发送 IDENTIFY（intents=37377）并按间隔心跳', async () => {
  const { manager, sockets } = setup()
  try {
    manager.start()
    const socket = sockets[0]
    assert.ok(socket)
    ready(socket, { heartbeatInterval: 200, seq: 42 })
    assert.equal(manager.status('bot-1').state, 'connected')

    const identify = socket.findOperation(2)
    assert.ok(identify)
    const identifyData = identify.d as Record<string, unknown>
    assert.equal(identifyData.token, 'discord-token-1')
    assert.equal(identifyData.intents, 37377)
    assert.equal(DISCORD_GATEWAY_INTENTS, 37377)
    assert.ok(identifyData.properties && typeof identifyData.properties === 'object')
    assert.equal(socket.findOperation(6), undefined)

    await waitFor(() => socket.heartbeats().length >= 1)
    assert.equal(socket.heartbeats()[0]?.d, 42)
    socket.dispatch({ op: 11 })
    await waitFor(() => socket.heartbeats().length >= 2)

    // 非法 JSON 不抛出，连接保持可用。
    socket.dispatchRaw('not-json')
    await flush()
    assert.equal(manager.status('bot-1').state, 'connected')
  } finally {
    manager.stop()
  }
})

test('Discord Gateway：MESSAGE_CREATE 解析频道/DM/mention/reply 并忽略 bot', async () => {
  const messages: DiscordGatewayMessage[] = []
  const { manager, sockets } = setup({
    onMessage: (event) => {
      messages.push(event)
    },
  })
  try {
    manager.start()
    const socket = sockets[0]
    assert.ok(socket)
    ready(socket)

    dispatchMessage(socket, 'msg-mention', {
      content: '<@bot-user> 你好',
      mentions: [{ id: 'bot-user' }],
    })
    dispatchMessage(socket, 'msg-reply', {
      content: '回复内容',
      referenced_message: { author: { id: 'bot-user' } },
    })
    dispatchMessage(socket, 'msg-reply-priority', {
      content: '两者都有',
      mentions: [{ id: 'bot-user' }],
      referenced_message: { author: { id: 'bot-user' } },
    })
    dispatchMessage(socket, 'msg-dm', {
      channel_id: 'dm-1',
      guild_id: undefined,
      content: '私聊',
      mentions: [],
    })
    dispatchMessage(socket, 'msg-dm-priority', {
      channel_id: 'dm-2',
      guild_id: undefined,
      content: '私聊回复',
      mentions: [{ id: 'bot-user' }],
      referenced_message: { author: { id: 'bot-user' } },
    })
    dispatchMessage(socket, 'msg-self', {
      author: { id: 'bot-user', username: 'self', bot: true },
      content: '自己发的',
    })
    dispatchMessage(socket, 'msg-other-bot', {
      author: { id: 'other-bot', username: 'other', bot: true },
      content: '其它 Bot',
    })
    dispatchMessage(socket, 'msg-webhook', {
      author: { id: 'webhook-user', username: 'hook', bot: false },
      webhook_id: 'wh-1',
      content: 'webhook',
    })
    dispatchMessage(socket, 'msg-empty', { content: '   ' })
    dispatchMessage(socket, 'msg-plain', { content: '普通频道消息' })
    dispatchMessage(socket, 'msg-other-mention', {
      content: '<@someone>',
      mentions: [{ id: 'someone' }],
    })
    await flush()

    assert.equal(messages.length, 5)
    const byId = new Map(messages.map((event) => [event.eventId, event]))
    assert.deepEqual(byId.get('dc_msg:msg-mention'), {
      botId: 'bot-1',
      eventId: 'dc_msg:msg-mention',
      messageId: 'msg-mention',
      targetExternalId: 'chan-1',
      targetKind: 'channel',
      userId: 'user-1',
      userName: 'alice',
      text: '<@bot-user> 你好',
      isDirect: false,
      chatTrigger: 'mention',
    })
    assert.equal(byId.get('dc_msg:msg-reply')?.chatTrigger, 'reply')
    assert.equal(byId.get('dc_msg:msg-reply-priority')?.chatTrigger, 'reply')
    assert.equal(byId.get('dc_msg:msg-dm')?.isDirect, true)
    assert.equal(byId.get('dc_msg:msg-dm')?.targetKind, 'channel')
    assert.equal(byId.get('dc_msg:msg-dm')?.chatTrigger, 'direct')
    assert.equal(byId.get('dc_msg:msg-dm-priority')?.chatTrigger, 'direct')
    for (const ignored of [
      'msg-self',
      'msg-other-bot',
      'msg-webhook',
      'msg-empty',
      'msg-plain',
      'msg-other-mention',
    ]) {
      assert.equal(byId.has(`dc_msg:${ignored}`), false)
    }
  } finally {
    manager.stop()
  }
})

test('Discord Gateway：wake 跳过退避立即重连', () => {
  const { manager, sockets } = setup()
  try {
    manager.start()
    ready(sockets[0]!)
    sockets[0]!.closeFromServer(4000)
    assert.equal(sockets.length, 1)
    manager.wake()
    assert.equal(sockets.length, 2)
  } finally {
    manager.stop()
  }
})

test('Discord Gateway：stop 关闭连接并停止重连', async () => {
  const { manager, sockets } = setup()
  try {
    manager.start()
    const socket = sockets[0]
    assert.ok(socket)
    ready(socket)

    manager.stop()
    assert.deepEqual(manager.status('bot-1'), { state: 'disabled', lastError: null })
    assert.equal(socket.closeCalls.length, 1)
    assert.equal(socket.closeCalls[0]?.code, 1000)

    await flush()
    manager.sync()
    await flush()
    assert.equal(sockets.length, 1)
  } finally {
    manager.stop()
  }
})

test('Discord Gateway：RECONNECT 后按 resume_gateway_url 发送 RESUME', async () => {
  const { manager, sockets } = setup()
  try {
    manager.start()
    const first = sockets[0]
    assert.ok(first)
    ready(first, { sessionId: 'sess-abc', seq: 7 })

    first.dispatch({ op: 7 })
    await waitFor(() => sockets.length === 2)
    const second = sockets[1]
    assert.ok(second)
    assert.equal(first.closeCalls.length, 1)
    assert.equal(second.url, 'wss://resume.discord.gg/?v=10&encoding=json')
    assert.equal(manager.status('bot-1').state, 'reconnecting')

    second.open()
    second.dispatch({ op: 10, d: { heartbeat_interval: 60_000 } })
    const resume = second.findOperation(6)
    assert.ok(resume)
    assert.deepEqual(resume.d, { token: 'discord-token-1', session_id: 'sess-abc', seq: 7 })
    assert.equal(second.findOperation(2), undefined)

    second.dispatch({ op: 0, t: 'RESUMED', s: 8, d: {} })
    assert.equal(manager.status('bot-1').state, 'connected')
  } finally {
    manager.stop()
  }
})

test('Discord Gateway：INVALID_SESSION 清空会话并进入重连', () => {
  const { manager, sockets } = setup()
  try {
    manager.start()
    const socket = sockets[0]
    assert.ok(socket)
    ready(socket, { sessionId: 'sess-old', seq: 9 })

    socket.dispatch({ op: 9, d: false })
    assert.equal(socket.closeCalls.length, 1)
    assert.equal(manager.status('bot-1').state, 'reconnecting')
  } finally {
    manager.stop()
  }
})

test('Discord Gateway：4014/4004 标记 error 并停止自动重连', () => {
  for (const code of [4014, 4004]) {
    const { manager, sockets, logs } = setup()
    try {
      manager.start()
      const socket = sockets[0]
      assert.ok(socket)
      socket.open()
      socket.dispatch({ op: 10, d: { heartbeat_interval: 60_000 } })
      socket.closeFromServer(code, code === 4014 ? 'Disallowed intent(s)' : 'Authentication failed')

      const status = manager.status('bot-1')
      assert.equal(status.state, 'error')
      assert.ok(status.lastError?.includes(String(code)))
      assert.equal(sockets.length, 1)
      assert.equal(logs.some((entry) => entry.message.includes('准备重连')), false)
      assert.ok(!JSON.stringify(logs).includes('discord-token-1'))
    } finally {
      manager.stop()
    }
  }
})

test('Discord Gateway：sync 在 Token 变化时重建连接、禁用时关闭', () => {
  const { manager, sockets, bots, logs } = setup()
  try {
    manager.start()
    const first = sockets[0]
    assert.ok(first)
    ready(first)

    const bot = bots[0]
    assert.ok(bot)
    bot.token = 'discord-token-2'
    manager.sync()
    assert.equal(first.closeCalls.length, 1)
    assert.equal(sockets.length, 2)

    const second = sockets[1]
    assert.ok(second)
    assert.equal(second.url, DISCORD_GATEWAY_URL)
    second.open()
    second.dispatch({ op: 10, d: { heartbeat_interval: 60_000 } })
    const identify = second.findOperation(2)
    assert.ok(identify)
    assert.equal((identify.d as Record<string, unknown>).token, 'discord-token-2')
    assert.equal(second.findOperation(6), undefined)
    second.dispatch({
      op: 0,
      t: 'READY',
      s: 1,
      d: {
        session_id: 'sess-2',
        resume_gateway_url: 'wss://resume.discord.gg',
        user: { id: 'bot-user' },
      },
    })
    assert.equal(manager.status('bot-1').state, 'connected')

    bot.enabled = false
    manager.sync()
    assert.equal(second.closeCalls.length, 1)
    assert.deepEqual(manager.status('bot-1'), { state: 'disabled', lastError: null })
    assert.ok(!JSON.stringify(logs).includes('discord-token-1'))
    assert.ok(!JSON.stringify(logs).includes('discord-token-2'))
  } finally {
    manager.stop()
  }
})

test('Discord Gateway：总开关关闭时不建立连接', () => {
  const { manager, sockets } = setup({ enabled: false })
  try {
    manager.start()
    assert.equal(sockets.length, 0)
    assert.deepEqual(manager.status('bot-1'), { state: 'disabled', lastError: null })
    manager.sync()
    assert.equal(sockets.length, 0)
  } finally {
    manager.stop()
  }
})

test('Discord Gateway：onMessage 异步异常被捕获且不打断连接', async () => {
  const { manager, sockets, logs } = setup({
    onMessage: async () => {
      throw new Error('handler failure')
    },
  })
  try {
    manager.start()
    const socket = sockets[0]
    assert.ok(socket)
    ready(socket)
    dispatchMessage(socket, 'msg-error', {
      content: '<@bot-user> 会失败',
      mentions: [{ id: 'bot-user' }],
    })
    await flush()

    assert.equal(manager.status('bot-1').state, 'connected')
    assert.ok(logs.some((entry) => entry.level === 'warn' && entry.message.includes('消息处理失败')))
  } finally {
    manager.stop()
  }
})
