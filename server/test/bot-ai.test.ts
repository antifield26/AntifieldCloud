/**
 * OpenCode AI 客户端单元测试：全部使用进程内 fake fetch，不访问真实 OpenCode。
 * 安全边界：测试只断言 Basic 头存在与凭据解码结果，不把密码写入断言消息或测试输出。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../src/config.ts'
import { OpenCodeBotAi } from '../src/bot/ai.ts'
import { AppError } from '../src/util/errors.ts'
import { cleanupDir, tempDataDir, testConfig, testDb } from './helpers.ts'

const BOT_ID = 'bot-ai-test'
const OTHER_BOT_ID = 'bot-ai-other'
const TARGET = 'target-1'
const USER = 'user-1'
const SESSION_ID = 'ses_test_1'
const PASSWORD = 'unit-test-password-not-printed'

interface CapturedCall {
  method: string
  url: URL
  rawUrl: string
  headers: Headers
  body: unknown
  signal: AbortSignal | null
}

type Handler = (call: CapturedCall) => Response | Promise<Response>

interface LogEntry {
  level: 'info' | 'warn' | 'error'
  message: string
  detail?: Record<string, unknown>
}

interface Fixture {
  dir: string
  db: DatabaseSync
  ai: OpenCodeBotAi
  calls: CapturedCall[]
  logs: LogEntry[]
}

interface HandlerOptions {
  sessionStatus?: number
  promptStatus?: number
  waitStatus?: number
  /** 第一次建会话时模拟 OpenCode 拒绝 permissions 字段。 */
  rejectPermissionsFirst?: boolean
  messages?: unknown[] | ((index: number) => unknown[])
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function assistant(content: unknown[]): Record<string, unknown> {
  return {
    id: 'msg_test',
    time: { created: 1 },
    type: 'assistant',
    agent: 'build',
    model: { id: 'test-model', providerID: 'test-provider' },
    content,
  }
}

/** 按请求方法与路径分发的 OpenCode 假服务。 */
function basicHandler(options: HandlerOptions = {}): Handler {
  let messageCalls = 0
  let createCalls = 0
  return (call) => {
    const path = call.url.pathname
    if (call.method === 'POST' && path === '/api/session') {
      createCalls += 1
      if (options.rejectPermissionsFirst && createCalls === 1) {
        return jsonResponse({ _tag: 'InvalidRequestError', message: 'unsupported field', field: 'permissions' }, 400)
      }
      return jsonResponse({ data: { id: SESSION_ID } }, options.sessionStatus ?? 200)
    }
    if (call.method === 'POST' && path === `/api/session/${SESSION_ID}/prompt`) {
      return options.promptStatus
        ? jsonResponse({ _tag: 'InvalidRequestError', message: 'prompt failed' }, options.promptStatus)
        : jsonResponse({ data: { id: 'inbox_test' } })
    }
    if (call.method === 'POST' && path === `/api/experimental/session/${SESSION_ID}/wait`) {
      const status = options.waitStatus ?? 204
      return status === 204
        ? new Response(null, { status })
        : jsonResponse({ _tag: 'SessionNotFoundError', message: 'wait unavailable' }, status)
    }
    if (call.method === 'GET' && path === `/api/session/${SESSION_ID}/message`) {
      messageCalls += 1
      const messages =
        typeof options.messages === 'function'
          ? options.messages(messageCalls)
          : (options.messages ?? [assistant([{ type: 'text', text: '默认回答' }])])
      return jsonResponse({ data: messages, cursor: { previous: null, next: null } })
    }
    return jsonResponse({ _tag: 'UnknownError', message: 'unexpected request' }, 404)
  }
}

function makeFetch(handler: Handler): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    let body: unknown = null
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as unknown
      } catch {
        body = init.body
      }
    }
    const call: CapturedCall = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url: new URL(rawUrl),
      rawUrl,
      headers: new Headers(init?.headers),
      body,
      signal: init?.signal ?? null,
    }
    calls.push(call)
    return handler(call)
  }
  return { fetchImpl: fetchImpl as typeof fetch, calls }
}

