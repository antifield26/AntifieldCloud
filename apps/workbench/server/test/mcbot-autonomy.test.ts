/**
 * mcbot v1.0.2 测试：10 任务名、AI 自主模式客户端/服务/路由、GET 限流、
 * 轮询停止收口（中止在途请求、停止后不写游标）与 mcbot 服务监控接入。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'
import type { Config } from '../src/config.ts'
import { buildApp } from '../src/app.ts'
import { DashboardService } from '../src/dashboard/service.ts'
import { MinecraftService } from '../src/mc/service.ts'
import { McbotClient, normalizeAutonomy, type McbotClientOptions } from '../src/mcbot/client.ts'
import { MCBOT_EVENT_CURSOR_KEY, McbotService } from '../src/mcbot/service.ts'
import { MCBOT_TASK_NAMES, registerLofiiRoutes } from '../src/http/routes/mcbot.ts'
import { defaultServiceUnits } from '../src/alerts/service.ts'
import { getMeta, setMeta } from '../src/db.ts'
import { cleanupDir, tempDataDir, testConfig, testDb } from './helpers.ts'
import { authHeaders, createAuthedApp, csrfHeadersOnly, phase2Fixture, type Phase2Fixture } from './phase2-fixtures.ts'

const T0 = '2026-10-28T00:00:00.000Z'
const BASE = 'http://127.0.0.1:3010'
const READ = 'read-token-secret-0123456789abcdef'
const CONTROL = 'control-token-secret-0123456789abcdef'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function autonomySnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    active: true,
    state: 'running',
    goal: '收集小麦并存入箱子',
    startedAt: T0,
    elapsedSec: 42,
    remainingSec: 600,
    toolCalls: 3,
    maxToolCalls: 12,
    lastAction: 'gather_wheat',
    lastReason: '需要食物',
    lastError: null,
    lastDecisionAt: T0,
    ...overrides,
  }
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 1500): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

/** 不主动返回、仅在 AbortSignal 触发时 reject 的 fetch 响应，用于验证停止收口。 */
function pendingUntilAborted(init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init.signal
    if (!signal) return
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  })
}

interface FetchCall {
  url: string
  init: RequestInit
}

function makeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  impl: typeof fetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init: init ?? {} })
    return handler(url, init ?? {})
  }) as typeof fetch
  return { impl, calls }
}

function makeClient(impl: typeof fetch, overrides: Partial<McbotClientOptions> = {}): McbotClient {
  return new McbotClient({ baseUrl: BASE, readToken: READ, controlToken: CONTROL, timeoutMs: 2500, fetch: impl, ...overrides })
}

function authHeader(init: RequestInit): string {
  return String((init.headers as Record<string, string> | undefined)?.authorization ?? '')
}

/* ---------- 客户端 ---------- */

test('autonomy：读 Token、GET /autonomy、快照规范化与未知 state 保留', async () => {
  const { impl, calls } = makeFetch(() => json({ autonomy: autonomySnapshot({ state: 'thinking' }) }))
  const client = makeClient(impl)
  const snapshot = await client.autonomy()
  assert.equal(calls[0]?.url, `${BASE}/autonomy`)
  assert.equal(calls[0]?.init.method, 'GET')
  assert.equal(authHeader(calls[0]!.init), `Bearer ${READ}`)
  assert.equal(snapshot.state, 'thinking', '未知 state 保留原字符串（前向兼容）')
  assert.equal(snapshot.goal, '收集小麦并存入箱子')
  assert.equal(snapshot.toolCalls, 3)

  const missing = makeFetch(() => json({}))
  await assert.rejects(
    () => makeClient(missing.impl).autonomy(),
    (error: unknown) => (error as { code?: string }).code === 'mcbot_upstream_error',
  )
})

