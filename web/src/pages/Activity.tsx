import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity as ActivityIcon, RefreshCw } from 'lucide-react'
import { api, isAbortError, toErrorMessage } from '../api/client'
import type { AuditItem } from '../api/types'
import { auditActionMeta, AUDIT_ACTION_GROUPS } from '../lib/audit'
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

const CATEGORY_TONES: Record<AuditCategory, BadgeTone> = {
  auth: 'accent',
  file: 'muted',
  share: 'info',
  whitelist: 'success',
  knowledge: 'accent',
  alert: 'warning',
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
 * 活动：审计列表 + 服务端动作精确筛选 + 服务端分页。
 * `action` 参数由服务端执行精确匹配，避免一次拉取大量记录后在本地筛选。
 */
export function Activity() {
  usePageTitle('活动')
  const [items, setItems] = useState<AuditItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [action, setAction] = useState('')
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
      const result = await api.getAudit(
        PAGE_SIZE,
        (page - 1) * PAGE_SIZE,
        action || undefined,
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
  }, [page, action])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const actionLabel = action ? (ACTION_LABELS.get(action) ?? action) : '全部动作'

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
            : `共 ${total} 条记录 · 当前筛选：${actionLabel}`
        }
        actions={
          <>
            <div className="select-field">
              <label className="sr-only" htmlFor="activity-filter">筛选审计动作</label>
              <select
                id="activity-filter"
                className="select"
                value={action}
                onChange={(event) => {
                  setAction(event.target.value)
                  setPage(1)
                }}
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
              title={action ? `暂无「${actionLabel}」记录` : '暂无活动记录'}
              description="登录、文件操作、分享与白名单变更都会记录在这里。"
              action={<Button variant="secondary" onClick={() => void load()}>刷新</Button>}
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
