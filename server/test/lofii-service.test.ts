/** Lofii 服务测试：轮询缓存、单飞、降级、游标基线与去重、告警映射、控制刷新。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Config } from '../src/config.ts'
import type { ExternalAlertInput } from '../src/alerts/service.ts'
import { getMeta, setMeta } from '../src/db.ts'
import { LofiiClient, type LofiiEvent } from '../src/lofii/client.ts'
import {
  LOFII_EVENT_CACHE_LIMIT,
  LOFII_EVENT_CURSOR_KEY,
  LofiiService,
  eventsAfterCursor,
  mapLofiiAlert,
} from '../src/lofii/service.ts'
import { cleanupDir, tempDataDir, testConfig, testDb } from './helpers.ts'

const T0 = '2026-10-01T00:00:00.000Z'

function isoTick(index: number): string {
  return new Date(Date.parse(T0) + index * 1000).toISOString()
}

function ev(id: string, type: string, tick: number, data: unknown = {}): LofiiEvent {
  return { id, type, ts: isoTick(tick), data }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function statusBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '0.6.0',
    uptimeSec: 10,
    state: 'connected',
    task: { active: false, name: null, state: 'idle', pendingResume: null, queue: [] },
    ...overrides,
  }
}

interface FixtureOptions {
  config?: Partial<Config>
  handler?: (url: URL, init: RequestInit) => Response | Promise<Response>
  recordExternal?: (input: ExternalAlertInput) => number | null
}

interface ServiceFixture {
  dir: string
  db: ReturnType<typeof testDb>
  config: Config
  service: LofiiService
  clock: { now: () => Date; set: (iso: string) => void; advance: (ms: number) => void }
  recordCalls: ExternalAlertInput[]
  calls: { url: string; init: RequestInit }[]
  logs: { level: string; message: string; detail?: Record<string, unknown> }[]
  close: () => void
}

function serviceFixture(options: FixtureOptions = {}): ServiceFixture {
  const dir = tempDataDir()
  const config = testConfig(dir, {
    lofiiEnabled: true,
    lofiiReadToken: 'read-token',
    lofiiControlToken: 'control-token',
    lofiiTimeoutMs: 500,
    lofiiPollMs: 5000,
    ...options.config,
  })
  const db = testDb(dir)
  let current = new Date(T0)
  const clock = {
    now: () => current,
    set: (iso: string) => {
      current = new Date(iso)
    },
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms)
    },
  }
  const recordCalls: ExternalAlertInput[] = []
  const recordExternal =
    options.recordExternal ??
    ((input: ExternalAlertInput) => {
      recordCalls.push(input)
      return recordCalls.length
    })
  const calls: { url: string; init: RequestInit }[] = []
  const handler = options.handler ?? (() => json({ error: 'not_found' }, 404))
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init: init ?? {} })
    return handler(new URL(url), init ?? {})
  }) as typeof fetch
  const logs: { level: string; message: string; detail?: Record<string, unknown> }[] = []
  const client = new LofiiClient({
    baseUrl: config.lofiiUrl,
    readToken: config.lofiiReadToken,
    controlToken: config.lofiiControlToken,
    timeoutMs: config.lofiiTimeoutMs,
    fetch: impl,
  })
  const service = new LofiiService({
    db,
    config,
    alerts: { recordExternal },
    client,
    now: clock.now,
    log: (level, message, detail) => logs.push({ level, message, detail }),
  })
  return {
    dir,
    db,
    config,
    service,
    clock,
    recordCalls,
    calls,
    logs,
    close: () => {
      service.stop()
      db.close()
      cleanupDir(dir)
    },
  }
}

function cursor(db: ReturnType<typeof testDb>): { bootId: string; lastEventId: string | null; lastTs: string | null } | null {
  const raw = getMeta(db, LOFII_EVENT_CURSOR_KEY)
  return raw ? (JSON.parse(raw) as { bootId: string; lastEventId: string | null; lastTs: string | null }) : null
}

/** 构造按 URL 分发的上游处理器；status/recent 可为函数以便逐轮切换。 */
function handlerFor(state: {
  status?: () => Response | Promise<Response>
  recent?: () => Response | Promise<Response>
  history?: () => Response | Promise<Response>
  control?: () => Response | Promise<Response>
}): (url: URL) => Response | Promise<Response> {
  return (url) => {
    if (url.pathname === '/status') return (state.status ?? (() => json(statusBody())))()
    if (url.pathname === '/events/recent') {
      return (state.recent ?? (() => json({ error: 'not_found' }, 404)))()
    }
    if (url.pathname === '/history') {
      return (
        state.history ??
        (() =>
          url.searchParams.get('kind') === 'alerts'
            ? json({ kind: 'alerts', count: 0, alerts: [] })
            : json({ kind: 'samples', count: 0, samples: [] }))
      )()
    }
    if (url.pathname.startsWith('/task') || url.pathname === '/move' || url.pathname === '/say') {
      return (state.control ?? (() => json({ ok: true, requestId: 'req-1', queued: false, position: null })))()
    }
    return json({ error: 'not_found' }, 404)
  }
}

