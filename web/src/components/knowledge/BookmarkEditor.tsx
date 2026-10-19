// 书签编辑器：URL、标题、描述、标签与置顶。

import { useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'
import { api, toErrorMessage } from '../../api/client'
import type { Bookmark } from '../../api/types'
import { Modal } from '../Modal'
import { Button } from '../Button'
import { FormField } from '../FormField'

export interface BookmarkEditorProps {
  open: boolean
  bookmark: Bookmark | null
  onClose: () => void
  onSaved: (bookmark: Bookmark) => void
}

function parseTags(raw: string): string[] {
  return raw
    .split(/[,，\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 20)
}

function normalizeUrl(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  return `https://${value}`
}

export function BookmarkEditor({ open, bookmark, onClose, onSaved }: BookmarkEditorProps) {
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [pinned, setPinned] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const formId = useId()
  const urlId = useId()
  const titleId = useId()
  const descriptionId = useId()
  const tagsId = useId()

  useEffect(() => {
    if (!open) return
    setUrl(bookmark?.url ?? '')
    setTitle(bookmark?.title ?? '')
    setDescription(bookmark?.description ?? '')
    setTagInput(bookmark ? bookmark.tags.join(', ') : '')
    setPinned(bookmark?.pinned ?? false)
    setBusy(false)
    setError(null)
  }, [open, bookmark])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const normalizedUrl = normalizeUrl(url)
    if (!normalizedUrl) {
      setError('请输入链接')
      return
    }
    try {
      const parsed = new URL(normalizedUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol')
    } catch {
      setError('链接格式不合法，仅支持 http/https')
      return
    }
    if (!title.trim()) {
      setError('标题不能为空')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const payload = {
        url: normalizedUrl,
        title: title.trim(),
        description: description.trim(),
        tags: parseTags(tagInput),
        pinned,
      }
      const saved = bookmark ? await api.bookmarks.update(bookmark.id, payload) : await api.bookmarks.create(payload)
      onSaved(saved)
    } catch (saveError) {
      setError(toErrorMessage(saveError, '保存书签失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title={bookmark ? '编辑书签' : '新建书签'}
      size="md"
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
        <FormField label="链接" htmlFor={urlId} required>
          <input
            id={urlId}
            className="input"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com"
            inputMode="url"
            data-autofocus
            disabled={busy}
          />
        </FormField>
        <FormField label="标题" htmlFor={titleId} required>
          <input
            id={titleId}
            className="input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            disabled={busy}
          />
        </FormField>
        <FormField label="描述" htmlFor={descriptionId}>
          <textarea
            id={descriptionId}
            className="input knowledge-textarea knowledge-textarea-sm"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            maxLength={2000}
            disabled={busy}
          />
        </FormField>
        <div className="knowledge-meta-row">
          <FormField label="标签" htmlFor={tagsId} hint="逗号或空格分隔，最多 20 个。">
            <input
              id={tagsId}
              className="input"
              value={tagInput}
              onChange={(event) => setTagInput(event.target.value)}
              placeholder="工具, 文档"
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
