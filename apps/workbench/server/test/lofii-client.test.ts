/** Lofii 客户端测试：Token 分离、超时/重定向、响应上限、错误码映射与脱敏。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { LofiiClient, LofiiError, LOFII_MAX_RESPONSE_BYTES, type LofiiClientOptions } from '../src/lofii/client.ts'

const BASE = 'http://127.0.0.1:3010'
const READ = 'read-token-secret-0123456789abcdef'
const CONTROL = 'control-token-secret-0123456789abcdef'

interface Call {
  url: string
  init: RequestInit
}

function makeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  impl: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init: init ?? {} })
    return handler(url, init ?? {})
  }) as typeof fetch
  return { impl, calls }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function makeClient(impl: typeof fetch, overrides: Partial<LofiiClientOptions> = {}): LofiiClient {
  return new LofiiClient({
    baseUrl: BASE,
    readToken: READ,
    controlToken: CONTROL,
    timeoutMs: 2500,
    fetch: impl,
    ...overrides,
  })
}

async function expectLofiiError(promise: Promise<unknown>, code: string): Promise<LofiiError> {
  try {
    await promise
    assert.fail(`应抛出 LofiiError(${code})`)
  } catch (error) {
    assert.ok(error instanceof LofiiError, `应为 LofiiError，实际 ${String(error)}`)
    assert.equal(error.code, code)
    return error
  }
}

function authHeader(init: RequestInit): string {
  return String((init.headers as Record<string, string>)?.authorization ?? '')
}

test('status：使用读 Token、GET、redirect:error、带超时信号并解析 JSON', async () => {
  const { impl, calls } = makeFetch(() => json({ version: '0.6.0', state: 'connected' }))
  const client = makeClient(impl)
  const status = await client.status()
  assert.equal(status.version, '0.6.0')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, `${BASE}/status`)
  assert.equal(calls[0]?.init.method, 'GET')
  assert.equal(authHeader(calls[0]!.init), `Bearer ${READ}`)
  assert.equal(calls[0]?.init.redirect, 'error')
  assert.ok(calls[0]?.init.signal instanceof AbortSignal, '应带 AbortSignal.timeout')
})

test('recentEvents：limit 参数、contractVersion/bootId/lastEventId/events 解析', async () => {
  const events = [
    { id: 'b1-1', type: 'alert', ts: '2026-10-01T00:00:01.000Z', data: { type: 'low_health' } },
    { id: 'b1-2', type: 'chat', ts: '2026-10-01T00:00:02.000Z', data: { direction: 'in', message: 'hi' } },
  ]
  const { impl, calls } = makeFetch(() => json({ contractVersion: 1, bootId: 'b1', lastEventId: 'b1-2', events }))
  const client = makeClient(impl)
  const recent = await client.recentEvents(50)
  assert.equal(calls[0]?.url, `${BASE}/events/recent?limit=50`)
  assert.equal(authHeader(calls[0]!.init), `Bearer ${READ}`)
  assert.equal(recent.contractVersion, 1)
  assert.equal(recent.bootId, 'b1')
  assert.equal(recent.lastEventId, 'b1-2')
  assert.deepEqual(recent.events.map((event) => event.id), ['b1-1', 'b1-2'])
  // 非法 limit 回落 100，且上限 200。
  await client.recentEvents(0)
  assert.equal(calls[1]?.url, `${BASE}/events/recent?limit=100`)
  await client.recentEvents(9999)
  assert.equal(calls[2]?.url, `${BASE}/events/recent?limit=200`)
})

test('recentEvents：旧版无 /events/recent（404）暴露 statusCode=404 供服务层降级', async () => {
  const { impl } = makeFetch(() => json({ error: 'not_found', message: 'not found' }, 404))
  const client = makeClient(impl)
  const error = await expectLofiiError(client.recentEvents(), 'lofii_not_found')
  assert.equal(error.statusCode, 404)
})

test('history：把 kind/from/to/limit 透传为查询串，使用读 Token', async () => {
  const { impl, calls } = makeFetch(() => json({ kind: 'samples', from: null, to: null, count: 0, samples: [] }))
  const client = makeClient(impl)
  const body = await client.history('samples', {
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-10-02T00:00:00.000Z',
    limit: 100,
  })
  assert.deepEqual(body, { kind: 'samples', from: null, to: null, count: 0, samples: [] })
  const url = new URL(calls[0]!.url)
  assert.equal(url.pathname, '/history')
  assert.equal(url.searchParams.get('kind'), 'samples')
  assert.equal(url.searchParams.get('from'), '2026-10-01T00:00:00.000Z')
  assert.equal(url.searchParams.get('to'), '2026-10-02T00:00:00.000Z')
  assert.equal(url.searchParams.get('limit'), '100')
  assert.equal(authHeader(calls[0]!.init), `Bearer ${READ}`)
})

test('控制方法：使用控制 Token，/say 使用读 Token', async () => {
  const { impl, calls } = makeFetch(() => json({ ok: true, queued: false, position: null, requestId: 'r1' }))
  const client = makeClient(impl)

  const started = await client.startTask('fishing')
  assert.equal(started.ok, true)
  assert.equal(calls[0]?.url, `${BASE}/task/start`)
  assert.equal(calls[0]?.init.method, 'POST')
  assert.equal(authHeader(calls[0]!.init), `Bearer ${CONTROL}`)
  assert.equal((calls[0]?.init.headers as Record<string, string>)['content-type'], 'application/json; charset=utf-8')
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { name: 'fishing' })

  await client.stopTask()
  assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), {})

  await client.resumeTask()
  assert.deepEqual(JSON.parse(String(calls[2]?.init.body)), {})
  await client.resumeTask('task-1')
  assert.deepEqual(JSON.parse(String(calls[3]?.init.body)), { taskId: 'task-1' })

  await client.move('come', 'Antifield')
  assert.deepEqual(JSON.parse(String(calls[4]?.init.body)), { action: 'come', target: 'Antifield' })
  await client.move('home')
  assert.deepEqual(JSON.parse(String(calls[5]?.init.body)), { action: 'home' })

  await client.say('你好')
  assert.equal(calls[6]?.url, `${BASE}/say`)
  assert.equal(authHeader(calls[6]!.init), `Bearer ${READ}`)
  assert.deepEqual(JSON.parse(String(calls[6]?.init.body)), { message: '你好' })
})

test('控制 Token 为空：控制方法直接 lofii_control_disabled，不发请求；/say 仍可用', async () => {
  const { impl, calls } = makeFetch(() => json({ ok: true, lines: 1 }))
  const client = makeClient(impl, { controlToken: '' })
  const error = await expectLofiiError(client.startTask('fishing'), 'lofii_control_disabled')
  assert.equal(error.statusCode, null)
  assert.equal(calls.length, 0)
  await client.say('只读模式也能说话')
  assert.equal(calls.length, 1)
  assert.equal(authHeader(calls[0]!.init), `Bearer ${READ}`)
})

test('401/403 映射 lofii_auth_failed；错误文本不含 URL/Token', async () => {
  const { impl } = makeFetch(
    () =>
      json(
        {
          error: 'unauthorized',
          message: `invalid token ${READ} for ${BASE} (control ${CONTROL})`,
        },
        401,
      ),
  )
  const client = makeClient(impl)
  const error = await expectLofiiError(client.status(), 'lofii_auth_failed')
  assert.equal(error.statusCode, 401)
  assert.equal(error.message, 'Lofii 鉴权失败（Token 无效）')
  assert.ok(!error.message.includes(READ))
  assert.ok(!error.message.includes(CONTROL))
  assert.ok(!error.message.includes(BASE))
  assert.equal(error.upstreamCode, null)
})

test('上游 4xx：稳定码 lofii_<code> 且保留状态码，message 脱敏', async () => {
  const { impl } = makeFetch(
    () =>
      json(
        {
          error: 'resume_pending',
          message: `pending task; see ${BASE}/task and token ${READ} / ${CONTROL}`,
        },
        409,
      ),
  )
  const client = makeClient(impl)
  const error = await expectLofiiError(client.startTask('fishing'), 'lofii_resume_pending')
  assert.equal(error.statusCode, 409)
  assert.equal(error.upstreamCode, 'resume_pending')
  assert.ok(!error.message.includes(BASE))
  assert.ok(!error.message.includes(READ))
  assert.ok(!error.message.includes(CONTROL))

  const badRequestFetch = makeFetch(() => json({ error: 'invalid_request', message: 'bad name' }, 400))
  const badRequestClient = makeClient(badRequestFetch.impl)
  const invalid = await expectLofiiError(badRequestClient.startTask('nope'), 'lofii_invalid_request')
  assert.equal(invalid.statusCode, 400)
})

test('上游把 Token 回显进 error 字段时，错误码也不携带凭据', async () => {
  const hexToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  const { impl } = makeFetch(() => json({ error: hexToken, message: `bad ${hexToken}` }, 400))
  const client = makeClient(impl, { readToken: hexToken })
  const error = await expectLofiiError(client.status(), 'lofii_invalid_request')
  assert.equal(error.upstreamCode, 'invalid_request')
  assert.ok(!error.code.includes(hexToken), '错误码不得回显 Token')
  assert.ok(!error.message.includes(hexToken), '错误消息不得回显 Token')
})

test('5xx / 非 JSON / 非对象 JSON 统一 lofii_upstream_error', async () => {
  const serverError = makeFetch(() => json({ error: 'internal_error' }, 500))
  const error = await expectLofiiError(makeClient(serverError.impl).status(), 'lofii_upstream_error')
  assert.equal(error.statusCode, 500)

  const badJson = makeFetch(() => new Response('<html>oops</html>', { status: 200 }))
  await expectLofiiError(makeClient(badJson.impl).status(), 'lofii_upstream_error')

  const arrayJson = makeFetch(() => json([1, 2, 3]))
  await expectLofiiError(makeClient(arrayJson.impl).status(), 'lofii_upstream_error')

  const emptyBody = makeFetch(() => new Response('', { status: 200 }))
  await expectLofiiError(makeClient(emptyBody.impl).status(), 'lofii_upstream_error')
})

test('响应体超过 2 MiB 上限拒绝，不解析', async () => {
  const huge = 'x'.repeat(LOFII_MAX_RESPONSE_BYTES + 1024)
  const { impl } = makeFetch(() => new Response(huge, { status: 200 }))
  const error = await expectLofiiError(makeClient(impl).status(), 'lofii_upstream_error')
  assert.match(error.message, /大小上限/)
})

test('网络错误/超时/重定向被拒统一 lofii_unavailable，message 不泄露内部信息', async () => {
  const network = makeFetch(() => {
    throw new TypeError(`fetch failed for ${BASE}/status?token=${READ}`)
  })
  const error = await expectLofiiError(makeClient(network.impl).status(), 'lofii_unavailable')
  assert.equal(error.message, 'Lofii 服务不可用')
  assert.ok(!error.message.includes(BASE))
  assert.ok(!error.message.includes(READ))

  const timeout = makeFetch(() => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  })
  await expectLofiiError(makeClient(timeout.impl).status(), 'lofii_unavailable')

  const redirectBlocked = makeFetch(() => {
    throw new TypeError('unexpected redirect')
  })
  await expectLofiiError(makeClient(redirectBlocked.impl).status(), 'lofii_unavailable')
})

test('上游把 Token 以大小写混合形式回显进 error：同样完全脱敏', async () => {
  const hexToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  const upper = hexToken.toUpperCase()
  const { impl } = makeFetch(() => json({ error: upper, message: `bad ${upper}` }, 400))
  const client = makeClient(impl, { readToken: hexToken })
  const error = await expectLofiiError(client.status(), 'lofii_invalid_request')
  assert.equal(error.upstreamCode, 'invalid_request')
  assert.ok(!error.code.includes(upper.toLowerCase()), '错误码不得回显大小写变换后的 Token')
  assert.ok(!error.message.includes(upper), '错误消息不得回显 Token')
})

test('Token 含 -/_ 等编码变体回显时也不进入错误码', async () => {
  const token = 'abcd-ef01-2345-6789-abcd-ef01-2345-6789-abcdef'
  const { impl } = makeFetch(() => json({ error: token, message: `bad ${token}` }, 400))
  const client = makeClient(impl, { readToken: token })
  const error = await expectLofiiError(client.status(), 'lofii_invalid_request')
  assert.equal(error.upstreamCode, 'invalid_request')
  assert.ok(!error.code.includes('abcd_ef01'), '错误码不得携带归一化后的 Token')
})

test('上游 5xx 明确业务码 task_disabled 保留为 lofii_task_disabled', async () => {
  const { impl } = makeFetch(() => json({ error: 'task_disabled', message: 'tasks disabled' }, 503))
  const error = await expectLofiiError(makeClient(impl).startTask('fishing'), 'lofii_task_disabled')
  assert.equal(error.statusCode, 503)
  assert.equal(error.upstreamCode, 'task_disabled')
})

test('history 形状不合法（kind 不匹配/数组缺失/行非对象）时报上游格式错误', async () => {
  const wrongKind = makeFetch(() => json({ kind: 'alerts', count: 0, alerts: [] }))
  await expectLofiiError(makeClient(wrongKind.impl).history('samples'), 'lofii_upstream_error')

  const missingArray = makeFetch(() => json({ kind: 'samples', count: 0 }))
  await expectLofiiError(makeClient(missingArray.impl).history('samples'), 'lofii_upstream_error')

  const mixedRows = makeFetch(() => json({ kind: 'samples', count: 3, samples: [{ ts: 'x' }, null, 'bad', 3] }))
  const body = await makeClient(mixedRows.impl).history('samples')
  assert.deepEqual(body.samples, [{ ts: 'x' }])
})

test('响应读取失败映射 lofii_unavailable', async () => {
  const { impl } = makeFetch(
    () =>
      ({
        ok: true,
        status: 200,
        arrayBuffer: async () => {
          throw new Error('stream error')
        },
      }) as unknown as Response,
  )
  await expectLofiiError(makeClient(impl).status(), 'lofii_unavailable')
})
