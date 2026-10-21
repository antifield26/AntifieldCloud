import { useEffect, useId, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import { api, isAbortError, toErrorMessage } from '../../api/client'
import type { FileItem } from '../../api/types'
import { Button } from '../Button'
import { EmptyState } from '../EmptyState'
import { FormField } from '../FormField'
import { Modal } from '../Modal'
import { SkeletonText } from '../Skeleton'
import { formatBytes } from '../../lib/format'

const MEDIA_MAX_BYTES = 10 * 1024 * 1024

interface BotMediaPickerProps {
  open: boolean
  onClose: () => void
  onSelect: (file: FileItem) => void
  selectedIds: readonly string[]
  maxFiles: number
}

/**
 * 发布媒体选择器：从云端普通文件中选择 ≤5 个、单个 ≤10 MiB 文件。
 * 只读列表/搜索，不读取文件内容；不改变文件，也不提供外部 URL。
 */
export function BotMediaPicker({ open, onClose, onSelect, selectedIds, maxFiles }: BotMediaPickerProps) {
  const searchId = useId()
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<FileItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestSeq = useRef(0)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (!open) return
    const seq = ++requestSeq.current
    setLoading(true)
    setError(null)
    const run = async () => {
      try {
        const result = query.trim()
          ? await api.files.search(query.trim())
          : await api.files.list({ pageSize: 100 })
        if (requestSeq.current !== seq) return
        setItems(result.items.filter((item) => item.kind === 'file' && item.size <= MEDIA_MAX_BYTES))
      } catch (loadError) {
        if (requestSeq.current !== seq || isAbortError(loadError)) return
        setError(toErrorMessage(loadError, '加载文件列表失败，请稍后重试'))
      } finally {
        if (requestSeq.current === seq) setLoading(false)
      }
    }
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void run(), query ? 250 : 0)
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [open, query])

  return (
    <Modal open={open} title="选择发布媒体" onClose={onClose}>
      <p className="bot-picker-hint">
        仅显示云端普通文件，单个大小 ≤ {formatBytes(MEDIA_MAX_BYTES)}，最多选择 {maxFiles} 个（已选 {selectedIds.length}）；
        发布后会外发到平台。
      </p>
      <FormField label="搜索文件" htmlFor={searchId} hint="按名称搜索；留空显示根目录最近文件。">
        <input
          id={searchId}
          className="input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="输入文件名…"
          autoComplete="off"
        />
      </FormField>
      <div className="bot-picker-list" role="listbox" aria-label="可发布文件">
        {loading ? <SkeletonText lines={4} /> : null}
        {error ? (
          <p className="field-error" role="alert">{error}</p>
        ) : null}
        {!loading && !error && items.length === 0 ? (
          <EmptyState title="没有可发布文件" description="请先在文件页上传 ≤10 MiB 的普通文件。" />
        ) : null}
        {!loading && !error
          ? items.map((file) => {
              const selected = selectedIds.includes(file.id)
              const full = selectedIds.length >= maxFiles && !selected
              return (
                <div className="bot-picker-item" role="option" aria-selected={selected} key={file.id}>
                  <FileText size={18} aria-hidden="true" />
                  <div className="bot-picker-meta">
                    <strong title={file.name}>{file.name}</strong>
                    <span>{formatBytes(file.size)}</span>
                  </div>
                  <Button
                    variant={selected ? 'ghost' : 'secondary'}
                    size="sm"
                    disabled={full}
                    onClick={() => {
                      onSelect(file)
                    }}
                  >
                    {selected ? '已选' : full ? '已达上限' : '选择'}
                  </Button>
                </div>
              )
            })
          : null}
      </div>
      <div className="form-actions">
        <Button variant="secondary" onClick={onClose}>取消</Button>
      </div>
    </Modal>
  )
}
