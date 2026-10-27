// mcbot 历史：告警 / 采样两段式切换，默认查询最近 24 小时、最多 100 条。
// 数据来自 GET /api/mcbot/history（服务端透传 mcbot 形状）；只读表格，不使用图表库。
// 安全边界：只渲染白名单字段与纯文本，details 不展开，不展示 Token/URL。

import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api, isAbortError, toErrorMessage } from '../../api/client'
import type {
  McbotHistory,
  McbotHistoryAlert,
  McbotHistoryKind,
  McbotHistorySample,
} from '../../api/types'
import { Badge } from '../Badge'
import type { BadgeTone } from '../Badge'
import { Button } from '../Button'
import { Card } from '../Card'
import { EmptyState } from '../EmptyState'
import { InlineError } from '../InlineError'
import { RelativeTime } from '../RelativeTime'
import { Table } from '../Table'
import type { Column } from '../Table'
import { cx } from '../../lib/classnames'
import {
  mcbotAlertTypeLabel,
  mcbotBotStateLabel,
  mcbotHistoryAlertText,
  mcbotSeverityLabel,
  mcbotTaskNameLabel,
  mcbotTaskStateLabel,
} from '../../lib/mcbot'

/** 历史查询窗口：最近 24 小时。 */
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000
/** 单次最多展示条数（服务端上限 200，这里固定 100）。 */
const HISTORY_LIMIT = 100

const KIND_OPTIONS: readonly { id: McbotHistoryKind; label: string }[] = [
  { id: 'alerts', label: '告警' },
  { id: 'samples', label: '采样' },
]

function severityTone(severity: string): BadgeTone {
  const value = severity.toLowerCase()
  if (value === 'critical' || value === 'error' || value === 'danger') return 'danger'
  if (value === 'warning' || value === 'warn') return 'warning'
  if (value === 'info') return 'info'
  return 'muted'
}

function numberOrDash(value: number | null | undefined, digits = 0): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—'
}

const SAMPLE_COLUMNS: Column<McbotHistorySample>[] = [
  {
    key: 'ts',
    header: '时间',
    render: (row) => <RelativeTime ts={row.ts} />,
  },
  {
    key: 'connected',
    header: '连接',
    render: (row) => (
      <Badge tone={row.connected ? 'success' : 'danger'}>{row.connected ? '在线' : '离线'}</Badge>
    ),
  },
  {
    key: 'state',
    header: '状态',
    render: (row) => mcbotBotStateLabel(row.state),
  },
  {
    key: 'task',
    header: '任务',
    render: (row) =>
      row.taskName ? `${mcbotTaskNameLabel(row.taskName)} · ${mcbotTaskStateLabel(row.taskState)}` : '—',
  },
  {
    key: 'vitals',
    header: '血量 / 饥饿',
    render: (row) => `${numberOrDash(row.health)} / ${numberOrDash(row.food)}`,
  },
  {
    key: 'tps',
    header: 'TPS',
    render: (row) => numberOrDash(row.tps, 1),
  },
  {
    key: 'queue',
    header: '队列',
    render: (row) => String(row.queueLen ?? 0),
  },
  {
    key: 'memory',
    header: '内存 / RSS（MB）',
    render: (row) => `${numberOrDash(row.memoryMb, 1)} / ${numberOrDash(row.rssMb, 1)}`,
  },
]

const ALERT_COLUMNS: Column<McbotHistoryAlert>[] = [
  {
    key: 'ts',
    header: '时间',
    render: (row) => <RelativeTime ts={row.ts} />,
  },
  {
    key: 'type',
    header: '类型',
    render: (row) => mcbotAlertTypeLabel(row.type),
  },
  {
    key: 'severity',
    header: '级别',
    render: (row) => <Badge tone={severityTone(row.severity)}>{mcbotSeverityLabel(row.severity)}</Badge>,
  },
  {
    key: 'message',
    header: '内容',
    render: (row) => <span className="mcbot-history-message">{row.message || mcbotHistoryAlertText(row)}</span>,
  },
]

/** 历史卡片：告警/采样切换、刷新、空态与错误态。 */
export function McbotHistoryCard() {
  const [kind, setKind] = useState<McbotHistoryKind>('alerts')
  const [data, setData] = useState<McbotHistory | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const requestIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async (targetKind: McbotHistoryKind): Promise<void> => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    const to = new Date()
    const from = new Date(to.getTime() - HISTORY_WINDOW_MS)
    try {
      const result = await api.mcbot.history(
        {
          kind: targetKind,
          from: from.toISOString(),
          to: to.toISOString(),
          limit: HISTORY_LIMIT,
        },
        controller.signal,
      )
      if (requestId !== requestIdRef.current) return
      setData(result)
      setError(null)
    } catch (loadError) {
      if (isAbortError(loadError) || requestId !== requestIdRef.current) return
      setError(toErrorMessage(loadError, '加载 mcbot 历史失败'))
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    setError(null)
    void load(kind)
    return () => abortRef.current?.abort()
  }, [kind, load])

  const refresh = async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    await load(kind)
    setRefreshing(false)
  }

  // 切换类型后旧数据可能仍属于上一类，避免短暂展示错表。
  const activeData = data && data.kind === kind ? data : null
  const tableLoading = loading || (!activeData && !error)
  const samples = kind === 'samples' ? (activeData?.samples ?? []) : []
  const alerts = kind === 'alerts' ? (activeData?.alerts ?? []) : []

  return (
    <Card
      title="历史记录"
      description="最近 24 小时的告警或采样记录，只读表格。"
      actions={
        <div className="mcbot-history-actions">
          <div className="segmented mcbot-history-tabs" role="group" aria-label="mcbot 历史类型">
            {KIND_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={cx(
                  'segmented-button',
                  kind === option.id && 'segmented-button-active',
                )}
                aria-pressed={kind === option.id}
                onClick={() => setKind(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新 mcbot 历史记录"
            title="刷新"
            loading={refreshing}
            onClick={() => void refresh()}
            icon={<RefreshCw size={16} aria-hidden="true" />}
          />
        </div>
      }
    >
      {error ? <InlineError message={error} onRetry={() => void refresh()} /> : null}

      {kind === 'alerts' ? (
        <Table
          columns={ALERT_COLUMNS}
          rows={alerts}
          rowKey={(row, index) => `alert-${row.id ?? 'row'}-${index}`}
          loading={tableLoading}
          skeletonRows={3}
          caption="mcbot 告警历史"
          empty={
            <EmptyState
              compact
              title="暂无告警记录"
              description="最近 24 小时 mcbot 没有产生告警；低血量、任务失败、断线等会记录在这里。"
            />
          }
        />
      ) : (
        <Table
          columns={SAMPLE_COLUMNS}
          rows={samples}
          rowKey={(row, index) => `sample-${row.ts}-${index}`}
          loading={tableLoading}
          skeletonRows={3}
          caption="mcbot 采样历史"
          empty={
            <EmptyState
              compact
              title="暂无采样记录"
              description="mcbot 每 60 秒采样一次连接、任务、血量与 TPS；最近 24 小时没有数据。"
            />
          }
        />
      )}

      <p className="card-footnote">
        最近 24 小时 · 最多 {HISTORY_LIMIT} 条；采样由 mcbot 每 60 秒写入一次，时间按 Asia/Shanghai 展示。
      </p>
    </Card>
  )
}
