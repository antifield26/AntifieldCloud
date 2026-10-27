// v0.7.0 备份状态：加密/异地副本条目、演练 schema 不一致、失败不伪装成功。
import { describe, expect, it } from 'vitest'
import type { OffsiteStatus } from '../api/types'
import { buildBackupStatusEntries, encryptionView, offsiteView } from './backup-status'

const now = Date.parse('2026-10-24T12:00:00.000Z')

describe('encryptionView', () => {
  it('未下发/未启用/公钥缺失/已启用四态语义正确', () => {
    expect(encryptionView(null).value).toBe('未配置')
    expect(encryptionView({ enabled: false, keyConfigured: false }).value).toBe('未启用')
    const missing = encryptionView({ enabled: true, keyConfigured: false })
    expect(missing.value).toBe('公钥缺失')
    expect(missing.tone).toBe('danger')
    expect(missing.alert).toBe(true)
    const ok = encryptionView({ enabled: true, keyConfigured: true })
    expect(ok.value).toBe('已启用')
    expect(ok.tone).toBe('success')
  })
})

describe('offsiteView', () => {
  const base: OffsiteStatus = {
    lastRunAt: new Date(now - 3_600_000).toISOString(),
    ok: true,
    remoteLabel: 'nas-offsite',
    uploaded: 2,
    skipped: 0,
    failed: 0,
    bytes: 2048,
    keptRemote: 3,
    plaintextSkipped: 0,
  }

  it('缺失/未启用/失败/超期/正常', () => {
    expect(offsiteView(null, now).value).toBe('未运行')
    expect(offsiteView({ ...base, enabled: false }, now).value).toBe('未启用')
    const failed = offsiteView({ ...base, ok: false, error: 'rclone 失败' }, now)
    expect(failed.tone).toBe('danger')
    expect(failed.detail).toContain('rclone 失败')
    const stale = offsiteView({ ...base, lastRunAt: new Date(now - 72 * 3_600_000).toISOString() }, now)
    expect(stale.value).toBe('已过期')
    expect(stale.alert).toBe(true)
    const ok = offsiteView(base, now)
    expect(ok.value).toBe('正常')
    expect(ok.detail).toContain('nas-offsite')
    expect(ok.detail).toContain('远端保留 3 份')
  })

  it('拒绝明文数量进入详情（安全信号可见）', () => {
    const view = offsiteView({ ...base, plaintextSkipped: 2 }, now)
    expect(view.detail).toContain('拒绝明文 2 个')
  })
})

describe('buildBackupStatusEntries v0.7.0', () => {
  it('加密/异地副本缺失时按未配置/未运行展示，不当作成功', () => {
    const entries = buildBackupStatusEntries({ now })
    const byKey = new Map(entries.map((entry) => [entry.key, entry]))
    expect(byKey.get('encryption')?.tone).toBe('muted')
    expect(byKey.get('encryption')?.value).toBe('未配置')
    expect(byKey.get('offsite')?.tone).toBe('muted')
    expect(byKey.get('offsite')?.value).toBe('未运行')
  })

  it('加密启用+公钥缺失使整体健康为异常；异地副本失败同理', () => {
    const entries = buildBackupStatusEntries({
      now,
      backup: {
        lastPullAt: new Date(now - 3_600_000).toISOString(),
        ageHours: 1,
        sizeBytes: 1024,
        ok: true,
        overdue: false,
        secretsOk: true,
        encryption: { enabled: true, keyConfigured: false },
        offsite: { lastRunAt: new Date(now - 3_600_000).toISOString(), ok: false, error: 'rclone failed' },
      },
    })
    const byKey = new Map(entries.map((entry) => [entry.key, entry]))
    expect(byKey.get('encryption')?.tone).toBe('danger')
    expect(byKey.get('offsite')?.tone).toBe('danger')
  })

  it('演练 schema 与当前部署不一致时给出 warning 且可重跑提示', () => {
    const entries = buildBackupStatusEntries({
      now,
      drill: {
        lastRunAt: new Date(now - 86_400_000).toISOString(),
        ok: true,
        schemaVersion: 15,
        latestDb: 'db-x.sqlite',
        worldChecked: true,
      },
      currentSchemaVersion: 16,
    })
    const drill = entries.find((entry) => entry.key === 'drill')
    expect(drill?.tone).toBe('warning')
    expect(drill?.value).toBe('schema 不一致')
    expect(drill?.detail).toContain('drill.ps1 -ExpectedSchemaVersion 16')
  })

  it('未知当前 schema 时不做错误比较', () => {
    const entries = buildBackupStatusEntries({
      now,
      drill: { lastRunAt: new Date(now - 86_400_000).toISOString(), ok: true, schemaVersion: 15 },
      currentSchemaVersion: null,
    })
    expect(entries.find((entry) => entry.key === 'drill')?.tone).toBe('success')
  })
})
