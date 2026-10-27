import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Note, NoteAttachment, NoteVersion } from '../../api/types'
import { ToastProvider } from '../Toast'
import { NoteEditor } from './NoteEditor'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  listAttachments: vi.fn(),
  removeAttachment: vi.fn(),
  listVersions: vi.fn(),
  getVersion: vi.fn(),
  restoreVersion: vi.fn(),
  uploadAttachments: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: {
    notes: {
      get: mocks.get,
      update: mocks.update,
      create: mocks.create,
      attachments: {
        list: mocks.listAttachments,
        remove: mocks.removeAttachment,
      },
      versions: {
        list: mocks.listVersions,
        get: mocks.getVersion,
        restore: mocks.restoreVersion,
      },
    },
  },
  toErrorMessage: (error: unknown, fallback = '') =>
    error instanceof Error && error.message ? error.message : fallback,
  uploadNoteAttachments: mocks.uploadAttachments,
}))

vi.mock('../../meta/MetaContext', () => ({
  useAppMeta: () => ({
    meta: {
      appOrigin: 'https://app.example.com',
      noteAttachmentMaxBytes: 1024,
      noteMaxAttachments: 3,
      noteVersionsKeep: 20,
    },
    loading: false,
    refresh: async () => undefined,
  }),
}))

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 'note-1',
    title: '测试笔记',
    bodyMd: '# 原标题',
    tags: ['工作'],
    pinned: false,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    attachments: [],
    ...overrides,
  }
}

function attachment(overrides: Partial<NoteAttachment> = {}): NoteAttachment {
  return {
    fileId: 'file-1',
    name: 'a.txt',
    size: 100,
    mime: 'text/plain',
    url: '/api/files/file-1/content?inline=1',
    ...overrides,
  }
}

function version(overrides: Partial<NoteVersion> = {}): NoteVersion {
  return {
    id: 'v-1',
    noteId: 'note-1',
    title: '旧标题',
    bodyMd: '旧正文',
    tags: ['旧标签'],
    createdAt: '2026-10-19T00:00:00.000Z',
    ...overrides,
  }
}

function renderEditor(element: React.ReactElement) {
  return render(<ToastProvider>{element}</ToastProvider>)
}

/** Modal 通过 Portal 渲染到 document.body，文件输入不在 render container 内。 */
function attachmentInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('找不到附件文件输入')
  return input
}

