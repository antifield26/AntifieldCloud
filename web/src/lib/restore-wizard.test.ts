import { describe, expect, it } from 'vitest'
import type { BackupArchive } from '../api/types'
import {
  buildRestorePlanInput,
  createRestoreState,
  restoreWizardReducer,
  validateRestoreConfirmation,
  validateSelectStep,
} from './restore-wizard'

function makeArchive(overrides: Partial<BackupArchive> = {}): BackupArchive {
  return {
    id: 'snapshot-a-full.tar.gz',
    name: 'snapshot-a-full.tar.gz',
    mode: 'full',
    createdAt: '2026-10-19T00:00:00.000Z',
    sizeBytes: 1024,
    sha256: 'abcdefabcdefabcdef',
    status: 'acked',
    origin: 'import',
    verifiedAt: '2026-10-19T01:00:00.000Z',
    pulledAt: null,
    ackedAt: null,
    lastError: null,
    manifest: { mode: 'full', createdAt: '2026-10-19T00:00:00.000Z', since: null, fileCount: 3, totalBytes: 1024 },
    ...overrides,
  }
}

describe('restoreWizardReducer', () => {
  it('选择归档后可校验，未校验归档不允许进入恢复', () => {
    const archive = makeArchive()
    let state = createRestoreState()
    expect(validateSelectStep(state, archive)).toContain('请先选择归档')
    state = restoreWizardReducer(state, { type: 'select-archive', name: archive.name })
    expect(state.archiveName).toBe(archive.name)
    expect(validateSelectStep(state, archive)).toBeNull()
    expect(validateSelectStep(state, makeArchive({ verifiedAt: null }))).toContain('请先校验')
    expect(validateSelectStep(state, makeArchive({ status: 'missing', verifiedAt: 'x' }))).toContain('文件缺失')
  })

  it('完整流程：校验 → 确认 → 执行成功，完成后清空 TOTP', () => {
    let state = restoreWizardReducer(createRestoreState(), { type: 'select-archive', name: 'snapshot-a-full.tar.gz' })
    state = restoreWizardReducer(state, { type: 'toggle-path', path: '/data.txt' })
    expect(buildRestorePlanInput(state)?.paths).toEqual(['/data.txt'])

    state = restoreWizardReducer(state, { type: 'go-verify' })
    expect(state.step).toBe('verify')
    state = restoreWizardReducer(state, { type: 'verify-start' })
    expect(state.busy).toBe(true)
    // busy 时忽略用户输入
    expect(restoreWizardReducer(state, { type: 'toggle-path', path: '/x' }).selectedPaths).toEqual(['/data.txt'])
    state = restoreWizardReducer(state, {
      type: 'verify-success',
      verification: { ok: true, archiveName: 'snapshot-a-full.tar.gz', summary: '3 个文件', entryCount: 1 },
    })
    expect(state.step).toBe('confirm')
    expect(state.busy).toBe(false)

    state = restoreWizardReducer(state, { type: 'go-confirm' })
    state = restoreWizardReducer(state, { type: 'set-totp', value: '12345' })
    expect(validateRestoreConfirmation(state)).toContain('6 位')
    state = restoreWizardReducer(state, { type: 'set-totp', value: '123456' })
    expect(validateRestoreConfirmation(state)).toContain('RESTORE')
    state = restoreWizardReducer(state, { type: 'set-confirmation', value: 'restore' })
    expect(validateRestoreConfirmation(state)).toBeNull()

    state = restoreWizardReducer(state, { type: 'execute-start' })
    expect(state.step).toBe('executing')
    expect(state.busy).toBe(true)
    state = restoreWizardReducer(state, {
      type: 'execute-success',
      plan: {
        id: 'plan-1',
        status: 'completed',
        targetName: 'restore-1',
        archive: 'snapshot-a-full.tar.gz',
        archives: ['snapshot-a-full.tar.gz'],
        fileCount: 1,
        totalBytes: 10,
        createdAt: '2026-10-19T00:00:00.000Z',
        expiresAt: '2026-10-19T00:30:00.000Z',
        completedAt: '2026-10-19T00:01:00.000Z',
      },
      result: { targetFolderId: 'folder-1', targetName: 'restore-1', filesRestored: 1, bytesRestored: 10, durationMs: 500 },
    })
    expect(state.step).toBe('done')
    expect(state.result?.targetFolderId).toBe('folder-1')
    expect(state.totpCode).toBe('')
  })

  it('执行失败可回到确认步骤重试，TOTP 被清空', () => {
    let state = restoreWizardReducer(createRestoreState(), { type: 'select-archive', name: 'a-full.tar.gz' })
    state = restoreWizardReducer(state, { type: 'go-verify' })
    state = restoreWizardReducer(state, { type: 'verify-start' })
    state = restoreWizardReducer(state, {
      type: 'verify-success',
      verification: { ok: true, archiveName: 'a-full.tar.gz', summary: 'ok', entryCount: 0 },
    })
    state = restoreWizardReducer(state, { type: 'go-confirm' })
    state = restoreWizardReducer(state, { type: 'set-totp', value: '123456' })
    state = restoreWizardReducer(state, { type: 'set-confirmation', value: 'RESTORE' })
    state = restoreWizardReducer(state, { type: 'execute-start' })
    state = restoreWizardReducer(state, { type: 'execute-failure', error: '服务暂时不可用' })
    expect(state.step).toBe('confirm')
    expect(state.error).toContain('服务暂时不可用')
    expect(state.totpCode).toBe('')
  })

  it('返回修改会清空校验与计划，但保留归档选择', () => {
    let state = restoreWizardReducer(createRestoreState(), { type: 'select-archive', name: 'a-full.tar.gz' })
    state = restoreWizardReducer(state, { type: 'toggle-path', path: '/a' })
    state = restoreWizardReducer(state, { type: 'go-verify' })
    state = restoreWizardReducer(state, { type: 'verify-start' })
    state = restoreWizardReducer(state, {
      type: 'verify-success',
      verification: { ok: true, archiveName: 'a-full.tar.gz', summary: 'ok', entryCount: 1 },
    })
    state = restoreWizardReducer(state, { type: 'back-to-select' })
    expect(state.step).toBe('select')
    expect(state.archiveName).toBe('a-full.tar.gz')
    expect(state.selectedPaths).toEqual(['/a'])
    expect(state.verification).toBeNull()
  })
})
