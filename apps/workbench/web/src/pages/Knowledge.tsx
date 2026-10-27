import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Bookmark as BookmarkIcon,
  BookOpen,
  ExternalLink,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Trash,
  X,
} from 'lucide-react'
import { api, isAbortError, toErrorMessage } from '../api/client'
import type { Bookmark, Note, TagCount } from '../api/types'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { usePageTitle } from '../hooks/usePageTitle'
import { PageHeader } from '../components/PageHeader'
import { Button } from '../components/Button'
import { Badge } from '../components/Badge'
import { EmptyState } from '../components/EmptyState'
import { InlineError } from '../components/InlineError'
import { RelativeTime } from '../components/RelativeTime'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useToast } from '../components/Toast'
import { NoteEditor } from '../components/knowledge/NoteEditor'
import { BookmarkEditor } from '../components/knowledge/BookmarkEditor'
import { cx } from '../lib/classnames'

const PAGE_SIZE = 20

type KnowledgeTab = 'notes' | 'bookmarks'

interface DeleteTarget {
  kind: KnowledgeTab
  id: string
  title: string
}

function plainExcerpt(markdown: string, max = 180): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 知识库：笔记与书签的搜索、标签筛选、置顶与增删改。 */
export function Knowledge() {
  usePageTitle('知识库')
  const toast = useToast()
  const [tab, setTab] = useState<KnowledgeTab>('notes')
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebouncedValue(query.trim(), 300)
  const [tag, setTag] = useState('')
  const [pinnedOnly, setPinnedOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [notes, setNotes] = useState<Note[]>([])
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [total, setTotal] = useState(0)
  const [tags, setTags] = useState<TagCount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [noteEditorOpen, setNoteEditorOpen] = useState(false)
  const [editingNote, setEditingNote] = useState<Note | null>(null)
  const [bookmarkEditorOpen, setBookmarkEditorOpen] = useState(false)
  const [editingBookmark, setEditingBookmark] = useState<Bookmark | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
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
      const queryParams = {
        q: debouncedQuery || undefined,
        tag: tag || undefined,
        pinned: pinnedOnly ? true : undefined,
        page,
        pageSize: PAGE_SIZE,
      }
      if (tab === 'notes') {
        const result = await api.notes.list(queryParams, controller.signal)
        if (requestId !== requestIdRef.current) return
        setNotes(result.items)
        setTotal(result.total)
      } else {
        const result = await api.bookmarks.list(queryParams, controller.signal)
        if (requestId !== requestIdRef.current) return
        setBookmarks(result.items)
        setTotal(result.total)
      }
    } catch (loadError) {
      if (isAbortError(loadError) || requestId !== requestIdRef.current) return
      setError(toErrorMessage(loadError, '加载知识库失败'))
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [tab, debouncedQuery, tag, pinnedOnly, page])

  const loadTags = useCallback(async (): Promise<void> => {
    try {
      const result = tab === 'notes' ? await api.notes.tags() : await api.bookmarks.tags()
      setTags(Array.isArray(result.items) ? result.items : [])
    } catch {
      // 标签是辅助信息，读取失败不阻塞列表
    }
  }, [tab])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void loadTags()
  }, [loadTags])

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  useEffect(() => {
    setPage(1)
  }, [tab, debouncedQuery, tag, pinnedOnly])

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    await Promise.allSettled([load(), loadTags()])
    setRefreshing(false)
  }

  const changeTab = (next: KnowledgeTab): void => {
    setTab(next)
    setTag('')
    setQuery('')
    setPinnedOnly(false)
    setPage(1)
  }

  const openCreate = (): void => {
    if (tab === 'notes') {
      setEditingNote(null)
      setNoteEditorOpen(true)
    } else {
      setEditingBookmark(null)
      setBookmarkEditorOpen(true)
    }
  }

  const openEditNote = (note: Note): void => {
    setEditingNote(note)
    setNoteEditorOpen(true)
  }

  const openEditBookmark = (bookmark: Bookmark): void => {
    setEditingBookmark(bookmark)
    setBookmarkEditorOpen(true)
  }

  const handleNoteSaved = (saved: Note): void => {
    setNoteEditorOpen(false)
    setEditingNote(null)
    toast.success(`笔记「${saved.title}」已保存`)
    void refresh()
  }

  const handleBookmarkSaved = (saved: Bookmark): void => {
    setBookmarkEditorOpen(false)
    setEditingBookmark(null)
    toast.success(`书签「${saved.title}」已保存`)
    void refresh()
  }

  const togglePinned = async (kind: KnowledgeTab, id: string, pinned: boolean): Promise<void> => {
    try {
      if (kind === 'notes') {
        const updated = await api.notes.update(id, { pinned })
        setNotes((previous) => previous.map((note) => (note.id === id ? updated : note)))
      } else {
        const updated = await api.bookmarks.update(id, { pinned })
        setBookmarks((previous) => previous.map((bookmark) => (bookmark.id === id ? updated : bookmark)))
      }
      toast.success(pinned ? '已置顶' : '已取消置顶')
      void loadTags()
    } catch (pinError) {
      toast.error(toErrorMessage(pinError, '更新置顶状态失败'))
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return
    setDeleteBusy(true)
    try {
      if (deleteTarget.kind === 'notes') await api.notes.remove(deleteTarget.id)
      else await api.bookmarks.remove(deleteTarget.id)
      toast.success('已删除')
      setDeleteTarget(null)
      await refresh()
    } catch (deleteError) {
      toast.error(toErrorMessage(deleteError, '删除失败，请重试'))
    } finally {
      setDeleteBusy(false)
    }
  }

  const currentTags = tab === 'notes' ? notes : bookmarks
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // 删除/数据收缩后回收越界页码。
  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])
  const hasFilters = Boolean(debouncedQuery || tag || pinnedOnly)

  const clearFilters = (): void => {
    setQuery('')
    setTag('')
    setPinnedOnly(false)
    setPage(1)
  }

  return (
    <div className="knowledge-page">
      <PageHeader
        title="知识库"
        description={loading && currentTags.length === 0 ? '正在加载…' : `共 ${total} 条${tab === 'notes' ? '笔记' : '书签'}`}
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
            <Button variant="primary" icon={<Plus size={16} aria-hidden="true" />} onClick={openCreate}>
              {tab === 'notes' ? '新建笔记' : '新建书签'}
            </Button>
          </>
        }
      />

      <div className="knowledge-tabs" role="tablist" aria-label="知识库类型">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'notes'}
          className={cx('knowledge-tab', tab === 'notes' && 'knowledge-tab-active')}
          onClick={() => changeTab('notes')}
        >
          <BookOpen size={16} aria-hidden="true" />
          笔记
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'bookmarks'}
          className={cx('knowledge-tab', tab === 'bookmarks' && 'knowledge-tab-active')}
          onClick={() => changeTab('bookmarks')}
        >
          <BookmarkIcon size={16} aria-hidden="true" />
          书签
        </button>
      </div>

      <section className="knowledge-toolbar" aria-label="知识库筛选">
        <div className="search-field">
          <Search size={16} className="search-icon" aria-hidden="true" />
          <input
            type="search"
            className="search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tab === 'notes' ? '全文搜索笔记…' : '搜索书签…'}
            aria-label={tab === 'notes' ? '全文搜索笔记' : '搜索书签'}
          />
          {query ? (
            <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="清除搜索">
              <X size={15} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <Button
          variant={pinnedOnly ? 'primary' : 'secondary'}
          size="sm"
          icon={<Pin size={15} aria-hidden="true" />}
          aria-pressed={pinnedOnly}
          onClick={() => setPinnedOnly((value) => !value)}
        >
          仅看置顶
        </Button>
        {hasFilters ? (
          <Button variant="ghost" size="sm" onClick={clearFilters}>清除筛选</Button>
        ) : null}
      </section>

      {tags.length > 0 ? (
        <div className="knowledge-tag-filter" aria-label="标签筛选">
          <button
            type="button"
            className={cx('tag-chip', !tag && 'tag-chip-active')}
            onClick={() => setTag('')}
            aria-pressed={!tag}
          >
            全部标签
          </button>
          {tags.map((item) => (
            <button
              key={item.name}
              type="button"
              className={cx('tag-chip', tag === item.name && 'tag-chip-active')}
              onClick={() => setTag(tag === item.name ? '' : item.name)}
              aria-pressed={tag === item.name}
            >
              {item.name}
              <span className="tag-count">{item.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {error ? <InlineError message={error} onRetry={() => void load()} className="page-inline-error" /> : null}

      {loading && currentTags.length === 0 ? (
        <div className="knowledge-skeleton" aria-hidden="true">
          {Array.from({ length: 3 }, (_, index) => (
            <div className="knowledge-card knowledge-skeleton-card" key={index} />
          ))}
        </div>
      ) : currentTags.length === 0 ? (
        <EmptyState
          icon={tab === 'notes' ? <BookOpen size={24} /> : <BookmarkIcon size={24} />}
          title={hasFilters ? '没有匹配的内容' : tab === 'notes' ? '还没有笔记' : '还没有书签'}
          description={
            hasFilters
              ? '换个关键词或清除筛选后再试。'
              : tab === 'notes'
                ? '用 Markdown 记录想法、配置与待办。'
                : '收藏常用链接，避免在浏览器书签里翻找。'
          }
          action={
            hasFilters ? (
              <Button variant="secondary" onClick={clearFilters}>清除筛选</Button>
            ) : (
              <Button variant="primary" icon={<Plus size={16} aria-hidden="true" />} onClick={openCreate}>
                {tab === 'notes' ? '新建笔记' : '新建书签'}
              </Button>
            )
          }
        />
      ) : (
        <div className="knowledge-list">
          {tab === 'notes'
            ? notes.map((note) => (
                <article className="knowledge-card" key={note.id}>
                  <header className="knowledge-card-header">
                    <button type="button" className="knowledge-card-title" onClick={() => openEditNote(note)}>
                      {note.title}
                    </button>
                    {note.pinned ? (
                      <Badge tone="accent"><Pin size={11} aria-hidden="true" />置顶</Badge>
                    ) : null}
                  </header>
                  {note.bodyMd ? <p className="knowledge-card-excerpt">{plainExcerpt(note.bodyMd)}</p> : null}
                  <div className="knowledge-card-footer">
                    <div className="knowledge-tags">
                      {note.tags.map((item) => (
                        <button key={item} type="button" className="tag-chip" onClick={() => setTag(item)}>
                          {item}
                        </button>
                      ))}
                    </div>
                    <span className="knowledge-updated">
                      更新于 <RelativeTime ts={note.updatedAt} />
                    </span>
                    <div className="knowledge-actions">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={note.pinned ? `取消置顶 ${note.title}` : `置顶 ${note.title}`}
                        title={note.pinned ? '取消置顶' : '置顶'}
                        icon={note.pinned ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />}
                        onClick={() => void togglePinned('notes', note.id, !note.pinned)}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`编辑 ${note.title}`}
                        title="编辑"
                        icon={<Pencil size={16} aria-hidden="true" />}
                        onClick={() => openEditNote(note)}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`删除 ${note.title}`}
                        title="删除"
                        icon={<Trash size={16} aria-hidden="true" />}
                        onClick={() => setDeleteTarget({ kind: 'notes', id: note.id, title: note.title })}
                      />
                    </div>
                  </div>
                </article>
              ))
            : bookmarks.map((bookmark) => (
                <article className="knowledge-card" key={bookmark.id}>
                  <header className="knowledge-card-header">
                    <a
                      className="knowledge-card-title"
                      href={bookmark.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {bookmark.title}
                      <ExternalLink size={13} aria-hidden="true" />
                    </a>
                    {bookmark.pinned ? (
                      <Badge tone="accent"><Pin size={11} aria-hidden="true" />置顶</Badge>
                    ) : null}
                  </header>
                  <p className="knowledge-card-url mono">{bookmark.url}</p>
                  {bookmark.description ? <p className="knowledge-card-excerpt">{bookmark.description}</p> : null}
                  <div className="knowledge-card-footer">
                    <div className="knowledge-tags">
                      {bookmark.tags.map((item) => (
                        <button key={item} type="button" className="tag-chip" onClick={() => setTag(item)}>
                          {item}
                        </button>
                      ))}
                    </div>
                    <span className="knowledge-updated">
                      更新于 <RelativeTime ts={bookmark.updatedAt} />
                    </span>
                    <div className="knowledge-actions">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={bookmark.pinned ? `取消置顶 ${bookmark.title}` : `置顶 ${bookmark.title}`}
                        title={bookmark.pinned ? '取消置顶' : '置顶'}
                        icon={bookmark.pinned ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />}
                        onClick={() => void togglePinned('bookmarks', bookmark.id, !bookmark.pinned)}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`编辑 ${bookmark.title}`}
                        title="编辑"
                        icon={<Pencil size={16} aria-hidden="true" />}
                        onClick={() => openEditBookmark(bookmark)}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`删除 ${bookmark.title}`}
                        title="删除"
                        icon={<Trash size={16} aria-hidden="true" />}
                        onClick={() => setDeleteTarget({ kind: 'bookmarks', id: bookmark.id, title: bookmark.title })}
                      />
                    </div>
                  </div>
                </article>
              ))}
        </div>
      )}

      {total > PAGE_SIZE ? (
        <div className="pager">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
            上一页
          </Button>
          <span className="pager-info">第 {page} / {totalPages} 页 · 共 {total} 条</span>
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

      <NoteEditor
        open={noteEditorOpen}
        note={editingNote}
        onClose={() => {
          setNoteEditorOpen(false)
          setEditingNote(null)
        }}
        onSaved={handleNoteSaved}
        onRestored={() => {
          // 恢复后编辑器保持打开；后台刷新列表摘要与标签
          void refresh()
        }}
      />

      <BookmarkEditor
        open={bookmarkEditorOpen}
        bookmark={editingBookmark}
        onClose={() => {
          setBookmarkEditorOpen(false)
          setEditingBookmark(null)
        }}
        onSaved={handleBookmarkSaved}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除"
        message={deleteTarget ? `确定删除「${deleteTarget.title}」？` : ''}
        details="删除后无法恢复。"
        confirmText="删除"
        loading={deleteBusy}
        onConfirm={() => void confirmDelete()}
        onClose={() => {
          if (!deleteBusy) setDeleteTarget(null)
        }}
      />
    </div>
  )
}