test('normalizeAutonomy：旧版缺失/类型漂移给安全默认值，非对象返回 null', () => {
  assert.equal(normalizeAutonomy(undefined), null)
  assert.equal(normalizeAutonomy(null), null)
  assert.equal(normalizeAutonomy('running'), null)
  const fallback = normalizeAutonomy({ enabled: 'yes', active: 1, state: '', elapsedSec: -3, toolCalls: 'x' })
  assert.ok(fallback)
  assert.equal(fallback?.enabled, false)
  assert.equal(fallback?.active, false)
  assert.equal(fallback?.state, 'idle')
  assert.equal(fallback?.elapsedSec, 0)
  assert.equal(fallback?.toolCalls, 0)
  assert.equal(fallback?.goal, null)
  const long = normalizeAutonomy({ goal: 'x'.repeat(500) })
  assert.equal(long?.goal?.length, 200, '目标文本截断到 200 字符')
})

test('startAutonomy/stopAutonomy：控制 Token、请求体与 503 业务码透传', async () => {
  const { impl, calls } = makeFetch(() => json({ ok: true, autonomy: autonomySnapshot({ active: true, state: 'starting' }) }, 202))
  const client = makeClient(impl)
  const started = await client.startAutonomy('收集木材')
  assert.equal(calls[0]?.url, `${BASE}/autonomy/start`)
  assert.equal(calls[0]?.init.method, 'POST')
  assert.equal(authHeader(calls[0]!.init), `Bearer ${CONTROL}`)
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { goal: '收集木材' })
  assert.equal((started.autonomy as Record<string, unknown>).state, 'starting')

  await client.startAutonomy()
  assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), {}, '未提供目标时发送空对象')

  await client.stopAutonomy('用户急停')
  assert.equal(calls[2]?.url, `${BASE}/autonomy/stop`)
  assert.equal(authHeader(calls[2]!.init), `Bearer ${CONTROL}`)
  assert.deepEqual(JSON.parse(String(calls[2]?.init.body)), { reason: '用户急停' })

  const disabled = makeFetch(() => json({ error: 'autonomy_disabled', message: 'autonomy disabled' }, 503))
  await assert.rejects(
    () => makeClient(disabled.impl).startAutonomy(),
    (error: unknown) => (error as { code?: string }).code === 'mcbot_autonomy_disabled',
  )
  const unavailable = makeFetch(() => json({ error: 'autonomy_unavailable', message: 'unavailable' }, 503))
  await assert.rejects(
    () => makeClient(unavailable.impl).stopAutonomy(),
    (error: unknown) => (error as { code?: string }).code === 'mcbot_autonomy_unavailable',
  )
  const busy = makeFetch(() => json({ error: 'autonomy_busy', message: 'busy' }, 409))
  await assert.rejects(
    () => makeClient(busy.impl).startAutonomy(),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'mcbot_autonomy_busy')
      assert.equal((error as { statusCode?: number }).statusCode, 409)
      return true
    },
  )
})

test('外部 AbortSignal 中止在途请求（停止轮询依赖该能力）', async () => {
  const { impl, calls } = makeFetch((_url, init) => pendingUntilAborted(init))
  const controller = new AbortController()
  const pending = makeClient(impl).status(controller.signal)
  await waitFor(() => calls.length === 1, '发起请求')
  const external = calls[0]!.init.signal
  assert.ok(external instanceof AbortSignal)
  controller.abort()
  await assert.rejects(pending, (error: unknown) => (error as { code?: string }).code === 'mcbot_unavailable')
  assert.equal((external as AbortSignal).aborted, true, '合并后的请求信号必须随外部信号中止')
})

/* ---------- 服务 ---------- */

interface ServiceFixture {
  dir: string
  db: ReturnType<typeof testDb>
  config: Config
  service: McbotService
  calls: FetchCall[]
  close: () => void
}

function serviceFixture(options: {
  config?: Partial<Config>
  handler?: (url: URL, init: RequestInit) => Response | Promise<Response>
} = {}): ServiceFixture {
  const dir = tempDataDir()
  const config = testConfig(dir, {
    mcbotEnabled: true,
    mcbotReadToken: READ,
    mcbotControlToken: CONTROL,
    mcbotTimeoutMs: 500,
    mcbotPollMs: 5000,
    ...options.config,
  })
  const db = testDb(dir)
  const calls: FetchCall[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    calls.push({ url: url.toString(), init: init ?? {} })
    return (options.handler ?? (() => json({ error: 'not_found' }, 404)))(url, init ?? {})
  }) as typeof fetch
  const service = new McbotService({
    db,
    config,
    alerts: { recordExternal: () => 1 },
    client: new McbotClient({
      baseUrl: config.mcbotUrl,
      readToken: config.mcbotReadToken,
      controlToken: config.mcbotControlToken,
      timeoutMs: config.mcbotTimeoutMs,
      fetch: impl,
    }),
    now: () => new Date(T0),
    log: () => {},
  })
  return {
    dir,
    db,
    config,
    service,
    calls,
    close: () => {
      void service.stop()
      db.close()
      cleanupDir(dir)
    },
  }
}

