/** 告警模块测试：阈值评估、去重/冷却/恢复、webhook 投递与脱敏、路由与启停。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { Config } from '../src/config.ts'
import {
  AlertService,
  DEFAULT_MEMORY_USED_PCT,
  parsePiHealth,
  parseThrottled,
  type AlertDeps,
} from '../src/alerts/service.ts'
import { registerAlertRoutes } from '../src/http/routes/alerts.ts'
import { authHeaders, createAuthedApp, csrfHeadersOnly, phase2Fixture, type Phase2Fixture } from './phase2-fixtures.ts'

const T0 = '2026-06-01T00:00:00.000Z'
const WEBHOOK = 'https://hooks.example.test/notify?token=super-secret'

interface AlertFixture extends Phase2Fixture {
  alerts: AlertService
  clock: { now: () => Date; set: (iso: string) => void; advanceMs: (ms: number) => void }
  logs: { level: string; message: string; detail?: Record<string, unknown> }[]
}

interface AlertFixtureOptions {
  config?: Partial<Config>
  deps?: AlertDeps
}

function alertFixture(options: AlertFixtureOptions = {}): AlertFixture {
  const fixture = phase2Fixture({
    alertWebhookUrl: '',
    alertsEnabled: true,
    alertDiskFreePct: 15,
    alertTempC: 80,
    alertBackupMaxAgeHours: 48,
    alertCooldownMinutes: 5,
    alertCheckIntervalSeconds: 60,
    ...options.config,
  })
  fixture.config.piHealthFile = join(fixture.dir, 'pi-health.json')
  let current = new Date(T0)
  const clock = {
    now: () => current,
    set: (iso: string) => {
      current = new Date(iso)
    },
    advanceMs: (ms: number) => {
      current = new Date(current.getTime() + ms)
    },
  }
  const logs: { level: string; message: string; detail?: Record<string, unknown> }[] = []
  const alerts = new AlertService(fixture.db, fixture.config, {
    now: clock.now,
    sleep: async () => {},
    log: (level, message, detail) => {
      logs.push({ level, message, detail })
    },
    statfs: () => ({ availableBytes: 50, totalBytes: 100 }),
    memory: () => ({ totalBytes: 100, usedBytes: 50 }),
    serviceStates: async () => ({}),
    readFile: () => {
      throw new Error('ENOENT: pi-health 不存在')
    },
    ...options.deps,
  })
  return { ...fixture, alerts, clock, logs }
}

function eventNames(rows: { event: string; status: string }[]): string[] {
  return rows.map((row) => `${row.event}:${row.status}`)
}

function events(fx: AlertFixture): { id: number; event: string; status: string; severity: string; title: string; delivered_at: string | null; delivery_error: string | null }[] {
  return fx.db
    .prepare('SELECT id, event, status, severity, title, delivered_at, delivery_error FROM alert_events ORDER BY id ASC')
    .all() as unknown as { id: number; event: string; status: string; severity: string; title: string; delivered_at: string | null; delivery_error: string | null }[]
}

test('磁盘阈值：首次 firing、冷却内去重、冷却后重复通知与恢复', async () => {
  const fx = alertFixture({
    deps: {
      statfs: () => ({ availableBytes: 5, totalBytes: 100 }),
      // 其它数据源保持可用，避免 unknown 降级事件干扰本用例的事件计数。
      readFile: (path) => {
        if (path.endsWith('backup-pull.json')) {
          return JSON.stringify({
            lastPullAt: T0,
            secretsAttempted: true,
            secretsOk: true,
            lastSecretsAt: T0,
          })
        }
        if (path.endsWith('status.json')) {
          return JSON.stringify({ lastRunAt: T0, ok: true })
        }
        return JSON.stringify({ tempC: 45, underVoltage: false, throttled: '0x0' })
      },
      serviceStates: async () => ({ minecraft: 'active' }),
      minecraftStatus: async () => ({ online: true }),
    },
  })
  try {
    fx.db.prepare('UPDATE backup_state SET last_backup_at = ? WHERE id = 1').run(T0)
    const first = await fx.alerts.evaluateOnce()
    assert.equal(first.skipped, false)
    assert.equal(first.checked, 12, '12 个告警条件（含 v0.4.0 世界备份/拉取/演练）')
    assert.equal(first.firing, 1)
    assert.match(eventNames(events(fx))[0] ?? '', /^disk_low:firing$/)
    assert.equal(events(fx)[0]?.severity, 'critical', '剩余 5% 低于阈值一半应为 critical')

    const state = fx.db.prepare("SELECT * FROM alert_state WHERE event = 'disk_low'").get() as {
      status: string
      last_fired_at: string
    }
    assert.equal(state.status, 'firing')
    assert.equal(state.last_fired_at, T0)

    // 同一时刻/冷却期内不重复产生事件。
    await fx.alerts.evaluateOnce()
    fx.clock.advanceMs(2 * 60_000)
    await fx.alerts.evaluateOnce()
    assert.equal(events(fx).length, 1)

    // 超过冷却时间（5 分钟）后重复通知。
    fx.clock.advanceMs(4 * 60_000)
    const repeated = await fx.alerts.evaluateOnce()
    assert.equal(repeated.firing, 1)
    assert.equal(events(fx).length, 2)
    assert.equal(events(fx)[1]?.status, 'firing')

    // 恢复：同一 DB 上换用健康依赖，产生 resolved 事件并把状态置回 ok。
    fx.clock.advanceMs(60_000)
    const healthy = new AlertService(fx.db, fx.config, {
      now: fx.clock.now,
      sleep: async () => {},
      log: () => {},
      statfs: () => ({ availableBytes: 90, totalBytes: 100 }),
      memory: () => ({ totalBytes: 100, usedBytes: 10 }),
      serviceStates: async () => ({}),
      readFile: () => {
        throw new Error('ENOENT')
      },
    })
    const result = await healthy.evaluateOnce()
    assert.equal(result.resolved, 1)
    const rows = events(fx)
    assert.equal(rows.at(-1)?.status, 'resolved')
    assert.match(rows.at(-1)?.title ?? '', /已恢复/)
    const stateRow = fx.db.prepare("SELECT * FROM alert_state WHERE event = 'disk_low'").get() as {
      status: string
      last_ok_at: string
    }
    assert.equal(stateRow.status, 'ok')
    assert.equal(stateRow.last_ok_at, fx.clock.now().toISOString())
    // 持续正常时不产生新事件。
    const before = events(fx).length
    await healthy.evaluateOnce()
    assert.equal(events(fx).length, before)
  } finally {
    fx.close()
  }
})

test('温度/内存/服务/备份超期/待拉取/Minecraft/欠压同时触发', async () => {
  const fx = alertFixture({
    deps: {
      statfs: () => ({ availableBytes: 60, totalBytes: 100 }),
      memory: () => ({ totalBytes: 100, usedBytes: 95 }),
      serviceStates: async () => ({ minecraft: 'inactive', nginx: 'active', cloudflared: 'unknown' }),
      minecraftStatus: async () => ({ online: false, error: '连接超时' }),
      readFile: (path: string) => {
        if (path.endsWith('pi-health.json')) {
          return JSON.stringify({ tempC: 95.5, throttled: '0x1' })
        }
        throw new Error('ENOENT')
      },
    },
  })
  try {
    fx.db.prepare('UPDATE backup_state SET last_backup_at = ? WHERE id = 1').run('2026-05-29T00:00:00.000Z')
    fx.db
      .prepare(
        `INSERT INTO backup_archives (name, mode, created_at, sha256, size, file_count)
         VALUES ('snapshot-1-full.tar.gz', 'full', ?, ?, 1, 1)`,
      )
      .run('2026-05-29T12:00:00.000Z', 'a'.repeat(64))

    const result = await fx.alerts.evaluateOnce()
    assert.equal(result.skipped, false)
    const firing = events(fx).filter((row) => row.status === 'firing')
    assert.deepEqual(
      firing.map((row) => row.event).sort(),
      ['backup_overdue', 'backup_pending', 'mc_offline', 'mem_high', 'service_down', 'temp_high', 'undervoltage'].sort(),
    )

    const temp = firing.find((row) => row.event === 'temp_high')
    assert.equal(temp?.severity, 'critical')
    const service = firing.find((row) => row.event === 'service_down')
    assert.ok(service)
    const serviceDetail = fx.db
      .prepare("SELECT details_json FROM alert_events WHERE event = 'service_down'")
      .get() as { details_json: string }
    assert.deepEqual(JSON.parse(serviceDetail.details_json).down, ['minecraft'])
    const undervoltage = fx.db
      .prepare("SELECT details_json FROM alert_events WHERE event = 'undervoltage'")
      .get() as { details_json: string }
    assert.equal(JSON.parse(undervoltage.details_json).underVoltage, true)

    const stateRows = fx.db.prepare('SELECT event FROM alert_state').all() as unknown as { event: string }[]
    assert.ok(stateRows.some((row) => row.event === 'temp_high'))
    // 磁盘/其它正常指标被静默记录为 ok，不产生事件。
    assert.ok(stateRows.some((row) => row.event === 'disk_low'))
  } finally {
    fx.close()
  }
})

test('未知指标不改变既有状态', async () => {
  const firingFx = alertFixture({ deps: { statfs: () => ({ availableBytes: 5, totalBytes: 100 }) } })
  try {
    await firingFx.alerts.evaluateOnce()
    const healthy = new AlertService(firingFx.db, firingFx.config, {
      now: firingFx.clock.now,
      sleep: async () => {},
      log: () => {},
      statfs: () => null,
      memory: () => null,
      serviceStates: async () => ({}),
      readFile: () => {
        throw new Error('ENOENT')
      },
    })
    const result = await healthy.evaluateOnce()
    assert.equal(result.skipped, false)
    assert.equal(result.firing, 0)
    const state = firingFx.db
      .prepare("SELECT status FROM alert_state WHERE event = 'disk_low'")
      .get() as { status: string }
    assert.equal(state.status, 'firing', '未知不应覆盖既有 firing 状态')
    assert.equal(events(firingFx).length, 1)
  } finally {
    firingFx.close()
  }
})

test('webhook：成功投递带签名、失败重试 3 次且日志不含 URL', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const success = alertFixture({
    config: { alertWebhookUrl: WEBHOOK, alertWebhookSecret: 'whsec-test' },
    deps: {
      statfs: () => ({ availableBytes: 5, totalBytes: 100 }),
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init })
        return { ok: true, status: 200 } as unknown as Response
      }) as unknown as typeof fetch,
    },
  })
  try {
    const result = await success.alerts.evaluateOnce()
    assert.equal(result.delivered, 1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, WEBHOOK)
    const headers = calls[0]?.init?.headers as Record<string, string>
    assert.match(headers['x-antifieldcloud-signature'] ?? '', /^sha256=[0-9a-f]{64}$/)
    assert.ok(calls[0]?.init?.signal, '应带超时 AbortSignal')
    const payload = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>
    assert.equal(payload.source, 'antifieldcloud')
    assert.equal(payload.event, 'disk_low')
    assert.equal(payload.severity, 'critical')
    assert.equal(payload.status, 'firing')
    const row = events(success)[0]
    assert.ok(row?.delivered_at)
    assert.equal(row?.delivery_error, null)
    assert.ok(!JSON.stringify(success.logs).includes(WEBHOOK), '日志不得包含 webhook URL')
  } finally {
    success.close()
  }

  const attempts: string[] = []
  const failure = alertFixture({
    config: { alertWebhookUrl: WEBHOOK, alertWebhookSecret: 'whsec-test' },
    deps: {
      statfs: () => ({ availableBytes: 5, totalBytes: 100 }),
      fetch: (async (url: string | URL | Request) => {
        attempts.push(String(url))
        throw new Error(`connect ECONNREFUSED ${WEBHOOK}`)
      }) as unknown as typeof fetch,
    },
  })
  try {
    const result = await failure.alerts.evaluateOnce()
    assert.equal(result.delivered, 0)
    assert.equal(attempts.length, 3, '失败应最多重试 3 次')
    const row = events(failure)[0]
    assert.equal(row?.delivered_at, null)
    assert.ok(row?.delivery_error)
    const serialized = `${row?.delivery_error}\n${JSON.stringify(failure.logs)}`
    assert.ok(!serialized.includes(WEBHOOK), '错误与日志不得包含 webhook URL')
    assert.ok(!serialized.includes('super-secret'), '错误与日志不得包含 URL 中的敏感参数')
    assert.ok(failure.logs.some((entry) => entry.message.includes('投递失败')))
  } finally {
    failure.close()
  }
})

test('sendTest：未配置、成功与失败路径', async () => {
  const noWebhook = alertFixture()
  try {
    const result = await noWebhook.alerts.sendTest()
    assert.equal(result.ok, false)
    assert.equal(result.delivered, false)
    assert.match(result.message ?? '', /未配置/)
    assert.equal(events(noWebhook).length, 1)
    assert.equal(events(noWebhook)[0]?.event, 'test')
  } finally {
    noWebhook.close()
  }

  let calls = 0
  const success = alertFixture({
    config: { alertWebhookUrl: WEBHOOK },
    deps: {
      fetch: (async () => {
        calls += 1
        return { ok: true, status: 200 } as unknown as Response
      }) as unknown as typeof fetch,
    },
  })
  try {
    const result = await success.alerts.sendTest()
    assert.deepEqual(result, { ok: true, delivered: true })
    assert.equal(calls, 1)
    const payload = success.db
      .prepare("SELECT event, status FROM alert_events WHERE event = 'test'")
      .get() as { event: string; status: string }
    assert.equal(payload.event, 'test')
  } finally {
    success.close()
  }

  const failure = alertFixture({
    config: { alertWebhookUrl: WEBHOOK },
    deps: {
      fetch: (async () => {
        throw new Error(`request to ${WEBHOOK} failed`)
      }) as unknown as typeof fetch,
    },
  })
  try {
    const result = await failure.alerts.sendTest()
    assert.equal(result.ok, false)
    assert.equal(result.delivered, false)
    assert.ok(!String(result.message).includes(WEBHOOK))
  } finally {
    failure.close()
  }
})

test('GET/POST 告警路由：认证、CSRF、形状与测试限流', async () => {
  let fetchCalls = 0
  const fx = alertFixture({
    config: { alertWebhookUrl: WEBHOOK },
    deps: {
      statfs: () => ({ availableBytes: 5, totalBytes: 100 }),
      fetch: (async () => {
        fetchCalls += 1
        return { ok: true, status: 200 } as unknown as Response
      }) as unknown as typeof fetch,
    },
  })
  const app = await createAuthedApp(fx.db, (instance) => {
    registerAlertRoutes(instance, fx.config, fx.alerts)
  })
  try {
    const anonymous = await app.inject({ method: 'GET', url: '/api/alerts' })
    assert.equal(anonymous.statusCode, 401)

    await fx.alerts.evaluateOnce()
    fetchCalls = 0
    const list = await app.inject({ method: 'GET', url: '/api/alerts?limit=5', headers: authHeaders() })
    assert.equal(list.statusCode, 200)
    assert.deepEqual(Object.keys(list.json()).sort(), ['config', 'items', 'state', 'total'])
    const body = list.json() as {
      items: unknown[]
      state: unknown[]
      config: {
        enabled: boolean
        webhookConfigured: boolean
        diskFreePct: number
        tempC: number
        memoryUsedPct: number
        backupMaxAgeHours: number
        cooldownMinutes: number
        checkIntervalSeconds: number
      }
    }
    assert.ok(body.items.length >= 1)
    assert.equal(body.config.enabled, true)
    assert.equal(body.config.webhookConfigured, true)
    assert.equal(body.config.memoryUsedPct, DEFAULT_MEMORY_USED_PCT)
    assert.equal(body.config.diskFreePct, 15)
    assert.equal(body.config.tempC, 80)
    assert.equal(body.config.backupMaxAgeHours, 48)
    assert.equal(body.config.cooldownMinutes, 5)
    assert.equal(body.config.checkIntervalSeconds, 60)

    const noCsrf = await app.inject({ method: 'POST', url: '/api/alerts/test', headers: csrfHeadersOnly() })
    assert.equal(noCsrf.statusCode, 403)
    assert.equal(noCsrf.json().error.code, 'csrf_failed')

    for (let index = 0; index < 10; index += 1) {
      const response = await app.inject({ method: 'POST', url: '/api/alerts/test', headers: authHeaders() })
      assert.equal(response.statusCode, 200, `第 ${index + 1} 次测试告警应放行`)
      assert.equal(typeof response.json().ok, 'boolean')
      assert.equal(typeof response.json().delivered, 'boolean')
    }
    const limited = await app.inject({ method: 'POST', url: '/api/alerts/test', headers: authHeaders() })
    assert.equal(limited.statusCode, 429)
    assert.equal(limited.json().error.code, 'rate_limited')
    assert.equal(fetchCalls, 10, '每次测试告警各投递一次')
  } finally {
    await app.close()
    fx.close()
  }
})

test('启动/停止、关闭开关与 pi-health 解析', async () => {
  const fx = alertFixture({
    config: { alertWebhookUrl: '' },
    deps: {
      statfs: () => ({ availableBytes: 5, totalBytes: 100 }),
      fetch: (async () => {
        throw new Error('不应调用 webhook')
      }) as unknown as typeof fetch,
    },
  })
  try {
    fx.alerts.start()
    fx.alerts.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.ok(events(fx).length >= 1, 'start 后应执行一次评估')
    fx.alerts.stop()
    fx.alerts.stop()

    const disabled = alertFixture({ config: { alertsEnabled: false } })
    try {
      const result = await disabled.alerts.evaluateOnce()
      assert.equal(result.skipped, true)
      disabled.alerts.start()
      disabled.alerts.stop()
    } finally {
      disabled.close()
    }
  } finally {
    fx.close()
  }

  assert.deepEqual(parseThrottled('0x50000'), {
    underVoltageNow: false,
    underVoltageOccurred: true,
    text: '0x50000',
  })
  assert.equal(parseThrottled('throttled=0x1').underVoltageNow, true)
  assert.equal(parseThrottled(undefined).underVoltageNow, false)
  assert.equal(parsePiHealth('not json'), null)
  assert.deepEqual(parsePiHealth('{"tempC": 48.2, "throttled": "0x0"}'), {
    tempC: 48.2,
    underVoltage: false,
    throttledRaw: '0x0',
  })
  assert.equal(parsePiHealth('{"underVoltage": true}')?.underVoltage, true)
  assert.equal(parsePiHealth('{"temperature": 61.5}')?.tempC, 61.5)
  // deploy/health-probe.sh 的实际字段形状。
  const probe = parsePiHealth(
    '{"generatedAt":"2026-06-01T00:00:00Z","throttled":"0x50000","undervoltageNow":false,"undervoltageOccurred":true,"tempC":48.2,"fan":0}',
  )
  assert.equal(probe?.underVoltage, false)
  assert.equal(probe?.tempC, 48.2)
  assert.equal(probe?.throttledRaw, '0x50000')
  assert.equal(parsePiHealth('{"undervoltageNow":true,"tempC":70}')?.underVoltage, true)
})