test('轮询：status+recent 并行、缓存 newest-first、快照/版本/游标/单飞', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const events = [
    ev('b1-1', 'alert', 1, { type: 'low_health' }),
    ev('b1-2', 'task', 2, { action: 'started' }),
    ev('b1-3', 'chat', 3, { direction: 'out', text: 'hi' }),
  ]
  const fx = serviceFixture({
    handler: async (url) => {
      await gate
      if (url.pathname === '/status') return json(statusBody({ task: { active: true, name: 'fishing', state: 'running' } }))
      if (url.pathname === '/events/recent') {
        return json({ contractVersion: 1, bootId: 'b1', lastEventId: 'b1-3', events })
      }
      return json({ error: 'not_found' }, 404)
    },
  })
  try {
    const first = fx.service.pollOnce()
    const second = fx.service.pollOnce()
    assert.equal(first, second, '在途轮询应复用同一 Promise（单飞）')
    assert.equal(fx.calls.length, 2, '并发轮询只允许 status + recent 两个请求')
    release()
    const [resultA, resultB] = await Promise.all([first, second])
    assert.deepEqual(resultA, resultB)
    assert.equal(resultA.skipped, false)
    assert.equal(resultA.ok, true)
    assert.equal(resultA.error, null)
    assert.equal(fx.calls.length, 2)

    const snapshot = fx.service.snapshot()
    assert.equal(snapshot.enabled, true)
    assert.equal(snapshot.reachable, true)
    assert.equal(snapshot.stale, false)
    assert.equal(snapshot.controlEnabled, true)
    assert.equal(snapshot.alertsEnabled, true)
    assert.equal(snapshot.eventsSupported, true)
    assert.equal(snapshot.version, '0.6.0')
    assert.equal(snapshot.contractVersion, 1)
    assert.equal(snapshot.lastPollAt, T0)
    assert.equal(snapshot.error, null)
    assert.equal(snapshot.status?.state, 'connected')
    assert.deepEqual(snapshot.events.map((event) => event.id), ['b1-3', 'b1-2', 'b1-1'])
    // 首次轮询只建立游标基线，不重放 ring 内旧告警。
    assert.equal(fx.recordCalls.length, 0)
    assert.deepEqual(cursor(fx.db), { bootId: 'b1', lastEventId: 'b1-3', lastTs: isoTick(3) })
  } finally {
    fx.close()
  }
})

