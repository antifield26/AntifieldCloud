import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FileItem } from '../../api/types'
import { ToastProvider } from '../Toast'
import { ShareDialog } from './ShareDialog'

const mocks = vi.hoisted(() => ({
  createShare: vi.fn(),
  createBundle: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: {
    files: { createShare: mocks.createShare },
    shares: { createBundle: mocks.createBundle },
  },
  toErrorMessage: (error: unknown, fallback = '') =>
    error instanceof Error && error.message ? error.message : fallback,
}))

vi.mock('../../meta/MetaContext', () => ({
  useAppMeta: () => ({
    meta: {
      appOrigin: 'https://app.example.com',
      shareMaxItems: 50,
      sharesEnabled: true,
    },
    loading: false,
    refresh: async () => undefined,
  }),
}))

function file(id: string, name: string, size: number): FileItem {
  return {
    id,
    parentId: null,
    name,
    kind: 'file',
    size,
    mime: 'text/plain',
    sha256: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    previewKind: 'text',
    inlineAllowed: false,
  }
}

function renderDialog(element: React.ReactElement) {
  return render(<ToastProvider>{element}</ToastProvider>)
}

afterEach(() => {
  cleanup()
  mocks.createShare.mockReset()
  mocks.createBundle.mockReset()
})

describe('ShareDialog 单文件与多文件入口', () => {
  it('单文件入口调用兼容端点并展示条目数', async () => {
    mocks.createShare.mockResolvedValue({
      share: {
        id: 'share-1',
        fileId: 'a',
        fileName: 'a.txt',
        itemCount: 1,
        totalSizeBytes: 1024,
        expiresAt: null,
        maxDownloads: null,
        downloadCount: 0,
        createdAt: '2026-10-20T00:00:00.000Z',
        revokedAt: null,
        hasPassword: false,
        note: null,
      },
      url: '/s/token-1',
    })
    renderDialog(<ShareDialog file={file('a', 'a.txt', 1024)} onClose={vi.fn()} />)

    expect(screen.getByText('为「a.txt」创建公开下载链接')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '创建链接' }))

    await waitFor(() => expect(mocks.createShare).toHaveBeenCalledTimes(1))
    expect(mocks.createShare).toHaveBeenCalledWith('a', {})
    expect(mocks.createBundle).not.toHaveBeenCalled()
    expect(await screen.findByText('分享链接已创建')).toBeTruthy()
    expect(screen.getByText('1 个')).toBeTruthy()
    expect(screen.getByText('https://app.example.com/s/token-1')).toBeTruthy()
  })

  it('多选入口调用 POST /api/shares 并显示文件数与总大小', async () => {
    mocks.createBundle.mockResolvedValue({
      share: {
        id: 'share-2',
        fileId: 'a',
        fileName: 'a.txt',
        itemCount: 2,
        totalSizeBytes: 3072,
        expiresAt: null,
        maxDownloads: null,
        downloadCount: 0,
        createdAt: '2026-10-20T00:00:00.000Z',
        revokedAt: null,
        hasPassword: false,
        note: null,
      },
      url: '/s/token-2',
    })
    const onCreated = vi.fn()
    renderDialog(
      <ShareDialog
        files={[file('a', 'a.txt', 1024), file('b', 'b.txt', 2048)]}
        onClose={vi.fn()}
        onCreated={onCreated}
      />,
    )

    expect(screen.getByText('分享所选文件')).toBeTruthy()
    expect(screen.getByText('已选 2 个文件 · 共 3 KB')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '创建 2 个文件的分享' }))

    await waitFor(() => expect(mocks.createBundle).toHaveBeenCalledTimes(1))
    expect(mocks.createBundle).toHaveBeenCalledWith({ fileIds: ['a', 'b'] })
    expect(mocks.createShare).not.toHaveBeenCalled()
    expect(onCreated).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('分享链接已创建')).toBeTruthy()
    expect(screen.getByText('a.txt 等 2 个文件')).toBeTruthy()
    expect(screen.getByText('2 个')).toBeTruthy()
    expect(screen.getByText('3 KB')).toBeTruthy()
  })

  it('多选超过单次上限时阻止提交并提示', async () => {
    const files = Array.from({ length: 51 }, (_, index) => file(`f-${index}`, `f-${index}.txt`, 1))
    renderDialog(<ShareDialog files={files} onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: '创建 51 个文件的分享' }))
    expect(screen.getByRole('alert').textContent).toContain('单次最多分享 50 个文件')
    expect(mocks.createBundle).not.toHaveBeenCalled()
  })
})
