import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { FileItem } from '../../api/types'
import { MediaPreview } from './MediaPreview'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function makeMediaFile(overrides: Partial<FileItem> = {}): FileItem {
  return {
    id: 'video-1',
    parentId: null,
    name: 'demo.mp4',
    kind: 'file',
    size: 1024,
    mime: 'video/mp4',
    sha256: null,
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
    previewKind: 'video',
    inlineAllowed: true,
    ...overrides,
  }
}

describe('MediaPreview', () => {
  it('渲染原生 video 并支持下载', () => {
    const { container } = render(
      <MediaPreview file={makeMediaFile()} inlineUrl="/api/files/video-1/content?inline=1" downloadUrl="/api/files/video-1/content?download=1" />,
    )
    const video = container.querySelector('video')
    expect(video).not.toBeNull()
    expect(video?.getAttribute('controls')).not.toBeNull()
    const download = container.querySelector('a[href*="download=1"]')
    expect(download).not.toBeNull()
  })

  it('解码/格式失败时展示错误提示并回退下载', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 415, ok: false })))
    const { container } = render(
      <MediaPreview file={makeMediaFile()} inlineUrl="/content" downloadUrl="/download" />,
    )
    const video = container.querySelector('video')!
    Object.defineProperty(video, 'error', { value: { code: 4 }, configurable: true })
    fireEvent.error(video)
    await waitFor(() => {
      expect(container.textContent).toContain('不支持')
    })
    expect(container.querySelector('a[href="/download"]')).not.toBeNull()
  })

  it('inlineAllowed=false 时不允许内联播放', () => {
    const { container } = render(
      <MediaPreview
        file={makeMediaFile({ previewKind: 'audio', mime: 'audio/mpeg', inlineAllowed: false })}
        inlineUrl="/content"
        downloadUrl="/download"
      />,
    )
    expect(container.textContent).toContain('不允许内联播放')
  })
})