test('事件缓存最多 100 条且 newest-first', async () => {
  const many = Array.from({ length: 120 }, (_, index) => ev(`b1-${index + 1}`, 'task', index + 1))
  const fx = serviceFixture({
    handler: handlerFor({
      recent: () => json({ contractVersion: 1, bootId: 'b1', lastEventId: 'b1-120', events: many.slice(-120) }),
    }),
  })
  try {
    await fx.service.pollOnce()
    assert.equal(fx.service.snapshot().events.length, LOFII_EVENT_CACHE_LIMIT)
    assert.deepEqual(fx.service.snapshot().events.slice(0, 3).map((event) => event.id), ['b1-120', 'b1-119', 'b1-118'])
  } finally {
    fx.close()
  }
})

test('轮询失败只降级 reachable/stale/error，保留旧 status/events', async () => {
  let healthy = true
  const events = [ev('b1-1', 'task', 1)]
  const fx = serviceFixture({
    handler: (url) => {
      if (!healthy) throw new TypeError('connect ECONNREFUSED')
      if (url.pathname === '/status') return json(statusBody())
      return json({ contractVersion: 1, bootId: 'b1', lastEventId: 'b1-1', events })
    },
  })
  try {
    await fx.service.pollOnce()
    const before = fx.service.snapshot()
    assert.equal(before.reachable, true)
    healthy = false
    // 刚失败时还没超过 3 个轮询周期：stale 仍为 false。
    fx.clock.advance(5000)
    const failed = await fx.service.pollOnce()
    assert.equal(failed.ok, false)
    assert.equal(failed.error, 'lofii_unavailable')
    const snapshot = fx.service.snapshot()
    assert.equal(snapshot.reachable, false)
    assert.equal(snapshot.stale, false)
    assert.equal(snapshot.error, 'lofii_unavailable')
    assert.deepEqual(snapshot.status, before.status, '失败不应清空旧状态快照')
    assert.deepEqual(snapshot.events.map((event) => event.id), ['b1-1'], '失败不应清空旧事件缓存')
    assert.equal(snapshot.version, '0.6.0')

    // 超过 3 个轮询周期仍无成功：判定 stale。
    fx.clock.advance(3 * 5000 + 1)
    await fx.service.pollOnce()
    assert.equal(fx.service.snapshot().stale, true)
    // 恢复后 stale=false 且保留缓存。
    healthy = true
    fx.clock.advance(5000)
    const recovered = await fx.service.pollOnce()
    assert.equal(recovered.ok, true)
    assert.equal(fx.service.snapshot().stale, false)
    assert.deepEqual(fx.service.snapshot().events.map((event) => event.id), ['b1-1'])
  } finally {
    fx.close()
  }
})

test('/events/recent 404：eventsSupported=false 但 /status 仍可用，contractVersion 归 null', async () => {
  const fx = serviceFixture({
    handler: handlerFor({ recent: () => json({ error: 'not_found', message: 'not found' }, 404) }),
  })
  try {
    const result = await fx.service.pollOnce()
    assert.equal(result.ok, true)
    assert.equal(result.error, null)
    const snapshot = fx.service.snapshot()
    assert.equal(snapshot.reachable, true)
    assert.equal(snapshot.eventsSupported, false)
    assert.equal(snapshot.contractVersion, null)
    assert.equal(snapshot.version, '0.6.0')
    assert.deepEqual(snapshot.events, [])
    assert.equal(cursor(fx.db), null, '无事件流时不写游标')
  } finally {
    fx.close()
  }
})

test('空 ring 基线：首轮无事件写空基线，之后第一条例告警正常处理', async () => {
  let events: LofiiEvent[] = []
  const fx = serviceFixture({
    handler: handlerFor({
      recent: () => json({ contractVersion: 1, bootId: 'b1', lastEventId: events.at(-1)?.id ?? null, events }),
    }),
  })
  try {
    await fx.service.pollOnce()
    assert.equal(fx.recordCalls.length, 0)
    assert.deepEqual(cursor(fx.db), { bootId: 'b1', lastEventId: null, lastTs: null })

    events = [ev('b1-1', 'alert', 1, { type: 'low_health', message: '血量偏低' })]
    await fx.service.pollOnce()
    assert.equal(fx.recordCalls.length, 1, '空 ring 基线之后的首条告警不应被吞掉')
    assert.equal(fx.recordCalls[0]?.event, 'lofii_low_health')
    assert.equal(cursor(fx.db)?.lastEventId, 'b1-1')
  } finally {
    fx.close()
  }
})