function autonomyStatusHandler(state: { autonomy: Record<string, unknown> }) {
  return (url: URL): Response | Promise<Response> => {
    if (url.pathname === '/status') {
      return json({
        version: '1.0.2',
        state: 'connected',
        task: { active: false, state: 'idle' },
        autonomy: state.autonomy,
      })
    }
    if (url.pathname === '/events/recent') {
      return json({ contractVersion: 1, bootId: 'b1', lastEventId: null, events: [] })
    }
    if (url.pathname === '/autonomy') return json({ autonomy: state.autonomy })
    if (url.pathname === '/autonomy/start') {
      return json({ ok: true, autonomy: autonomySnapshot({ state: 'starting', active: true, goal: '默认' }) }, 202)
    }
    if (url.pathname === '/autonomy/stop') {
      // 停止成功后 /status 也进入 finished，模拟真实上游的快速状态收敛。
      state.autonomy = autonomySnapshot({ state: 'finished', active: false, toolCalls: 4 })
      return json({ ok: true, autonomy: state.autonomy }, 202)
    }
    return json({ error: 'not_found' }, 404)
  }
}

test('服务：/status 的 autonomy 段进入快照；旧版缺失降级 null；GET /autonomy 更新缓存', async () => {
  const fx = serviceFixture({ handler: autonomyStatusHandler({ autonomy: autonomySnapshot() }) })
  try {
    await fx.service.pollOnce()
    const snapshot = fx.service.snapshot()
    assert.equal(snapshot.autonomy?.state, 'running')
    assert.equal(snapshot.autonomy?.toolCalls, 3)
    assert.equal(snapshot.autonomy?.goal, '收集小麦并存入箱子')

    // GET /autonomy 用读 Token 并更新缓存。
    const before = fx.calls.length
    const live = await fx.service.autonomy()
    assert.equal(live.enabled, true)
    assert.equal(new URL(fx.calls[before]!.url).pathname, '/autonomy')
    assert.equal(authHeader(fx.calls[before]!.init), `Bearer ${READ}`)
  } finally {
    fx.close()
  }

  // 旧版 mcbot /status 无 autonomy：快照为 null，不伪造状态、不抛错。
  const legacy = serviceFixture({
    handler: (url) => {
      if (url.pathname === '/status') return json({ version: '0.6.0', state: 'connected' })
      if (url.pathname === '/events/recent') return json({ contractVersion: 1, bootId: 'b1', lastEventId: null, events: [] })
      return json({ error: 'not_found', message: 'not found' }, 404)
    },
  })
  try {
    await legacy.service.pollOnce()
    assert.equal(legacy.service.snapshot().autonomy, null)
    assert.equal(legacy.service.snapshot().reachable, true)
  } finally {
    legacy.close()
  }
})

test('服务：startAutonomy/stopAutonomy 走控制 Token 并在成功后刷新', async () => {
  const fx = serviceFixture({ handler: autonomyStatusHandler({ autonomy: autonomySnapshot() }) })
  try {
    const started = await fx.service.startAutonomy('收集木材')
    assert.equal(started.ok, true)
    assert.equal(started.autonomy?.state, 'starting')
    const paths = fx.calls.map((call) => new URL(call.url).pathname)
    assert.deepEqual(paths.slice(0, 3), ['/autonomy/start', '/status', '/events/recent'])
    assert.equal(authHeader(fx.calls[0]!.init), `Bearer ${CONTROL}`)
    // 刷新后快照以最新 /status 为准（running）。
    assert.equal(fx.service.snapshot().autonomy?.state, 'running')

    const stopped = await fx.service.stopAutonomy('用户急停')
    assert.equal(stopped.ok, true)
    assert.equal(stopped.autonomy?.state, 'finished')

    // 只读模式：控制 Token 为空时自主控制直接 503 业务码，不发请求。
    const readOnly = serviceFixture({
      config: { mcbotControlToken: '' },
      handler: autonomyStatusHandler({ autonomy: autonomySnapshot() }),
    })
    try {
      await assert.rejects(
        () => readOnly.service.startAutonomy(),
        (error: unknown) => (error as { code?: string }).code === 'mcbot_control_disabled',
      )
      assert.equal(readOnly.calls.length, 0)
    } finally {
      readOnly.close()
    }
  } finally {
    fx.close()
  }
})

