// 备份 prepare 对话框（v0.7.0 修复回归）：warnings/skippedMissing 必须可见；超时不得提示直接重试。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PrepareBackupDialog } from './PrepareBackupDialog'
import type { BackupPrepareResult } from '../../api/types'

const prepare = vi.hoisted(() => vi.fn())
const onPrepared = vi.hoisted(() => vi.fn())

vi.mock('../../api/client', () => ({
  api: { backups: { prepare } },
  toErrorMessage: (error: unknown, fallback = '') => (error instanceof Error ? error.message : fallback),
}))

afterEach(() => {
  cleanup()
  prepare.mockReset()
  onPrepared.mockReset()
})

function baseResult(overrides: Partial<BackupPrepareResult> = {}): BackupPrepareResult {
  return {
    ok: true,
    mode: 'inc',
    archiveName: 'snapshot-20261024T140000Z-inc.tar.gz',
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
    fileCount: 9,
    ...overrides,
  }
}

function renderDialog() {
  const onClose = vi.fn()
  render(<PrepareBackupDialog open onClose={onClose} onPrepared={onPrepared} />)
  return { onClose }
}

async function submitTotp(): Promise<void> {
  // Modal 打开后 20ms 会移动默认焦点；直接 change 输入避免逐字输入被焦点切换打断。
  const input = screen.getByPlaceholderText('000000')
  fireEvent.change(input, { target: { value: '123456' } })
  await userEvent.click(screen.getByRole('button', { name: '准备备份' }))
}

describe('PrepareBackupDialog 结果完整性', () => {
  it('skippedMissing 非空时展示“备份未包含全部文件”，不关闭对话框', async () => {
    prepare.mockResolvedValue(baseResult({ skippedMissing: ['file-1', 'file-2'], warnings: [] }))
    const { onClose } = renderDialog()
    await submitTotp()

    expect(await screen.findByText('备份未包含全部文件')).toBeTruthy()
    expect(screen.getByText(/2 个物理文件缺失已被跳过/)).toBeTruthy()
    expect(onPrepared).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy()
  })

  it('warnings 非空时展示服务端警告列表', async () => {
    prepare.mockResolvedValue(baseResult({ warnings: ['磁盘余量偏低'] }))
    renderDialog()
    await submitTotp()

    expect(await screen.findByText('服务端警告')).toBeTruthy()
    expect(screen.getByText('磁盘余量偏低')).toBeTruthy()
  })

  it('加密归档展示密文标识，提示 PC 私钥校验', async () => {
    prepare.mockResolvedValue(
      baseResult({ encrypted: true, archiveFormat: 'tar.gz.age', archiveName: 'snapshot-20261024T140000Z-inc.tar.gz.age' }),
    )
    renderDialog()
    await submitTotp()

    expect(await screen.findByText(/加密归档，PC 需 age 私钥解密校验/)).toBeTruthy()
  })

  it('无警告时成功后关闭并回传结果', async () => {
    const result = baseResult()
    prepare.mockResolvedValue(result)
    const { onClose } = renderDialog()
    await submitTotp()

    await waitFor(() => expect(onPrepared).toHaveBeenCalledWith(result))
    expect(onClose).toHaveBeenCalled()
  })

  it('超时/网络中断提示“服务端可能仍在执行”，不显示可直接重试的错误', async () => {
    const timeoutError = Object.assign(new Error('请求超时'), { code: 'timeout', status: 0 })
    prepare.mockRejectedValue(timeoutError)
    const { onClose } = renderDialog()
    await submitTotp()

    expect(await screen.findByText('备份请求中断')).toBeTruthy()
    expect(screen.getByText(/请勿重复提交/)).toBeTruthy()
    expect(onPrepared).toHaveBeenCalledWith(null)
    expect(onClose).not.toHaveBeenCalled()
  })
})
