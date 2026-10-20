import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { PublicShare } from './PublicShare'

const mocks = vi.hoisted(() => ({ info: vi.fn() }))

vi.mock('../api/client', () => {
  class ApiError extends Error {
    status: number
    code: string
    constructor(status: number, code: string, message: string) {
      super(message)
      this.status = status
      this.code = code
    }
  }
  return {
    api: {
      publicShares: {
        info: mocks.info,
        unlock: vi.fn(),
        contentUrl: (token: string) => `/api/public/shares/${token}/content`,
      },
    },
    ApiError,
    isApiError: (error: unknown, code?: string) =>
      error instanceof ApiError && (code === undefined || error.code === code),
    toErrorMessage: (error: unknown, fallback = '') =>
      error instanceof Error && error.message ? error.message : fallback,
  }
})

afterEach(() => {
  cleanup()
  mocks.info.mockReset()
})

describe('PublicShare 隐私', () => {
  it('不展示分享备注（备注仅分享者可见）', async () => {
    mocks.info.mockResolvedValue({
      share: {
        fileName: 'readme.md',
        size: 1234,
        mime: 'text/markdown',
        expiresAt: null,
        hasPassword: false,
        maxDownloads: null,
        downloadCount: 0,
        note: '仅分享者可见的私密备注',
      },
      state: 'active',
      requiresPassword: false,
    })
    render(
      <MemoryRouter initialEntries={['/s/TOKEN123']}>
        <Routes>
          <Route path="/s/:token" element={<PublicShare />} />
        </Routes>
      </MemoryRouter>,
    )
    await screen.findByText('readme.md')
    expect(screen.queryByText('仅分享者可见的私密备注')).toBeNull()
    expect(screen.queryByText('备注')).toBeNull()
    expect(screen.getByText('下载文件')).toBeTruthy()
  })

  it('需要密码时显示解锁表单', async () => {
    mocks.info.mockResolvedValue({
      share: {
        fileName: 'photo.jpg',
        size: 1024,
        mime: 'image/jpeg',
        expiresAt: null,
        hasPassword: true,
        maxDownloads: 5,
        downloadCount: 0,
      },
      state: 'active',
      requiresPassword: true,
    })
    render(
      <MemoryRouter initialEntries={['/s/PWTOKEN']}>
        <Routes>
          <Route path="/s/:token" element={<PublicShare />} />
        </Routes>
      </MemoryRouter>,
    )
    await screen.findByText('该分享受密码保护，请输入分享者提供的密码。')
    expect(screen.getByLabelText(/分享密码/)).toBeTruthy()
  })
})
