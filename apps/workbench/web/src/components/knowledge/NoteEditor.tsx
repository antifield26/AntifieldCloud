// 笔记编辑器：标题、Markdown 正文（编辑/预览切换）、标签、置顶、附件与历史版本。
// 附件通过笔记接口上传（每文件一次 multipart 请求，便于单项进度/失败重试），
// 上传成功后自动插入 Markdown 图片/链接；附件计入总配额，不出现在文件列表。
// 历史版本：列表 → 预览 → 二次确认恢复；恢复后由父级刷新列表。

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { DragEvent, FormEvent } from 'react'
import {
  ChevronLeft,
  Eye,
  History,
  Paperclip,
  Pencil,
  RotateCcw,
  Trash2,
  UploadCloud,
} from 'lucide-react'
import { api, toErrorMessage, uploadNoteAttachments } from '../../api/client'
import type { Note, NoteAttachment, NoteVersion, NoteVersionSummary } from '../../api/types'
import { useAppMeta } from '../../meta/MetaContext'
import { Modal } from '../Modal'
import { Button } from '../Button'
import { FormField } from '../FormField'
import { MarkdownView } from '../MarkdownView'
import { CopyButton } from '../CopyButton'
import { ConfirmDialog } from '../ConfirmDialog'
import { ProgressBar } from '../ProgressBar'
import { RelativeTime } from '../RelativeTime'
import { InlineError } from '../InlineError'
import { FileIcon } from '../FileIcon'
import { useToast } from '../Toast'
import { formatBytes, formatDateTime } from '../../lib/format'
import { absoluteShareUrl } from '../../lib/share-link'
import { cx } from '../../lib/classnames'

export interface NoteEditorProps {
  open: boolean
  note: Note | null
  onClose: () => void
  onSaved: (note: Note) => void
  /** 恢复历史版本后通知父级刷新列表（编辑器保持打开、内容已更新） */
  onRestored?: (note: Note) => void
}

const NOTE_TITLE_MAX = 200
const NOTE_BODY_MAX = 200_000
const ATTACHMENT_BATCH_MAX = 5
const ATTACHMENT_CONCURRENCY = 2

/** 服务端按 UTF-8 字节限制正文，前端用同一单位校验，避免中文正文被 400 拒绝。 */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

type AttachmentTaskStatus = 'waiting' | 'uploading' | 'success' | 'error'

interface AttachmentTask {
  id: number
  file: File
  status: AttachmentTaskStatus
  progress: number
  error: string | null
}

function joinTags(tags: string[]): string {
  return tags.join(', ')
}

