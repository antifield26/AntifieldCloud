import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Camera,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FolderOpen,
  FolderPlus,
  LayoutGrid,
  LayoutList,
  RefreshCw,
  Search,
  Share2,
  Upload,
  X,
} from 'lucide-react'
import { api, isAbortError, toErrorMessage } from '../api/client'
import { useAppMeta } from '../meta/MetaContext'
import type {
  BreadcrumbItem,
  FileItem,
  FileSearchResult,
  FileSortDirection,
  FileSortField,
  StorageInfo,
} from '../api/types'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useUploadQueue } from '../hooks/useUploadQueue'
import { PageHeader } from '../components/PageHeader'
import { Button } from '../components/Button'
import { ProgressBar } from '../components/ProgressBar'
import { EmptyState } from '../components/EmptyState'
import { InlineError } from '../components/InlineError'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Table } from '../components/Table'
import type { Column } from '../components/Table'
import { Skeleton } from '../components/Skeleton'
import { RelativeTime } from '../components/RelativeTime'
import { FileIcon } from '../components/FileIcon'
import { useToast } from '../components/Toast'
import { FileRowActions } from '../components/files/FileRowActions'
import { FileThumb } from '../components/files/FileThumb'
import { NameDialog } from '../components/files/NameDialog'
import { MoveDialog } from '../components/files/MoveDialog'
import { PreviewModal } from '../components/files/PreviewModal'
import { ShareDialog } from '../components/files/ShareDialog'
import { UploadPanel } from '../components/files/UploadPanel'
import { formatBytes, formatPercent, percentOf } from '../lib/format'
import {
  areAllSelected,
  pruneSelection,
  selectedFiles,
  setAllSelected,
  toggleSelection,
} from '../lib/selection'
import { cx } from '../lib/classnames'

const LIST_PAGE_SIZE = 200
const VIEW_STORAGE_KEY = 'af-files-view'

type ViewMode = 'list' | 'grid'

interface SortHeaderProps {
  label: string
  field: FileSortField
  sort: FileSortField
  dir: FileSortDirection
  onSortChange: (field: FileSortField) => void
}

function SortHeader({ label, field, sort, dir, onSortChange }: SortHeaderProps) {
  const active = sort === field
  const icon = active ? (dir === 'asc' ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />) : null
  return (
    <button
      type="button"
      className={cx('sort-button', active && 'sort-button-active')}
      onClick={() => onSortChange(field)}
      aria-label={`按${label}排序${active ? (dir === 'asc' ? '（升序）' : '（降序）') : ''}`}
    >
      {label}
      {icon}
    </button>
  )
}

/** 搜索接口不接收排序参数，结果在前端按当前排序规则排列。 */
function sortFileList(list: FileItem[], field: FileSortField, direction: FileSortDirection): FileItem[] {
  const factor = direction === 'asc' ? 1 : -1
  return [...list].sort((left, right) => {
    let result: number
    if (field === 'name') result = left.name.localeCompare(right.name, 'zh-CN')
    else if (field === 'size') result = left.size - right.size
    else result = new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime()
    if (result === 0) result = left.name.localeCompare(right.name, 'zh-CN')
    return result * factor
  })
}