test('从未成功：连续 3 轮失败才判定 stale，恢复后清除', async () => {
  let healthy = false
  const fx = serviceFixture({
    handler: handlerFor({
      status: () => {
        if (!healthy) throw new TypeError('connect ECONNREFUSED')
        return json(statusBody())
      },
      recent: () => json({ contractVersion: 1, bootId: 'b1', lastEventId: null, events: [] }),
    }),
  })
  try {
    await fx.service.pollOnce()
    assert.equal(fx.service.snapshot().stale, false, '首次失败给启动宽限')
    await fx.service.pollOnce()
    assert.equal(fx.service.snapshot().stale, false)
    await fx.service.pollOnce()
    assert.equal(fx.service.snapshot().stale, true, '连续 3 轮失败判定 stale')
    healthy = true
    await fx.service.pollOnce()
    assert.equal(fx.service.snapshot().stale, false)
    assert.equal(fx.service.snapshot().reachable, true)
  } finally {
    fx.close()
  }
})

test('游标：bootId 变化只重建基线，不重放旧 ring 告警', async () => {
  let boot = 'b1'
  let events = [ev('b1-1', 'alert', 1, { type: 'low_health' }), ev('b1-2', 'task', 2)]
  const fx = serviceFixture({
    handler: handlerFor({
      recent: () => json({ contractVersion: 1, bootId: boot, lastEventId: events.at(-1)?.id ?? null, events }),
    }),
  })
  try {
    await fx.service.pollOnce()
    assert.equal(fx.recordCalls.length, 0, '首次只建立基线')
    assert.equal(cursor(fx.db)?.lastEventId, 'b1-2')

    // Lofii 重启：bootId 变化，ring 内同类型旧告警不得补发。
    boot = 'b2'
    events = [
      ev('b2-1', 'alert', 3, { type: 'low_health' }),
      ev('b2-2', 'alert', 4, { type: 'task_failed' }),
    ]
    await fx.service.pollOnce()
    assert.equal(fx.recordCalls.length, 0, 'bootId 变化不重放旧告警')
    assert.deepEqual(cursor(fx.db), { bootId: 'b2', lastEventId: 'b2-2', lastTs: isoTick(4) })

    // 新 boot 基线之后的新告警正常处理。
    events = [...events, ev('b2-3', 'alert', 5, { type: 'task_failed', message: '任务失败' })]
    await fx.service.pollOnce()
    assert.equal(fx.recordCalls.length, 1)
    assert.equal(fx.recordCalls[0]?.event, 'lofii_task_failed')
    assert.equal(cursor(fx.db)?.lastEventId, 'b2-3')
  } finally {
    fx.close()
  }
})

