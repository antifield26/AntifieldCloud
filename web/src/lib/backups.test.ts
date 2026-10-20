import { describe, expect, it } from 'vitest'
import {
  archiveStatusLabel,
  archiveStatusTone,
  backupModeLabel,
  isArchiveRestorable,
  normalizeBackupMode,
  shaPrefix,
  summarizeBackups,
  validateBackupFile,
} from './backups'
import type { BackupArchive, BackupListResult } from '../api/types'

function makeArchive(overrides: Partial<BackupArchive> = {}): BackupArchive {
  return {
    id: 'snapshot-a-full.tar.gz',
    name: 'snapshot-a-full.tar.gz',
    mode: 'full',
    createdAt: '2026-10-19T00:00:00.000Z',
    sizeBytes: 100,
    sha256: '0123456789abcdef0123456789abcdef',
    status: 'acked',
    origin: 'import',
    verifiedAt: '2026-10-19T01:00:00.000Z',
    pulledAt: null,
    ackedAt: null,
    lastError: null,
    manifest: null,
    ...overrides,
  }
}

describe('备份归档 helpers', () => {
  it('模式与状态用于展示', () => {
    expect(normalizeBackupMode('full')).toBe('full')
    expect(normalizeBackupMode('inc')).toBe('incremental')
    expect(backupModeLabel('inc')).toBe('增量')
    expect(archiveStatusLabel(makeArchive({ status: 'pending' }))).toBe('待确认')
    expect(archiveStatusLabel(makeArchive({ status: 'missing' }))).toBe('文件缺失')
    expect(archiveStatusTone(makeArchive({ status: 'imported' }))).toBe('accent')
  })

  it('只有已校验且文件存在才可恢复', () => {
    expect(isArchiveRestorable(makeArchive())).toBe(true)
    expect(isArchiveRestorable(makeArchive({ verifiedAt: null }))).toBe(false)
    expect(isArchiveRestorable(makeArchive({ status: 'missing' }))).toBe(false)
  })

  it('上传前校验文件名和大小', () => {
    expect(validateBackupFile({ name: 'snapshot-20261019-full.tar.gz', size: 100 })).toBeNull()
    expect(validateBackupFile({ name: 'snapshot-20261019-2-inc.tar.gz', size: 100 })).toBeNull()
    expect(validateBackupFile({ name: 'backup.zip', size: 100 })).toContain('文件名')
    expect(validateBackupFile({ name: 'snapshot-a-full.tar.gz', size: 101 * 1024 * 1024 })).toContain('100 MiB')
  })

  it('SHA 前缀与汇总状态', () => {
    expect(shaPrefix('0123456789abcdef')).toBe('0123456789ab…')
    expect(shaPrefix(null)).toBe('—')
    const result: BackupListResult = {
      items: [makeArchive(), makeArchive({ id: 'b', name: 'b', status: 'pending', verifiedAt: null })],
      inbox: [],
      orphans: [],
      state: {
        lastPullAt: null,
        pendingCount: 1,
        ackedCount: 1,
        importCount: 1,
        orphanCount: 2,
        lastError: null,
        dataDirFreeBytes: 10,
      },
    }
    expect(summarizeBackups(result)).toMatchObject({ total: 2, pending: 1, orphan: 2 })
  })
})
