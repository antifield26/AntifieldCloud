import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { FileItem } from '../api/types'
import { useUploadQueue } from './useUploadQueue'

const mocks = vi.hoisted(() => ({ uploadFiles: vi.fn() }))

vi.mock('../api/client', () => ({
  uploadFiles: mocks.uploadFiles,
  isApiError: (error: unknown): boolean => Boolean(error && typeof error === 'object' && 'code' in error),
  toErrorMessage: (error: unknown, fallback = '操作失败'): string =>
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message: unknown }).message)
      : fallback,
}))

interface UploadCallbacksLike {
  signal?: AbortSignal
}

function makeFile(name = 'a.txt', content = 'hello'): File {
  return new File([content], name, { type: 'text/plain' })
}

function makeItem(name = 'a.txt'): FileItem {
  return {
    id: 'file-1',
    parentId: null,
    name,
    kind: 'file',
    size: 5,
    mime: 'text/plain',
    sha256: null,
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
    previewKind: 'text',
    inlineAllowed: true,
  }
}

beforeEach(() => {
  mocks.uploadFiles.mockReset()
})

afterEach(cleanup)

describe('useUploadQueue', () => {
  it('取消进行中的上传并标记为 cancelled', async () => {
    mocks.uploadFiles.mockImplementation(
      (_files: File[], _parentId: string | null, callbacks: UploadCallbacksLike) =>
        new Promise((_resolve, reject) => {
          callbacks.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('上传已取消'), { code: 'aborted' })),
          )
        }),
    )

    const { result } = renderHook(() => useUploadQueue())
    act(() => result.current.enqueue([makeFile()], null))
    await waitFor(() => expect(result.current.tasks[0]?.status).toBe('uploading'))
    const taskId = result.current.tasks[0]?.id ?? 0
    act(() => result.current.cancel(taskId))
    await waitFor(() => expect(result.current.tasks[0]?.status).toBe('cancelled'))
    expect(result.current.busy).toBe(false)
  })

  it('超时错误展示为失败并可重试', async () => {
    mocks.uploadFiles.mockRejectedValue(Object.assign(new Error('上传超时，请检查网络后重试'), { code: 'timeout' }))
    const { result } = renderHook(() => useUploadQueue())
    act(() => result.current.enqueue([makeFile()], null))
    await waitFor(() => expect(result.current.tasks[0]?.status).toBe('error'))
    expect(result.current.tasks[0]?.error).toContain('超时')
  })

  it('超过大小上限的文件不发请求，直接标记失败', () => {
    const { result } = renderHook(() => useUploadQueue({ maxFileBytes: 3 }))
    act(() => result.current.enqueue([makeFile('big.txt', '1234')], null))
    expect(result.current.tasks[0]?.status).toBe('error')
    expect(result.current.tasks[0]?.error).toContain('大小')
    expect(mocks.uploadFiles).not.toHaveBeenCalled()
  })

  it('全部完成后回调汇总（成功/失败/取消）', async () => {
    mocks.uploadFiles.mockResolvedValue({ items: [makeItem()], errors: [] })
    const onFinished = vi.fn()
    const { result } = renderHook(() => useUploadQueue({ onFinished }))
    act(() => result.current.enqueue([makeFile()], null))
    await waitFor(() => expect(result.current.tasks[0]?.status).toBe('success'))
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1))
    expect(onFinished.mock.calls[0]?.[0]).toMatchObject({ succeeded: 1, failed: 0, cancelled: 0 })
  })
})