test('游标去重：只处理游标之后的 alert；重复窗口不重复写入', async () => {
  let events: LofiiEvent[] = [ev('b1-1', 'alert', 1, { type: 'low_health' }), ev('b1-2', 'task', 2)]
  const fx = serviceFixture({
    handler: handlerFor({
      recent: () => json({ contractVersion: 1, bootId: 'b1', lastEventId: events.at(-1)?.id ?? null, events }),
    }),
  })
  try {
    await fx.service.pollOnce()
    assert.equal(fx.recordCalls.length, 0)

    // 窗口内包含 cursor 之前/等于 cursor 的事件（b1-1、b1-2），只能处理 b1-3。
    events = [
      ev('b1-1', 'alert', 1, { type: 'low_health' }),
      ev('b1-2', 'task', 2),
      ev('b1-3', 'alert', 3, { type: 'chest_full' }),
      ev('b1-4', 'chat', 4, { text: 'hello' }),
    ]
    await fx.service.pollOnce()
    assert.equal(fx.recordCalls.length, 1)
    assert.equal(fx.recordCalls[0]?.event, 'lofii_chest_full')
    assert.equal(cursor(fx.db)?.lastEventId, 'b1-4')

    // 同一窗口再轮询：cursor 之后无新事件，不重复。
    await fx.service.pollOnce()
    assert.equal(fx.recordCalls.length, 1)

    // ring 已滚出 cursor（窗口里没有 b1-4）：按序号比较，只处理更新的 b1-5。
    events = [ev('b1-4', 'task', 4), ev('b1-5', 'alert', 5, { type: 'disconnected' })]
    await fx.service.pollOnce()
    assert.equal(fx.recordCalls.length, 2)
    assert.equal(fx.recordCalls[1]?.event, 'lofii_disconnected')
  } finally {
    fx.close()
  }
})

test('告警映射：5 种已知类型 + 未知类型，details 含 source/lofiiEventId/lofiiType 且被清洗', async () => {
  const fx = serviceFixture({
    handler: handlerFor({
      recent: () =>
        json({
          contractVersion: 1,
          bootId: 'b1',
          lastEventId: 'b1-6',
          events: [
            ev('b1-1', 'alert', 1, { type: 'low_health', severity: 'warning', message: '血量 8/20', details: { health: 8 } }),
            ev('b1-2', 'alert', 2, { type: 'task_failed', message: '任务失败', details: { task: 'fishing' } }),
            ev('b1-3', 'alert', 3, { type: 'disconnected', message: '连接断开' }),
            ev('b1-4', 'alert', 4, { type: 'chest_full', message: '箱子满' }),
            ev('b1-5', 'alert', 5, { type: 'defense_retreat', message: '撤退' }),
            ev('b1-6', 'alert', 6, {
              type: 'gremlin',
              severity: 'error',
              message: '未知告警',
              details: { nested: { deep: { tooDeep: true } }, list: [1, 2, 3], long: 'y'.repeat(500), ok: true },
            }),
          ],
        }),
    }),
  })
  try {
    await fx.service.pollOnce() // 基线：全部不告警
    assert.equal(fx.recordCalls.length, 0)
    // 建立基线后再来一轮新事件，验证映射（先推进 cursor 到 b1-0，避免首次基线吞掉）。
    setMeta(
      fx.db,
      LOFII_EVENT_CURSOR_KEY,
      JSON.stringify({ bootId: 'b1', lastEventId: 'b1-0', lastTs: isoTick(0) }),
    )
    await fx.service.pollOnce()
    assert.equal(fx.recordCalls.length, 6)
    assert.deepEqual(
      fx.recordCalls.map((input) => `${input.event}:${input.severity}`),
      [
        'lofii_low_health:warning',
        'lofii_task_failed:critical',
        'lofii_disconnected:critical',
        'lofii_chest_full:warning',
        'lofii_defense_retreat:warning',
        'lofii_alert:critical',
      ],
    )
    assert.equal(fx.recordCalls[0]?.message, '血量 8/20')
    assert.equal(fx.recordCalls[0]?.details.source, 'lofii')
    assert.equal(fx.recordCalls[0]?.details.lofiiEventId, 'b1-1')
    assert.equal(fx.recordCalls[0]?.details.lofiiType, 'low_health')
    assert.equal(fx.recordCalls[0]?.details.health, 8)
    const unknown = fx.recordCalls[5]?.details
    assert.equal(unknown?.lofiiType, 'gremlin')
    assert.equal(unknown?.ok, true)
    assert.equal(String(unknown?.long).length, 300, '超长字符串应截断')
    assert.deepEqual(unknown?.nested, { deep: null }, '超过深度限制的内层对象降级为 null')
    assert.deepEqual(unknown?.list, [1, 2, 3])
  } finally {
    fx.close()
  }
})

