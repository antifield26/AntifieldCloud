// v0.7.0 加密归档 Web 边界：名称识别、按钮 gate、导入预检、错误原因。
import { describe, expect, it } from 'vitest'
import type { BackupArchive } from '../api/types'
import {
  archiveWebActionReason,
  isArchiveEncrypted,
  isArchiveRestorable,
  isArchiveWebRestorable,
  isArchiveWebVerifiable,
  validateBackupFile,
} from './backups'

function archive(overrides: Partial<BackupArchive> = {}): BackupArchive {
  return {
    id: 'snapshot-20261024T000000Z-full.tar.gz',
    name: 'snapshot-20261024T000000Z-full.tar.gz',
    mode: 'full',
    createdAt: '2026-10-24T00:00:00.000Z',
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
    status: 'acked',
    origin: 'pi',
    available: true,
    verifiedAt: '2026-10-24T01:00:00.000Z',
    pulledAt: null,
    ackedAt: '2026-10-24T02:00:00.000Z',
    lastError: null,
    manifest: null,
    ...overrides,
  }
}

describe('加密归档 Web 边界', () => {
  it('服务端 encrypted 字段或 .tar.gz.age 名称均识别为加密', () => {
    expect(isArchiveEncrypted(archive())).toBe(false)
    expect(isArchiveEncrypted(archive({ encrypted: true }))).toBe(true)
    expect(isArchiveEncrypted(archive({ name: 'snapshot-20261024T000000Z-full.tar.gz.age' }))).toBe(true)
  })

  it('加密归档 Web 不可校验/恢复，即使已校验且有副本', () => {
    const encrypted = archive({ encrypted: true, name: 'snapshot-20261024T000000Z-full.tar.gz.age' })
    expect(isArchiveWebVerifiable(encrypted)).toBe(false)
    expect(isArchiveWebRestorable(encrypted)).toBe(false)
    expect(isArchiveRestorable(encrypted)).toBe(false)
    expect(archiveWebActionReason(encrypted, 'verify')).toContain('PC')
    expect(archiveWebActionReason(encrypted, 'restore')).toContain('PC')
  })

  it('明文归档仍按原规则（校验/可用/可恢复）', () => {
    const plain = archive()
    expect(isArchiveRestorable(plain)).toBe(true)
    expect(archiveWebActionReason(plain, 'restore')).toBeNull()
    expect(isArchiveRestorable(archive({ available: false }))).toBe(false)
    expect(isArchiveRestorable(archive({ verifiedAt: null }))).toBe(false)
  })

  it('导入预检拒绝 .age 加密归档并给出 PC 流程说明', () => {
    const message = validateBackupFile({ name: 'snapshot-20261024T000000Z-full.tar.gz.age', size: 1024 })
    expect(message).toContain('不能在 Web 导入')
    expect(validateBackupFile({ name: 'snapshot-20261024T000000Z-full.tar.gz', size: 1024 })).toBeNull()
  })
})
