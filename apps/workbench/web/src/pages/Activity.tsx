import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity as ActivityIcon, RefreshCw, Search, X } from 'lucide-react'
import { api, isAbortError, toErrorMessage } from '../api/client'
import type { AuditItem } from '../api/types'
import { auditActionMeta, AUDIT_ACTION_GROUPS, AUDIT_TIME_RANGES, auditTimeRangeFrom, auditTimeRangeLabel } from '../lib/audit'
import type { AuditCategory, AuditTimeRange } from '../lib/audit'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { usePageTitle } from '../hooks/usePageTitle'
import { PageHeader } from '../components/PageHeader'
import { Button } from '../components/Button'
import { Table } from '../components/Table'
import type { Column } from '../components/Table'
import { Badge } from '../components/Badge'
import type { BadgeTone } from '../components/Badge'
import { EmptyState } from '../components/EmptyState'
import { InlineError } from '../components/InlineError'
import { RelativeTime } from '../components/RelativeTime'
import { formatDateTime, truncateText } from '../lib/format'

const PAGE_SIZE = 50

const CATEGORY_TONES: Record<AuditCategory, BadgeTone> = {
  auth: 'accent',
  file: 'muted',
  share: 'info',
  whitelist: 'success',
  knowledge: 'accent',
  alert: 'warning',
  backup: 'warning',
  chatbot: 'info',
  other: 'muted',
}

const ACTION_LABELS = new Map<string, string>(
  AUDIT_ACTION_GROUPS.flatMap((group) => group.options.map((option) => [option.value, option.label])),
)

/** 审计详情是结构化对象，转成单行文本展示，不直接渲染对象。 */
function auditDetailText(detail: Record<string, unknown> | null): string {
  if (!detail) return ''
  try {
    const text = JSON.stringify(detail)
    return text === '{}' ? '' : text
  } catch {
    return ''
  }
}

/**
 * 活动：审计列表 + 服务端动作精确筛选 + 关键词/时间范围筛选 + 服务端分页。
 * `action` 精确匹配、`q` 对 action/target/ip 做 LIKE、`from/to` 为 ISO 时间，均由服务端执行，
 * 避免一次拉取大量记录后在本地筛选。默认视图（无任何筛选）与旧版一致。
 */