/** 文件页：目录浏览、搜索、上传队列、预览、重命名、移动与删除。 */
export function Files() {
  const toast = useToast()
  const { meta } = useAppMeta()
  const [searchParams, setSearchParams] = useSearchParams()
  const parentId = searchParams.get('parent')

  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<FileSortField>('name')
  const [dir, setDir] = useState<FileSortDirection>('asc')
  const [view, setView] = useState<ViewMode>(() => {
    try {
      return window.localStorage.getItem(VIEW_STORAGE_KEY) === 'grid' ? 'grid' : 'list'
    } catch {
      return 'list'
    }
  })

  const [items, setItems] = useState<FileItem[]>([])
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbItem[]>([{ id: null, name: '全部文件' }])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [quota, setQuota] = useState<StorageInfo | null>(null)

  const [searchInput, setSearchInput] = useState('')
  const debouncedSearch = useDebouncedValue(searchInput.trim(), 300)
  const searching = debouncedSearch.length > 0
  const [searchResult, setSearchResult] = useState<FileSearchResult | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchReloadKey, setSearchReloadKey] = useState(0)

  const [createOpen, setCreateOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<FileItem | null>(null)
  const [moveTarget, setMoveTarget] = useState<FileItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<FileItem | null>(null)
  const [previewTarget, setPreviewTarget] = useState<FileItem | null>(null)
  const [shareFiles, setShareFiles] = useState<FileItem[] | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const refreshTimerRef = useRef<number | undefined>(undefined)
  const listAbortRef = useRef<AbortController | null>(null)
  const searchAbortRef = useRef<AbortController | null>(null)
  const listRequestIdRef = useRef(0)
  const searchRequestIdRef = useRef(0)

  const loadQuota = useCallback(async (): Promise<void> => {
    try {
      // v0.4.0 轻量端点：避免为取配额触发 Dashboard 的 MC/opencode/systemctl 聚合
      const storage = await api.getStorage()
      setQuota(storage)
    } catch {
      // 配额只是辅助信息，读取失败不阻塞文件浏览
    }
  }, [])

  // 列表请求带 AbortController + requestId，快速切换目录时丢弃旧响应
  const loadList = useCallback(async (): Promise<void> => {
    listAbortRef.current?.abort()
    const controller = new AbortController()
    listAbortRef.current = controller
    const requestId = listRequestIdRef.current + 1
    listRequestIdRef.current = requestId
    setLoading(true)
    setError(null)
    try {
      const result = await api.files.list(
        { parentId, page, pageSize: LIST_PAGE_SIZE, sort, dir },
        controller.signal,
      )
      if (requestId !== listRequestIdRef.current) return
      setItems(result.items)
      setBreadcrumb(result.breadcrumb.length > 0 ? result.breadcrumb : [{ id: null, name: '全部文件' }])
      setTotal(result.total)
    } catch (loadError) {
      if (isAbortError(loadError) || requestId !== listRequestIdRef.current) return
      setError(toErrorMessage(loadError, '加载文件列表失败'))
    } finally {
      if (requestId === listRequestIdRef.current) setLoading(false)
    }
  }, [parentId, page, sort, dir])

  useEffect(() => {
    void loadList()
  }, [loadList])

  useEffect(() => {
    void loadQuota()
  }, [loadQuota])

  useEffect(() => {
    searchAbortRef.current?.abort()
    if (!searching) {
      setSearchResult(null)
      setSearchError(null)
      setSearchLoading(false)
      return
    }
    const controller = new AbortController()
    searchAbortRef.current = controller
    const requestId = searchRequestIdRef.current + 1
    searchRequestIdRef.current = requestId
    setSearchLoading(true)
    setSearchError(null)
    api.files
      .search(debouncedSearch, controller.signal)
      .then((result) => {
        if (requestId === searchRequestIdRef.current) setSearchResult(result)
      })
      .catch((searchFailure) => {
        if (isAbortError(searchFailure) || requestId !== searchRequestIdRef.current) return
        setSearchError(toErrorMessage(searchFailure, '搜索失败，请重试'))
      })
      .finally(() => {
        if (requestId === searchRequestIdRef.current) setSearchLoading(false)
      })
    return () => {
      controller.abort()
    }
  }, [debouncedSearch, searching, searchReloadKey])

  useEffect(() => {
    return () => {
      listAbortRef.current?.abort()
      searchAbortRef.current?.abort()
    }
  }, [])

  // 删除后当前页可能超出最大页数
  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE))
    if (page > totalPages) setPage(totalPages)
  }, [total, page])

  useEffect(() => () => window.clearTimeout(refreshTimerRef.current), [])

  const refreshAll = useCallback(async (): Promise<void> => {
    await Promise.allSettled([loadList(), loadQuota()])
    setSearchReloadKey((value) => value + 1)
  }, [loadList, loadQuota])

  const scheduleRefresh = useCallback((): void => {
    window.clearTimeout(refreshTimerRef.current)
    refreshTimerRef.current = window.setTimeout(() => {
      void refreshAll()
    }, 500)
  }, [refreshAll])

  const uploadQueue = useUploadQueue({
    maxFileBytes: meta.maxUploadBytes,
    chunkedUploadEnabled: meta.chunkedUploadEnabled,
    chunkThresholdBytes: meta.maxUploadBytes,
    chunkSizeBytes: meta.chunkSizeBytes > 0 ? meta.chunkSizeBytes : undefined,
    chunkMaxFileBytes: meta.chunkMaxFileBytes > 0 ? meta.chunkMaxFileBytes : undefined,
    onUploaded: scheduleRefresh,
    onFinished: (summary) => {
      if (summary.failed > 0) {
        toast.error(`上传结束：成功 ${summary.succeeded} 个，失败 ${summary.failed} 个`)
      } else if (summary.cancelled > 0) {
        toast.info(`上传结束：成功 ${summary.succeeded} 个，取消 ${summary.cancelled} 个`)
      } else if (summary.succeeded > 0) {
        toast.success(`已上传 ${summary.succeeded} 个文件`)
      }
    },
  })

  const enqueueFiles = useCallback(
    (files: File[]): void => {
      if (files.length === 0) return
      uploadQueue.enqueue(files, parentId)
    },
    [uploadQueue, parentId],
  )

  const clearSearch = (): void => {
    setSearchInput('')
    setSelectMode(false)
    setSelected([])
  }

  const navigateToParent = (id: string | null): void => {
    setPage(1)
    setSearchInput('')
    setSelectMode(false)
    setSelected([])
    if (id) setSearchParams({ parent: id })
    else setSearchParams({})
  }

  const changeView = (next: ViewMode): void => {
    setView(next)
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next)
    } catch {
      // 忽略隐私模式下不可写的情况
    }
  }

  const changeSort = (field: FileSortField): void => {
    if (sort === field) {
      setDir(dir === 'asc' ? 'desc' : 'asc')
    } else {
      setSort(field)
      setDir(field === 'name' ? 'asc' : 'desc')
    }
    setPage(1)
  }

  const openFile = (file: FileItem): void => {
    if (selectMode) {
      // 多选模式下点击文件切换选择；目录不参与分享，保持不响应
      if (file.kind === 'file') setSelected((previous) => toggleSelection(previous, file.id))
      return
    }
    if (file.kind === 'dir') {
      navigateToParent(file.id)
      return
    }
    setPreviewTarget(file)
  }

  const downloadFile = (file: FileItem): void => {
    const anchor = document.createElement('a')
    anchor.href = api.files.contentUrl(file.id, { download: true })
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  const handleCreateFolder = async (name: string): Promise<void> => {
    const created = await api.files.createFolder(parentId, name)
    setCreateOpen(false)
    toast.success(`已创建文件夹「${created.name}」`)
    await refreshAll()
  }

  const handleRename = async (name: string): Promise<void> => {
    if (!renameTarget) return
    const updated = await api.files.update(renameTarget.id, { name })
    setRenameTarget(null)
    toast.success(`已重命名为「${updated.name}」`)
    await refreshAll()
  }

  const handleMoveDone = (): void => {
    setMoveTarget(null)
    toast.success('已移动文件')
    void refreshAll()
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return
    setDeleteBusy(true)
    try {
      await api.files.remove(deleteTarget.id)
      toast.success(`已删除「${deleteTarget.name}」`)
      setDeleteTarget(null)
      await refreshAll()
    } catch (deleteError) {
      toast.error(toErrorMessage(deleteError, '删除失败，请重试'))
    } finally {
      setDeleteBusy(false)
    }
  }

  // 拖拽上传：进入/离开计数，避免子元素抖动
  const hasFiles = (event: DragEvent<HTMLElement>): boolean => Array.from(event.dataTransfer.types).includes('Files')
  const handleDragEnter = (event: DragEvent<HTMLDivElement>): void => {
    if (!hasFiles(event)) return
    event.preventDefault()
    dragDepth.current += 1
    setDragActive(true)
  }
  const handleDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }
  const handleDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragActive(false)
  }
  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragDepth.current = 0
    setDragActive(false)
    enqueueFiles(Array.from(event.dataTransfer.files))
  }

  const currentFolderName = breadcrumb[breadcrumb.length - 1]?.name ?? '全部文件'
  const displayed = searching ? sortFileList(searchResult?.items ?? [], sort, dir) : items
  const displayedTotal = searching ? (searchResult?.total ?? 0) : total
  const listBusy = searching ? searchLoading : loading
  const listError = searching ? searchError : error
  const totalPages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE))
  const quotaPercent = quota ? percentOf(quota.usedBytes, quota.quotaBytes) : 0

  // 多选分享：切换目录/进入搜索时退出多选，列表刷新后剔除已不可见的选择
  useEffect(() => {
    setSelectMode(false)
    setSelected([])
  }, [parentId, searching])

  useEffect(() => {
    setSelected((previous) => pruneSelection(previous, displayed))
  }, [items, searchResult, sort, dir])

  const selectedItems = selectedFiles(selected, displayed)
  const allSelected = areAllSelected(selected, displayed)

  const toggleSelectMode = (): void => {
    setSelectMode((previous) => {
      if (previous) setSelected([])
      return !previous
    })
  }

  const toggleSelectAll = (): void => {
    setSelected((previous) => setAllSelected(previous, displayed, !areAllSelected(previous, displayed)))
  }

  const openShareForSelection = (): void => {
    if (selectedItems.length === 0) return
    setShareFiles(selectedItems)
  }

  const selectionColumn: Column<FileItem> = {
    key: 'select',
    header: (
      <input
        type="checkbox"
        className="row-checkbox"
        checked={allSelected}
        onChange={toggleSelectAll}
        aria-label={allSelected ? '取消全选当前列表文件' : '全选当前列表文件'}
        title={allSelected ? '取消全选' : '全选'}
      />
    ),
    className: 'cell-select',
    render: (file) =>
      file.kind === 'file' ? (
        <input
          type="checkbox"
          className="row-checkbox"
          checked={selected.includes(file.id)}
          onChange={() => setSelected((previous) => toggleSelection(previous, file.id))}
          aria-label={`选择 ${file.name}`}
        />
      ) : (
        <span className="cell-select-placeholder" aria-hidden="true" />
      ),
  }

  const columns: Column<FileItem>[] = [
    ...(selectMode ? [selectionColumn] : []),
    {
      key: 'name',
      header: <SortHeader label="名称" field="name" sort={sort} dir={dir} onSortChange={changeSort} />,
      primary: true,
      render: (file) => (
        <button
          type="button"
          className="file-name-cell file-name-button"
          onClick={() => openFile(file)}
          aria-label={
            selectMode
              ? file.kind === 'file'
                ? `选择 ${file.name}`
                : `${file.name} 是目录，不能分享`
              : file.kind === 'dir'
                ? `打开文件夹 ${file.name}`
                : `预览 ${file.name}`
          }
          disabled={selectMode && file.kind === 'dir'}
        >
          <FileIcon name={file.name} mime={file.mime} kind={file.kind} size={20} />
          <div className="file-name-text">
            <span className="file-name" title={file.name}>{file.name}</span>
            {file.kind === 'file' && file.previewKind !== 'none' ? (
              <span className="file-preview-mark">可预览</span>
            ) : null}
          </div>
        </button>
      ),
    },
    {
      key: 'size',
      header: <SortHeader label="大小" field="size" sort={sort} dir={dir} onSortChange={changeSort} />,
      mobileHeader: '大小',
      align: 'right',
      className: 'cell-size',
      render: (file) => (file.kind === 'dir' ? '—' : formatBytes(file.size)),
    },
    {
      key: 'updated',
      header: <SortHeader label="修改时间" field="updated" sort={sort} dir={dir} onSortChange={changeSort} />,
      mobileHeader: '修改时间',
      className: 'cell-time',
      render: (file) => <RelativeTime ts={file.updatedAt} />,
    },
    {
      key: 'actions',
      header: <span className="sr-only">操作</span>,
      align: 'right',
      className: 'cell-actions',
      render: (file) => (
        <FileRowActions
          file={file}
          onPreview={() => setPreviewTarget(file)}
          onDownload={() => downloadFile(file)}
          onRename={() => setRenameTarget(file)}
          onMove={() => setMoveTarget(file)}
          onDelete={() => setDeleteTarget(file)}
          onShare={meta.sharesEnabled && file.kind === 'file' ? () => setShareFiles([file]) : undefined}
        />
      ),
    },
  ]

  const emptyState = searching ? (
    <EmptyState
      icon={<Search size={24} />}
      title="没有找到匹配的文件"
      description="换个关键词试试，或清除搜索回到当前目录。"
      action={<Button variant="secondary" onClick={clearSearch}>清除搜索</Button>}
    />
  ) : (
    <EmptyState
      icon={<FolderOpen size={24} />}
      title="这个文件夹还是空的"
      description="把文件拖到页面任意位置，或点击下方按钮上传；也可以先建一个文件夹。"
      action={
        <div className="empty-actions">
          <Button variant="primary" icon={<Upload size={16} />} onClick={() => fileInputRef.current?.click()}>
            上传文件
          </Button>
          <Button variant="secondary" icon={<FolderPlus size={16} />} onClick={() => setCreateOpen(true)}>
            新建文件夹
          </Button>
        </div>
      }
    />
  )

  return (
    <div
      className="files-page"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <PageHeader
        title="文件"
        description={quota ? `共 ${quota.fileCount} 个文件 · 回收站 ${formatBytes(quota.trashBytes)}` : '上传、预览与管理文件'}
        actions={
          selectMode ? (
            <Button
              variant="ghost"
              icon={<X size={16} aria-hidden="true" />}
              onClick={toggleSelectMode}
            >
              退出选择
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                icon={<CheckSquare size={16} aria-hidden="true" />}
                onClick={toggleSelectMode}
                disabled={displayed.length === 0}
                title="多选文件并创建分享"
              >
                选择文件
              </Button>
              <Button variant="secondary" icon={<FolderPlus size={16} />} onClick={() => setCreateOpen(true)}>
                新建文件夹
              </Button>
              <Button
                variant="secondary"
                icon={<Camera size={16} aria-hidden="true" />}
                onClick={() => cameraInputRef.current?.click()}
              >
                拍照上传
              </Button>
              <Button variant="primary" icon={<Upload size={16} />} onClick={() => fileInputRef.current?.click()}>
                上传文件
              </Button>
            </>
          )
        }
      />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          const files = event.target.files ? Array.from(event.target.files) : []
          enqueueFiles(files)
          event.target.value = ''
        }}
      />

      {/* 移动端拍照上传：accept=image/* + capture=environment 调起后置摄像头 */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          const files = event.target.files ? Array.from(event.target.files) : []
          enqueueFiles(files)
          event.target.value = ''
        }}
      />

      {quota ? (
        <section className="quota-bar" aria-label="存储配额">
          <div className="quota-bar-top">
            <span className="quota-bar-title">存储配额</span>
            <span className="quota-bar-numbers">
              已用 {formatBytes(quota.usedBytes)} / {formatBytes(quota.quotaBytes)} · 回收站 {formatBytes(quota.trashBytes)}
            </span>
          </div>
          <ProgressBar value={quotaPercent} tone="auto" ariaLabel="存储配额使用率" />
          <div className="quota-bar-hint">
            {quotaPercent >= 90
              ? '空间即将用尽，建议清理回收站或删除不再需要的文件。'
              : `已用 ${formatPercent(quotaPercent, 1)} · 剩余 ${formatBytes(quota.freeBytes)}`}
          </div>
        </section>
      ) : null}

      {selectMode ? (
        <div className="selection-bar" role="region" aria-label="多选分享操作">
          <span className="selection-count" role="status">
            已选 {selectedItems.length} 个文件
            {selectedItems.length > 0
              ? ` · ${formatBytes(selectedItems.reduce((sum, item) => sum + item.size, 0))}`
              : ''}
          </span>
          <div className="selection-actions">
            <Button variant="secondary" size="sm" onClick={toggleSelectAll} disabled={displayed.length === 0}>
              {allSelected ? '取消全选' : '全选'}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Share2 size={15} aria-hidden="true" />}
              disabled={selectedItems.length === 0 || selectedItems.length > meta.shareMaxItems}
              onClick={openShareForSelection}
              title={
                selectedItems.length > meta.shareMaxItems
                  ? `单次最多分享 ${meta.shareMaxItems} 个文件`
                  : undefined
              }
            >
              分享所选{selectedItems.length > 0 ? `（${selectedItems.length}）` : ''}
            </Button>
            <Button variant="ghost" size="sm" onClick={toggleSelectMode}>退出</Button>
          </div>
        </div>
      ) : null}

      <section className="files-panel" aria-label="文件列表">
        <div className="files-toolbar">
          <nav className="breadcrumb" aria-label="目录路径">
            {breadcrumb.map((crumb, index) => {
              const isLast = index === breadcrumb.length - 1
              return (
                <Fragment key={crumb.id ?? 'root'}>
                  {index > 0 ? <ChevronRight size={14} className="breadcrumb-sep" aria-hidden="true" /> : null}
                  {isLast ? (
                    <span className="breadcrumb-current" aria-current="page">{crumb.name}</span>
                  ) : (
                    <button type="button" className="breadcrumb-link" onClick={() => navigateToParent(crumb.id)}>
                      {crumb.name}
                    </button>
                  )}
                </Fragment>
              )
            })}
          </nav>

          <div className="files-toolbar-right">
            <div className="search-field">
              <Search size={16} className="search-icon" aria-hidden="true" />
              <input
                type="search"
                className="search-input"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="搜索文件名…"
                aria-label="搜索文件名"
              />
              {searchInput ? (
                <button type="button" className="search-clear" onClick={clearSearch} aria-label="清除搜索">
                  <X size={15} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="刷新文件列表"
              title="刷新"
              onClick={() => void loadList()}
              icon={<RefreshCw size={17} aria-hidden="true" />}
            />
            <div className="view-toggle" role="group" aria-label="视图切换">
              <button
                type="button"
                className={cx('view-toggle-button', view === 'list' && 'view-toggle-active')}
                onClick={() => changeView('list')}
                aria-label="列表视图"
                aria-pressed={view === 'list'}
              >
                <LayoutList size={17} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={cx('view-toggle-button', view === 'grid' && 'view-toggle-active')}
                onClick={() => changeView('grid')}
                aria-label="网格视图"
                aria-pressed={view === 'grid'}
              >
                <LayoutGrid size={17} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        {searching ? (
          <div className="search-summary">
            <span>
              “{debouncedSearch}”的搜索结果 · {displayedTotal} 项
            </span>
            <Button variant="ghost" size="sm" onClick={clearSearch}>清除搜索</Button>
          </div>
        ) : null}

        {listError ? (
          <div className="files-error">
            <InlineError message={listError} onRetry={() => void (searching ? setSearchReloadKey((value) => value + 1) : loadList())} />
          </div>
        ) : view === 'list' ? (
          <Table
            columns={columns}
            rows={displayed}
            rowKey={(file) => file.id}
            loading={listBusy}
            skeletonRows={6}
            empty={emptyState}
            caption="文件列表"
          />
        ) : !listBusy && displayed.length === 0 ? (
          <div className="files-empty">{emptyState}</div>
        ) : (
          <div className="files-grid">
            {listBusy
              ? Array.from({ length: 6 }, (_, index) => (
                  <div className="file-grid-card file-grid-skeleton" key={index} aria-hidden="true">
                    <Skeleton height={72} radius="10px" />
                    <Skeleton height={13} width="80%" />
                    <Skeleton height={11} width="55%" />
                  </div>
                ))
              : displayed.map((file) => (
                  <div
                    className={cx('file-grid-card', selected.includes(file.id) && 'file-grid-card-selected')}
                    key={file.id}
                  >
                    {selectMode ? (
                      <label className="file-grid-check">
                        <input
                          type="checkbox"
                          className="row-checkbox"
                          checked={selected.includes(file.id)}
                          disabled={file.kind !== 'file'}
                          onChange={() => {
                            if (file.kind === 'file') setSelected((previous) => toggleSelection(previous, file.id))
                          }}
                          aria-label={`选择 ${file.name}`}
                        />
                      </label>
                    ) : null}
                    <button
                      type="button"
                      className="file-grid-main"
                      onClick={() => openFile(file)}
                      disabled={selectMode && file.kind === 'dir'}
                      aria-label={
                        selectMode
                          ? file.kind === 'file'
                            ? `选择 ${file.name}`
                            : `${file.name} 是目录，不能分享`
                          : file.kind === 'dir'
                            ? `打开文件夹 ${file.name}`
                            : `预览 ${file.name}`
                      }
                    >
                      <FileThumb file={file} size={26} />
                      <span className="file-grid-name" title={file.name}>{file.name}</span>
                      <span className="file-grid-meta">
                        {file.kind === 'dir' ? '文件夹' : formatBytes(file.size)}
                        {' · '}
                        <RelativeTime ts={file.updatedAt} />
                      </span>
                    </button>
                    <div className="file-grid-actions">
                      <FileRowActions
                        file={file}
                        onPreview={() => setPreviewTarget(file)}
                        onDownload={() => downloadFile(file)}
                        onRename={() => setRenameTarget(file)}
                        onMove={() => setMoveTarget(file)}
                        onDelete={() => setDeleteTarget(file)}
                        onShare={meta.sharesEnabled && file.kind === 'file' ? () => setShareFiles([file]) : undefined}
                      />
                    </div>
                  </div>
                ))}
          </div>
        )}

        {!searching && total > LIST_PAGE_SIZE ? (
          <div className="pager">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
              上一页
            </Button>
            <span className="pager-info">第 {page} / {totalPages} 页 · 共 {total} 项</span>
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

      {dragActive ? (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-inner">
            <Upload size={30} />
            <strong>松开上传到当前目录</strong>
            <span>{currentFolderName}</span>
          </div>
        </div>
      ) : null}

      <UploadPanel
        tasks={uploadQueue.tasks}
        busy={uploadQueue.busy}
        onRetry={uploadQueue.retry}
        onCancel={uploadQueue.cancel}
        onDiscard={(id) => void uploadQueue.discard(id)}
        onClear={uploadQueue.clear}
      />

      <NameDialog
        open={createOpen}
        title="新建文件夹"
        label="文件夹名称"
        initialValue=""
        submitText="创建"
        placeholder="例如：文档"
        hint={`将在「${currentFolderName}」中创建`}
        onClose={() => setCreateOpen(false)}
        onSubmit={handleCreateFolder}
      />

      <NameDialog
        open={renameTarget !== null}
        title="重命名"
        label="新名称"
        initialValue={renameTarget?.name ?? ''}
        submitText="保存"
        onClose={() => setRenameTarget(null)}
        onSubmit={handleRename}
      />

      <MoveDialog
        open={moveTarget !== null}
        file={moveTarget}
        parentId={parentId}
        parentName={currentFolderName}
        onClose={() => setMoveTarget(null)}
        onMoved={handleMoveDone}
      />

      <PreviewModal file={previewTarget} onClose={() => setPreviewTarget(null)} />

      <ShareDialog
        files={shareFiles ?? undefined}
        onClose={() => setShareFiles(null)}
        onCreated={(created) => {
          const count = created.share.itemCount ?? shareFiles?.length ?? 1
          setSelectMode(false)
          setSelected([])
          toast.success(
            count > 1 ? `已创建 ${count} 个文件的分享链接` : `已创建「${created.share.fileName}」的分享链接`,
          )
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除"
        message={deleteTarget ? `确定删除${deleteTarget.kind === 'dir' ? '文件夹' : '文件'}「${deleteTarget.name}」？` : ''}
        details={
          deleteTarget?.kind === 'dir'
            ? '目录会连同全部内容移入回收站，可在回收站恢复。'
            : '文件会移入回收站，可在回收站恢复。'
        }
        confirmText="移入回收站"
        loading={deleteBusy}
        onConfirm={() => void confirmDelete()}
        onClose={() => {
          if (!deleteBusy) setDeleteTarget(null)
        }}
      />
    </div>
  )
}
