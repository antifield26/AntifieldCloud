// useBackups（v0.7.0 WEB-17）：已有数据时轮询失败也必须暴露错误，避免旧“正常”状态长期误导。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { useBackups } from './useBackups'

const list = vi.hoisted(() => vi.fn())

vi.mock('../api/client', () => ({
  api: { backups: { list } },
  ApiError: class ApiError extends Error {
    status: number
    code: string
    constructor(status: number, code: string, message: string) {
      super(message)
      this.status = status
      this.code = code
    }
  },
  isAbortError: (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  toErrorMessage: (error: unknown, fallback = '') => (error instanceof Error && error.message ? error.message : fallback),
}))

afterEach(() => {
  cleanup()
  list.mockReset()
})

const emptyResult = {
  items: [],
  inbox: [],
  orphans: [],
  state: {
    lastPullAt: null,
    pendingCount: 0,
    ackedCount: 0,
    importCount: 0,
    orphanCount: 0,
    lastError: null,
    dataDirFreeBytes: 0,
  },
  world: null,
  worldPull: null,
  drill: null,
}

describe('useBackups 轮询失败语义', () => {
  it('首次成功后再刷新失败：保留数据但设置 error，供卡片提示“数据可能过期”', async () => {
    list.mockResolvedValueOnce(emptyResult)
    const { result } = renderHook(() => useBackups(3_600_000))
    await waitFor(() => expect(result.current.data).not.toBeNull())

    list.mockRejectedValueOnce(new Error('网络失败'))
    await result.current.refresh()

    await waitFor(() => expect(result.current.error).toBe('网络失败'))
    expect(result.current.data).not.toBeNull()
  })
})
