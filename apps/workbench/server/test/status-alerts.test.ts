/** 状态文件与告警 v0.4.0：dashboard/backups 只读状态、世界备份/拉取/演练条件、审计与告警筛选。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../src/config.ts'
import type { AlertDeps } from '../src/alerts/service.ts'
import { AlertService } from '../src/alerts/service.ts'
import { DashboardService } from '../src/dashboard/service.ts'
import { MinecraftService } from '../src/mc/service.ts'
import { audit, listAudit } from '../src/auth/audit.ts'
import { backupsFixture } from './backups-fixtures.ts'
import { phase2Fixture } from './phase2-fixtures.ts'

const T0 = '2026-06-01T00:00:00.000Z'

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), 'utf8')
}

function backupRow(db: ReturnType<typeof phase2Fixture>['db'], name: string, origin: string, ackedAt: string | null, size: number) {
  db.prepare(
    `INSERT INTO backup_archives (name, mode, created_at, sha256, size, file_count, pulled_at, acked_at, deleted_at, origin)
     VALUES (?, 'full', ?, ?, ?, 1, NULL, ?, NULL, ?)`,
  ).run(name, T0, 'a'.repeat(64), size, ackedAt, origin)
}

test('dashboard.backup：已 ack 归档的历史 last_error 不作为最近错误', async () => {
  const fx = phase2Fixture()
  const mc = new MinecraftService(fx.db, { ...fx.config, mcPort: 1, rconPort: 1 } as Config)
  const dashboard = new DashboardService(fx.db, fx.config, fx.files, mc)
  try {
    backupRow(fx.db, 'snapshot-20260606-full.tar.gz', 'pi', T0, 100)
    fx.db
      .prepare("UPDATE backup_archives SET last_error = '归档文件不存在' WHERE name = 'snapshot-20260606-full.tar.gz'")
      .run()
    const data = await dashboard.get()
    assert.equal(data.backup?.lastError, null, '已 ack 归档的历史错误不应标记备份异常')
  } finally {
    fx.close()
  }
})

test('BackupService.list：世界备份/拉取/演练状态文件读取，缺失返回 null', () => {
  const fx = backupsFixture()
  try {
    // 初始缺失：三个字段均为 null，不抛错。
    const empty = fx.service.list()
    assert.equal(empty.world, null)
    assert.equal(empty.worldPull, null)
    assert.equal(empty.drill, null)

    writeJson(fx.config.worldBackupStatusFile, {
      lastRunAt: T0,
      ok: true,
      archiveName: 'world-1.tar.gz',
      sizeBytes: 100,
      kept: 2,
    })
    writeJson(fx.config.worldPullStatusFile, { lastRunAt: T0, ok: false, error: 'scp 超时' })
    writeJson(fx.config.drillStatusFile, { lastRunAt: T0, ok: true, dbIntegrity: 'ok' })
    const list = fx.service.list()
    assert.equal((list.world as Record<string, unknown>).archiveName, 'world-1.tar.gz')
    assert.equal((list.worldPull as Record<string, unknown>).ok, false)
    assert.equal((list.drill as Record<string, unknown>).dbIntegrity, 'ok')

    // 损坏/非对象 JSON 同样降级为 null。
    writeFileSync(fx.config.drillStatusFile, 'not-json', 'utf8')
    assert.equal(fx.service.list().drill, null)
    writeJson(fx.config.drillStatusFile, [1, 2, 3])
    assert.equal(fx.service.list().drill, null)
  } finally {
    fx.close()
  }
})

test('dashboard.backup：pending/acked/orphan 统计与状态对象，文件缺失不抛错', async () => {
  const fx = phase2Fixture()
  const mc = new MinecraftService(fx.db, { ...fx.config, mcPort: 1, rconPort: 1 } as Config)
  const dashboard = new DashboardService(fx.db, fx.config, fx.files, mc)
  try {
    // backup-pull.json：最近拉取成功、密钥包状态独立。
    writeJson(fx.config.backupPullFile, {
      lastPullAt: T0,
      sizeBytes: 123,
      ok: true,
      secretsAttempted: true,
      secretsOk: true,
      lastSecretsAt: T0,
    })
    backupRow(fx.db, 'snapshot-1-full.tar.gz', 'pi', null, 100)
    backupRow(fx.db, 'snapshot-2-inc.tar.gz', 'pi', T0, 200)
    backupRow(fx.db, 'snapshot-import-full.tar.gz', 'import', null, 300)
    fx.db
      .prepare("UPDATE backup_archives SET last_error = 'SHA 校验失败' WHERE name = 'snapshot-1-full.tar.gz'")
      .run()
    mkdirSync(join(fx.dir, 'backups', 'imports'), { recursive: true })
    writeFileSync(join(fx.dir, 'backups', 'imports', 'orphan.tar.gz'), 'x')
    writeJson(fx.config.worldBackupStatusFile, { lastRunAt: T0, ok: true, archiveName: 'world-2.tar.gz' })
    writeJson(fx.config.drillStatusFile, { lastRunAt: T0, ok: true })
    writeJson(fx.config.worldPullStatusFile, { lastRunAt: T0, ok: true })

    const data = await dashboard.get()
    const backup = data.backup
    assert.ok(backup, 'backup 对象始终存在（字段缺失用 null 表达）')
    assert.equal(backup.lastPullAt, T0)
    assert.equal(backup.pendingCount, 1, '仅 Pi pending 归档计数，不含 import')
    assert.equal(backup.pendingBytes, 100)
    assert.equal(backup.ackedBytes, 200)
    assert.equal(backup.orphanCount, 1)
    assert.equal(backup.lastError, 'SHA 校验失败')
    assert.equal((backup.world as Record<string, unknown>).archiveName, 'world-2.tar.gz')
    assert.equal((backup.worldPull as Record<string, unknown>).ok, true)
    assert.equal((backup.drill as Record<string, unknown>).ok, true)
    assert.equal(backup.secretsOk, true)

    // 状态文件缺失：字段为 null 而不是抛错。
    rmSync(fx.config.worldBackupStatusFile, { force: true })
    rmSync(fx.config.drillStatusFile, { force: true })
    rmSync(fx.config.backupPullFile, { force: true })
    const degraded = await dashboard.get()
    assert.ok(degraded.backup)
    assert.equal(degraded.backup.lastPullAt, null)
    assert.equal(degraded.backup.overdue, null)
    assert.equal(degraded.backup.world, null)
    assert.equal(degraded.backup.drill, null)
    // 归档统计不依赖状态文件。
    assert.equal(degraded.backup.pendingCount, 1)
  } finally {
    fx.close()
  }
})

interface AlertFixture {
  dir: string
  config: Config
  db: ReturnType<typeof phase2Fixture>['db']
  alerts: AlertService
  clock: { now: () => Date; set: (iso: string) => void }
  files: Map<string, string>
  close: () => void
}

function alertFixture(options: { config?: Partial<Config>; deps?: AlertDeps; files?: Map<string, string> } = {}): AlertFixture {
  const fx = phase2Fixture({
    alertsEnabled: true,
    alertWebhookUrl: '',
    alertCheckIntervalSeconds: 60,
    ...options.config,
  })
  let current = new Date(T0)
  const filesStore =
    options.files ??
    new Map<string, string>([
      [fx.config.piHealthFile, JSON.stringify({ tempC: 45, underVoltage: false })],
      [
        fx.config.backupPullFile,
        JSON.stringify({ lastPullAt: T0, secretsAttempted: true, secretsOk: true, lastSecretsAt: T0 }),
      ],
    ])
  const deps: AlertDeps = {
    now: () => current,
    sleep: async () => {},
    log: () => {},
    statfs: () => ({ availableBytes: 90, totalBytes: 100 }),
    memory: () => ({ totalBytes: 100, usedBytes: 10 }),
    serviceStates: async () => ({ minecraft: 'active' }),
    minecraftStatus: async () => ({ online: true }),
    readFile: (path) => {
      const value = filesStore.get(path)
      if (value === undefined) throw new Error(`ENOENT: ${path}`)
      return value
    },
    ...options.deps,
  }
  fx.db.prepare('UPDATE backup_state SET last_backup_at = ? WHERE id = 1').run(T0)
  const alerts = new AlertService(fx.db, fx.config, deps)
  return {
    dir: fx.dir,
    config: fx.config,
    db: fx.db,
    alerts,
    clock: {
      now: () => current,
      set: (iso) => {
        current = new Date(iso)
      },
    },
    files: filesStore,
    close: fx.close,
  }
}

function eventsOf(fx: AlertFixture, event?: string) {
  const rows = fx.db.prepare('SELECT event, status, severity, title, message FROM alert_events ORDER BY id ASC').all() as unknown as {
    event: string
    status: string
    severity: string
    title: string
    message: string
  }[]
  return event ? rows.filter((row) => row.event === event) : rows
}

function isoHoursAgo(hours: number): string {
  return new Date(new Date(T0).getTime() - hours * 3_600_000).toISOString()
}

test('告警：世界备份/拉取/演练超期触发、失败 critical、恢复后 resolved', async () => {
  const fx = alertFixture()
  try {
    fx.files.set(
      fx.config.worldBackupStatusFile,
      JSON.stringify({ lastRunAt: isoHoursAgo(300), ok: true, archiveName: 'world-old.tar.gz' }),
    )
    fx.files.set(
      fx.config.worldPullStatusFile,
      JSON.stringify({ lastRunAt: T0, ok: false, error: 'scp 超时' }),
    )
    fx.files.set(fx.config.drillStatusFile, JSON.stringify({ lastRunAt: isoHoursAgo(40 * 24), ok: true }))

    const result = await fx.alerts.evaluateOnce()
    assert.equal(result.checked, 12)
    const firing = eventsOf(fx).filter((row) => row.status === 'firing')
    assert.deepEqual(
      firing.map((row) => row.event).sort(),
      ['drill_stale', 'world_backup_stale', 'world_pull_stale'],
    )
    const worldBackup = firing.find((row) => row.event === 'world_backup_stale')
    assert.equal(worldBackup?.severity, 'warning')
    assert.match(worldBackup?.message ?? '', /192 小时/)
    const worldPull = firing.find((row) => row.event === 'world_pull_stale')
    assert.equal(worldPull?.severity, 'critical', '最近执行失败应为 critical')
    assert.match(worldPull?.message ?? '', /scp 超时/)
    const drill = firing.find((row) => row.event === 'drill_stale')
    assert.match(drill?.message ?? '', /840 小时/, '35 天 = 840 小时阈值')

    // 状态更新为正常 → resolved 并把状态置回 ok。
    fx.files.set(fx.config.worldBackupStatusFile, JSON.stringify({ lastRunAt: T0, ok: true }))
    fx.files.set(fx.config.worldPullStatusFile, JSON.stringify({ lastRunAt: T0, ok: true }))
    fx.files.set(fx.config.drillStatusFile, JSON.stringify({ lastRunAt: T0, ok: true }))
    const recovered = await fx.alerts.evaluateOnce()
    assert.equal(recovered.resolved, 3)
    for (const event of ['world_backup_stale', 'world_pull_stale', 'drill_stale']) {
      const rows = eventsOf(fx, event)
      assert.equal(rows.at(-1)?.status, 'resolved')
      assert.equal(
        (fx.db.prepare('SELECT status FROM alert_state WHERE event = ?').get(event) as { status: string }).status,
        'ok',
      )
    }
  } finally {
    fx.close()
  }
})

test('告警：状态文件缺失连续 3 次后降级 unknown，补上文件后恢复', async () => {
  const fx = alertFixture()
  try {
    // 首次与第二次 unknown 不产生事件。
    await fx.alerts.evaluateOnce()
    await fx.alerts.evaluateOnce()
    assert.equal(eventsOf(fx, 'world_backup_stale').length, 0)
    await fx.alerts.evaluateOnce()
    const degraded = eventsOf(fx, 'world_backup_stale')
    assert.equal(degraded.length, 1)
    assert.equal(degraded[0]?.status, 'unknown')
    assert.match(degraded[0]?.title ?? '', /数据不可用/)

    fx.files.set(fx.config.worldBackupStatusFile, JSON.stringify({ lastRunAt: T0, ok: true }))
    await fx.alerts.evaluateOnce()
    const recovered = eventsOf(fx, 'world_backup_stale')
    assert.equal(recovered.length, 2)
    assert.equal(recovered[1]?.status, 'resolved')
    assert.match(recovered[1]?.title ?? '', /数据已恢复/)
  } finally {
    fx.close()
  }
})

test('告警配置输出新增阈值；事件列表支持 event/status/severity/分页', async () => {
  const fx = alertFixture()
  try {
    fx.files.set(fx.config.worldBackupStatusFile, JSON.stringify({ lastRunAt: isoHoursAgo(300), ok: true }))
    await fx.alerts.evaluateOnce()
    const config = fx.alerts.configSummary()
    assert.equal(config.worldBackupMaxAgeHours, 192)
    assert.equal(config.drillMaxAgeDays, 35)

    const all = fx.alerts.list({ limit: 200 })
    assert.equal(all.total, 1)
    assert.equal(all.items.length, 1)
    const byEvent = fx.alerts.list({ event: 'world_backup_stale' })
    assert.equal(byEvent.total, 1)
    assert.equal(fx.alerts.list({ event: 'disk_low' }).total, 0)
    assert.equal(fx.alerts.list({ status: 'firing' }).total, 1)
    assert.equal(fx.alerts.list({ severity: 'warning' }).total, 1)
    assert.equal(fx.alerts.list({ status: 'resolved' }).total, 0)
    assert.equal(fx.alerts.list({ limit: 1, offset: 1 }).items.length, 0)
    assert.equal(fx.alerts.list({ limit: 1 }).total, 1)
  } finally {
    fx.close()
  }
})

test('pending 告警只统计 origin=pi 归档，Web 导入行永不计入', async () => {
  const fx = alertFixture()
  try {
    // Web 导入归档 acked_at 永远为 NULL；若误计入会永久误报“待拉取”。
    fx.db
      .prepare(
        `INSERT INTO backup_archives (name, mode, created_at, sha256, size, file_count, pulled_at, acked_at, deleted_at, origin)
         VALUES ('snapshot-imported-full.tar.gz', 'full', ?, ?, 1, 1, NULL, NULL, NULL, 'import')`,
      )
      .run(isoHoursAgo(500), 'a'.repeat(64))
    await fx.alerts.evaluateOnce()
    assert.equal(
      eventsOf(fx).filter((row) => row.event === 'backup_pending' && row.status === 'firing').length,
      0,
      '导入归档不应触发待拉取告警',
    )
    assert.equal(
      (fx.db.prepare("SELECT status FROM alert_state WHERE event = 'backup_pending'").get() as { status: string }).status,
      'ok',
    )

    // 超期的 Pi pending 归档才触发。
    fx.db
      .prepare(
        `INSERT INTO backup_archives (name, mode, created_at, sha256, size, file_count, pulled_at, acked_at, deleted_at, origin)
         VALUES ('snapshot-pi-full.tar.gz', 'full', ?, ?, 1, 1, NULL, NULL, NULL, 'pi')`,
      )
      .run(isoHoursAgo(500), 'b'.repeat(64))
    await fx.alerts.evaluateOnce()
    const firing = eventsOf(fx, 'backup_pending')
    assert.equal(firing.length, 1)
    assert.equal(firing[0]?.status, 'firing')
    assert.match(firing[0]?.message ?? '', /1 个归档超过 48 小时/)
  } finally {
    fx.close()
  }
})

test('审计筛选：q 转义 LIKE（action/target/ip）、action 精确、from/to 时间窗与 total', () => {
  const fx = phase2Fixture()
  try {
    audit(fx.db, 'admin', 'login', null, null, '203.0.113.9')
    audit(fx.db, 'admin', 'share_download', '报告_100%.txt', null, '198.51.100.7')
    audit(fx.db, 'system', 'backup_prepare', 'snapshot-1', { full: true }, null)
    const login = listAudit(fx.db, { limit: 50, offset: 0, action: 'login' })
    assert.equal(login.total, 1)
    assert.equal(listAudit(fx.db, { limit: 50, offset: 0, q: '报告' }).total, 1)
    assert.equal(listAudit(fx.db, { limit: 50, offset: 0, q: '100%' }).total, 1, '% 被转义为字面量')
    assert.equal(listAudit(fx.db, { limit: 50, offset: 0, q: '203.0.113.9' }).total, 1, '按 IP 搜索')
    assert.equal(
      listAudit(fx.db, { limit: 50, offset: 0, q: '_' }).total,
      2,
      '_ 被转义为字面量：命中 share_download 动作与含 _ 的文件名，而不是通配',
    )
    assert.equal(listAudit(fx.db, { limit: 50, offset: 0, q: '不存在的关键字' }).total, 0)

    const from = new Date(Date.now() - 60_000).toISOString()
    assert.equal(listAudit(fx.db, { limit: 50, offset: 0, from }).total, 3)
    assert.equal(listAudit(fx.db, { limit: 50, offset: 0, to: new Date(Date.now() - 60_000).toISOString() }).total, 0)
    assert.equal(listAudit(fx.db, { limit: 1, offset: 0 }).items.length, 1)
  } finally {
    fx.close()
  }
})
