/**
 * v0.3 告警韧性测试：unknown 连续降级/恢复、阈值可配置、alert_events 90 天保留。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { Config } from '../src/config.ts'
import { ALERT_EVENT_RETENTION_DAYS, AlertService, UNKNOWN_DEGRADE_THRESHOLD, type AlertDeps } from '../src/alerts/service.ts'
import { phase2Fixture } from './phase2-fixtures.ts'

const T0 = '2026-06-01T00:00:00.000Z'

interface AlertFixture {
  dir: string
  db: ReturnType<typeof phase2Fixture>['db']
  alerts: AlertService
  clock: { now: () => Date; advanceMs: (ms: number) => void }
  close: () => void
}

function alertFixture(options: { config?: Partial<Config>; deps?: AlertDeps } = {}): AlertFixture {
  const fx = phase2Fixture({
    alertsEnabled: true,
    alertWebhookUrl: '',
    alertDiskFreePct: 15,
    alertTempC: 80,
    alertBackupMaxAgeHours: 48,
    alertCooldownMinutes: 5,
    alertCheckIntervalSeconds: 60,
    ...options.config,
  })
  fx.config.piHealthFile = join(fx.dir, 'pi-health.json')
  let current = new Date(T0)
  const clock = {
    now: () => current,
    advanceMs: (ms: number) => {
      current = new Date(current.getTime() + ms)
    },
  }
  const baseDeps: AlertDeps = {
    now: clock.now,
    sleep: async () => {},
    log: () => {},
    statfs: () => ({ availableBytes: 90, totalBytes: 100 }),
    memory: () => ({ totalBytes: 100, usedBytes: 50 }),
    serviceStates: async () => ({ minecraft: 'active' }),
    minecraftStatus: async () => ({ online: true }),
    readFile: () => JSON.stringify({ tempC: 45, underVoltage: false, throttled: '0x0' }),
  }
  fx.db.prepare('UPDATE backup_state SET last_backup_at = ? WHERE id = 1').run(T0)
  const alerts = new AlertService(fx.db, fx.config, { ...baseDeps, ...options.deps })
  return { dir: fx.dir, db: fx.db, alerts, clock, close: fx.close }
}

function events(fx: AlertFixture, event?: string): { id: number; event: string; status: string; title: string }[] {
  const rows = fx.db
    .prepare('SELECT id, event, status, title FROM alert_events ORDER BY id ASC')
    .all() as unknown as { id: number; event: string; status: string; title: string }[]
  return event ? rows.filter((row) => row.event === event) : rows
}

function stateOf(fx: AlertFixture, event: string): string | undefined {
  return (fx.db.prepare('SELECT status FROM alert_state WHERE event = ?').get(event) as { status: string } | undefined)
    ?.status
}

test('unknown 连续达到阈值后降级并只发一次；数据恢复后发 resolved', async () => {
  let disk: { availableBytes: number; totalBytes: number } | null = null
  const fx = alertFixture({ deps: { statfs: () => disk } })
  try {
    assert.ok(UNKNOWN_DEGRADE_THRESHOLD >= 2)
    for (let index = 0; index < UNKNOWN_DEGRADE_THRESHOLD - 1; index += 1) {
      await fx.alerts.evaluateOnce()
      assert.equal(events(fx, 'disk_low').length, 0, `第 ${index + 1} 次 unknown 不应产生事件`)
    }
    await fx.alerts.evaluateOnce()
    const degraded = events(fx, 'disk_low')
    assert.equal(degraded.length, 1)
    assert.equal(degraded[0]?.status, 'unknown')
    assert.match(degraded[0]?.title ?? '', /数据不可用/)
    assert.equal(stateOf(fx, 'disk_low'), 'unknown')

    // 持续 unknown 不再重复发事件。
    await fx.alerts.evaluateOnce()
    assert.equal(events(fx, 'disk_low').length, 1)

    // 数据源恢复 → resolved，状态回 ok。
    disk = { availableBytes: 90, totalBytes: 100 }
    await fx.alerts.evaluateOnce()
    const recovered = events(fx, 'disk_low')
    assert.equal(recovered.length, 2)
    assert.equal(recovered[1]?.status, 'resolved')
    assert.match(recovered[1]?.title ?? '', /数据已恢复/)
    assert.equal(stateOf(fx, 'disk_low'), 'ok')
  } finally {
    fx.close()
  }
})

test('firing → unknown 降级 → 数据恢复 resolved（不丢状态转换）', async () => {
  let disk: { availableBytes: number; totalBytes: number } | null = { availableBytes: 5, totalBytes: 100 }
  const fx = alertFixture({ deps: { statfs: () => disk } })
  try {
    await fx.alerts.evaluateOnce()
    assert.equal(events(fx, 'disk_low')[0]?.status, 'firing')
    assert.equal(stateOf(fx, 'disk_low'), 'firing')

    disk = null
    for (let index = 0; index < UNKNOWN_DEGRADE_THRESHOLD; index += 1) await fx.alerts.evaluateOnce()
    const degraded = events(fx, 'disk_low')
    assert.equal(degraded.length, 2)
    assert.equal(degraded[1]?.status, 'unknown')

    disk = { availableBytes: 90, totalBytes: 100 }
    await fx.alerts.evaluateOnce()
    const recovered = events(fx, 'disk_low')
    assert.equal(recovered.length, 3)
    assert.equal(recovered[2]?.status, 'resolved')
    assert.equal(stateOf(fx, 'disk_low'), 'ok')
  } finally {
    fx.close()
  }
})

test('unknown 阈值可通过 deps 调小（测试/低延迟场景）', async () => {
  const fx = alertFixture({ deps: { statfs: () => null, unknownThreshold: 1 } })
  try {
    await fx.alerts.evaluateOnce()
    const degraded = events(fx, 'disk_low')
    assert.equal(degraded.length, 1)
    assert.equal(degraded[0]?.status, 'unknown')
  } finally {
    fx.close()
  }
})

test(`alert_events 保留 ${ALERT_EVENT_RETENTION_DAYS} 天：评估时清理更早事件`, async () => {
  const fx = alertFixture()
  try {
    const oldIso = new Date(new Date(T0).getTime() - (ALERT_EVENT_RETENTION_DAYS + 10) * 86_400_000).toISOString()
    const recentIso = new Date(new Date(T0).getTime() - 86_400_000).toISOString()
    const insert = fx.db.prepare(
      `INSERT INTO alert_events (event, severity, status, title, message, details_json, created_at, delivered_at, delivery_error)
       VALUES (?, 'info', 'firing', '旧事件', '', '{}', ?, NULL, NULL)`,
    )
    insert.run('old_event', oldIso)
    insert.run('recent_event', recentIso)

    await fx.alerts.evaluateOnce()
    const rows = fx.db.prepare("SELECT event FROM alert_events WHERE event IN ('old_event', 'recent_event')").all() as unknown as {
      event: string
    }[]
    assert.deepEqual(rows.map((row) => row.event), ['recent_event'])
  } finally {
    fx.close()
  }
})
