/** Lofii 路由与接线测试：认证/CSRF/校验/限流/错误映射/审计/历史透传/version 字段。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'
import type { Config } from '../src/config.ts'
import { buildApp } from '../src/app.ts'
import { DashboardService } from '../src/dashboard/service.ts'
import { FileService } from '../src/files/service.ts'
import { LofiiClient } from '../src/lofii/client.ts'
import { LofiiService } from '../src/lofii/service.ts'
import { MinecraftService } from '../src/mc/service.ts'
import { registerDashboardRoutes } from '../src/http/routes/dashboard.ts'
import { registerLofiiRoutes } from '../src/http/routes/lofii.ts'
import { createSession } from '../src/auth/sessions.ts'
import { cleanupDir, seedAdmin, tempDataDir, testConfig, testDb } from './helpers.ts'
import { authHeaders, createAuthedApp, csrfHeadersOnly, phase2Fixture, type Phase2Fixture } from './phase2-fixtures.ts'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>

function defaultHandler(url: URL): Response {
  if (url.pathname === '/status') return json({ version: '0.6.0', state: 'connected', task: { state: 'idle' } })
  if (url.pathname === '/events/recent') {
    return json({ contractVersion: 1, bootId: 'b1', lastEventId: null, events: [] })
  }
  if (url.pathname === '/history') {
    const kind = url.searchParams.get('kind') ?? 'samples'
    return json({ kind, from: null, to: null, count: 0, [kind]: [] })
  }
  if (url.pathname === '/task/start') {
    return json(
      { ok: true, queued: true, position: 1, requestId: 'r1', task: { name: 'fishing', state: 'running' } },
      202,
    )
  }
  if (url.pathname === '/task/stop') {
    return json({ ok: true, requestId: 'r2', task: { active: false, state: 'idle' } }, 202)
  }
  if (url.pathname === '/task/resume') {
    return json({ ok: true, requestId: 'r3', task: { state: 'running' } }, 202)
  }
  if (url.pathname === '/move') return json({ ok: true, requestId: 'r4', action: 'home', target: null }, 202)
  if (url.pathname === '/say') return json({ ok: true, lines: 1 })
  return json({ error: 'not_found', message: 'not found' }, 404)
}

interface LofiiAppFixture {
  fixture: Phase2Fixture
  app: FastifyInstance
  service: LofiiService
  calls: { url: URL; init: RequestInit }[]
  close: () => Promise<void>
}

async function makeLofiiApp(options: { config?: Partial<Config>; handler?: Handler } = {}): Promise<LofiiAppFixture> {
  const fixture = phase2Fixture({
    lofiiEnabled: true,
    lofiiReadToken: 'read-token',
    lofiiControlToken: 'control-token',
    lofiiPollMs: 60_000,
    lofiiTimeoutMs: 500,
    ...options.config,
  })
  const calls: { url: URL; init: RequestInit }[] = []
  const handler = options.handler ?? defaultHandler
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    calls.push({ url, init: init ?? {} })
    return handler(url, init ?? {})
  }) as typeof fetch
  const client = new LofiiClient({
    baseUrl: fixture.config.lofiiUrl,
    readToken: fixture.config.lofiiReadToken,
    controlToken: fixture.config.lofiiControlToken,
    timeoutMs: fixture.config.lofiiTimeoutMs,
    fetch: impl,
  })
  const service = new LofiiService({
    db: fixture.db,
    config: fixture.config,
    alerts: { recordExternal: () => 1 },
    client,
    log: () => {},
  })
  const app = await createAuthedApp(fixture.db, (instance) => {
    registerLofiiRoutes(instance, fixture.config, service, fixture.db)
  })
  return {
    fixture,
    app,
    service,
    calls,
    close: async () => {
      service.stop()
      await app.close()
      fixture.close()
    },
  }
}

function authOf(call: { init: RequestInit }): string {
  return String((call.init.headers as Record<string, string>)?.authorization ?? '')
}

function auditRows(db: Phase2Fixture['db']): { action: string; target: string | null; detail_json: string | null }[] {
  return db.prepare('SELECT action, target, detail_json FROM audit_log ORDER BY id ASC').all() as unknown as {
    action: string
    target: string | null
    detail_json: string | null
  }[]
}

const SENSITIVE = ['read-token', 'control-token', '127.0.0.1:3010']

test('GET /api/lofii/status：登录校验、快照字段（含 eventsSupported）与禁用降级', async () => {
  const fx = await makeLofiiApp()
  try {
    const anonymous = await fx.app.inject({ method: 'GET', url: '/api/lofii/status' })
    assert.equal(anonymous.statusCode, 401)

    const before = await fx.app.inject({ method: 'GET', url: '/api/lofii/status', headers: authHeaders() })
    assert.equal(before.statusCode, 200)
    const initial = before.json() as Record<string, unknown>
    assert.equal(initial.enabled, true)
    assert.equal(initial.reachable, false)
    assert.equal(initial.eventsSupported, true)
    assert.equal(initial.controlEnabled, true)
    assert.equal(initial.alertsEnabled, true)
    assert.equal(initial.lastPollAt, null)
    assert.deepEqual(initial.events, [])

    await fx.service.pollOnce()
    const after = await fx.app.inject({ method: 'GET', url: '/api/lofii/status', headers: authHeaders() })
    const body = after.json() as Record<string, unknown>
    assert.equal(body.reachable, true)
    assert.equal(body.stale, false)
    assert.equal(body.version, '0.6.0')
    assert.equal(body.contractVersion, 1)
    assert.equal(body.eventsSupported, true)
    assert.equal(body.error, null)
    assert.equal(typeof body.lastPollAt, 'string')
    assert.deepEqual(body.status, { version: '0.6.0', state: 'connected', task: { state: 'idle' } })
    assert.deepEqual(body.events, [])
  } finally {
    await fx.close()
  }

  const disabled = await makeLofiiApp({ config: { lofiiEnabled: false } })
  try {
    const status = await disabled.app.inject({ method: 'GET', url: '/api/lofii/status', headers: authHeaders() })
    assert.equal(status.statusCode, 200)
    const body = status.json() as Record<string, unknown>
    assert.equal(body.enabled, false)
    assert.equal(body.eventsSupported, false)
    assert.deepEqual(body.events, [])
    assert.equal(disabled.calls.length, 0)

    const blocked = await disabled.app.inject({
      method: 'POST',
      url: '/api/lofii/tasks/stop',
      headers: authHeaders(),
    })
    assert.equal(blocked.statusCode, 503)
    assert.equal(blocked.json().error.code, 'lofii_disabled')

    const history = await disabled.app.inject({ method: 'GET', url: '/api/lofii/history', headers: authHeaders() })
    assert.equal(history.statusCode, 503)
    assert.equal(history.json().error.code, 'lofii_disabled')
  } finally {
    await disabled.close()
  }
})

test('控制路由：CSRF、上游字段保留、审计动作（不记 say 正文）', async () => {
  const fx = await makeLofiiApp()
  try {
    const noCsrf = await fx.app.inject({
      method: 'POST',
      url: '/api/lofii/tasks',
      headers: csrfHeadersOnly(),
      payload: { name: 'fishing' },
    })
    assert.equal(noCsrf.statusCode, 403)
    assert.equal(noCsrf.json().error.code, 'csrf_failed')

    const started = await fx.app.inject({
      method: 'POST',
      url: '/api/lofii/tasks',
      headers: authHeaders(),
      payload: { name: 'fishing' },
    })
    assert.equal(started.statusCode, 200)
    const startBody = started.json() as Record<string, unknown>
    assert.equal(startBody.ok, true)
    assert.equal(startBody.queued, true, '必须保留上游 queued 字段')
    assert.equal(startBody.position, 1, '必须保留上游 position 字段')
    assert.equal((startBody.task as { name?: string }).name, 'fishing')
    assert.equal(authOf(fx.calls[0]!), 'Bearer control-token')

    const stopped = await fx.app.inject({ method: 'POST', url: '/api/lofii/tasks/stop', headers: authHeaders() })
    assert.equal(stopped.statusCode, 200)
    assert.equal(stopped.json().ok, true)

    const resumed = await fx.app.inject({
      method: 'POST',
      url: '/api/lofii/tasks/resume',
      headers: authHeaders(),
      payload: { taskId: 'task-1' },
    })
    assert.equal(resumed.statusCode, 200)
    assert.equal(resumed.json().ok, true)

    const moved = await fx.app.inject({
      method: 'POST',
      url: '/api/lofii/move',
      headers: authHeaders(),
      payload: { action: 'come', target: 'Antifield' },
    })
    assert.equal(moved.statusCode, 200)
    assert.equal(moved.json().ok, true)

    const secret = '这是一条聊天正文'
    const said = await fx.app.inject({
      method: 'POST',
      url: '/api/lofii/say',
      headers: authHeaders(),
      payload: { message: secret },
    })
    assert.equal(said.statusCode, 200)
    assert.equal(said.json().ok, true)
    const sayCall = fx.calls.find((call) => call.url.pathname === '/say')
    assert.ok(sayCall)
    assert.equal(authOf(sayCall), 'Bearer read-token', '/say 必须使用读 Token')

    const rows = auditRows(fx.fixture.db)
    const actions = rows.map((row) => row.action)
    assert.ok(actions.includes('lofii.task.start'))
    assert.ok(actions.includes('lofii.task.stop'))
    assert.ok(actions.includes('lofii.task.resume'))
    assert.ok(actions.includes('lofii.move'))
    assert.ok(actions.includes('lofii.say'))
    const sayAudit = rows.find((row) => row.action === 'lofii.say')
    assert.deepEqual(JSON.parse(sayAudit?.detail_json ?? '{}'), { chars: secret.length })
    const serializedAudit = JSON.stringify(rows)
    assert.ok(!serializedAudit.includes(secret), '审计不得包含聊天正文')
    for (const value of SENSITIVE) {
      assert.ok(!serializedAudit.includes(value), `审计不得包含 ${value}`)
    }
  } finally {
    await fx.close()
  }
})

test('参数校验：任务名/action/taskId/say 长度与 / 前缀、history kind 与时间', async () => {
  const fx = await makeLofiiApp()
  try {
    const badName = await fx.app.inject({
      method: 'POST',
      url: '/api/lofii/tasks',
      headers: authHeaders(),
      payload: { name: 'cooking' },
    })
    assert.equal(badName.statusCode, 400)
    assert.equal(badName.json().error.code, 'invalid_request')

    const badAction = await fx.app.inject({
      method: 'POST',
      url: '/api/lofii/move',
      headers: authHeaders(),
      payload: { action: 'teleport' },
    })
    assert.equal(badAction.statusCode, 400)

    const badTaskId = await fx.app.inject({
      method: 'POST',
      url: '/api/lofii/tasks/resume',
      headers: authHeaders(),
      payload: { taskId: 123 },
    })
    assert.equal(badTaskId.statusCode, 400)

    const emptySay = await fx.app.inject({
      method: 'POST',
      url: '/api/lofii/say',
      headers: authHeaders(),
      payload: { message: '   ' },
    })
    assert.equal(emptySay.statusCode, 400)

    const longSay = await fx.app.inject({
      method: 'POST',
      url: '/api/lofii/say',
      headers: authHeaders(),
      payload: { message: 'x'.repeat(721) },
    })
    assert.equal(longSay.statusCode, 400)

    const slashSay = await fx.app.inject({
      method: 'POST',
      url: '/api/lofii/say',
      headers: authHeaders(),
      payload: { message: '/help' },
    })
    assert.equal(slashSay.statusCode, 400)
    assert.equal(slashSay.json().error.code, 'message_must_not_start_with_slash')
    assert.equal(fx.calls.filter((call) => call.url.pathname === '/say').length, 0, '非法消息不应发往上游')

    const badKind = await fx.app.inject({
      method: 'GET',
      url: '/api/lofii/history?kind=bogus',
      headers: authHeaders(),
    })
    assert.equal(badKind.statusCode, 400)

    const badTime = await fx.app.inject({
      method: 'GET',
      url: '/api/lofii/history?from=not-a-date',
      headers: authHeaders(),
    })
    assert.equal(badTime.statusCode, 400)

    const overLimit = await fx.app.inject({
      method: 'GET',
      url: '/api/lofii/history?limit=9999',
      headers: authHeaders(),
    })
    assert.equal(overLimit.statusCode, 200)
    const historyCall = fx.calls.find((call) => call.url.pathname === '/history')
    assert.equal(historyCall?.url.searchParams.get('limit'), '100', 'limit 越界回落默认 100')
    assert.equal(authOf(historyCall!), 'Bearer read-token')
  } finally {
    await fx.close()
  }
})

test('history 原样透传上游响应 {kind,from,to,count,samples|alerts}', async () => {
  const upstreamBody = {
    kind: 'alerts',
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-10-02T00:00:00.000Z',
    count: 1,
    alerts: [{ id: 1, ts: '2026-10-01T01:00:00.000Z', type: 'low_health', severity: 'warning', message: 'x' }],
  }
  const fx = await makeLofiiApp({
    handler: (url) => {
      if (url.pathname === '/history') return json(upstreamBody)
      return defaultHandler(url)
    },
  })
  try {
    const from = '2026-10-01T00:00:00.000Z'
    const to = '2026-10-02T00:00:00.000Z'
    const response = await fx.app.inject({
      method: 'GET',
      url: `/api/lofii/history?kind=alerts&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=50`,
      headers: authHeaders(),
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), upstreamBody)
    const call = fx.calls.find((item) => item.url.pathname === '/history')
    assert.equal(call?.url.searchParams.get('kind'), 'alerts')
    assert.equal(call?.url.searchParams.get('limit'), '50')
    assert.equal(call?.url.searchParams.get('from'), from)
  } finally {
    await fx.close()
  }
})

test('限流：控制 20/min/IP、say 10/min/IP，超限 429 rate_limited', async () => {
  const fx = await makeLofiiApp()
  try {
    for (let index = 0; index < 20; index += 1) {
      const response = await fx.app.inject({ method: 'POST', url: '/api/lofii/tasks/stop', headers: authHeaders() })
      assert.equal(response.statusCode, 200, `第 ${index + 1} 次控制应放行`)
    }
    const controlLimited = await fx.app.inject({ method: 'POST', url: '/api/lofii/tasks/stop', headers: authHeaders() })
    assert.equal(controlLimited.statusCode, 429)
    assert.equal(controlLimited.json().error.code, 'rate_limited')
    assert.ok(controlLimited.headers['retry-after'])

    for (let index = 0; index < 10; index += 1) {
      const response = await fx.app.inject({
        method: 'POST',
        url: '/api/lofii/say',
        headers: authHeaders(),
        payload: { message: `hi ${index}` },
      })
      assert.equal(response.statusCode, 200, `第 ${index + 1} 次 say 应放行`)
    }
    const sayLimited = await fx.app.inject({
      method: 'POST',
      url: '/api/lofii/say',
      headers: authHeaders(),
      payload: { message: 'one too many' },
    })
    assert.equal(sayLimited.statusCode, 429)
    assert.equal(sayLimited.json().error.code, 'rate_limited')
  } finally {
    await fx.close()
  }
})

test('错误映射：unavailable 503 / auth_failed 502 / upstream_error 502 / 上游 400·409 透传', async () => {
  let mode: 'ok' | 'unavailable' | 'auth' | 'upstream' | 'resume' | 'bad' = 'ok'
  const fx = await makeLofiiApp({
    handler: (url) => {
      if (url.pathname === '/status') return json({ version: '0.6.0' })
      if (url.pathname === '/events/recent') {
        return json({ contractVersion: 1, bootId: 'b1', lastEventId: null, events: [] })
      }
      if (mode === 'unavailable') throw new TypeError(`connect ECONNREFUSED http://127.0.0.1:3010/ token read-token control-token`)
      if (mode === 'auth') return json({ error: 'unauthorized', message: 'bad read-token' }, 401)
      if (mode === 'upstream') return json({ error: 'internal_error', message: 'boom' }, 500)
      if (mode === 'resume') return json({ error: 'resume_pending', message: 'pending task; see http://127.0.0.1:3010' }, 409)
      if (mode === 'bad') return json({ error: 'invalid_request', message: 'bad request' }, 400)
      return defaultHandler(url)
    },
  })
  try {
    async function postAndExpect(expectedStatus: number, expectedCode: string): Promise<Record<string, unknown>> {
      const response = await fx.app.inject({
        method: 'POST',
        url: '/api/lofii/tasks/resume',
        headers: authHeaders(),
        payload: {},
      })
      assert.equal(response.statusCode, expectedStatus)
      const body = response.json() as { error: { code: string; message: string } }
      assert.equal(body.error.code, expectedCode)
      for (const value of SENSITIVE) {
        assert.ok(!body.error.message.includes(value), `错误消息不得包含 ${value}`)
      }
      return response.json() as Record<string, unknown>
    }

    mode = 'unavailable'
    await postAndExpect(503, 'lofii_unavailable')
    mode = 'auth'
    await postAndExpect(502, 'lofii_auth_failed')
    mode = 'upstream'
    await postAndExpect(502, 'lofii_upstream_error')
    mode = 'resume'
    await postAndExpect(409, 'lofii_resume_pending')
    mode = 'bad'
    await postAndExpect(400, 'lofii_invalid_request')

    // 失败也必须留下 lofii.control_failed 审计，且不带敏感信息。
    const failures = auditRows(fx.fixture.db).filter((row) => row.action === 'lofii.control_failed')
    assert.equal(failures.length, 5)
    assert.deepEqual(
      failures.map((row) => JSON.parse(row.detail_json ?? '{}').code),
      ['lofii_unavailable', 'lofii_auth_failed', 'lofii_upstream_error', 'lofii_resume_pending', 'lofii_invalid_request'],
    )
    for (const value of SENSITIVE) {
      assert.ok(!JSON.stringify(failures).includes(value))
    }
  } finally {
    await fx.close()
  }

  // 只读模式（无控制 Token）：控制接口 503 lofii_control_disabled，/say 仍可用。
  const readonly = await makeLofiiApp({ config: { lofiiControlToken: '' } })
  try {
    const blocked = await readonly.app.inject({
      method: 'POST',
      url: '/api/lofii/tasks/stop',
      headers: authHeaders(),
    })
    assert.equal(blocked.statusCode, 503)
    assert.equal(blocked.json().error.code, 'lofii_control_disabled')

    const say = await readonly.app.inject({
      method: 'POST',
      url: '/api/lofii/say',
      headers: authHeaders(),
      payload: { message: '只读也能说话' },
    })
    assert.equal(say.statusCode, 200)
  } finally {
    await readonly.close()
  }
})

test('/api/version 增加 lofiiEnabled/lofiiControlEnabled', async () => {
  const dir = tempDataDir()
  const config = testConfig(dir, {
    lofiiEnabled: true,
    lofiiReadToken: 'read-token',
    lofiiControlToken: 'control-token',
  })
  const db = testDb(dir)
  try {
    const files = new FileService(db, config)
    const minecraft = new MinecraftService(db, config)
    const dashboard = new DashboardService(db, config, files, minecraft)
    const app = await createAuthedApp(db, (instance) => {
      registerDashboardRoutes(instance, config, dashboard, db)
    })
    try {
      const response = await app.inject({ method: 'GET', url: '/api/version', headers: authHeaders() })
      assert.equal(response.statusCode, 200)
      const body = response.json() as Record<string, unknown>
      assert.equal(body.lofiiEnabled, true)
      assert.equal(body.lofiiControlEnabled, true)
    } finally {
      await app.close()
    }
  } finally {
    db.close()
    cleanupDir(dir)
  }
})

test('app.ts 接线：AppContext.lofii / startLofii / 关闭无悬挂定时器，API 可用', async () => {
  const dir = tempDataDir()
  const config = testConfig(dir, { lofiiEnabled: false })
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const context = await buildApp(config, db)
  try {
    assert.equal(context.lofii.snapshot().enabled, false)
    context.startLofii()
    context.startLofii()
    const session = createSession(db, seeded.userId, 'csrf-version', 7, '127.0.0.1', 'test')
    const headers = { cookie: `af_session=${session.token}` }

    const status = await context.app.inject({ method: 'GET', url: '/api/lofii/status', headers })
    assert.equal(status.statusCode, 200)
    assert.equal(status.json().enabled, false)

    const version = await context.app.inject({ method: 'GET', url: '/api/version', headers })
    assert.equal(version.statusCode, 200)
    assert.equal(version.json().lofiiEnabled, false)
    assert.equal(version.json().lofiiControlEnabled, false)
  } finally {
    await context.app.close()
    db.close()
    cleanupDir(dir)
  }
})