beforeEach(() => {
  // GET /api/notes/:id 返回附件；编辑器打开时以详情接口为准
  mocks.get.mockResolvedValue(note({ attachments: [attachment()] }))
  mocks.listAttachments.mockResolvedValue({ items: [attachment()] })
  mocks.listVersions.mockResolvedValue({
    items: [
      { id: 'v-1', title: '旧标题', createdAt: '2026-10-19T00:00:00.000Z' },
      { id: 'v-2', title: '更旧标题', createdAt: '2026-10-18T00:00:00.000Z' },
    ],
    total: 2,
  })
  mocks.getVersion.mockResolvedValue({ version: version() })
  mocks.restoreVersion.mockResolvedValue(note({ title: '旧标题', bodyMd: '旧正文' }))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('NoteEditor 附件', () => {
  it('打开时加载附件，上传后插入 Markdown 并出现在列表', async () => {
    mocks.uploadAttachments.mockResolvedValue({
      items: [attachment({ fileId: 'file-2', name: 'b.png', mime: 'image/png', url: '/api/files/file-2/content?inline=1' })],
    })
    renderEditor(<NoteEditor open note={note()} onClose={vi.fn()} onSaved={vi.fn()} />)

    expect(await screen.findByText('a.txt')).toBeTruthy()
    await userEvent.upload(attachmentInput(), new File(['x'], 'b.png', { type: 'image/png' }))

    await waitFor(() => expect(mocks.uploadAttachments).toHaveBeenCalledTimes(1))
    expect(mocks.uploadAttachments.mock.calls[0]?.[1]).toHaveLength(1)
    await waitFor(() => {
      const list = document.querySelector('.note-attachment-list')
      expect(list).not.toBeNull()
      expect(within(list as HTMLElement).getByText('b.png')).toBeTruthy()
    })
    const textarea = screen.getByLabelText('Markdown 正文') as HTMLTextAreaElement
    await waitFor(() => expect(textarea.value).toContain('![b.png](/api/files/file-2/content?inline=1)'))
  })

  it('单次超过 5 个附件时阻止上传并提示', async () => {
    renderEditor(<NoteEditor open note={note()} onClose={vi.fn()} onSaved={vi.fn()} />)
    await screen.findByText('a.txt')
    const files = Array.from({ length: 6 }, (_, index) => new File(['x'], `f-${index}.txt`, { type: 'text/plain' }))
    await userEvent.upload(attachmentInput(), files)
    expect(await screen.findByText(/单次最多上传 5 个附件/)).toBeTruthy()
    expect(mocks.uploadAttachments).not.toHaveBeenCalled()
  })

  it('单文件超过上限时逐文件报错', async () => {
    renderEditor(<NoteEditor open note={note()} onClose={vi.fn()} onSaved={vi.fn()} />)
    await screen.findByText('a.txt')
    const tooLarge = new File([new Uint8Array(2048)], 'big.bin', { type: 'application/octet-stream' })
    await userEvent.upload(attachmentInput(), tooLarge)
    expect(await screen.findByText(/超过单文件上限/)).toBeTruthy()
    expect(mocks.uploadAttachments).not.toHaveBeenCalled()
  })

  it('删除附件需二次确认后调用硬删除接口并移除列表项', async () => {
    mocks.removeAttachment.mockResolvedValue({ ok: true })
    renderEditor(<NoteEditor open note={note()} onClose={vi.fn()} onSaved={vi.fn()} />)
    await screen.findByText('a.txt')
    await userEvent.click(screen.getByRole('button', { name: '删除附件 a.txt' }))
    expect(await screen.findByText('确定删除附件「a.txt」？')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '删除附件' }))
    await waitFor(() => expect(mocks.removeAttachment).toHaveBeenCalledWith('note-1', 'file-1'))
    await waitFor(() => expect(screen.queryByText('a.txt')).toBeNull())
  })
})

describe('NoteEditor 历史版本', () => {
  it('打开历史版本、预览并以二次确认恢复后刷新编辑器内容', async () => {
    const onRestored = vi.fn()
    renderEditor(
      <NoteEditor open note={note()} onClose={vi.fn()} onSaved={vi.fn()} onRestored={onRestored} />,
    )
    await screen.findByText('a.txt')

    await userEvent.click(screen.getByRole('button', { name: '历史版本' }))
    await waitFor(() => expect(mocks.listVersions).toHaveBeenCalledWith('note-1', { limit: 20 }))
    expect(await screen.findByText('旧标题')).toBeTruthy()

    const versionList = document.querySelector('.note-version-list')
    expect(versionList).not.toBeNull()
    const previewButtons = within(versionList as HTMLElement).getAllByRole('button', { name: '预览' })
    await userEvent.click(previewButtons[0] as HTMLElement)
    await waitFor(() => expect(mocks.getVersion).toHaveBeenCalledWith('note-1', 'v-1'))
    expect(await screen.findByText('旧正文')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '恢复到此版本' }))
    expect(await screen.findByText('确定把当前笔记恢复到「旧标题」？')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '恢复此版本' }))
    await waitFor(() => expect(mocks.restoreVersion).toHaveBeenCalledWith('note-1', 'v-1'))
    // 恢复后编辑器保持打开并刷新内容，父级收到 onRestored
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1))
    expect(onRestored.mock.calls[0]?.[0]).toMatchObject({ title: '旧标题', bodyMd: '旧正文' })
    const textarea = screen.getByLabelText('Markdown 正文') as HTMLTextAreaElement
    await waitFor(() => expect(textarea.value).toBe('旧正文'))
    expect((screen.getByLabelText(/标题/) as HTMLInputElement).value).toBe('旧标题')
  })
})