export function Activity() {
  usePageTitle('活动')
  const [items, setItems] = useState<AuditItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [action, setAction] = useState('')
  const [query, setQuery] = useState('')
  const [timeRange, setTimeRange] = useState<AuditTimeRange>('all')
  const debouncedQuery = useDebouncedValue(query.trim(), 300)
  const [page, setPage] = useState(1)
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
      const result = await api.getAuditPage(
        {
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
          action: action || undefined,
          q: debouncedQuery || undefined,
          from: auditTimeRangeFrom(timeRange) ?? undefined,
        },
        controller.signal,
      )
      if (requestId !== requestIdRef.current) return
      setItems(result.items)
      setTotal(result.total)
    } catch (loadError) {
      if (isAbortError(loadError) || requestId !== requestIdRef.current) return
      setError(toErrorMessage(loadError, '加载活动记录失败'))
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [page, action, debouncedQuery, timeRange])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  // 任一筛选变化都回到第一页，避免停留在越界页码
  useEffect(() => {
    setPage(1)
  }, [action, debouncedQuery, timeRange])

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // 数据收缩（删除/保留期清理）后回收越界页码，避免空白页。
  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])
  const actionLabel = action ? (ACTION_LABELS.get(action) ?? action) : '全部动作'
  const timeLabel = auditTimeRangeLabel(timeRange)
  const hasFilters = Boolean(action || debouncedQuery || timeRange !== 'all')

  const clearFilters = (): void => {
    setAction('')
    setQuery('')
    setTimeRange('all')
  }

  const filterSummary = [
    actionLabel,
    timeRange !== 'all' ? timeLabel : null,
    debouncedQuery ? `关键词「${debouncedQuery}」` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const columns: Column<AuditItem>[] = [
    {
      key: 'time',
      header: '时间',
      className: 'cell-time',
      render: (item) => (
        <div className="time-cell">
          <RelativeTime ts={item.ts} />
          <span className="time-absolute">{formatDateTime(item.ts)}</span>
        </div>
      ),
    },
    {
      key: 'action',
      header: '动作',
      primary: true,
      render: (item) => {
        const meta = auditActionMeta(item.action)
        return <Badge tone={CATEGORY_TONES[meta.category]}>{meta.label}</Badge>
      },
    },
    {
      key: 'target',
      header: '目标',
      render: (item) => (item.target ? <span className="mono" title={item.target}>{item.target}</span> : '—'),
    },
    {
      key: 'ip',
      header: 'IP',
      className: 'cell-ip',
      render: (item) => <span className="mono">{item.ip ?? '—'}</span>,
    },
    {
      key: 'detail',
      header: '详情',
      className: 'cell-detail',
      render: (item) => {
        const text = auditDetailText(item.detail)
        return text ? <span title={text}>{truncateText(text, 60)}</span> : '—'
      },
    },
  ]

  return (
    <div className="activity-page">
      <PageHeader
        title="活动"
        description={
          loading && items.length === 0
            ? '正在加载审计记录…'
            : `共 ${total} 条记录 · 当前筛选：${filterSummary || '全部动作'}`
        }
        actions={
          <>
            <div className="search-field activity-search">
              <Search size={16} className="search-icon" aria-hidden="true" />
              <input
                type="search"
                className="search-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索动作、目标或 IP…"
                aria-label="搜索审计记录"
              />
              {query ? (
                <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="清除搜索">
                  <X size={15} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <div className="select-field">
              <label className="sr-only" htmlFor="activity-time-filter">筛选时间范围</label>
              <select
                id="activity-time-filter"
                className="select"
                value={timeRange}
                onChange={(event) => setTimeRange(event.target.value as AuditTimeRange)}
              >
                {AUDIT_TIME_RANGES.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <div className="select-field">
              <label className="sr-only" htmlFor="activity-filter">筛选审计动作</label>
              <select
                id="activity-filter"
                className="select"
                value={action}
                onChange={(event) => setAction(event.target.value)}
              >
                <option value="">全部动作</option>
                {AUDIT_ACTION_GROUPS.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.options.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            {hasFilters ? (
              <Button variant="ghost" size="sm" onClick={clearFilters}>清除筛选</Button>
            ) : null}
            <Button
              variant="secondary"
              icon={<RefreshCw size={16} aria-hidden="true" />}
              loading={refreshing}
              onClick={() => void refresh()}
            >
              刷新
            </Button>
          </>
        }
      />

      {error ? <InlineError message={error} onRetry={() => void load()} className="page-inline-error" /> : null}

      <section className="surface-panel" aria-label="活动记录">
        <Table
          columns={columns}
          rows={items}
          rowKey={(item) => String(item.id)}
          loading={loading}
          skeletonRows={8}
          caption="审计活动记录"
          empty={
            <EmptyState
              icon={<ActivityIcon size={24} />}
              title={hasFilters ? '没有匹配的审计记录' : '暂无活动记录'}
              description={
                hasFilters
                  ? '换个关键词、时间范围或动作后再试，也可以清除筛选。'
                  : '登录、文件操作、分享与白名单变更都会记录在这里。'
              }
              action={
                hasFilters ? (
                  <Button variant="secondary" onClick={clearFilters}>清除筛选</Button>
                ) : (
                  <Button variant="secondary" onClick={() => void load()}>刷新</Button>
                )
              }
            />
          }
        />

        {total > PAGE_SIZE ? (
          <div className="pager">
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              上一页
            </Button>
            <span className="pager-info">
              第 {page} / {totalPages} 页 · 共 {total} 条
            </span>
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
    </div>
  )
}