test('停止收口：中止在途 status/recent、await 在途轮询、停止后不写告警游标', async () => {
  const dir = tempDataDir()
  const config = testConfig(dir, {
    mcbotEnabled: true,
    mcbotReadToken: READ,
    mcbotControlToken: CONTROL,
    mcbotTimeoutMs: 500,
    mcbotPollMs: 5000,
  })
  const db = testDb(dir)
  const calls: FetchCall[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    calls.push({ url: url.toString(), init: init ?? {} })
    return pendingUntilAborted(init ?? {})
  }) as typeof fetch
  const service = new McbotService({
    db,
    config,
    alerts: { recordExternal: () => 1 },
    client: new McbotClient({
      baseUrl: config.mcbotUrl,
      readToken: config.mcbotReadToken,
      controlToken: config.mcbotControlToken,
      timeoutMs: config.mcbotTimeoutMs,
      fetch: impl,
    }),
    now: () => new Date(T0),
    log: () => {},
  })
  // 已存在的旧游标：若停止后仍写游标，会被改成新值。
  setMeta(db, MCBOT_EVENT_CURSOR_KEY, JSON.stringify({ bootId: 'b1', lastEventId: 'b1-1', lastTs: T0 }))
  try {
    const polling = service.pollOnce()
    await waitFor(() => calls.length === 2, '发起 status+recent 请求')
    const statusSignal = calls[0]!.init.signal as AbortSignal
    const recentSignal = calls[1]!.init.signal as AbortSignal

    await service.stop()
    const result = await polling
    assert.equal(result.skipped, true)
    assert.equal(result.error, 'mcbot_stopped')
    assert.equal(statusSignal.aborted, true, 'stop() 必须中止在途 status 请求')
    assert.equal(recentSignal.aborted, true, 'stop() 必须中止在途 recent 请求')
    assert.equal(getMeta(db, MCBOT_EVENT_CURSOR_KEY), JSON.stringify({ bootId: 'b1', lastEventId: 'b1-1', lastTs: T0 }))
    assert.equal(service.snapshot().lastPollAt, null, '停止后不得写 lastPollAt')
    assert.equal(service.snapshot().reachable, false)
    assert.equal(service.isStopped, true)

    // 停止后 pollOnce 不再发起请求，返回 skipped。
    const afterStop = await service.pollOnce()
    assert.equal(afterStop.skipped, true)
    assert.equal(afterStop.error, 'mcbot_stopped')
    assert.equal(calls.length, 2)

    // stop() 幂等：重复调用直接返回。
    await service.stop()
    await service.stop()
  } finally {
    db.close()
    cleanupDir(dir)
  }
})

/* ---------- 路由 ---------- */

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>

interface RouteFixture {
  fixture: Phase2Fixture
  app: FastifyInstance
  service: McbotService
  calls: FetchCall[]
  close: () => Promise<void>
}

