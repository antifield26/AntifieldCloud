// 备份管理（v0.7.0 特性 UI 回归）：加密归档禁用 Web 校验/恢复；加密与异地副本状态卡可见。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { BackupManager } from './BackupManager'
import { ToastProvider } from '../Toast'
import type { BackupArchive, BackupListResult, BackupStatus } from '../../api/types'
const backupsState = vi.hoisted(() => ({ data: null as BackupListResult | null }))
const refresh = vi.hoisted(() => vi.fn())

vi.mock('../../hooks/useBackups', () => ({
  useBackups: () => ({
    data: backupsState.data,
    loading: false,
    error: null,
    errorStatus: null,
    refresh,
  }),
}))

vi.mock('../../meta/MetaContext', () => ({
  useAppMeta: () => ({
    meta: {
      version: '0.7.0',
      appOrigin: 'https://app.example.com',
      aiOrigin: 'https://ai.example.com',
      trashRetentionDays: 30,
      trashRetentionFromServer: true,
      maxUploadBytes: 100 * 1024 * 1024,
      sharesEnabled: true,
      alertsEnabled: true,
      backupRestoreEnabled: true,
      chunkedUploadEnabled: true,
      chunkSizeBytes: 8 * 1024 * 1024,
      chunkMaxFileBytes: 5 * 1024 * 1024 * 1024,
      noteAttachmentMaxBytes: 25 * 1024 * 1024,
      noteMaxAttachments: 100,
      noteVersionsKeep: 20,
      shareMaxItems: 50,
      metricsEnabled: true,
      metricsSampleSeconds: 60,
      metricsRetentionDays: 30,
      backupImportMaxBytes: 100 * 1024 * 1024,
      backupRestoreMaxEntries: 5000,
      schemaVersion: 16,
      backupArchiveEncryption: true,
      backupAgeRecipientConfigured: true,
      backupOffsiteStatusConfigured: true,
    },
    loading: false,
    refresh: vi.fn(),
  }),
}))

vi.mock('../../api/client', () => ({
  api: { backups: { verify: vi.fn(), prepare: vi.fn(), importArchive: vi.fn(), entries: vi.fn() } },
  toErrorMessage: (error: unknown, fallback = '') => (error instanceof Error ? error.message : fallback),
}))

afterEach(cleanup)

function archive(overrides: Partial<BackupArchive> = {}): BackupArchive {
  return {
    id: 'snapshot-20261024T000000Z-full.tar.gz',
    name: 'snapshot-20261024T000000Z-full.tar.gz',
    mode: 'full',
    createdAt: new Date().toISOString(),
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
    status: 'acked',
    origin: 'pi',
    available: true,
    verifiedAt: new Date().toISOString(),
    pulledAt: null,
    ackedAt: new Date().toISOString(),
    lastError: null,
    manifest: null,
    ...overrides,
  }
}

function listResult(items: BackupArchive[]): BackupListResult {
  return {
    items,
    inbox: [],
    orphans: [],
    state: {
      lastPullAt: null,
      pendingCount: 0,
      ackedCount: items.length,
      importCount: 0,
      orphanCount: 0,
      lastError: null,
      dataDirFreeBytes: 1024 * 1024,
      encryptedPendingCount: 0,
      encryptedAckedCount: items.filter((item) => item.encrypted).length,
    },
    world: null,
    worldPull: null,
    drill: null,
  }
}

function backupStatus(): BackupStatus {
  return {
    lastPullAt: new Date().toISOString(),
    ageHours: 1,
    sizeBytes: 1024,
    ok: true,
    overdue: false,
    secretsOk: true,
    lastSecretsAt: new Date().toISOString(),
    pendingCount: 0,
    pendingBytes: 0,
    orphanCount: 0,
    ackedBytes: 1024,
    lastError: null,
    world: null,
    worldPull: null,
    drill: null,
    encryptedPendingCount: 0,
    encryptedAckedCount: 1,
    encryption: { enabled: true, keyConfigured: true },
    offsite: {
      lastRunAt: new Date().toISOString(),
      ok: true,
      remoteLabel: 'nas-offsite',
      uploaded: 2,
      skipped: 0,
      failed: 0,
      bytes: 2048,
      keptRemote: 3,
      plaintextSkipped: 0,
    },
  }
}

function renderManager(items: BackupArchive[]): void {
  backupsState.data = listResult(items)
  render(
    <ToastProvider>
      <BackupManager backupStatus={backupStatus()} />
    </ToastProvider>,
  )
}

describe('BackupManager 加密归档与异地副本', () => {
  it('加密归档显示“加密”徽章，不提供校验按钮且恢复禁用', () => {
    renderManager([
      archive({ id: 'verified', name: 'snapshot-20261024T000000Z-full.tar.gz' }),
      archive({
        id: 'unverified',
        name: 'snapshot-20261024T000000Z-inc.tar.gz',
        mode: 'inc',
        verifiedAt: null,
        status: 'pending',
      }),
      archive({
        id: 'enc',
        name: 'snapshot-20261024T010000Z-inc.tar.gz.age',
        encrypted: true,
        verifiedAt: null,
        mode: 'inc',
        status: 'pending',
      }),
    ])

    expect(screen.getAllByText('加密').length).toBeGreaterThan(0)
    // Table 同时渲染桌面表格与移动卡片：取第一份（桌面表格行）做行内断言。
    const rowOf = (name: string): HTMLElement => {
      const node = screen.getAllByText(name)[0]
      if (!node) throw new Error(`missing ${name}`)
      return node.closest('tr') as HTMLElement
    }
    const unverifiedRow = rowOf('snapshot-20261024T000000Z-inc.tar.gz')
    expect(within(unverifiedRow).getByRole('button', { name: '校验' })).toBeTruthy()
    const encryptedRow = rowOf('snapshot-20261024T010000Z-inc.tar.gz.age')
    expect(within(encryptedRow).queryByRole('button', { name: '校验' })).toBeNull()
    expect(within(encryptedRow).getByRole('button', { name: '恢复' })).toBeDisabled()
    const verifiedRow = rowOf('snapshot-20261024T000000Z-full.tar.gz')
    expect(within(verifiedRow).getByRole('button', { name: '恢复' })).toBeEnabled()
  })

  it('渲染备份加密与异地副本状态卡（不含远端真实路径/凭据）', () => {
    renderManager([archive()])
    expect(screen.getAllByText('备份加密').length).toBeGreaterThan(0)
    expect(screen.getAllByText('异地副本').length).toBeGreaterThan(0)
    expect(screen.getByText('nas-offsite')).toBeTruthy()
    expect(screen.getAllByText(/远端保留/).length).toBeGreaterThan(0)
    const statusCard = screen.getByLabelText('备份健康状态')
    expect(within(statusCard).getByText('备份加密')).toBeTruthy()
    expect(within(statusCard).getByText('异地副本')).toBeTruthy()
  })
})
