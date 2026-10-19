import { useCallback, useEffect, useState } from 'react'
import { Activity as ActivityIcon, RefreshCw } from 'lucide-react'
import { api, toErrorMessage } from '../api/client'
import type { AuditItem } from '../api/types'
import { auditActionMeta, auditCategory } from '../lib/audit'
import type { AuditCategory } from '../lib/audit'
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
const MAX_LOADED = 200

const FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'auth', label: '登录' },
  { value: 'file', label: '文件' },
  { value: 'whitelist', label: '白名单' },
] as const

type FilterValue = (typeof FILTERS)[number]['value']

const CATEGORY_TONES: Record<AuditCategory, BadgeTone> = {
  auth: 'accent',
  file: 'muted',
  whitelist: 'success',
  other: 'muted',
}

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
 * 活动：审计列表 + 类型筛选 + 简单分页。
 * API 只支持 limit/offset，因此一次加载最近 200 条后在本地筛选与分页。
 */
export function Activity() {
  usePageTitle('活动')
  const [items, setItems] = useState<AuditItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState<FilterValue>('all')
  const [page, setPage] = useState(1)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const result = await api.getAudit(MAX_LOADED, 0)
      setItems(result.items)
      setTotal(result.total)
    } catch (loadError) {
      setError(toErrorMessage(loadError, '加载活动记录失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const filtered = filter === 'all' ? items : items.filter((item) => auditCategory(item.action) === filter)
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))

  useEffect(() => {
    setPage(1)
  }, [filter])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

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
        description={loading && items.length === 0 ? '正在加载审计记录…' : `共 ${total} 条记录 · 最多加载最近 ${MAX_LOADED} 条`}
        actions={
          <>
            <div className="select-field">
              <label className="sr-only" htmlFor="activity-filter">筛选活动类型</label>
              <select
                id="activity-filter"
                className="select"
                value={filter}
                onChange={(event) => setFilter(event.target.value as FilterValue)}
              >
                {FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
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

      {total > MAX_LOADED ? (
        <div className="notice notice-info">
          仅加载最近 {MAX_LOADED} 条记录（共 {total} 条）；更早的记录请在服务端审计数据库中查看。
        </div>
      ) : null}

      {error ? <InlineError message={error} onRetry={() => void load()} className="page-inline-error" /> : null}

      <section className="surface-panel" aria-label="活动记录">
        <Table
          columns={columns}
          rows={pageItems}
          rowKey={(item) => String(item.id)}
          loading={loading}
          skeletonRows={8}
          caption="审计活动记录"
          empty={
            <EmptyState
              icon={<ActivityIcon size={24} />}
              title={filter === 'all' ? '暂无活动记录' : '该类型暂无记录'}
              description="登录、文件操作与白名单变更会记录在这里。"
              action={<Button variant="secondary" onClick={() => void load()}>刷新</Button>}
            />
          }
        />

        {filtered.length > PAGE_SIZE ? (
          <div className="pager">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
              上一页
            </Button>
            <span className="pager-info">
              第 {page} / {totalPages} 页 · 当前筛选 {filtered.length} 条
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