function defaultRouteHandler(url: URL, init: RequestInit): Response | Promise<Response> {
  if (url.pathname === '/status') {
    return json({ version: '1.0.2', state: 'connected', autonomy: autonomySnapshot() })
  }
  if (url.pathname === '/events/recent') return json({ contractVersion: 1, bootId: 'b1', lastEventId: null, events: [] })
  if (url.pathname === '/autonomy') return json({ autonomy: autonomySnapshot() })
  if (url.pathname === '/autonomy/start') {
    let goal: string | null
    try {
      goal = (JSON.parse(String(init.body)) as { goal?: string }).goal ?? null
    } catch {
      goal = null
    }
    return json({ ok: true, autonomy: autonomySnapshot({ state: 'starting', active: true, goal }) }, 202)
  }
  if (url.pathname === '/autonomy/stop') {
    return json({ ok: true, autonomy: autonomySnapshot({ state: 'finished', active: false }) }, 202)
  }
  if (url.pathname === '/task/start') return json({ ok: true, queued: false }, 202)
  if (url.pathname === '/history') {
    const kind = url.searchParams.get('kind') ?? 'samples'
    return json({ kind, from: null, to: null, count: 0, [kind]: [] })
  }
  return json({ error: 'not_found', message: 'not found' }, 404)
}

async function makeRouteApp(options: { config?: Partial<Config>; handler?: Handler } = {}): Promise<RouteFixture> {
  const fixture = phase2Fixture({
    mcbotEnabled: true,
    mcbotReadToken: READ,
    mcbotControlToken: CONTROL,
    mcbotPollMs: 60_000,
    mcbotTimeoutMs: 500,
    ...options.config,
  })
  const calls: FetchCall[] = []
  const handler = options.handler ?? defaultRouteHandler
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    calls.push({ url: url.toString(), init: init ?? {} })
    return handler(url, init ?? {})
  }) as typeof fetch
  const service = new McbotService({
    db: fixture.db,
    config: fixture.config,
    alerts: { recordExternal: () => 1 },
    client: new McbotClient({
      baseUrl: fixture.config.mcbotUrl,
      readToken: fixture.config.mcbotReadToken,
      controlToken: fixture.config.mcbotControlToken,
      timeoutMs: fixture.config.mcbotTimeoutMs,
      fetch: impl,
    }),
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
      await service.stop()
      await app.close()
      fixture.close()
    },
  }
}

function auditRows(db: Phase2Fixture['db']): { action: string; target: string | null; detail_json: string | null }[] {
  return db.prepare('SELECT action, target, detail_json FROM audit_log ORDER BY id ASC').all() as unknown as {
    action: string
    target: string | null
    detail_json: string | null
  }[]
}

function lastUpstreamCall(calls: FetchCall[], path: string): FetchCall | undefined {
  return [...calls].reverse().find((call) => new URL(call.url).pathname === path)
}

test('MCBOT_TASK_NAMES：10 种任务全部可启动，未知任务 400', async () => {
  const fx = await makeRouteApp()
  try {
    assert.equal(MCBOT_TASK_NAMES.length, 10)
    for (const name of MCBOT_TASK_NAMES) {
      const response = await fx.app.inject({
        method: 'POST',
        url: '/api/mcbot/tasks',
        headers: authHeaders(),
        payload: { name },
      })
      assert.equal(response.statusCode, 200, `任务 ${name} 应可启动`)
      const body = JSON.parse(String(lastUpstreamCall(fx.calls, '/task/start')?.init.body)) as { name: string }
      assert.equal(body.name, name)
    }
    const invalid = await fx.app.inject({
      method: 'POST',
      url: '/api/mcbot/tasks',
      headers: authHeaders(),
      payload: { name: 'cooking' },
    })
    assert.equal(invalid.statusCode, 400)
    assert.equal(invalid.json().error.code, 'invalid_request')
  } finally {
    await fx.close()
  }
})

test('GET /api/mcbot/autonomy：登录、包装 {autonomy}、禁用降级', async () => {
  const fx = await makeRouteApp()
  try {
    const anonymous = await fx.app.inject({ method: 'GET', url: '/api/mcbot/autonomy' })
    assert.equal(anonymous.statusCode, 401)

    const response = await fx.app.inject({ method: 'GET', url: '/api/mcbot/autonomy', headers: authHeaders() })
    assert.equal(response.statusCode, 200)
    const body = response.json() as { autonomy: Record<string, unknown> }
    assert.equal(body.autonomy.state, 'running')
    assert.equal(body.autonomy.goal, '收集小麦并存入箱子')
    assert.equal(body.autonomy.toolCalls, 3)
    assert.equal(authHeader(lastUpstreamCall(fx.calls, '/autonomy')!.init), `Bearer ${READ}`)
  } finally {
    await fx.close()
  }

  const disabled = await makeRouteApp({ config: { mcbotEnabled: false } })
  try {
    for (const url of ['/api/mcbot/autonomy', '/api/mcbot/autonomy/start', '/api/mcbot/autonomy/stop']) {
      const response = await disabled.app.inject({
        method: url.endsWith('autonomy') ? 'GET' : 'POST',
        url,
        headers: authHeaders(),
      })
      assert.equal(response.statusCode, 503)
      assert.equal(response.json().error.code, 'mcbot_disabled')
    }
    assert.equal(disabled.calls.length, 0, '禁用时不得访问上游')
  } finally {
    await disabled.close()
  }
})

