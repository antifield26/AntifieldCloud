import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight, Folder, LoaderCircle } from 'lucide-react'
import { api, toErrorMessage } from '../../api/client'
import type { FileItem } from '../../api/types'
import { Modal } from '../Modal'
import { Button } from '../Button'
import { InlineError } from '../InlineError'
import { cx } from '../../lib/classnames'

export interface MoveDialogProps {
  open: boolean
  file: FileItem | null
  parentId: string | null
  parentName: string
  onClose: () => void
  onMoved: () => void
}

interface SelectedTarget {
  id: string | null
  name: string
}

/**
 * 移动文件：懒加载目录树 + 目标选择。
 * 只做前端预校验（不得移入自身）；循环检测、重名等由服务端最终裁决。
 */
export function MoveDialog({ open, file, parentId, parentName, onClose, onMoved }: MoveDialogProps) {
  const [rootDirs, setRootDirs] = useState<FileItem[] | null>(null)
  const [rootExpanded, setRootExpanded] = useState(true)
  const [rootLoading, setRootLoading] = useState(false)
  const [rootError, setRootError] = useState<string | null>(null)
  const [children, setChildren] = useState<Record<string, FileItem[]>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [loadingIds, setLoadingIds] = useState<Record<string, boolean>>({})
  const [failedIds, setFailedIds] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<SelectedTarget>({ id: parentId, name: parentName })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadRoot = useCallback(async (): Promise<void> => {
    setRootLoading(true)
    setRootError(null)
    try {
      const result = await api.files.list({ parentId: null, pageSize: 500, sort: 'name', dir: 'asc' })
      setRootDirs(result.items.filter((item) => item.kind === 'dir'))
    } catch (loadError) {
      setRootError(toErrorMessage(loadError, '无法读取目录'))
    } finally {
      setRootLoading(false)
    }
  }, [])

  const loadChildren = useCallback(async (id: string): Promise<void> => {
    setLoadingIds((previous) => ({ ...previous, [id]: true }))
    setFailedIds((previous) => ({ ...previous, [id]: false }))
    try {
      const result = await api.files.list({ parentId: id, pageSize: 500, sort: 'name', dir: 'asc' })
      setChildren((previous) => ({ ...previous, [id]: result.items.filter((item) => item.kind === 'dir') }))
    } catch {
      setFailedIds((previous) => ({ ...previous, [id]: true }))
    } finally {
      setLoadingIds((previous) => ({ ...previous, [id]: false }))
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setRootDirs(null)
    setChildren({})
    setExpanded({})
    setLoadingIds({})
    setFailedIds({})
    setRootExpanded(true)
    setRootError(null)
    setSelected({ id: parentId, name: parentName })
    setBusy(false)
    setError(null)
    void loadRoot()
  }, [open, parentId, parentName, loadRoot])

  const toggleDir = (dir: FileItem): void => {
    const nextExpanded = !expanded[dir.id]
    setExpanded((previous) => ({ ...previous, [dir.id]: nextExpanded }))
    if (nextExpanded && !children[dir.id] && !loadingIds[dir.id]) void loadChildren(dir.id)
  }

  const choose = (target: SelectedTarget): void => {
    setSelected(target)
    setError(null)
  }

  const handleSubmit = async (): Promise<void> => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      await api.files.update(file.id, { parentId: selected.id })
      onMoved()
    } catch (moveError) {
      setError(toErrorMessage(moveError, '移动失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  const excludedId = file && file.kind === 'dir' ? file.id : null
  const unchanged = file !== null && selected.id === file.parentId

  const renderDirList = (parent: string | null, depth: number): ReactNode => {
    const list = parent === null ? rootDirs : children[parent]
    if (!list) return null
    return list
      .filter((dir) => dir.id !== excludedId)
      .map((dir) => {
        const isExpanded = Boolean(expanded[dir.id])
        const isLoading = Boolean(loadingIds[dir.id])
        const isFailed = Boolean(failedIds[dir.id])
        const isSelected = selected.id === dir.id
        return (
          <div key={dir.id}>
            <div className={cx('tree-row', isSelected && 'tree-row-selected')} style={{ paddingLeft: `${8 + depth * 18}px` }}>
              <button
                type="button"
                className="tree-toggle"
                onClick={() => toggleDir(dir)}
                aria-label={isExpanded ? `折叠 ${dir.name}` : `展开 ${dir.name}`}
              >
                {isExpanded ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
              </button>
              <button
                type="button"
                className="tree-label"
                onClick={() => choose({ id: dir.id, name: dir.name })}
                aria-pressed={isSelected}
              >
                <Folder size={16} className="tree-folder-icon" aria-hidden="true" />
                <span className="tree-name">{dir.name}</span>
              </button>
              {isLoading ? <LoaderCircle size={14} className="spin tree-spinner" aria-hidden="true" /> : null}
              {isFailed ? <span className="tree-failed">加载失败</span> : null}
            </div>
            {isExpanded ? renderDirList(dir.id, depth + 1) : null}
          </div>
        )
      })
  }

  return (
    <Modal
      open={open}
      title="移动"
      description={file ? `将「${file.name}」移动到其他文件夹` : undefined}
      size="md"
      onClose={busy ? () => undefined : onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>取消</Button>
          <Button variant="primary" onClick={() => void handleSubmit()} loading={busy} disabled={unchanged}>
            {unchanged ? '已在该文件夹中' : '移动到此处'}
          </Button>
        </>
      }
    >
      {error ? <InlineError message={error} /> : null}
      <p className="move-target-hint">
        目标文件夹：<strong>{selected.name}</strong>
      </p>
      <div className="dir-tree" role="group" aria-label="目录树">
        <div className={cx('tree-row', selected.id === null && 'tree-row-selected')} style={{ paddingLeft: '8px' }}>
          <button
            type="button"
            className="tree-toggle"
            onClick={() => {
              const nextExpanded = !rootExpanded
              setRootExpanded(nextExpanded)
              if (nextExpanded && rootDirs === null && !rootLoading) void loadRoot()
            }}
            aria-label={rootExpanded ? '折叠全部文件' : '展开全部文件'}
          >
            {rootExpanded ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="tree-label"
            onClick={() => choose({ id: null, name: '全部文件' })}
            aria-pressed={selected.id === null}
          >
            <Folder size={16} className="tree-folder-icon" aria-hidden="true" />
            <span className="tree-name">全部文件</span>
          </button>
          {rootLoading ? <LoaderCircle size={14} className="spin tree-spinner" aria-hidden="true" /> : null}
        </div>

        {rootExpanded ? (
          rootError ? (
            <InlineError message={rootError} onRetry={() => void loadRoot()} className="tree-inline-error" />
          ) : (
            <>
              {renderDirList(null, 1)}
              {rootDirs !== null && rootDirs.length === 0 ? (
                <p className="muted tree-empty">根目录下暂无子文件夹</p>
              ) : null}
            </>
          )
        ) : null}
      </div>
      {file && file.kind === 'dir' ? (
        <p className="field-hint">不能把文件夹移动到自身或其子目录，服务端会再次校验。</p>
      ) : null}
    </Modal>
  )
}
