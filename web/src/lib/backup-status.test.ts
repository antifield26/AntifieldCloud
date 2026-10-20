import { describe, expect, it } from 'vitest'
import type { BackupArchive } from '../api/types'
import {
  DRILL_STALE_DAYS,
  WORLD_BACKUP_STALE_HOURS,
  backupHealthLabel,
  buildBackupStatusEntries,
  drillView,
  isStaleByDays,
  isStaleByHours,
  worldBackupView,
  worldPullView,
  worstBackupTone,
} from './backup-status'

const now = Date.parse('2026-10-20T12:00:00.000Z')

function isoDaysAgo(days: number): string {
  return new Date(now - days * 86_400_000).toISOString()
}

function archive(overrides: Partial<BackupArchive> = {}): BackupArchive {
  return {
    id: 'snapshot-20261020T000000Z-full.tar.gz',
    name: 'snapshot-20261020T000000Z-full.tar.gz',
    mode: 'full',
    createdAt: isoDaysAgo(1),
    sizeBytes: 1024 * 1024,
    sha256: 'a'.repeat(64),
    status: 'acked',
    origin: 'pi',
    verifiedAt: isoDaysAgo(1),
    pulledAt: isoDaysAgo(1),
    ackedAt: isoDaysAgo(1),
    lastError: null,
    manifest: null,
    ...overrides,
  }
}

describe('备份状态时间判定', () => {
  it('缺时间戳返回 null（未知），过期按小时/天判定', () => {
    expect(isStaleByHours(null, 48, now)).toBeNull()
    expect(isStaleByHours(isoDaysAgo(3), WORLD_BACKUP_STALE_HOURS, now)).toBe(false)
    expect(isStaleByHours(isoDaysAgo(10), WORLD_BACKUP_STALE_HOURS, now)).toBe(true)
    expect(isStaleByDays(isoDaysAgo(40), DRILL_STALE_DAYS, now)).toBe(true)
  })
})

describe('世界备份 / 拉取 / 演练状态', () => {
  it('缺失状态显示未运行且不告警', () => {
    expect(worldBackupView(null, now)).toMatchObject({ value: '未运行', tone: 'muted', alert: false })
    expect(worldPullView(undefined, now)).toMatchObject({ value: '未运行', tone: 'muted' })
    expect(drillView(null, now)).toMatchObject({ value: '未运行', tone: 'muted' })
  })

  it('失败优先于过期并高亮', () => {
    const failed = worldBackupView({ ok: false, lastRunAt: isoDaysAgo(10), error: 'tar 失败' }, now)
    expect(failed).toMatchObject({ value: '失败', tone: 'danger', alert: true })
    expect(failed.detail).toContain('tar 失败')
    expect(worldPullView({ ok: false, lastPullAt: isoDaysAgo(1), error: 'scp 超时' }, now)).toMatchObject({
      value: '失败',
      tone: 'danger',
      alert: true,
    })
    expect(drillView({ ok: false, lastRunAt: isoDaysAgo(1), error: 'integrity' }, now)).toMatchObject({
      value: '失败',
      tone: 'danger',
      alert: true,
    })
  })

  it('超过阈值显示过期警告', () => {
    expect(worldBackupView({ ok: true, lastRunAt: isoDaysAgo(10) }, now)).toMatchObject({
      value: '已过期',
      tone: 'warning',
      alert: true,
    })
    expect(worldPullView({ ok: true, lastPullAt: isoDaysAgo(10) }, now)).toMatchObject({
      value: '已过期',
      tone: 'warning',
    })
    expect(drillView({ ok: true, lastRunAt: isoDaysAgo(40) }, now)).toMatchObject({
      value: '已过期',
      tone: 'warning',
    })
  })

  it('正常状态带归档大小与完整性信息', () => {
    const world = worldBackupView(
      { ok: true, lastRunAt: isoDaysAgo(1), archiveName: 'world-a.tar.gz', sizeBytes: 2048, kept: 2 },
      now,
    )
    expect(world).toMatchObject({ value: '正常', tone: 'success', alert: false })
    expect(world.detail).toContain('world-a.tar.gz')
    expect(world.detail).toContain('2 KB')
    const drill = drillView({ ok: true, lastRunAt: isoDaysAgo(2), dbIntegrity: 'ok', reportPath: 'drills/a/report.json' }, now)
    expect(drill).toMatchObject({ value: '成功', tone: 'success' })
    expect(drill.detail).toContain('ok')
  })
})

