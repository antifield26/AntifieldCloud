// 恢复向导 v0.7.0（WEB-01/04/06 + 加密归档）：计划持久化、超时不清空、加密不可执行、截断提示。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { BackupArchive, RestorePlan } from '../../api/types'
import { RestoreWizard } from './RestoreWizard'
import { loadStoredRestorePlan, saveStoredRestorePlan } from '../../lib/restore-plan-store'

const mocks = vi.hoisted(() => ({
  entries: vi.fn(),
  verify: vi.fn(),
  restorePlan: vi.fn(),
  executeRestore: vi.fn(),
  getRestore: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: {
    backups: {
      entries: mocks.entries,
      verify: mocks.verify,
      restorePlan: mocks.restorePlan,
      executeRestore: mocks.executeRestore,
      getRestore: mocks.getRestore,
    },
  },
  toErrorMessage: (error: unknown, fallback = '') =>
    error instanceof Error && error.message ? error.message : fallback,
}))

vi.mock('../../meta/MetaContext', () => ({
  useAppMeta: () => ({
    meta: { backupRestoreEnabled: true, backupRestoreMaxEntries: 5000 },
    loading: false,
    refresh: async () => undefined,
  }),
}))

function archive(overrides: Partial<BackupArchive> = {}): BackupArchive {
  return {
    id: 'snapshot-20261019T000000Z-full.tar.gz',
    name: 'snapshot-20261019T000000Z-full.tar.gz',
    mode: 'full',
    createdAt: '2026-10-19T00:00:00.000Z',
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
    status: 'acked',
    origin: 'pi',
    verifiedAt: '2026-10-19T01:00:00.000Z',
    pulledAt: null,
    ackedAt: '2026-10-19T01:00:00.000Z',
    lastError: null,
    manifest: null,
    ...overrides,
  }
}

function plan(overrides: Partial<RestorePlan> = {}): RestorePlan {
  return {
    id: 'plan-1',
    status: 'planned',
    targetName: 'restore-1',
    archive: 'snapshot-20261019T000000Z-full.tar.gz',
    archives: ['snapshot-20261019T000000Z-full.tar.gz'],
    fileCount: 3,
    totalBytes: 1024,
    createdAt: '2026-10-19T00:00:00.000Z',
    expiresAt: '2026-10-19T00:30:00.000Z',
    completedAt: null,
    skippedMissing: [],
    ...overrides,
  }
}

function renderWizard(archiveOverride: Partial<BackupArchive> = {}): void {
  render(
    <MemoryRouter>
      <RestoreWizard open archive={archive(archiveOverride)} onClose={() => undefined} />
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.sessionStorage.clear()
})

beforeEach(() => {
  mocks.entries.mockResolvedValue({ path: '/', items: [] })
  mocks.verify.mockResolvedValue({ ok: true, archive: archive() })
  mocks.restorePlan.mockResolvedValue({ plan: plan() })
  mocks.getRestore.mockResolvedValue({ plan: plan() })
  mocks.executeRestore.mockResolvedValue({
    ok: true,
    plan: plan({ status: 'completed', completedAt: '2026-10-19T00:01:00.000Z' }),
    result: {
      targetFolderId: 'folder-1',
      targetName: 'restore-1',
      filesRestored: 3,
      bytesRestored: 1024,
      durationMs: 900,
      skippedMissing: [],
    },
  })
})

describe('RestoreWizard v0.7.0', () => {
  it('加密归档在 Web 不可执行：显示说明且“校验并继续”禁用', async () => {
    renderWizard({ name: 'snapshot-20261019T000000Z-full.tar.gz.age', encrypted: true })
    expect(await screen.findByText(/该归档已加密（.tar.gz.age）/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '校验并继续' })).toBeDisabled()
    expect(mocks.entries).not.toHaveBeenCalled()
  })

  it('打开时读取持久化计划并显示最近状态（刷新后仍可见）', async () => {
    saveStoredRestorePlan({
      planId: 'plan-1',
      archive: 'snapshot-20261019T000000Z-full.tar.gz',
      status: 'unknown',
      savedAt: '2026-10-19T00:02:00.000Z',
    })
    mocks.getRestore.mockResolvedValue({ plan: plan({ status: 'completed', completedAt: '2026-10-19T00:01:00.000Z' }) })
    renderWizard()
    expect(await screen.findByText('最近恢复计划')).toBeTruthy()
    await waitFor(() => expect(screen.getByText(/已完成/)).toBeTruthy())
    expect(mocks.getRestore).toHaveBeenCalledWith('plan-1')
    expect(loadStoredRestorePlan()?.status).toBe('completed')
  })

  it('执行超时：提示服务端可能仍在执行并保存 planId 轮询状态，不清空提示为普通失败', async () => {
    const timeoutError = Object.assign(new Error('请求超时'), { code: 'timeout', status: 0 })
    mocks.executeRestore.mockRejectedValue(timeoutError)
    renderWizard()

    await userEvent.click(await screen.findByRole('button', { name: '校验并继续' }))
    const totp = await screen.findByLabelText(/TOTP 验证码/)
    fireEvent.change(totp, { target: { value: '123456' } })
    fireEvent.change(screen.getByLabelText(/确认文本/), { target: { value: 'RESTORE' } })
    await userEvent.click(screen.getByRole('button', { name: '执行恢复' }))

    expect(await screen.findByText(/执行请求超时或中断/)).toBeTruthy()
    expect(loadStoredRestorePlan()?.planId).toBe('plan-1')
    await waitFor(() => expect(mocks.getRestore).toHaveBeenCalledWith('plan-1'))
  })

  it('entries 截断时提示列表不完整', async () => {
    mocks.entries.mockResolvedValue({
      path: '/',
      truncated: true,
      items: [{ path: '/a.txt', name: 'a.txt', kind: 'file', size: 1 }],
    })
    renderWizard()
    expect(await screen.findByText(/归档条目超过 500 条/)).toBeTruthy()
  })
})