test('LOFII_ALERTS_ENABLED=false：推进游标但不写告警；重新启用后不补发旧告警', async () => {
  let events: LofiiEvent[] = [ev('b1-1', 'alert', 1, { type: 'low_health' })]
  const fx = serviceFixture({
    config: { lofiiAlertsEnabled: false },
    handler: handlerFor({
      recent: () => json({ contractVersion: 1, bootId: 'b1', lastEventId: events.at(-1)?.id ?? null, events }),
    }),
  })
  let second: LofiiService | null = null
  try {
    await fx.service.pollOnce() // 基线
    events = [...events, ev('b1-2', 'alert', 2, { type: 'task_failed' })]
    const result = await fx.service.pollOnce()
    assert.equal(result.alerts, 0, '告警关闭时不写入')
    assert.equal(fx.recordCalls.length, 0)
    assert.equal(cursor(fx.db)?.lastEventId, 'b1-2', '告警关闭仍推进游标')

    // 用同一 DB 新建启用告警的服务：旧告警已越过游标，不得补发。
    const enabledConfig = { ...fx.config, lofiiAlertsEnabled: true }
    second = new LofiiService({
      db: fx.db,
      config: enabledConfig,
      alerts: { recordExternal: (input) => (fx.recordCalls.push(input), fx.recordCalls.length) },
      client: new LofiiClient({
        baseUrl: fx.config.lofiiUrl,
        readToken: fx.config.lofiiReadToken,
        controlToken: fx.config.lofiiControlToken,
        timeoutMs: fx.config.lofiiTimeoutMs,
        fetch: (async (input: string | URL | Request) => {
          const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
          if (url.pathname === '/status') return json(statusBody())
          return json({ contractVersion: 1, bootId: 'b1', lastEventId: events.at(-1)?.id ?? null, events })
        }) as typeof fetch,
      }),
      now: fx.clock.now,
      log: () => {},
    })
    await second.pollOnce()
    assert.equal(fx.recordCalls.length, 0, '重新启用后不补发游标之前的历史告警')
    events = [...events, ev('b1-3', 'alert', 3, { type: 'disconnected' })]
    await second.pollOnce()
    assert.equal(fx.recordCalls.length, 1)
    assert.equal(fx.recordCalls[0]?.event, 'lofii_disconnected')
  } finally {
    second?.stop()
    fx.close()
  }
})

test('控制代理：控制成功后立即刷新；只读模式只允许 /say；history 透传读 Token', async () => {
  const fx = serviceFixture({
    handler: handlerFor({
      recent: () => json({ contractVersion: 1, bootId: 'b1', lastEventId: null, events: [] }),
    }),
  })
  try {
    const started = await fx.service.startTask('fishing')
    assert.equal(started.ok, true)
    assert.equal(started.queued, false)
    assert.equal(new URL(fx.calls[0]!.url).pathname, '/task/start')
    assert.equal(
      String((fx.calls[0]!.init.headers as Record<string, string>).authorization),
      'Bearer control-token',
    )
    // 控制成功后立即刷新：/status + /events/recent。
    assert.deepEqual(
      fx.calls.slice(1).map((call) => new URL(call.url).pathname),
      ['/status', '/events/recent'],
    )

    await fx.service.move('come', 'Antifield')
    assert.equal(new URL(fx.calls[3]!.url).pathname, '/move')

    await fx.service.say('你好')
    const sayCall = fx.calls.find((call) => new URL(call.url).pathname === '/say')
    assert.ok(sayCall)
    assert.equal(String((sayCall.init.headers as Record<string, string>).authorization), 'Bearer read-token')

    const history = await fx.service.history('alerts', { limit: 50 })
    assert.equal(history.kind, 'alerts')
    const historyCall = fx.calls.find((call) => new URL(call.url).pathname === '/history')
    assert.equal(new URL(historyCall!.url).searchParams.get('kind'), 'alerts')
    assert.equal(new URL(historyCall!.url).searchParams.get('limit'), '50')
  } finally {
    fx.close()
  }
})