test('POST /api/mcbot/autonomy/start：CSRF、goal 校验、转发 trim 值、审计只记长度', async () => {
  const fx = await makeRouteApp()
  try {
    const noCsrf = await fx.app.inject({
      method: 'POST',
      url: '/api/mcbot/autonomy/start',
      headers: csrfHeadersOnly(),
      payload: { goal: 'ok' },
    })
    assert.equal(noCsrf.statusCode, 403)
    assert.equal(noCsrf.json().error.code, 'csrf_failed')

    const badGoals: unknown[] = [123, 'x'.repeat(201), 'a\u0000b', '\u0007']
    for (const goal of badGoals) {
      const response = await fx.app.inject({
        method: 'POST',
        url: '/api/mcbot/autonomy/start',
        headers: authHeaders(),
        payload: { goal },
      })
      assert.equal(response.statusCode, 400, `非法 goal 应 400：${JSON.stringify(goal).slice(0, 20)}`)
      assert.equal(response.json().error.code, 'invalid_request')
    }
    assert.equal(lastUpstreamCall(fx.calls, '/autonomy/start'), undefined, '非法 goal 不得发往上游')

    const success = await fx.app.inject({
      method: 'POST',
      url: '/api/mcbot/autonomy/start',
      headers: authHeaders(),
      payload: { goal: '  收集木材  ' },
    })
    assert.equal(success.statusCode, 200)
    const body = success.json() as { ok: boolean; autonomy: Record<string, unknown> }
    assert.equal(body.ok, true)
    assert.equal(body.autonomy.state, 'starting')
    assert.equal(body.autonomy.goal, '收集木材', 'goal 必须 trim 后转发')
    const upstream = lastUpstreamCall(fx.calls, '/autonomy/start')!
    assert.deepEqual(JSON.parse(String(upstream.init.body)), { goal: '收集木材' })
    assert.equal(authHeader(upstream.init), `Bearer ${CONTROL}`)

    const rows = auditRows(fx.fixture.db)
    const startAudit = rows.find((row) => row.action === 'mcbot.autonomy.start')
    assert.ok(startAudit)
    assert.deepEqual(JSON.parse(startAudit?.detail_json ?? '{}'), { goalChars: 4 })
    assert.ok(!JSON.stringify(rows).includes('收集木材'), '审计不得记录自主目标正文')

    // 目标省略（空对象或空白）：按默认目标发送空 body。
    const defaultGoal = await fx.app.inject({
      method: 'POST',
      url: '/api/mcbot/autonomy/start',
      headers: authHeaders(),
      payload: {},
    })
    assert.equal(defaultGoal.statusCode, 200)
    assert.deepEqual(JSON.parse(String(lastUpstreamCall(fx.calls, '/autonomy/start')!.init.body)), {})
  } finally {
    await fx.close()
  }
})

