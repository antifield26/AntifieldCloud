import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { FolderOpen, RefreshCw, RotateCcw, Trash as TrashIcon, Trash2 } from 'lucide-react'
import { api, isAbortError, toErrorMessage } from '../api/client'
import { useAppMeta } from '../meta/MetaContext'
import type { FileItem, TrashListResult } from '../api/types'
import { PageHeader } from '../components/PageHeader'
import { Button } from '../components/Button'
import { Table } from '../components/Table'
import type { Column } from '../components/Table'
import { EmptyState } from '../components/EmptyState'
import { InlineError } from '../components/InlineError'
import { RelativeTime } from '../components/RelativeTime'
import { FileIcon } from '../components/FileIcon'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useToast } from '../components/Toast'
import { formatBytes } from '../lib/format'

const TRASH_PAGE_SIZE = 200

/** 回收站：恢复、彻底删除与清空；提示内容仍占用配额。 */
export function Trash() {
  const toast = useToast()
  const { meta } = useAppMeta()
  const [data, setData] = useState<TrashListResult | null>(null)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<FileItem | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const [clearBusy, setClearBusy] = useState(false)
  const requestIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async (): Promise<void> => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setLoading(true)
    setError(null)
    try {
      const result = await api.trash.list(page, TRASH_PAGE_SIZE, controller.signal)
      if (requestId !== requestIdRef.current) return
      setData(result)
    } catch (loadError) {
      if (isAbortError(loadError) || requestId !== requestIdRef.current) return
      setError(toErrorMessage(loadError, '加载回收站失败'))
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [page])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / TRASH_PAGE_SIZE))
  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const handleRestore = async (file: FileItem): Promise<void> => {
    setRestoringId(file.id)
    try {
      await api.trash.restore(file.id)
      toast.success(`已恢复「${file.name}」`)
      await load()
    } catch (restoreError) {
      toast.error(toErrorMessage(restoreError, '恢复失败，请重试'))
    } finally {
      setRestoringId(null)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return
    setDeleteBusy(true)
    try {
      const result = await api.trash.remove(deleteTarget.id)
      const freed = result.freedBytes ? `，释放 ${formatBytes(result.freedBytes)}` : ''
      toast.success(`已彻底删除「${deleteTarget.name}」${freed}`)
      setDeleteTarget(null)
      await load()
    } catch (deleteError) {
      toast.error(toErrorMessage(deleteError, '彻底删除失败，请重试'))
    } finally {
      setDeleteBusy(false)
    }
  }

  const confirmClear = async (): Promise<void> => {
    setClearBusy(true)
    try {
      const result = await api.trash.clear()
      const freed = result.freedBytes ? `，释放 ${formatBytes(result.freedBytes)}` : ''
      toast.success(`已清空回收站（${result.count} 项）${freed}`)
      setClearOpen(false)
      if (page === 1) await load()
      else setPage(1)
    } catch (clearError) {
      toast.error(toErrorMessage(clearError, '清空回收站失败，请重试'))
    } finally {
      setClearBusy(false)
    }
  }

  const columns: Column<FileItem>[] = [
    {
      key: 'name',
      header: '名称',
      primary: true,
      render: (file) => (
        <div className="file-name-cell">
          <FileIcon name={file.name} mime={file.mime} kind={file.kind} size={20} />
          <span className="file-name" title={file.name}>{file.name}</span>
        </div>
      ),
    },
    {
      key: 'path',
      header: '原路径',
      className: 'cell-path',
      render: (file) => <span className="mono path-text" title={file.originalPath ?? ''}>{file.originalPath ?? '—'}</span>,
    },
    {
      key: 'size',
      header: '大小',
      align: 'right',
      className: 'cell-size',
      render: (file) => (file.kind === 'dir' ? '—' : formatBytes(file.size)),
    },
    {
      key: 'deleted',
      header: '删除时间',
      className: 'cell-time',
      render: (file) => <RelativeTime ts={file.deletedAt} />,
    },
    {
      key: 'actions',
      header: <span className="sr-only">操作</span>,
      align: 'right',
      className: 'cell-actions',
      render: (file) => (
        <div className="row-actions">
          <Button
            size="sm"
            variant="secondary"
            icon={<RotateCcw size={15} aria-hidden="true" />}
            loading={restoringId === file.id}
            onClick={() => void handleRestore(file)}
          >
            恢复
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            icon={<Trash2 size={15} aria-hidden="true" />}
            aria-label={`彻底删除 ${file.name}`}
            onClick={() => setDeleteTarget(file)}
          >
            彻底删除
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="trash-page">
      <PageHeader
        title="回收站"
        description={
          data
            ? `共 ${data.total} 项 · 占用 ${formatBytes(data.trashBytes)}`
            : `已删除的文件会在这里保留 ${meta.trashRetentionDays} 天`
        }
        actions={
          <>
            <Button
              variant="secondary"
              icon={<RefreshCw size={16} aria-hidden="true" />}
              loading={refreshing}
              onClick={() => void refresh()}
            >
              刷新
            </Button>
            <Button
              variant="danger"
              icon={<TrashIcon size={16} aria-hidden="true" />}
              disabled={!data || data.total === 0}
              onClick={() => setClearOpen(true)}
            >
              清空回收站
            </Button>
          </>
        }
      />

      <div className="notice notice-info">
        回收站中的文件仍占用配额{data ? `（当前 ${formatBytes(data.trashBytes)}）` : ''}；
        {meta.trashRetentionDays} 天后自动清理。彻底删除会立即释放配额。
        {meta.trashRetentionFromServer ? null : '（保留天数未由服务端下发，按默认 30 天展示）'}
      </div>

      {error ? <InlineError message={error} onRetry={() => void load()} className="page-inline-error" /> : null}

      <section className="surface-panel" aria-label="回收站列表">
        <Table
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(file) => file.id}
          loading={loading}
          skeletonRows={5}
          caption="回收站文件列表"
          empty={
            <EmptyState
              icon={<FolderOpen size={24} />}
              title="回收站是空的"
              description={`删除的文件会保留在这里 ${meta.trashRetentionDays} 天，期间可随时恢复。`}
              action={
                <Link className="btn btn-secondary btn-md" to="/files">
                  <FolderOpen size={16} aria-hidden="true" />
                  <span className="btn-label">去文件页</span>
                </Link>
              }
            />
          }
        />

        {(data?.total ?? 0) > TRASH_PAGE_SIZE ? (
          <div className="pager">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
              上一页
            </Button>
            <span className="pager-info">第 {page} / {totalPages} 页</span>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
            >
              下一页
            </Button>
          </div>
        ) : null}
      </section>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="彻底删除"
        message={deleteTarget ? `确定彻底删除「${deleteTarget.name}」？` : ''}
        details="彻底删除后无法恢复，目录会连同全部内容一起删除，配额将立即释放。"
        confirmText="彻底删除"
        loading={deleteBusy}
        onConfirm={() => void confirmDelete()}
        onClose={() => {
          if (!deleteBusy) setDeleteTarget(null)
        }}
      />

      <ConfirmDialog
        open={clearOpen}
        title="清空回收站"
        message={`确定清空回收站中的 ${data?.total ?? 0} 项内容？`}
        details="所有内容都会被永久删除且无法恢复，配额会立即释放。"
        confirmText="清空回收站"
        loading={clearBusy}
        onConfirm={() => void confirmClear()}
        onClose={() => {
          if (!clearBusy) setClearOpen(false)
        }}
      />
    </div>
  )
}
