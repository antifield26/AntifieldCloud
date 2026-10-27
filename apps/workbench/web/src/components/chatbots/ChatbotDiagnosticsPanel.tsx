// 诊断分区：入站事件元数据与最近的投递/发布失败信息。
// 安全边界：只渲染服务端返回的事件元数据与脱敏错误文本，不展示消息正文、用户名或任何平台凭据；
// 错误原文来自队列记录，中文提示由服务端根据错误类型映射。

import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, Info, RefreshCw, TriangleAlert } from 'lucide-react'
import { api, toErrorMessage } from '../../api/client'
import type { ChatbotDelivery, ChatbotEventItem, ChatbotPublishJob, ChatbotSummary } from '../../api/types'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Card } from '../Card'
import { EmptyState } from '../EmptyState'
import { Table } from '../Table'
import type { Column } from '../Table'
import { useToast } from '../Toast'
import {
  CHATBOT_DELIVERY_KIND_LABELS,
  CHATBOT_DELIVERY_STATUS_META,
  CHATBOT_PUBLISH_STATUS_META,
  chatbotOutcomeMeta,
  shortenId,
} from '../../lib/chatbots'
import { formatDateTime, truncateText } from '../../lib/format'

/** 事件列表每页 20 条；最近错误最多 10 条。 */
const PAGE_SIZE = 20
const MAX_RECENT_ERRORS = 10

const HOUR_OPTIONS = [
  { value: 1, label: '最近 1 小时' },
  { value: 24, label: '最近 24 小时' },
  { value: 168, label: '最近 7 天' },
] as const

const OUTCOME_OPTIONS = [
  { value: '', label: '全部结果' },
  { value: 'received', label: '已接收（received）' },
  { value: 'ok', label: '成功（ok）' },
  { value: 'denied', label: '拒绝（denied）' },
  { value: 'rate_limited', label: '限流（rate_limited）' },
  { value: 'ignored', label: '忽略（ignored）' },
  { value: 'error', label: '错误（error）' },
] as const

interface ChatbotDiagnosticsPanelProps {
  chatbot: ChatbotSummary | null
  /** 页面级刷新令牌变化时重新拉取事件与错误。 */
  refreshToken: number
}

interface RecentError {
  key: string
  source: 'delivery' | 'publish'
  sourceLabel: string
  statusLabel: string
  statusTone: 'success' | 'warning' | 'danger' | 'muted' | 'accent' | 'info'
  lastError: string
  lastErrorHint: string | null
  createdAt: string
}

function recentErrorsFrom(
  deliveries: readonly ChatbotDelivery[],
  jobs: readonly ChatbotPublishJob[],
): RecentError[] {
  const items: RecentError[] = []
  for (const delivery of deliveries) {
    if (delivery.status !== 'failed' && delivery.status !== 'dead') continue
    if (!delivery.lastError) continue
    const meta = CHATBOT_DELIVERY_STATUS_META[delivery.status]
    items.push({
      key: `delivery:${delivery.id}`,
      source: 'delivery',
      sourceLabel: `${CHATBOT_DELIVERY_KIND_LABELS[delivery.kind]}投递`,
      statusLabel: meta.label,
      statusTone: meta.tone,
      lastError: delivery.lastError,
      lastErrorHint: delivery.lastErrorHint ?? null,
      createdAt: delivery.createdAt,
    })
  }
  for (const job of jobs) {
    if (job.status !== 'failed') continue
    if (!job.lastError) continue
    const meta = CHATBOT_PUBLISH_STATUS_META[job.status]
    items.push({
      key: `publish:${job.id}`,
      source: 'publish',
      sourceLabel: '发布',
      statusLabel: meta.label,
      statusTone: meta.tone,
      lastError: job.lastError,
      lastErrorHint: job.lastErrorHint ?? null,
      createdAt: job.createdAt,
    })
  }
  items.sort((left, right) => {
    const leftTime = new Date(left.createdAt).getTime()
    const rightTime = new Date(right.createdAt).getTime()
    const leftValue = Number.isNaN(leftTime) ? 0 : leftTime
    const rightValue = Number.isNaN(rightTime) ? 0 : rightTime
    return rightValue - leftValue
  })
  return items.slice(0, MAX_RECENT_ERRORS)
}