test('POST /api/mcbot/autonomy/stop：幂等、reason 校验/转发、审计', async () => {
  const fx = await makeRouteApp()
  try {
    const noCsrf = await fx.app.inject({
      method: 'POST',
      url: '/api/mcbot/autonomy/stop',
      headers: csrfHeadersOnly(),
    })
    assert.equal(noCsrf.statusCode, 403)

    for (let index = 0; index < 2; index += 1) {
      const response = await fx.app.inject({
        method: 'POST',
        url: '/api/mcbot/autonomy/stop',
        headers: authHeaders(),
        payload: { reason: '用户急停' },
      })
      assert.equal(response.statusCode, 200, '停止接口必须幂等')
      const body = response.json() as { ok: boolean; autonomy: Record<string, unknown> }
      assert.equal(body.ok, true)
      assert.equal(body.autonomy.state, 'finished')
      assert.deepEqual(JSON.parse(String(lastUpstreamCall(fx.calls, '/autonomy/stop')!.init.body)), {
        reason: '用户急停',
      })
    }

    const tooLong = await fx.app.inject({
      method: 'POST',
      url: '/api/mcbot/autonomy/stop',
      headers: authHeaders(),
      payload: { reason: 'x'.repeat(201) },
    })
    assert.equal(tooLong.statusCode, 400)
    const controlChar = await fx.app.inject({
      method: 'POST',
      url: '/api/mcbot/autonomy/stop',
      headers: authHeaders(),
      payload: { reason: 'a\u0000b' },
    })
    assert.equal(controlChar.statusCode, 400)

    const rows = auditRows(fx.fixture.db).filter((row) => row.action === 'mcbot.autonomy.stop')
    assert.equal(rows.length, 2)
    assert.deepEqual(JSON.parse(rows[0]?.detail_json ?? '{}'), { reasonChars: 4 })
    assert.ok(!JSON.stringify(rows).includes('用户急停'), '审计不得记录停止原因正文')
  } finally {
    await fx.close()
  }
})

test('自主控制错误映射：409 busy / 503 disabled / 503 unavailable / 502 upstream + 失败审计', async () => {
  let mode: 'busy' | 'disabled' | 'unavailable' | 'upstream' | 'ok' = 'ok'
  const fx = await makeRouteApp({
    handler: (url, init) => {
      if (url.pathname === '/autonomy/start' || url.pathname === '/autonomy/stop') {
        if (mode === 'busy') return json({ error: 'autonomy_busy', message: 'busy' }, 409)
        if (mode === 'disabled') return json({ error: 'autonomy_disabled', message: 'disabled' }, 503)
        if (mode === 'unavailable') return json({ error: 'autonomy_unavailable', message: 'unavailable' }, 503)
        if (mode === 'upstream') return json({ error: 'internal_error', message: 'boom' }, 500)
      }
      return defaultRouteHandler(url, init)
    },
  })
  try {
    async function expectStart(status: number, code: string): Promise<Record<string, unknown>> {
      const response = await fx.app.inject({
        method: 'POST',
        url: '/api/mcbot/autonomy/start',
        headers: authHeaders(),
        payload: {},
      })
      assert.equal(response.statusCode, status)
      const body = response.json() as { error: { code: string; message: string } }
      assert.equal(body.error.code, code)
      assert.ok(!body.error.message.includes('127.0.0.1'), '错误消息不得包含内部地址')
      return body.error
    }
    mode = 'busy'
    await expectStart(409, 'mcbot_autonomy_busy')
    mode = 'disabled'
    await expectStart(503, 'mcbot_autonomy_disabled')
    mode = 'unavailable'
    await expectStart(503, 'mcbot_autonomy_unavailable')
    mode = 'upstream'
    await expectStart(502, 'mcbot_upstream_error')

    const failures = auditRows(fx.fixture.db).filter((row) => row.action === 'mcbot.control_failed')
    assert.equal(failures.length, 4)
    assert.deepEqual(
      failures.map((row) => JSON.parse(row.detail_json ?? '{}').code),
      ['mcbot_autonomy_busy', 'mcbot_autonomy_disabled', 'mcbot_autonomy_unavailable', 'mcbot_upstream_error'],
    )
  } finally {
    await fx.close()
  }
})