test('只读模式（无控制 Token）：控制方法抛 lofii_control_disabled，/say 仍可用并刷新', async () => {
  const fx = serviceFixture({
    config: { lofiiControlToken: '' },
    handler: handlerFor({ recent: () => json({ contractVersion: 1, bootId: 'b1', lastEventId: null, events: [] }) }),
  })
  try {
    await assert.rejects(
      () => fx.service.startTask('fishing'),
      (error: unknown) => (error as { code?: string }).code === 'lofii_control_disabled',
    )
    assert.equal(fx.calls.length, 0)
    assert.equal(fx.service.snapshot().controlEnabled, false)
    const say = await fx.service.say('hi')
    assert.equal(say.ok, true)
    assert.deepEqual(fx.calls.map((call) => new URL(call.url).pathname), ['/say', '/status', '/events/recent'])
  } finally {
    fx.close()
  }
})

test('start/stop：空操作幂等、启动即轮询、停止后不再定时轮询', async () => {
  const fx = serviceFixture({
    handler: handlerFor({ recent: () => json({ contractVersion: 1, bootId: 'b1', lastEventId: null, events: [] }) }),
  })
  try {
    fx.service.start()
    fx.service.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(fx.service.snapshot().lastPollAt, T0)
    const callsBeforeStop = fx.calls.length
    fx.service.stop()
    fx.service.stop()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(fx.calls.length, callsBeforeStop, 'stop 后不应再有轮询请求')
  } finally {
    fx.close()
  }

  // 禁用状态：start 不建定时器、pollOnce 跳过、snapshot 为空壳。
  const disabled = serviceFixture({ config: { lofiiEnabled: false } })
  try {
    disabled.service.start()
    disabled.service.stop()
    const result = await disabled.service.pollOnce()
    assert.equal(result.skipped, true)
    assert.equal(result.error, 'lofii_disabled')
    const snapshot = disabled.service.snapshot()
    assert.equal(snapshot.enabled, false)
    assert.equal(snapshot.eventsSupported, false)
    assert.deepEqual(snapshot.events, [])
    assert.equal(disabled.calls.length, 0)
  } finally {
    disabled.close()
  }
})

test('meta 中游标损坏：按无游标处理（基线，不重放旧告警）', async () => {
  const fx = serviceFixture({
    handler: handlerFor({
      recent: () =>
        json({
          contractVersion: 1,
          bootId: 'b1',
          lastEventId: 'b1-1',
          events: [ev('b1-1', 'alert', 1, { type: 'low_health' })],
        }),
    }),
  })
  try {
    setMeta(fx.db, LOFII_EVENT_CURSOR_KEY, '{broken json')
    await fx.service.pollOnce()
    assert.equal(fx.recordCalls.length, 0)
    assert.equal(cursor(fx.db)?.lastEventId, 'b1-1')
  } finally {
    fx.close()
  }
})

test('日志不包含聊天正文/Token；事件缓存可含聊天但只在内存', async () => {
  const fx = serviceFixture({
    handler: handlerFor({
      recent: () =>
        json({
          contractVersion: 1,
          bootId: 'b1',
          lastEventId: 'b1-1',
          events: [ev('b1-1', 'chat', 1, { direction: 'in', message: 'secret chat message' })],
        }),
    }),
  })
  try {
    await fx.service.pollOnce()
    assert.equal(fx.service.snapshot().events[0]?.type, 'chat')
    const serializedLogs = JSON.stringify(fx.logs)
    assert.ok(!serializedLogs.includes('secret chat message'), '日志不得包含聊天正文')
    assert.ok(!serializedLogs.includes('read-token'))
    assert.ok(!serializedLogs.includes('control-token'))
  } finally {
    fx.close()
  }
})