describe('buildBackupStatusEntries', () => {
  it('无任何数据时所有条目降级为未知/未运行', () => {
    const entries = buildBackupStatusEntries({ now })
    expect(entries.map((entry) => entry.key)).toEqual([
      'archive',
      'secrets',
      'pending',
      'acked',
      'orphan',
      'world',
      'worldPull',
      'drill',
    ])
    expect(entries.every((entry) => entry.tone === 'muted')).toBe(true)
    expect(worstBackupTone(entries)).toBe('muted')
    expect(backupHealthLabel(entries)).toBe('暂无数据')
  })

  it('汇总 dashboard backup 与 /api/backups 状态', () => {
    const entries = buildBackupStatusEntries({
      now,
      backup: {
        lastPullAt: isoDaysAgo(1),
        ageHours: 24,
        sizeBytes: 2048,
        ok: true,
        overdue: false,
        secretsOk: false,
        lastSecretsAt: isoDaysAgo(2),
        secretsLastError: 'age 加密失败',
        pendingCount: 2,
        pendingBytes: 4096,
        orphanCount: 1,
        ackedBytes: 8192,
        world: { ok: true, lastRunAt: isoDaysAgo(1), archiveName: 'world.tar.gz' },
        drill: { ok: true, lastRunAt: isoDaysAgo(3), dbIntegrity: 'ok' },
      },
      state: {
        lastPullAt: isoDaysAgo(1),
        pendingCount: 2,
        ackedCount: 4,
        importCount: 0,
        orphanCount: 1,
        lastError: null,
        dataDirFreeBytes: 1_000_000,
      },
      archives: [archive({ status: 'missing', lastError: '文件缺失' })],
    })
    const byKey = new Map(entries.map((entry) => [entry.key, entry]))
    expect(byKey.get('archive')?.tone).toBe('danger')
    expect(byKey.get('archive')?.alert).toBe(true)
    expect(byKey.get('secrets')).toMatchObject({ value: '异常', tone: 'danger', alert: true })
    expect(byKey.get('secrets')?.detail).toContain('age 加密失败')
    expect(byKey.get('pending')).toMatchObject({ value: '2 个', tone: 'warning', alert: true })
    expect(byKey.get('pending')?.detail).toContain('4 KB')
    expect(byKey.get('acked')).toMatchObject({ value: '8 KB', detail: '已确认 4 个归档' })
    expect(byKey.get('orphan')).toMatchObject({ value: '1 个', tone: 'warning' })
    expect(byKey.get('world')).toMatchObject({ value: '正常', tone: 'success' })
    expect(byKey.get('drill')).toMatchObject({ value: '成功', tone: 'success' })
    expect(worstBackupTone(entries)).toBe('danger')
    expect(backupHealthLabel(entries)).toBe('存在异常')
  })

  it('取最新归档并用 state 回退 pending/acked', () => {
    const entries = buildBackupStatusEntries({
      now,
      state: {
        lastPullAt: isoDaysAgo(1),
        pendingCount: 0,
        ackedCount: 2,
        importCount: 0,
        orphanCount: 0,
        lastError: null,
        dataDirFreeBytes: 1,
        pendingBytes: 0,
        ackedBytes: 1234,
      },
      archives: [
        archive({ id: 'old', name: 'snapshot-old-inc.tar.gz', createdAt: isoDaysAgo(5), mode: 'inc' }),
        archive({ id: 'new', name: 'snapshot-new-full.tar.gz', createdAt: isoDaysAgo(1), mode: 'full' }),
      ],
    })
    const byKey = new Map(entries.map((entry) => [entry.key, entry]))
    expect(byKey.get('archive')?.value).toBe('全量归档')
    expect(byKey.get('archive')?.detail).toContain('new')
    expect(byKey.get('pending')).toMatchObject({ value: '0 个', tone: 'success' })
    expect(byKey.get('acked')?.value).toBe('1.2 KB')
  })
})
