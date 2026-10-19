// 笔记编辑器：标题、Markdown 正文（编辑/预览切换）、标签与置顶。

import { useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'
import { Eye, Pencil } from 'lucide-react'
import { api, toErrorMessage } from '../../api/client'
import type { Note } from '../../api/types'
import { Modal } from '../Modal'
import { Button } from '../Button'
import { FormField } from '../FormField'
import { MarkdownView } from '../MarkdownView'
import { cx } from '../../lib/classnames'

export interface NoteEditorProps {
  open: boolean
  note: Note | null
  onClose: () => void
  onSaved: (note: Note) => void
}

const NOTE_TITLE_MAX = 200
const NOTE_BODY_MAX = 200_000

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

export function NoteEditor({ open, note, onClose, onSaved }: NoteEditorProps) {
  const [title, setTitle] = useState('')
  const [bodyMd, setBodyMd] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [pinned, setPinned] = useState(false)
  const [tab, setTab] = useState<'edit' | 'preview'>('edit')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const formId = useId()
  const titleId = useId()
  const bodyId = useId()
  const tagsId = useId()

  useEffect(() => {
    if (!open) return
    setTitle(note?.title ?? '')
    setBodyMd(note?.bodyMd ?? '')
    setTagInput(note ? joinTags(note.tags) : '')
    setPinned(note?.pinned ?? false)
    setTab('edit')
    setBusy(false)
    setError(null)
  }, [open, note])

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
    if (bodyMd.length > NOTE_BODY_MAX) {
      setError('正文超过 200 KB 限制')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const payload = { title: title.trim(), bodyMd, tags: parseTags(tagInput), pinned }
      const saved = note ? await api.notes.update(note.id, payload) : await api.notes.create(payload)
      onSaved(saved)
    } catch (saveError) {
      setError(toErrorMessage(saveError, '保存笔记失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title={note ? '编辑笔记' : '新建笔记'}
      description="Markdown 正文，支持标签、置顶与全文搜索。"
      size="xl"
      onClose={busy ? () => undefined : onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>取消</Button>
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
          <span className="field-hint">{bodyMd.length} 字符</span>
        </div>

        {tab === 'edit' ? (
          <label className="sr-only" htmlFor={bodyId}>Markdown 正文</label>
        ) : null}
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
  )
}
