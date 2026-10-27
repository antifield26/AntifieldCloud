import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { BackupArchive, RestorePlan } from '../../api/types'
import { RestoreWizard } from './RestoreWizard'

const mocks = vi.hoisted(() => ({
  entries: vi.fn(),
  verify: vi.fn(),
  restorePlan: vi.fn(),
  executeRestore: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: {
    backups: {
      entries: mocks.entries,
      verify: mocks.verify,
      restorePlan: mocks.restorePlan,
      executeRestore: mocks.executeRestore,
    },
  },
  toErrorMessage: (error: unknown, fallback = '') =>
    error instanceof Error && error.message ? error.message : fallback,
}))

// 恢复向导只读取 meta 的恢复开关与文件数上限，测试不引入完整 Auth/Meta Provider。
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
    pulledAt: '2026-10-19T01:00:00.000Z',
    ackedAt: '2026-10-19T01:00:00.000Z',
    lastError: null,
    manifest: { mode: 'full', createdAt: '2026-10-19T00:00:00.000Z', since: null, fileCount: 3, totalBytes: 1024 },
    ...overrides,
  }
}

function plan(overrides: Partial<RestorePlan> = {}): RestorePlan {
  return {
    id: 'plan-1',
    status: 'completed',
    targetName: 'restore-1',
    archive: 'snapshot-20261019T000000Z-full.tar.gz',
    archives: ['snapshot-20261019T000000Z-full.tar.gz'],
    fileCount: 3,
    totalBytes: 1024,
    createdAt: '2026-10-19T00:00:00.000Z',
    expiresAt: '2026-10-19T00:30:00.000Z',
    completedAt: '2026-10-19T00:01:00.000Z',
    ...overrides,
  }
}

function renderWizard(): void {
  render(
    <MemoryRouter>
      <RestoreWizard open archive={archive()} onClose={() => undefined} />
    </MemoryRouter>,
  )
}

/** 走到确认步骤：选择 → 自动校验成功后直接进入确认。 */
async function goToConfirmStep(): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: '校验并继续' }))
  await screen.findByLabelText(/TOTP 验证码/)
}

async function executeRestore(): Promise<void> {
  const totpInput = await screen.findByLabelText(/TOTP 验证码/)
  const confirmInput = screen.getByLabelText(/确认文本/)
  // 用 fireEvent 直接触发受控 onChange，避免 Modal 自动聚焦计时器与 userEvent.type 竞态丢字符。
  fireEvent.change(totpInput, { target: { value: '123456' } })
  fireEvent.change(confirmInput, { target: { value: 'RESTORE' } })
  await userEvent.click(screen.getByRole('button', { name: '执行恢复' }))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

beforeEach(() => {
  mocks.entries.mockResolvedValue({ path: '/', items: [] })
  mocks.verify.mockResolvedValue({ ok: true, archive: archive() })
  mocks.restorePlan.mockResolvedValue({ plan: plan({ id: 'plan-1', skippedMissing: [] }) })
  mocks.executeRestore.mockResolvedValue({
    ok: true,
    plan: plan({ id: 'plan-1', skippedMissing: [] }),
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

describe('RestoreWizard 恢复结果', () => {
  it('执行结果存在 skippedMissing 时明确提示未包含全部文件', async () => {
    mocks.executeRestore.mockResolvedValue({
      ok: true,
      plan: plan({ skippedMissing: ['plan-file-a'] }),
      result: {
        targetFolderId: 'folder-1',
        targetName: 'restore-1',
        filesRestored: 1,
        bytesRestored: 512,
        durationMs: 900,
        skippedMissing: ['exec-file-b'],
      },
    })
    renderWizard()
    await goToConfirmStep()
    await executeRestore()

    expect(await screen.findByText('恢复未包含全部文件')).toBeTruthy()
    expect(screen.getByText(/有 2 个文件在归档中缺失/)).toBeTruthy()
    expect(screen.getByText(/plan-file-a/)).toBeTruthy()
    expect(screen.getByText(/exec-file-b/)).toBeTruthy()
    // 成功提示不能让人误以为完整恢复
    expect(screen.getByText(/2 个缺失文件被跳过/)).toBeTruthy()
    expect(screen.getByText('跳过缺失文件')).toBeTruthy()
  })

  it('没有 skippedMissing 时不显示跳过提示，按完整恢复展示', async () => {
    renderWizard()
    await goToConfirmStep()
    await executeRestore()

    expect(await screen.findByText(/恢复完成，已写入新目录「restore-1」/)).toBeTruthy()
    expect(screen.queryByText('恢复未包含全部文件')).toBeNull()
    expect(screen.queryByText('跳过缺失文件')).toBeNull()
    expect(screen.queryByText(/个文件在归档中缺失/)).toBeNull()
  })
})