test('告警写入失败：游标停在上一条已处理事件，下一轮重试且不永久丢告警', async () => {
  const first = ev('b1-1', 'chat', 1, { direction: 'out', text: 'hello' })
  const alert = ev('b1-2', 'alert', 2, { type: 'low_health', message: '血量低' })
  let round = 0
  let attempts = 0
  const recorded: ExternalAlertInput[] = []
  const fx = serviceFixture({
    handler: handlerFor({
      recent: () => {
        round += 1
        return json({
          contractVersion: 1,
          bootId: 'b1',
          lastEventId: round === 1 ? 'b1-1' : 'b1-2',
          events: round === 1 ? [first] : [first, alert],
        })
      },
    }),
    recordExternal: (input) => {
      attempts += 1
      if (attempts === 1) throw new Error('db busy')
      recorded.push(input)
      return attempts
    },
  })
  try {
    await fx.service.pollOnce() // 基线
    const failed = await fx.service.pollOnce()
    assert.equal(failed.alerts, 0)
    assert.equal(attempts, 1)
    assert.equal(cursor(fx.db)?.lastEventId, 'b1-1', '失败告警不得被游标跳过')
    assert.equal(recorded.length, 0)

    const retried = await fx.service.pollOnce()
    assert.equal(retried.alerts, 1)
    assert.equal(attempts, 2)
    assert.equal(recorded.length, 1)
    assert.equal(cursor(fx.db)?.lastEventId, 'b1-2')
  } finally {
    fx.close()
  }
})

test('事件缓存有总字节上限：超大事件不会无界占用内存', async () => {
  const large = 'x'.repeat(300 * 1024)
  const fx = serviceFixture({
    handler: handlerFor({
      recent: () =>
        json({
          contractVersion: 1,
          bootId: 'b1',
          lastEventId: 'b1-2',
          events: [
            ev('b1-1', 'chat', 1, { direction: 'out', text: large }),
            ev('b1-2', 'chat', 2, { direction: 'out', text: large }),
          ],
        }),
    }),
  })
  try {
    await fx.service.pollOnce()
    const snapshot = fx.service.snapshot()
    assert.equal(snapshot.events.length, 1, '超过字节预算的旧事件应被丢弃')
    assert.equal(snapshot.events[0]?.id, 'b1-2')
  } finally {
    fx.close()
  }
})

test('导出函数：eventsAfterCursor 窗口内/窗口外/时间兜底，mapLofiiAlert 忽略非 alert', () => {
  const events = [ev('b1-1', 'alert', 1), ev('b1-2', 'alert', 2), ev('b1-3', 'alert', 3)]
  assert.deepEqual(
    eventsAfterCursor(events, { bootId: 'b1', lastEventId: 'b1-1', lastTs: isoTick(1) }).map((event) => event.id),
    ['b1-2', 'b1-3'],
  )
  assert.deepEqual(
    eventsAfterCursor(events, { bootId: 'b1', lastEventId: 'b1-0', lastTs: isoTick(0) }).map((event) => event.id),
    ['b1-1', 'b1-2', 'b1-3'],
  )
  assert.deepEqual(eventsAfterCursor(events, { bootId: 'b1', lastEventId: null, lastTs: null }), [])
  // id 无法解析序号时回退时间比较。
  const weird = [{ id: 'custom-1', type: 'alert', ts: isoTick(10), data: {} }]
  assert.equal(eventsAfterCursor(weird, { bootId: 'b1', lastEventId: 'b1-x', lastTs: isoTick(5) }).length, 1)
  // 无法判断时序时不重复告警。
  assert.equal(eventsAfterCursor(weird, { bootId: 'b1', lastEventId: 'b1-x', lastTs: null }).length, 0)
  assert.equal(mapLofiiAlert(ev('b1-9', 'task', 9)), null)
})