function parseTags(raw: string): string[] {
  return raw
    .split(/[,，\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 20)
}

/** 仅栅格图片可内联；SVG 等按链接插入（服务端禁止内联 SVG）。 */
function isInlineImage(attachment: { mime: string | null; name: string }): boolean {
  if (attachment.mime && attachment.mime.startsWith('image/') && attachment.mime !== 'image/svg+xml') return true
  return /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(attachment.name)
}

function escapeMarkdownText(text: string): string {
  return text.replace(/[[\]()]/g, (match) => `\\${match}`)
}

/** 附件 Markdown 片段：图片用 ![]()，其它用 []()；地址只使用服务端返回的同源 url。 */
export function attachmentMarkdown(attachment: NoteAttachment): string {
  const url = attachment.url || `/api/files/${encodeURIComponent(attachment.fileId)}/content?inline=1`
  if (isInlineImage(attachment)) return `![${escapeMarkdownText(attachment.name)}](${url})`
  return `[${escapeMarkdownText(attachment.name)}](${url})`
}

export function NoteEditor({ open, note, onClose, onSaved, onRestored }: NoteEditorProps) {
  const { meta } = useAppMeta()
  const toast = useToast()
  const [title, setTitle] = useState('')
  const [bodyMd, setBodyMd] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [pinned, setPinned] = useState(false)
  const [baseline, setBaseline] = useState({ title: '', bodyMd: '', tagInput: '', pinned: false })
  const [discardOpen, setDiscardOpen] = useState(false)
  const [tab, setTab] = useState<'edit' | 'preview'>('edit')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<NoteAttachment[]>([])
  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  const [attachmentsError, setAttachmentsError] = useState<string | null>(null)
  const [uploadTasks, setUploadTasks] = useState<AttachmentTask[]>([])
  const [deletingFileId, setDeletingFileId] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [versions, setVersions] = useState<NoteVersionSummary[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [versionsError, setVersionsError] = useState<string | null>(null)
  const [previewVersion, setPreviewVersion] = useState<NoteVersion | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [restoreTarget, setRestoreTarget] = useState<NoteVersionSummary | null>(null)
  const [restoreBusy, setRestoreBusy] = useState(false)
  const [deleteAttachmentTarget, setDeleteAttachmentTarget] = useState<NoteAttachment | null>(null)

  const formId = useId()
  const titleId = useId()
  const bodyId = useId()
  const tagsId = useId()
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const tasksRef = useRef<AttachmentTask[]>([])
  const nextTaskIdRef = useRef(1)
  const activeUploadsRef = useRef(0)
  const controllersRef = useRef(new Map<number, AbortController>())
  const attachmentsRef = useRef<NoteAttachment[]>([])
  attachmentsRef.current = attachments

  const syncTasks = (next: AttachmentTask[]): void => {
    tasksRef.current = next
    setUploadTasks(next)
  }

  const patchTask = (id: number, patch: Partial<AttachmentTask>): void => {
    syncTasks(tasksRef.current.map((task) => (task.id === id ? { ...task, ...patch } : task)))
  }

  const appendMarkdown = useCallback((snippet: string): void => {
    setBodyMd((previous) => {
      const trimmed = previous.replace(/\s+$/, '')
      return trimmed ? `${trimmed}\n\n${snippet}` : snippet
    })
  }, [])

  const loadAttachments = useCallback(async (noteId: string): Promise<void> => {
    setAttachmentsLoading(true)
    setAttachmentsError(null)
    try {
      const result = await api.notes.attachments.list(noteId)
      setAttachments(Array.isArray(result.items) ? result.items : [])
    } catch (loadError) {
      setAttachmentsError(toErrorMessage(loadError, '附件列表加载失败'))
    } finally {
      setAttachmentsLoading(false)
    }
  }, [])

  const loadVersions = useCallback(
    async (noteId: string): Promise<void> => {
      setVersionsLoading(true)
      setVersionsError(null)
      try {
        const result = await api.notes.versions.list(noteId, { limit: meta.noteVersionsKeep })
        setVersions(Array.isArray(result.items) ? result.items : [])
      } catch (loadError) {
        setVersionsError(toErrorMessage(loadError, '历史版本加载失败'))
      } finally {
        setVersionsLoading(false)
      }
    },
    [meta.noteVersionsKeep],
  )

  // 打开编辑器时重置表单，并从详情接口补全附件（列表接口的 Note 可能不含 attachments）
  useEffect(() => {
    if (!open) return
    setTitle(note?.title ?? '')
    setBodyMd(note?.bodyMd ?? '')
    setTagInput(note ? joinTags(note.tags) : '')
    setPinned(note?.pinned ?? false)
    setBaseline({
      title: note?.title ?? '',
      bodyMd: note?.bodyMd ?? '',
      tagInput: note ? joinTags(note.tags) : '',
      pinned: note?.pinned ?? false,
    })
    setDiscardOpen(false)
    setTab('edit')
    setBusy(false)
    setError(null)
    setAttachments(note?.attachments ?? [])
    setAttachmentsError(null)
    setAttachmentsLoading(false)
    setUploadTasks([])
    tasksRef.current = []
    setDeletingFileId(null)
    setDragActive(false)
    setHistoryOpen(false)
    setVersions([])
    setVersionsError(null)
    setPreviewVersion(null)
    setPreviewError(null)
    setRestoreTarget(null)
    setDeleteAttachmentTarget(null)
    if (!note) return
    let active = true
    setAttachmentsLoading(true)
    api.notes
      .get(note.id)
      .then((detail) => {
        if (!active) return
        if (Array.isArray(detail.attachments)) setAttachments(detail.attachments)
      })
      .catch((loadError) => {
        if (active) setAttachmentsError(toErrorMessage(loadError, '附件列表加载失败'))
      })
      .finally(() => {
        if (active) setAttachmentsLoading(false)
      })
    return () => {
      active = false
    }
  }, [open, note])

  // 关闭 / 卸载时中止进行中的附件上传
  useEffect(() => {
    if (open) return
    for (const controller of controllersRef.current.values()) controller.abort()
    controllersRef.current.clear()
    activeUploadsRef.current = 0
  }, [open])

  useEffect(() => {
    return () => {
      for (const controller of controllersRef.current.values()) controller.abort()
      controllersRef.current.clear()
    }
  }, [])

  // 每次渲染重建：runUploadTask 依赖当前 note/meta 闭包，不能用固定依赖的 useCallback 缓存
  function pumpUploads(): void {
    while (activeUploadsRef.current < ATTACHMENT_CONCURRENCY) {
      const nextTask = tasksRef.current.find((task) => task.status === 'waiting')
      if (!nextTask) return
      runUploadTask(nextTask)
    }
  }

  function runUploadTask(task: AttachmentTask): void {
    const noteId = note?.id
    if (!noteId) return
    activeUploadsRef.current += 1
    const controller = new AbortController()
    controllersRef.current.set(task.id, controller)
    patchTask(task.id, { status: 'uploading', progress: 0, error: null })
    void uploadNoteAttachments(noteId, [task.file], {
      signal: controller.signal,
      onProgress: (loaded, total) => {
        const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0
        patchTask(task.id, { progress: percent })
      },
    })
      .then((result) => {
        const uploaded = result.items[0]
        if (!uploaded) {
          patchTask(task.id, { status: 'error', error: '服务端未返回附件信息' })
          return
        }
        patchTask(task.id, { status: 'success', progress: 100 })
        setAttachments((previous) => [...previous, uploaded])
        appendMarkdown(attachmentMarkdown(uploaded))
      })
      .catch((uploadError) => {
        if (uploadError instanceof DOMException && uploadError.name === 'AbortError') {
          patchTask(task.id, { status: 'error', error: '附件上传已取消' })
          return
        }
        patchTask(task.id, { status: 'error', error: toErrorMessage(uploadError, '附件上传失败，请重试') })
      })
      .finally(() => {
        controllersRef.current.delete(task.id)
        activeUploadsRef.current = Math.max(0, activeUploadsRef.current - 1)
        pumpUploads()
      })
  }

  const enqueueAttachments = (files: File[]): void => {
    if (!note?.id || files.length === 0) return
    setError(null)
    if (files.length > ATTACHMENT_BATCH_MAX) {
      setAttachmentsError(`单次最多上传 ${ATTACHMENT_BATCH_MAX} 个附件，请分批选择（本次选择 ${files.length} 个）`)
      return
    }
    const pending = tasksRef.current.filter((task) => task.status === 'waiting' || task.status === 'uploading').length
    const remaining = meta.noteMaxAttachments - attachmentsRef.current.length - pending
    if (files.length > remaining) {
      setAttachmentsError(
        remaining <= 0
          ? `每篇笔记最多 ${meta.noteMaxAttachments} 个附件，请先删除部分附件`
          : `每篇笔记最多 ${meta.noteMaxAttachments} 个附件，本次最多还能上传 ${remaining} 个`,
      )
      return
    }
    setAttachmentsError(null)
    const created: AttachmentTask[] = files.map((file) => {
      const oversized = file.size > meta.noteAttachmentMaxBytes
      return {
        id: nextTaskIdRef.current++,
        file,
        status: oversized ? 'error' : 'waiting',
        progress: 0,
        error: oversized ? `超过单文件上限 ${formatBytes(meta.noteAttachmentMaxBytes)}` : null,
      }
    })
    syncTasks([...tasksRef.current, ...created])
    pumpUploads()
  }

  const handleAttachmentPick = (): void => {
    attachmentInputRef.current?.click()
  }

  const hasFiles = (event: DragEvent<HTMLElement>): boolean => Array.from(event.dataTransfer.types).includes('Files')
  const handleDragEnter = (event: DragEvent<HTMLElement>): void => {
    if (!note?.id || !hasFiles(event)) return
    event.preventDefault()
    setDragActive(true)
  }
  const handleDragOver = (event: DragEvent<HTMLElement>): void => {
    if (!note?.id || !hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }
  const handleDragLeave = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault()
    setDragActive(false)
  }
  const handleDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault()
    setDragActive(false)
    if (!note?.id) return
    enqueueAttachments(Array.from(event.dataTransfer.files))
  }

  const handleDeleteAttachment = async (attachment: NoteAttachment): Promise<void> => {
    if (!note?.id || deletingFileId) return
    setDeletingFileId(attachment.fileId)
    try {
      await api.notes.attachments.remove(note.id, attachment.fileId)
      setAttachments((previous) => previous.filter((item) => item.fileId !== attachment.fileId))
      setDeleteAttachmentTarget(null)
      toast.success(`已删除附件「${attachment.name}」`)
    } catch (deleteError) {
      toast.error(toErrorMessage(deleteError, '删除附件失败，请重试'))
    } finally {
      setDeletingFileId(null)
    }
  }

  const openHistory = async (): Promise<void> => {
    if (!note?.id) return
    setHistoryOpen(true)
    setPreviewVersion(null)
    setPreviewError(null)
    await loadVersions(note.id)
  }

  const openVersionPreview = async (version: NoteVersionSummary): Promise<void> => {
    if (!note?.id) return
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const result = await api.notes.versions.get(note.id, version.id)
      setPreviewVersion(result.version)
    } catch (loadError) {
      setPreviewError(toErrorMessage(loadError, '版本内容加载失败'))
    } finally {
      setPreviewLoading(false)
    }
  }

  const confirmRestore = async (): Promise<void> => {
    if (!note?.id || !restoreTarget) return
    setRestoreBusy(true)
    try {
      const restored = await api.notes.versions.restore(note.id, restoreTarget.id)
      // 恢复后编辑器保持打开并刷新内容；服务端已在恢复前保存当前版本快照
      setTitle(restored.title)
      setBodyMd(restored.bodyMd)
      setTagInput(joinTags(restored.tags))
      setPinned(restored.pinned)
      if (Array.isArray(restored.attachments)) setAttachments(restored.attachments)
      setRestoreTarget(null)
      setPreviewVersion(null)
      toast.success('已恢复所选版本；恢复前的内容已自动保存为新的历史版本')
      onRestored?.(restored)
      await loadVersions(note.id)
    } catch (restoreError) {
      toast.error(toErrorMessage(restoreError, '恢复历史版本失败，请重试'))
    } finally {
      setRestoreBusy(false)
    }
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!title.trim()) {
      setError('标题不能为空')
      return
    }
    if (title.trim().length > NOTE_TITLE_MAX) {
      setError(`标题不能超过 ${NOTE_TITLE_MAX} 个字符`)
      return
    }
    if (utf8ByteLength(bodyMd) > NOTE_BODY_MAX) {
      setError('正文超过 200 KB（UTF-8）限制')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const payload = { title: title.trim(), bodyMd, tags: parseTags(tagInput), pinned }
      const saved = note ? await api.notes.update(note.id, payload) : await api.notes.create(payload)
      if (Array.isArray(saved.attachments)) setAttachments(saved.attachments)
      onSaved(saved)
    } catch (saveError) {
      setError(toErrorMessage(saveError, '保存笔记失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  const pendingUploads = uploadTasks.filter((task) => task.status === 'waiting' || task.status === 'uploading').length
  const hasHistory = Boolean(note?.id)
  const dirty =
    title !== baseline.title || bodyMd !== baseline.bodyMd || tagInput !== baseline.tagInput || pinned !== baseline.pinned
  const requestClose = (): void => {
    if (busy) return
    if (dirty) setDiscardOpen(true)
    else onClose()
  }
  const attachmentUrlFor = (attachment: NoteAttachment): string =>
    absoluteShareUrl(attachment.url, meta.appOrigin)

  return (
    <>
      <Modal
        open={open}
        title={note ? '编辑笔记' : '新建笔记'}
        description="Markdown 正文，支持标签、置顶、附件与历史版本。"
        size="xl"
        onClose={busy ? () => undefined : requestClose}
        busy={busy}
        footer={
          <>
            <Button variant="ghost" onClick={requestClose} disabled={busy}>取消</Button>
            <Button variant="primary" type="submit" form={formId} loading={busy}>保存</Button>
          </>
        }
      >
        <form id={formId} className="knowledge-form" onSubmit={(event) => void handleSubmit(event)}>
          <FormField label="标题" htmlFor={titleId} required>
            <input
              id={titleId}
              className="input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={NOTE_TITLE_MAX}
              data-autofocus
              disabled={busy}
            />
          </FormField>

          <div className="knowledge-editor-toolbar">
            <div className="segmented" role="group" aria-label="编辑或预览">
              <button
                type="button"
                className={cx('segmented-button', tab === 'edit' && 'segmented-button-active')}
                onClick={() => setTab('edit')}
                aria-pressed={tab === 'edit'}
              >
                <Pencil size={14} aria-hidden="true" />
                编辑
              </button>
              <button
                type="button"
                className={cx('segmented-button', tab === 'preview' && 'segmented-button-active')}
                onClick={() => setTab('preview')}
                aria-pressed={tab === 'preview'}
              >
                <Eye size={14} aria-hidden="true" />
                预览
              </button>
            </div>
            <div className="knowledge-editor-actions">
              <Button
                variant="secondary"
                size="sm"
                icon={<Paperclip size={15} aria-hidden="true" />}
                onClick={handleAttachmentPick}
                disabled={!note?.id || busy}
                title={note?.id ? '上传附件并插入 Markdown' : '保存笔记后可添加附件'}
              >
                添加附件
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<History size={15} aria-hidden="true" />}
                onClick={() => (historyOpen ? setHistoryOpen(false) : void openHistory())}
                disabled={!hasHistory || busy}
                aria-pressed={historyOpen}
              >
                历史版本
              </Button>
              <span className="field-hint">{utf8ByteLength(bodyMd)} / {NOTE_BODY_MAX} 字节</span>
            </div>
          </div>

          {tab === 'edit' ? <label className="sr-only" htmlFor={bodyId}>Markdown 正文</label> : null}
          {tab === 'edit' ? (
            <textarea
              id={bodyId}
              className="input knowledge-textarea"
              value={bodyMd}
              onChange={(event) => setBodyMd(event.target.value)}
              rows={12}
              maxLength={NOTE_BODY_MAX}
              placeholder="# 标题&#10;&#10;支持 Markdown 语法…"
              disabled={busy}
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            />
          ) : (
            <div className="knowledge-preview">
              {bodyMd.trim() ? (
                <MarkdownView content={bodyMd} />
              ) : (
                <p className="muted">暂无内容，切换到编辑模式开始输入。</p>
              )}
            </div>
          )}

          <section
            className={cx('note-attachments', dragActive && 'note-attachments-drag')}
            aria-label="笔记附件"
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <header className="note-attachments-header">
              <h3 className="subsection-title">附件</h3>
              <span className="field-hint">
                {note?.id
                  ? `单文件 ≤ ${formatBytes(meta.noteAttachmentMaxBytes)} · 最多 ${meta.noteMaxAttachments} 个 · 单次 ${ATTACHMENT_BATCH_MAX} 个`
                  : '保存笔记后可添加附件；附件计入总配额，不出现在文件列表。'}
              </span>
            </header>

            {dragActive ? (
              <div className="note-attachments-drop" aria-hidden="true">
                <UploadCloud size={20} />
                松开上传附件
              </div>
            ) : null}

            {uploadTasks.length > 0 ? (
              <ul className="note-upload-list" aria-label="附件上传进度">
                {uploadTasks.map((task) => (
                  <li key={task.id} className="note-upload-item">
                    <FileIcon name={task.file.name} mime={task.file.type} size={16} />
                    <div className="note-upload-main">
                      <div className="note-upload-line">
                        <span className="note-upload-name" title={task.file.name}>{task.file.name}</span>
                        <span className="note-upload-state">
                          {task.status === 'waiting' ? '等待上传'
                            : task.status === 'uploading' ? `${task.progress}%`
                              : task.status === 'success' ? '已完成'
                                : '失败'}
                        </span>
                      </div>
                      {task.status === 'uploading' ? (
                        <ProgressBar
                          value={task.progress}
                          size="sm"
                          tone="accent"
                          ariaLabel={`${task.file.name} 上传进度 ${task.progress}%`}
                        />
                      ) : null}
                      {task.status === 'error' ? (
                        <div className="note-upload-error">
                          <span role="alert">{task.error ?? '上传失败'}</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              patchTask(task.id, { status: 'waiting', progress: 0, error: null })
                              pumpUploads()
                            }}
                          >
                            重试
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}

            {attachmentsLoading ? <p className="field-hint">正在读取附件…</p> : null}
            {attachmentsError ? (
              <InlineError
                message={attachmentsError}
                onRetry={note?.id ? () => void loadAttachments(note.id) : undefined}
              />
            ) : null}

            {attachments.length > 0 ? (
              <ul className="note-attachment-list">
                {attachments.map((attachment) => (
                  <li key={attachment.fileId} className="note-attachment-item">
                    {isInlineImage(attachment) ? (
                      <img
                        className="note-attachment-thumb"
                        src={attachment.url}
                        alt=""
                        loading="lazy"
                      />
                    ) : (
                      <span className="note-attachment-icon" aria-hidden="true">
                        <FileIcon name={attachment.name} mime={attachment.mime} size={18} />
                      </span>
                    )}
                    <span className="note-attachment-name" title={attachment.name}>{attachment.name}</span>
                    <span className="note-attachment-size">{formatBytes(attachment.size)}</span>
                    <div className="note-attachment-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          appendMarkdown(attachmentMarkdown(attachment))
                          toast.success('已插入 Markdown 引用')
                        }}
                      >
                        插入
                      </Button>
                      <CopyButton
                        value={attachmentUrlFor(attachment)}
                        label="复制链接"
                        ariaLabel={`复制附件链接 ${attachment.name}`}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-danger"
                        icon={<Trash2 size={15} aria-hidden="true" />}
                        loading={deletingFileId === attachment.fileId}
                        disabled={deletingFileId !== null}
                        aria-label={`删除附件 ${attachment.name}`}
                        onClick={() => setDeleteAttachmentTarget(attachment)}
                      >
                        删除
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : !attachmentsLoading && !attachmentsError && note?.id ? (
              <p className="field-hint">还没有附件；点击“添加附件”或把文件拖到此处。</p>
            ) : null}

            {pendingUploads > 0 ? (
              <p className="field-hint" role="status">正在上传 {pendingUploads} 个附件…</p>
            ) : null}
          </section>

          <input
            ref={attachmentInputRef}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => {
              const files = event.target.files ? Array.from(event.target.files) : []
              enqueueAttachments(files)
              event.target.value = ''
            }}
          />

          {historyOpen && note?.id ? (
            <section className="note-history" aria-label="历史版本">
              <header className="note-history-header">
                <h3 className="subsection-title">历史版本</h3>
                <div className="note-history-nav">
                  {previewVersion ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<ChevronLeft size={15} aria-hidden="true" />}
                      onClick={() => setPreviewVersion(null)}
                    >
                      返回列表
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void loadVersions(note.id)}
                    loading={versionsLoading}
                  >
                    刷新
                  </Button>
                </div>
              </header>

              {previewVersion ? (
                <div className="note-history-preview">
                  <div className="note-history-preview-head">
                    <strong>{previewVersion.title}</strong>
                    <span className="field-hint">
                      保存于 <RelativeTime ts={previewVersion.createdAt} /> · {formatDateTime(previewVersion.createdAt)}
                    </span>
                  </div>
                  <div className="note-history-preview-body">
                    {previewVersion.bodyMd.trim() ? (
                      <MarkdownView content={previewVersion.bodyMd} />
                    ) : (
                      <p className="muted">该版本正文为空。</p>
                    )}
                  </div>
                  {previewVersion.tags.length > 0 ? (
                    <div className="knowledge-tags">
                      {previewVersion.tags.map((tag) => (
                        <span key={tag} className="tag-chip">{tag}</span>
                      ))}
                    </div>
                  ) : null}
                  <div className="form-actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<RotateCcw size={15} aria-hidden="true" />}
                      onClick={() =>
                        setRestoreTarget({
                          id: previewVersion.id,
                          title: previewVersion.title,
                          createdAt: previewVersion.createdAt,
                        })
                      }
                    >
                      恢复到此版本
                    </Button>
                  </div>
                </div>
              ) : versionsLoading ? (
                <p className="field-hint">正在读取历史版本…</p>
              ) : versionsError ? (
                <InlineError message={versionsError} onRetry={() => void loadVersions(note.id)} />
              ) : versions.length > 0 ? (
                <ul className="note-version-list">
                  {versions.map((version) => (
                    <li key={version.id} className="note-version-item">
                      <span className="note-version-title" title={version.title}>{version.title}</span>
                      <span className="note-version-time">
                        <RelativeTime ts={version.createdAt} />
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={previewLoading && previewVersion === null}
                        onClick={() => void openVersionPreview(version)}
                      >
                        预览
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="field-hint">还没有历史版本；修改标题、正文或标签后会自动生成快照。</p>
              )}
              {previewError ? <p className="field-error" role="alert">{previewError}</p> : null}
            </section>
          ) : null}

          <div className="knowledge-meta-row">
            <FormField label="标签" htmlFor={tagsId} hint="逗号或空格分隔，最多 20 个。">
              <input
                id={tagsId}
                className="input"
                value={tagInput}
                onChange={(event) => setTagInput(event.target.value)}
                placeholder="工作, 备忘"
                disabled={busy}
              />
            </FormField>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={pinned}
                onChange={(event) => setPinned(event.target.checked)}
                disabled={busy}
              />
              <span>置顶</span>
            </label>
          </div>

          {error ? <p className="field-error" role="alert">{error}</p> : null}
        </form>
      </Modal>

      <ConfirmDialog
        open={discardOpen}
        title="放弃未保存的修改"
        message="当前笔记有未保存的标题、正文、标签或置顶修改，关闭后将丢失。"
        details="选择“继续编辑”可返回保存；只有确认放弃才会关闭编辑器。"
        confirmText="放弃修改"
        cancelText="继续编辑"
        onConfirm={() => {
          setDiscardOpen(false)
          onClose()
        }}
        onClose={() => setDiscardOpen(false)}
      />

      <ConfirmDialog
        open={restoreTarget !== null}
        title="恢复历史版本"
        message={restoreTarget ? `确定把当前笔记恢复到「${restoreTarget.title}」？` : ''}
        details="当前内容会先自动保存为新的历史版本，然后恢复所选版本；操作不可直接撤销。"
        confirmText="恢复此版本"
        loading={restoreBusy}
        onConfirm={() => void confirmRestore()}
        onClose={() => {
          if (!restoreBusy) setRestoreTarget(null)
        }}
      />

      <ConfirmDialog
        open={deleteAttachmentTarget !== null}
        title="删除附件"
        message={deleteAttachmentTarget ? `确定删除附件「${deleteAttachmentTarget.name}」？` : ''}
        details="附件会被彻底删除并释放配额，不进入回收站；旧版本或正文中对该附件的引用可能失效。"
        confirmText="删除附件"
        loading={deletingFileId !== null}
        onConfirm={() => {
          if (deleteAttachmentTarget) void handleDeleteAttachment(deleteAttachmentTarget)
        }}
        onClose={() => {
          if (!deletingFileId) setDeleteAttachmentTarget(null)
        }}
      />
    </>
  )
}