/** 诊断分区：筛选入站事件 + 汇总最近错误。 */
export function ChatbotDiagnosticsPanel({ chatbot, refreshToken }: ChatbotDiagnosticsPanelProps) {
  const toast = useToast()
  const chatbotId = chatbot?.id ?? ''

  const [hours, setHours] = useState<number>(24)
  const [outcome, setOutcome] = useState('')
  const [page, setPage] = useState(1)
  const [events, setEvents] = useState<ChatbotEventItem[]>([])
  const [eventsTotal, setEventsTotal] = useState(0)
  const [eventsLoading, setEventsLoading] = useState(true)
  const [eventsError, setEventsError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  const [errors, setErrors] = useState<RecentError[]>([])
  const [errorsLoading, setErrorsLoading] = useState(true)
  const [errorsError, setErrorsError] = useState<string | null>(null)
  const eventsSeqRef = useRef(0)
  const errorsSeqRef = useRef(0)

  const loadEvents = useCallback(async (): Promise<void> => {
    if (!chatbotId) {
      setEvents([])
      setEventsTotal(0)
      setEventsLoading(false)
      return
    }
    const seq = eventsSeqRef.current + 1
    eventsSeqRef.current = seq
    setEventsLoading(true)
    setEventsError(null)
    try {
      const result = await api.chatbots.events(chatbotId, {
        hours,
        outcome: outcome || undefined,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      })
      if (seq !== eventsSeqRef.current) return
      setEvents(result.items)
      setEventsTotal(result.total)
    } catch (loadError) {
      if (seq !== eventsSeqRef.current) return
      setEventsError(toErrorMessage(loadError, '读取入站事件失败'))
    } finally {
      if (seq === eventsSeqRef.current) setEventsLoading(false)
    }
  }, [chatbotId, hours, outcome, page])

  const loadErrors = useCallback(async (): Promise<void> => {
    if (!chatbotId) {
      setErrors([])
      setErrorsLoading(false)
      return
    }
    const seq = errorsSeqRef.current + 1
    errorsSeqRef.current = seq
    setErrorsLoading(true)
    setErrorsError(null)
    try {
      const [deliveries, jobs] = await Promise.all([
        api.chatbots.deliveries.list(chatbotId, 200),
        api.chatbots.publish.list(chatbotId, 200),
      ])
      if (seq !== errorsSeqRef.current) return
      setErrors(recentErrorsFrom(deliveries, jobs))
    } catch (loadError) {
      if (seq !== errorsSeqRef.current) return
      setErrorsError(toErrorMessage(loadError, '读取最近错误失败'))
    } finally {
      if (seq === errorsSeqRef.current) setErrorsLoading(false)
    }
  }, [chatbotId])

  useEffect(() => {
    void loadEvents()
  }, [loadEvents, refreshToken, reloadKey])

  useEffect(() => {
    void loadErrors()
  }, [loadErrors, refreshToken, reloadKey])

  // 数据收缩（删除事件保留期/筛选变化）后回收越界页码。
  const totalPages = Math.max(1, Math.ceil(eventsTotal / PAGE_SIZE))
  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const handleRefresh = async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await Promise.all([loadEvents(), loadErrors()])
      toast.success('诊断信息已刷新')
    } finally {
      setRefreshing(false)
    }
  }

  const handleHoursChange = (value: number): void => {
    setHours(value)
    setPage(1)
  }

  const handleOutcomeChange = (value: string): void => {
    setOutcome(value)
    setPage(1)
  }

  const eventColumns: Column<ChatbotEventItem>[] = [
    {
      key: 'time',
      header: '时间',
      primary: true,
      render: (event) => <span className="cell-time">{formatDateTime(event.receivedAt)}</span>,
    },
    {
      key: 'kind',
      header: '类型',
      render: (event) => <span className="chatbot-diag-kind">{event.kind ?? '—'}</span>,
    },
    {
      key: 'outcome',
      header: '结果',
      render: (event) => {
        const meta = chatbotOutcomeMeta(event.outcome)
        return <Badge tone={meta.tone}>{meta.label}</Badge>
      },
    },
    {
      key: 'target',
      header: '目标',
      render: (event) => (
        <span className="chatbot-diag-id" title={event.targetExternalId ?? undefined}>
          {shortenId(event.targetExternalId)}
        </span>
      ),
    },
    {
      key: 'user',
      header: '用户',
      render: (event) => (
        <span className="chatbot-diag-id" title={event.userId ?? undefined}>
          {shortenId(event.userId, 10)}
        </span>
      ),
    },
    {
      key: 'detail',
      header: '详情',
      render: (event) =>
        event.detail ? (
          <span className="cell-detail" title={event.detail}>
            {truncateText(event.detail, 48)}
          </span>
        ) : (
          <span className="cell-detail">—</span>
        ),
    },
  ]

  if (!chatbot) {
    return (
      <Card title="诊断">
        <EmptyState
          icon={<Activity size={24} />}
          title="请选择一个 Chatbot"
          description="在顶部选择 Chatbot 后，可查看入站事件与最近的投递/发布错误。"
        />
      </Card>
    )
  }

  return (
    <div className="chatbot-diagnostics">
      <div className="notice notice-muted chatbot-diag-privacy" role="note">
        <Info size={16} aria-hidden="true" />
        诊断只展示事件元数据与脱敏错误：不展示消息正文、平台用户名或任何 Token/Secret。
      </div>

      <Card
        title="最近事件"
        description="入站 Webhook/消息的去重记录；按到达时间倒序，可按时间范围与结果筛选。"
        actions={
          <div className="chatbot-diag-actions">
            <div className="select-field chatbot-field-select chatbot-diag-filter">
              <select
                className="select"
                aria-label="事件时间范围"
                value={String(hours)}
                onChange={(event) => handleHoursChange(Number(event.target.value))}
                disabled={eventsLoading || refreshing}
              >
                {HOUR_OPTIONS.map((option) => (
                  <option key={option.value} value={String(option.value)}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="select-field chatbot-field-select chatbot-diag-filter">
              <select
                className="select"
                aria-label="事件结果筛选"
                value={outcome}
                onChange={(event) => handleOutcomeChange(event.target.value)}
                disabled={eventsLoading || refreshing}
              >
                {OUTCOME_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <Button
              size="sm"
              variant="secondary"
              icon={<RefreshCw size={14} aria-hidden="true" />}
              loading={refreshing}
              onClick={() => void handleRefresh()}
            >
              刷新
            </Button>
          </div>
        }
        loading={eventsLoading}
        error={eventsError}
        onRetry={() => setReloadKey((value) => value + 1)}
      >
        <Table
          className="chatbots-table-scroll"
          columns={eventColumns}
          rows={events}
          rowKey={(event) => event.eventId}
          caption="入站事件元数据"
          empty={
            <EmptyState
              compact
              icon={<Activity size={22} />}
              title="暂无入站事件"
              description="用户触发命令或 Chat 后，Webhook/消息事件会在这里按元数据展示。"
            />
          }
        />
        {eventsTotal > PAGE_SIZE ? (
          <div className="pager chatbot-diag-pager">
            <Button
              size="sm"
              variant="secondary"
              aria-label="上一页事件"
              disabled={page <= 1 || eventsLoading}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              上一页
            </Button>
            <span className="pager-info">第 {page} / {totalPages} 页 · 共 {eventsTotal} 条</span>
            <Button
              size="sm"
              variant="secondary"
              aria-label="下一页事件"
              disabled={page >= totalPages || eventsLoading}
              onClick={() => setPage((value) => value + 1)}
            >
              下一页
            </Button>
          </div>
        ) : null}
      </Card>

      <Card
        title="最近错误"
        description="失败/死信的投递与发布任务（最多 10 条）；展示队列错误原文与服务端中文提示，不包含消息正文。"
        actions={<Badge tone={errors.length > 0 ? 'danger' : 'muted'}>{errors.length} 条</Badge>}
        loading={errorsLoading}
        error={errorsError}
        onRetry={() => void loadErrors()}
      >
        {errors.length === 0 ? (
          <EmptyState
            compact
            icon={<TriangleAlert size={22} />}
            title="最近没有失败记录"
            description="投递或发布失败后，错误原文与中文提示会在这里出现。"
          />
        ) : (
          <ul className="chatbot-diag-error-list">
            {errors.map((item) => (
              <li className="chatbot-diag-error" key={item.key}>
                <div className="chatbot-diag-error-head">
                  <Badge tone={item.statusTone}>{item.statusLabel}</Badge>
                  <Badge tone="muted">{item.sourceLabel}</Badge>
                  <span className="cell-time">{formatDateTime(item.createdAt)}</span>
                </div>
                <p className="chatbot-diag-error-message">{item.lastError}</p>
                {item.lastErrorHint ? (
                  <p className="chatbot-diag-error-hint">
                    <Info size={13} aria-hidden="true" /> {item.lastErrorHint}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