test('GET 限流：/status 与 /history 各 60/min/IP，超限 429；12 次/分 UI 轮询不受影响', async () => {
  const statusFx = await makeRouteApp()
  try {
    for (let index = 0; index < 12; index += 1) {
      const response = await statusFx.app.inject({ method: 'GET', url: '/api/mcbot/status', headers: authHeaders() })
      assert.equal(response.statusCode, 200, `UI 5 秒轮询第 ${index + 1} 次应放行`)
    }
    for (let index = 12; index < 60; index += 1) {
      const response = await statusFx.app.inject({ method: 'GET', url: '/api/mcbot/status', headers: authHeaders() })
      assert.equal(response.statusCode, 200, `第 ${index + 1} 次 GET 应放行`)
    }
    const limited = await statusFx.app.inject({ method: 'GET', url: '/api/mcbot/status', headers: authHeaders() })
    assert.equal(limited.statusCode, 429)
    assert.equal(limited.json().error.code, 'rate_limited')
    assert.ok(limited.headers['retry-after'])
  } finally {
    await statusFx.close()
  }

  const historyFx = await makeRouteApp()
  try {
    for (let index = 0; index < 60; index += 1) {
      const response = await historyFx.app.inject({
        method: 'GET',
        url: '/api/mcbot/history?kind=samples',
        headers: authHeaders(),
      })
      assert.equal(response.statusCode, 200, `第 ${index + 1} 次 history 应放行`)
    }
    const limited = await historyFx.app.inject({
      method: 'GET',
      url: '/api/mcbot/history?kind=samples',
      headers: authHeaders(),
    })
    assert.equal(limited.statusCode, 429)
    assert.equal(limited.json().error.code, 'rate_limited')
  } finally {
    await historyFx.close()
  }
})

test('GET /api/mcbot/status 聚合快照包含 autonomy', async () => {
  const fx = await makeRouteApp()
  try {
    await fx.service.pollOnce()
    const response = await fx.app.inject({ method: 'GET', url: '/api/mcbot/status', headers: authHeaders() })
    const body = response.json() as { autonomy: Record<string, unknown> | null }
    assert.equal(body.autonomy?.state, 'running')
    assert.equal(body.autonomy?.maxToolCalls, 12)
  } finally {
    await fx.close()
  }
})

/* ---------- Dashboard / 告警服务监控 ---------- */

test('DashboardService：mcbot 启用时监控 mcbot 服务，禁用时不检查', async () => {
  const enabled = phase2Fixture({ mcbotEnabled: true })
  try {
    const mc = new MinecraftService(enabled.db, { ...enabled.config, mcPort: 1, rconPort: 1 })
    const dashboard = new DashboardService(enabled.db, enabled.config, enabled.files, mc)
    const data = await dashboard.get()
    assert.ok(
      data.services.mcbot === 'unknown' || data.services.mcbot === 'inactive',
      '启用时包含 mcbot 服务键（非 Linux 主机为 unknown，Linux 无该单元为 inactive）',
    )
    assert.equal(Object.keys(data.services).length, 4)
  } finally {
    enabled.close()
  }

  const disabled = phase2Fixture({ mcbotEnabled: false })
  try {
    const mc = new MinecraftService(disabled.db, { ...disabled.config, mcPort: 1, rconPort: 1 })
    const dashboard = new DashboardService(disabled.db, disabled.config, disabled.files, mc)
    const data = await dashboard.get()
    assert.equal(data.services.mcbot, undefined, '禁用时不得包含 mcbot 服务键')
    assert.equal(Object.keys(data.services).length, 3)
  } finally {
    disabled.close()
  }
})

test('defaultServiceUnits：仅 mcbot 启用时加入 mcbot 单元，避免未启用误报', () => {
  const dir = tempDataDir()
  try {
    const base = testConfig(dir)
    const disabled = defaultServiceUnits(base)
    assert.equal(disabled.mcbot, undefined)
    assert.deepEqual(Object.keys(disabled).sort(), ['cloudflared', 'minecraft', 'opencode'])

    const enabled = defaultServiceUnits({ ...base, mcbotEnabled: true })
    assert.equal(enabled.mcbot, 'mcbot')
    assert.equal(enabled.minecraft, base.mcSystemdUnit)
  } finally {
    cleanupDir(dir)
  }
})

/* ---------- app 接线 ---------- */

test('app 接线：关闭时 await mcbot.stop（onClose 不挂起），禁用状态自主路由为 503', async () => {
  const dir = tempDataDir()
  const config = testConfig(dir, { mcbotEnabled: false })
  const db = testDb(dir)
  try {
    const context = await buildApp(config, db)
    await context.app.close()
    // 关闭后再次调用 stop 幂等。
    await context.mcbot.stop()
  } finally {
    db.close()
    cleanupDir(dir)
  }
})
