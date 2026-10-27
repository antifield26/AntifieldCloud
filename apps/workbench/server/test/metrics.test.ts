/** 指标历史：采样写入、范围聚合、空数据、非法 range、保留清理、sampler 与 HTTP 路由。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.ts'
import { createSession } from '../src/auth/sessions.ts'
import { MetricsService, parseMetricsRange } from '../src/metrics/service.ts'
import { createMetricsSampler } from '../src/metrics/sampler.ts'
import type { Config } from '../src/config.ts'
import { AppError } from '../src/util/errors.ts'
import { cleanupDir, seedAdmin, tempDataDir, testConfig, testDb } from './helpers.ts'

const T0 = '2026-06-01T00:00:00.000Z'

function metricsFixture() {
  const dir = tempDataDir()
  const config = testConfig(dir)
  const db = testDb(dir)
  let current = new Date(T0)
  const metrics = new MetricsService(db, { now: () => current })
  return {
    dir,
    config,
    db,
    metrics,
    clock: {
      now: () => current,
      set: (iso: string) => {
        current = new Date(iso)
      },
      advanceMs: (ms: number) => {
        current = new Date(current.getTime() + ms)
      },
    },
    close: () => {
      db.close()
      cleanupDir(dir)
    },
  }
}

function sample(metrics: MetricsService, overrides: Record<string, unknown> = {}) {
  metrics.record({
    cpuPercent: 10,
    memUsedBytes: 40,
    memTotalBytes: 100,
    tempC: 45,
    diskFreeBytes: 900,
    diskTotalBytes: 1000,
    load1: 0.5,
    load5: 0.4,
    load15: 0.3,
    ...overrides,
  })
}

test('record/query：按桶聚合平均值、磁盘取最小值、百分比与范围', () => {
  const fx = metricsFixture()
  try {
    // 24h 范围：bucketSeconds=360。两个采样落在同一桶、一个落在下一桶。
    sample(fx.metrics, { ts: T0, cpuPercent: 10, memUsedBytes: 40, diskFreeBytes: 900, load1: 0.2 })
    sample(fx.metrics, {
      ts: '2026-06-01T00:05:00.000Z',
      cpuPercent: 30,
      memUsedBytes: 60,
      diskFreeBytes: 800,
      load1: 0.4,
      tempC: null,
    })
    sample(fx.metrics, { ts: '2026-06-01T00:30:00.000Z', cpuPercent: 50, memUsedBytes: 80, diskFreeBytes: 700, load1: 1.2 })
    fx.clock.set('2026-06-01T01:00:00.000Z')

    const result = fx.metrics.query('1h')
    assert.equal(result.range, '1h')
    assert.equal(result.bucketSeconds, 15, '范围秒数/240 向上取整')
    assert.equal(result.sampleCount, 3)
    assert.equal(result.series.length, 3)
    const last = result.series.at(-1)!
    assert.equal(last.cpuPercent, 50)
    assert.equal(last.memUsedPct, 80)
    assert.equal(last.diskFreeBytes, 700)
    assert.equal(last.diskFreePct, 70)
    assert.equal(last.tempC, 45)
    assert.equal(last.load1, 1.2)

    // 24h：前两个采样同桶 -> CPU 平均 20、磁盘取最小 800。
    const day = fx.metrics.query('24h')
    assert.equal(day.bucketSeconds, 360)
    assert.equal(day.series.length, 2)
    assert.equal(day.series[0]?.cpuPercent, 20)
    assert.equal(day.series[0]?.diskFreeBytes, 800)
    assert.equal(day.series[0]?.memUsedPct, 50)
    assert.equal(day.series[0]?.tempC, 45)
    assert.equal(day.series[1]?.tempC, 45)

    // 时间窗过滤：6 小时范围包含全部；把时钟拨到 8 天后，1h 窗口为空。
    assert.equal(fx.metrics.query('6h').sampleCount, 3)
    fx.clock.advanceMs(8 * 86_400_000)
    const empty = fx.metrics.query('1h')
    assert.equal(empty.sampleCount, 0)
    assert.deepEqual(empty.series, [])
  } finally {
    fx.close()
  }
})

test('非法 range 抛 400 invalid_range；默认 24h', () => {
  const fx = metricsFixture()
  try {
    assert.equal(parseMetricsRange(undefined), '24h')
    assert.equal(parseMetricsRange('30d'), '30d')
    for (const value of ['2h', 'foo', '1D', 42]) {
      assert.throws(
        () => fx.metrics.query(value as never),
        (error: unknown) => error instanceof AppError && error.statusCode === 400 && error.code === 'invalid_range',
      )
    }
  } finally {
    fx.close()
  }
})

test('prune 按保留期删除旧采样并返回删除数', () => {
  const fx = metricsFixture()
  try {
    sample(fx.metrics, { ts: '2026-04-01T00:00:00.000Z' })
    sample(fx.metrics, { ts: T0 })
    assert.equal(fx.metrics.prune(30), 1, '30 天前样本被删除')
    const remaining = fx.db.prepare('SELECT COUNT(*) AS c FROM metrics_samples').get() as { c: number }
    assert.equal(remaining.c, 1)
  } finally {
    fx.close()
  }
})

test('sampler：成功写入一条、失败只记 warn 不抛错、start/stop 幂等', () => {
  const fx = metricsFixture()
  try {
    const host = {
      snapshot: () => ({
        hostname: 'test',
        uptimeSec: 1,
        load: [0.1, 0.2, 0.3] as [number, number, number],
        cpuPercent: 12.5,
        mem: { totalBytes: 1000, usedBytes: 400, availableBytes: 600 },
        tempC: 48.2,
        root: { totalBytes: 2000, usedBytes: 1000, freeBytes: 1000 },
      }),
    }
    const warnings: string[] = []
    const sampler = createMetricsSampler({
      config: fx.config,
      metrics: fx.metrics,
      host,
      files: { usage: () => ({ usedBytes: 0, trashBytes: 0, fileCount: 0, quotaBytes: 1, freeBytes: 1500 }) } as never,
      log: (_level, message) => warnings.push(message),
    })
    assert.equal(sampler.sampleOnce(), true)
    const row = fx.db
      .prepare('SELECT cpu_percent, mem_used, disk_free, disk_total, load1 FROM metrics_samples')
      .get() as { cpu_percent: number; mem_used: number; disk_free: number; disk_total: number; load1: number }
    assert.equal(row.cpu_percent, 12.5)
    assert.equal(row.mem_used, 400)
    assert.equal(row.disk_free, 1500)
    assert.equal(row.disk_total, 2000)
    assert.equal(row.load1, 0.1)

    const failing = createMetricsSampler({
      config: fx.config,
      metrics: fx.metrics,
      host: {
        snapshot: () => {
          throw new Error('host unavailable')
        },
      },
      files: { usage: () => ({ freeBytes: 0 }) } as never,
      log: (_level, message) => warnings.push(message),
    })
    assert.equal(failing.sampleOnce(), false)
    assert.ok(warnings.includes('指标采样失败'))

    sampler.start()
    sampler.start()
    sampler.stop()
    sampler.stop()
    failing.stop()
  } finally {
    fx.close()
  }
})

async function httpFixture() {
  const dir = tempDataDir()
  const config: Config = testConfig(dir)
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const context = await buildApp(config, db)
  const session = createSession(db, seeded.userId, 'metrics-csrf', 7, '127.0.0.1', 'test')
  return {
    context,
    headers: { host: 'app.test', cookie: `af_session=${session.token}`, 'x-csrf-token': 'metrics-csrf' },
    async close() {
      await context.app.close()
      db.close()
      cleanupDir(dir)
    },
  }
}

test('GET /api/metrics：401、默认 24h、范围切换与 400 invalid_range', async () => {
  const fx = await httpFixture()
  try {
    const anonymous = await fx.context.app.inject({ method: 'GET', url: '/api/metrics' })
    assert.equal(anonymous.statusCode, 401)

    fx.context.metrics.record({
      ts: new Date().toISOString(),
      cpuPercent: 20,
      memUsedBytes: 40,
      memTotalBytes: 100,
      tempC: 50,
      diskFreeBytes: 900,
      diskTotalBytes: 1000,
      load1: 0.5,
      load5: 0.4,
      load15: 0.3,
    })
    const defaultRange = await fx.context.app.inject({ method: 'GET', url: '/api/metrics', headers: fx.headers })
    assert.equal(defaultRange.statusCode, 200)
    const body = defaultRange.json() as {
      range: string
      from: string
      to: string
      bucketSeconds: number
      sampleCount: number
      series: { ts: string; memUsedPct: number }[]
    }
    assert.equal(body.range, '24h')
    assert.equal(body.bucketSeconds, 360)
    assert.equal(body.sampleCount, 1)
    assert.equal(body.series.length, 1)
    assert.equal(body.series[0]?.memUsedPct, 40)
    assert.ok(body.from < body.to)

    const week = await fx.context.app.inject({ method: 'GET', url: '/api/metrics?range=7d', headers: fx.headers })
    assert.equal(week.statusCode, 200)
    assert.equal(week.json().range, '7d')

    const invalid = await fx.context.app.inject({ method: 'GET', url: '/api/metrics?range=bad', headers: fx.headers })
    assert.equal(invalid.statusCode, 400)
    assert.equal(invalid.json().error.code, 'invalid_range')
  } finally {
    await fx.close()
  }
})

test('GET /api/storage：401；登录后返回与 dashboard.storage 一致的用量字段', async () => {
  const fx = await httpFixture()
  try {
    const anonymous = await fx.context.app.inject({ method: 'GET', url: '/api/storage' })
    assert.equal(anonymous.statusCode, 401)
    const response = await fx.context.app.inject({ method: 'GET', url: '/api/storage', headers: fx.headers })
    assert.equal(response.statusCode, 200)
    const body = response.json() as Record<string, number>
    for (const key of ['quotaBytes', 'usedBytes', 'trashBytes', 'fileCount', 'freeBytes']) {
      assert.equal(typeof body[key], 'number', `缺少数值字段 ${key}`)
    }
    assert.equal(body.quotaBytes, fx.context.config.quotaBytes)
    const dashboardStorage = fx.context.dashboard.storage()
    assert.equal(body.usedBytes, dashboardStorage.usedBytes)
    assert.equal(body.trashBytes, dashboardStorage.trashBytes)
    assert.equal(body.fileCount, dashboardStorage.fileCount)
    assert.ok((body.freeBytes as number) > 0, '空闲磁盘应为正数（两次 statfs 之间可能变化）')
  } finally {
    await fx.close()
  }
})

test('版本接口 output 包含 v0.4.0 指标/笔记/分享配置项', async () => {
  const fx = await httpFixture()
  try {
    const response = await fx.context.app.inject({ method: 'GET', url: '/api/version', headers: fx.headers })
    assert.equal(response.statusCode, 200)
    const body = response.json() as Record<string, unknown>
    for (const key of [
      'noteAttachmentMaxBytes',
      'noteMaxAttachments',
      'noteVersionsKeep',
      'shareMaxItems',
      'metricsEnabled',
      'metricsSampleSeconds',
      'metricsRetentionDays',
    ]) {
      assert.ok(key in body, `缺少 version 字段 ${key}`)
    }
  } finally {
    await fx.close()
  }
})