function seedBot(db: DatabaseSync, id: string): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO bots
       (id, platform, name, enabled, config_json, secret_ciphertext, secret_iv, secret_tag, key_version, created_at, updated_at)
     VALUES (?, 'telegram', 'AI 测试 Bot', 1, '{}', 'x', 'x', 'x', 1, ?, ?)`,
  ).run(id, now, now)
}

function setup(handler: Handler, overrides: Partial<Config> = {}): Fixture {
  const dir = tempDataDir()
  const db = testDb(dir)
  seedBot(db, BOT_ID)
  const { fetchImpl, calls } = makeFetch(handler)
  const logs: LogEntry[] = []
  const config = testConfig(dir, {
    // 故意保留尾斜杠，验证客户端会归一化 baseUrl。
    opencodeUrl: 'http://127.0.0.1:4096/',
    opencodePassword: PASSWORD,
    botAiProvider: 'test-provider',
    botAiModel: 'test-model',
    botAiTimeoutSeconds: 2,
    botAiSessionRetentionDays: 7,
    ...overrides,
  })
  const ai = new OpenCodeBotAi({
    db,
    config,
    fetch: fetchImpl,
    log: (level, message, detail) => {
      logs.push({ level, message, detail })
    },
  })
  return { dir, db, ai, calls, logs }
}

function dispose(fixture: Fixture): void {
  try {
    fixture.db.close()
  } catch {
    // 测试失败时可能已关闭；Windows 上目录由 cleanupDir 兜底。
  }
  cleanupDir(fixture.dir)
}

function mapping(db: DatabaseSync, botId: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM bot_ai_sessions WHERE bot_id = ?').get(botId) as
    | Record<string, unknown>
    | undefined
}

function assertNoSecret(logs: LogEntry[]): void {
  const serialized = JSON.stringify(logs)
  assert.ok(!serialized.includes(PASSWORD), '日志不含密码')
  assert.ok(!serialized.includes('127.0.0.1'), '日志不含上游 URL')
}

test('首次对话：创建 deny-all 权限会话、发送 prompt、等待 idle 并拼接 assistant 文本', async () => {
  const fixture = setup(
    basicHandler({
      messages: [
        assistant([
          { type: 'reasoning', text: '不应返回的推理' },
          { type: 'text', text: '第一段' },
          { type: 'tool', id: 'tool_1', name: 'bash', state: {}, time: { created: 1 } },
          { type: 'text', text: '第二段' },
        ]),
      ],
    }),
  )
  try {
    const reply = await fixture.ai.chat({
      botId: BOT_ID,
      targetExternalId: TARGET,
      userId: USER,
      mode: 'chat', prompt: '你好',
    })
    assert.equal(reply, '第一段\n第二段')

    const create = fixture.calls.find((call) => call.method === 'POST' && call.url.pathname === '/api/session')
    assert.ok(create, '应创建 OpenCode 会话')
    const createBody = create.body as Record<string, unknown>
    assert.deepEqual(createBody.permissions, [{ action: '*', resource: '*', effect: 'deny' }])
    assert.deepEqual(createBody.model, { providerID: 'test-provider', id: 'test-model' })

    const prompt = fixture.calls.find(
      (call) => call.method === 'POST' && call.url.pathname === `/api/session/${SESSION_ID}/prompt`,
    )
    assert.ok(prompt, '应发送 prompt')
    assert.equal((prompt.body as Record<string, unknown>).text, '你好')

    const wait = fixture.calls.find(
      (call) => call.method === 'POST' && call.url.pathname === `/api/experimental/session/${SESSION_ID}/wait`,
    )
    assert.ok(wait, '应调用 wait 等待 idle')

    const messages = fixture.calls.find(
      (call) => call.method === 'GET' && call.url.pathname === `/api/session/${SESSION_ID}/message`,
    )
    assert.ok(messages, '应读取 assistant 消息')
    assert.equal(messages.url.searchParams.get('order'), 'desc')
    assert.equal(messages.url.searchParams.get('limit'), '20')
    assert.equal(messages.url.searchParams.get('type'), 'assistant')

    assert.ok(fixture.calls.indexOf(create) < fixture.calls.indexOf(prompt), '创建会话应早于发送 prompt')
    assert.ok(fixture.calls.indexOf(prompt) < fixture.calls.indexOf(wait), '发送 prompt 应早于 wait')
    assert.ok(fixture.calls.indexOf(wait) < fixture.calls.indexOf(messages), 'wait 应早于读取消息')

    for (const call of fixture.calls) {
      assert.ok(!call.rawUrl.includes('//api/'), 'baseUrl 不应产生双斜杠')
    }
    assert.ok(create.signal instanceof AbortSignal, '请求应带 AbortSignal 超时')

    const auth = create.headers.get('authorization') ?? ''
    assert.ok(/^Basic [A-Za-z0-9+/=]+$/.test(auth), 'Authorization 应为 Basic 头')
    const decoded = Buffer.from(auth.slice('Basic '.length), 'base64').toString('utf8')
    assert.equal(decoded.split(':')[0], 'opencode')
    assert.ok(decoded.endsWith(`:${PASSWORD}`), 'Basic 认证使用配置凭据')

    const row = mapping(fixture.db, BOT_ID)
    assert.ok(row, '应写入会话映射')
    assert.equal(row.session_id, SESSION_ID)
    assert.equal(row.target_external_id, TARGET)
    assert.equal(row.user_id, USER)
    assert.equal(row.model, 'test-provider/test-model')
    assert.ok(typeof row.updated_at === 'string' && row.updated_at.length > 0)
    assertNoSecret(fixture.logs)
  } finally {
    dispose(fixture)
  }
})

test('第二次对话复用同一 session_id，不重复创建会话', async () => {
  let reply = '第一次回答'
  const fixture = setup(
    basicHandler({
      messages: () => [assistant([{ type: 'text', text: reply }])],
    }),
  )
  try {
    const first = await fixture.ai.chat({
      botId: BOT_ID,
      targetExternalId: TARGET,
      userId: USER,
      mode: 'chat', prompt: '第一次',
    })
    assert.equal(first, '第一次回答')
    fixture.db
      .prepare("UPDATE bot_ai_sessions SET updated_at = '2000-01-01T00:00:00.000Z' WHERE bot_id = ?")
      .run(BOT_ID)

    reply = '第二次回答'
    const second = await fixture.ai.chat({
      botId: BOT_ID,
      targetExternalId: TARGET,
      userId: USER,
      mode: 'chat', prompt: '第二次',
    })
    assert.equal(second, '第二次回答')

    const createCalls = fixture.calls.filter((call) => call.method === 'POST' && call.url.pathname === '/api/session')
    assert.equal(createCalls.length, 1, '只应创建一次会话')
    const promptCalls = fixture.calls.filter(
      (call) => call.method === 'POST' && call.url.pathname === `/api/session/${SESSION_ID}/prompt`,
    )
    assert.equal(promptCalls.length, 2, '两次对话都应发送 prompt')

    const count = fixture.db.prepare('SELECT COUNT(*) AS n FROM bot_ai_sessions').get() as { n: number }
    assert.equal(count.n, 1)
    const row = mapping(fixture.db, BOT_ID)
    assert.ok(row)
    assert.equal(row.session_id, SESSION_ID)
    assert.notEqual(row.updated_at, '2000-01-01T00:00:00.000Z')
    assert.ok(String(row.updated_at) > '2000-01-01T00:00:00.000Z')
  } finally {
    dispose(fixture)
  }
})

test('v0.5.4：task/chat 各自维护会话映射，不互相复用', async () => {
  const fixture = setup(basicHandler())
  try {
    await fixture.ai.chat({
      botId: BOT_ID,
      targetExternalId: TARGET,
      userId: USER,
      mode: 'chat', prompt: '闲聊',
    })
    await fixture.ai.chat({
      botId: BOT_ID,
      targetExternalId: TARGET,
      userId: USER,
      mode: 'task', prompt: '任务',
    })
    const rows = fixture.db
      .prepare('SELECT mode, session_id FROM bot_ai_sessions WHERE bot_id = ? ORDER BY mode')
      .all(BOT_ID) as unknown as { mode: string; session_id: string }[]
    assert.deepEqual(rows.map((row) => row.mode), ['chat', 'task'])
    const createCalls = fixture.calls.filter((call) => call.method === 'POST' && call.url.pathname === '/api/session')
    assert.equal(createCalls.length, 2, '两种模式应各建一次会话')
  } finally {
    dispose(fixture)
  }
})

test('assistant 无文本时抛错，错误与日志不泄漏密码或上游 URL', async () => {
  const fixture = setup(
    basicHandler({
      messages: [
        assistant([
          { type: 'reasoning', text: '只有推理' },
          { type: 'tool', id: 'tool_1', name: 'bash', state: {}, time: { created: 1 } },
        ]),
      ],
    }),
  )
  try {
    await assert.rejects(
      fixture.ai.chat({ botId: BOT_ID, targetExternalId: TARGET, userId: USER, mode: 'chat', prompt: '你好' }),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, 'bot_ai_empty_response')
        assert.ok(!error.message.includes(PASSWORD), '错误消息不含密码')
        assert.ok(!error.message.includes('127.0.0.1'), '错误消息不含上游 URL')
        return true
      },
    )
    assertNoSecret(fixture.logs)
  } finally {
    dispose(fixture)
  }
})

test('wait 返回 404 时回退为 500ms 轮询消息，不忙等', async () => {
  const fixture = setup(
    basicHandler({
      waitStatus: 404,
      messages: (index) =>
        index === 1 ? [] : [assistant([{ type: 'text', text: '轮询回答' }])],
    }),
    { botAiTimeoutSeconds: 2 },
  )
  try {
    const startedAt = Date.now()
    const reply = await fixture.ai.chat({
      botId: BOT_ID,
      targetExternalId: TARGET,
      userId: USER,
      mode: 'chat', prompt: '你好',
    })
    assert.equal(reply, '轮询回答')

    const messageCalls = fixture.calls.filter(
      (call) => call.method === 'GET' && call.url.pathname === `/api/session/${SESSION_ID}/message`,
    )
    assert.ok(messageCalls.length >= 2, '应至少轮询两次')
    assert.ok(Date.now() - startedAt >= 400, '轮询应等待 500ms，不得忙等')
    assert.ok(fixture.logs.some((entry) => entry.message.includes('回退轮询')), '应记录回退原因')
    assertNoSecret(fixture.logs)
  } finally {
    dispose(fixture)
  }
})

test('OpenCode 以 400 拒绝 permissions 时回退并在日志中标注未隔离', async () => {
  const fixture = setup(basicHandler({ rejectPermissionsFirst: true }))
  try {
    const reply = await fixture.ai.chat({
      botId: BOT_ID,
      targetExternalId: TARGET,
      userId: USER,
      mode: 'chat', prompt: '你好',
    })
    assert.equal(reply, '默认回答')

    const createCalls = fixture.calls.filter((call) => call.method === 'POST' && call.url.pathname === '/api/session')
    assert.equal(createCalls.length, 2, '应重试一次创建会话')
    const firstBody = createCalls[0]!.body as Record<string, unknown>
    const secondBody = createCalls[1]!.body as Record<string, unknown>
    assert.ok('permissions' in firstBody)
    assert.ok(!('permissions' in secondBody), '回退请求不应再带 permissions')
    assert.ok(
      fixture.logs.some((entry) => entry.level === 'warn' && entry.message.includes('未隔离')),
      '日志必须明确工具未隔离',
    )
    assertNoSecret(fixture.logs)
  } finally {
    dispose(fixture)
  }
})

test('上游 HTTP 失败抛出短码 AppError，不泄漏密码或 URL', async () => {
  const fixture = setup(basicHandler({ promptStatus: 500 }))
  try {
    await assert.rejects(
      fixture.ai.chat({ botId: BOT_ID, targetExternalId: TARGET, userId: USER, mode: 'chat', prompt: '你好' }),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, 'bot_ai_http_error')
        assert.ok(!error.message.includes(PASSWORD), '错误消息不含密码')
        assert.ok(!error.message.includes('127.0.0.1'), '错误消息不含上游 URL')
        return true
      },
    )
    assertNoSecret(fixture.logs)
  } finally {
    dispose(fixture)
  }
})

test('网络失败归一化为不可达错误，不转发原始异常 URL', async () => {
  const fixture = setup(() => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:4096')
  })
  try {
    await assert.rejects(
      fixture.ai.chat({ botId: BOT_ID, targetExternalId: TARGET, userId: USER, mode: 'chat', prompt: '你好' }),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, 'bot_ai_unavailable')
        assert.ok(!error.message.includes('127.0.0.1'), '错误消息不含上游 URL')
        return true
      },
    )
  } finally {
    dispose(fixture)
  }
})

test('回复超过 4000 字符时截断', async () => {
  const fixture = setup(
    basicHandler({
      messages: [assistant([{ type: 'text', text: '字'.repeat(4500) }])],
    }),
  )
  try {
    const reply = await fixture.ai.chat({
      botId: BOT_ID,
      targetExternalId: TARGET,
      userId: USER,
      mode: 'chat', prompt: '你好',
    })
    assert.equal(reply.length, 4000)
  } finally {
    dispose(fixture)
  }
})

test('cleanup 只删除超过保留期的会话映射', async () => {
  const fixture = setup(basicHandler())
  try {
    seedBot(fixture.db, OTHER_BOT_ID)
    await fixture.ai.chat({ botId: BOT_ID, targetExternalId: TARGET, userId: USER, mode: 'chat', prompt: '旧会话' })
    await fixture.ai.chat({ botId: OTHER_BOT_ID, targetExternalId: TARGET, userId: USER, mode: 'chat', prompt: '新会话' })

    const old = new Date(Date.now() - 8 * 86_400_000).toISOString()
    fixture.db.prepare('UPDATE bot_ai_sessions SET updated_at = ? WHERE bot_id = ?').run(old, BOT_ID)

    const removed = fixture.ai.cleanup()
    assert.equal(removed, 1)
    assert.equal(mapping(fixture.db, BOT_ID), undefined)
    assert.ok(mapping(fixture.db, OTHER_BOT_ID), '未过期映射应保留')
  } finally {
    dispose(fixture)
  }
})
