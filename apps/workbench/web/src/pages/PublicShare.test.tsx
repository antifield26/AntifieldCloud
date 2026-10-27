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
        itemContentUrl: (token: string, itemId: string) =>
          `/api/public/shares/${token}/items/${itemId}/content`,
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

  it('多文件分享渲染文件清单并逐个下载', async () => {
    mocks.info.mockResolvedValue({
      share: {
        fileName: 'a.txt',
        size: 3072,
        mime: null,
        itemCount: 2,
        totalSizeBytes: 3072,
        expiresAt: null,
        hasPassword: false,
        maxDownloads: null,
        downloadCount: 0,
        items: [
          { id: 'item-1', name: 'a.txt', size: 1024, mime: 'text/plain' },
          { id: 'item-2', name: 'b.jpg', size: 2048, mime: 'image/jpeg' },
        ],
      },
      state: 'active',
      requiresPassword: false,
    })
    render(
      <MemoryRouter initialEntries={['/s/BUNDLE']}>
        <Routes>
          <Route path="/s/:token" element={<PublicShare />} />
        </Routes>
      </MemoryRouter>,
    )
    await screen.findByText('2 个文件')
    expect(screen.getByText('a.txt')).toBeTruthy()
    expect(screen.getByText('b.jpg')).toBeTruthy()
    // 多文件分享不展示单文件下载按钮，改为逐项下载链接
    expect(screen.queryByText('下载文件')).toBeNull()
    const links = screen.getAllByRole('link', { name: /下载/ })
    expect(links).toHaveLength(2)
    expect(links[0]?.getAttribute('href')).toBe('/api/public/shares/BUNDLE/items/item-1/content')
    expect(links[1]?.getAttribute('href')).toBe('/api/public/shares/BUNDLE/items/item-2/content')
  })
})
