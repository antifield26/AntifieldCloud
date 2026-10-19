// 工作台告警卡片：当前活跃告警 + 最近历史 + webhook 配置状态。
// 数据来自 GET /api/alerts，不提供修改能力；阈值与配置在设置页只读展示。

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bell, BellRing, RefreshCw } from 'lucide-react'
import { api, isAbortError, toErrorMessage } from '../../api/client'
import type { AlertEvent, AlertsResult } from '../../api/types'
import { useAppMeta } from '../../meta/MetaContext'
import { usePolling } from '../../hooks/usePolling'
import { Card } from '../Card'
import { Badge } from '../Badge'
import type { BadgeTone } from '../Badge'
import { Button } from '../Button'
import { InlineError } from '../InlineError'
import { EmptyState } from '../EmptyState'
import { RelativeTime } from '../RelativeTime'
import { SkeletonText } from '../Skeleton'
import { cx } from '../../lib/classnames'

const EVENT_LABELS: Record<string, string> = {
  disk: '磁盘空间',
  disk_free: '磁盘空间',
  temp: '温度',
  temperature: '温度',
  memory: '内存',
  mem: '内存',
  service: '服务状态',
  backup: '备份超期',
  backup_age: '备份超期',
  minecraft: 'Minecraft 状态',
  mc: 'Minecraft 状态',
  undervoltage: '电源欠压',
  throttle: '电源欠压',
}

const SEVERITY_LABELS: Record<string, string> = {
  critical: '严重',
  error: '错误',
  warning: '警告',
  warn: '警告',
  info: '提示',
  ok: '正常',
}

const STATUS_LABELS: Record<string, string> = {
  firing: '触发中',
  fired: '已触发',
  active: '活跃',
  resolved: '已恢复',
  recovered: '已恢复',
  normal: '正常',
  ok: '正常',
}

function severityLabel(severity: string): string {
  return SEVERITY_LABELS[severity.toLowerCase()] ?? severity
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status.toLowerCase()] ?? status
}

function severityTone(severity: string): BadgeTone {
  const value = severity.toLowerCase()
  if (value === 'critical' || value === 'error' || value === 'danger') return 'danger'
  if (value === 'warning' || value === 'warn') return 'warning'
  if (value === 'info') return 'info'
  return 'muted'
}

function statusTone(status: string): BadgeTone {
  const value = status.toLowerCase()
  if (value === 'ok' || value === 'resolved' || value === 'recovered' || value === 'normal') return 'success'
  if (value === 'firing' || value === 'fired' || value === 'active') return 'danger'
  return 'muted'
}

function isResolvedStatus(status: string): boolean {
  const value = status.toLowerCase()
  return value === 'ok' || value === 'resolved' || value === 'recovered' || value === 'normal'
}

function eventLabel(event: string): string {
  return EVENT_LABELS[event] ?? event
}

function EventRow({ item }: { item: AlertEvent }) {
  return (
    <li className="alert-event">
      <span className={cx('alert-event-dot', `alert-event-${severityTone(item.severity)}`)} aria-hidden="true" />
      <div className="alert-event-main">
        <div className="alert-event-title">
          <strong>{item.title || eventLabel(item.event)}</strong>
          <Badge tone={severityTone(item.severity)}>{severityLabel(item.severity)}</Badge>
          <Badge tone={statusTone(item.status)}>{statusLabel(item.status)}</Badge>
        </div>
        {item.message ? <p className="alert-event-message">{item.message}</p> : null}
        {item.deliveryError ? (
          <p className="alert-event-delivery text-warning">通知发送失败：{item.deliveryError}</p>
        ) : null}
      </div>
      <RelativeTime ts={item.createdAt} className="alert-event-time" />
    </li>
  )
}

export function AlertsCard() {
  const { meta } = useAppMeta()
  const [data, setData] = useState<AlertsResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const dataRef = useRef<AlertsResult | null>(null)
  const requestIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!meta.alertsEnabled) {
      setLoading(false)
      return
    }
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    try {
      const result = await api.alerts.list(20)
      if (requestId !== requestIdRef.current) return
      dataRef.current = result
      setData(result)
      setError(null)
    } catch (loadError) {
      if (isAbortError(loadError) || requestId !== requestIdRef.current) return
      const message = toErrorMessage(loadError, '加载告警失败')
      if (dataRef.current) setError(message)
      else setError(message)
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [meta.alertsEnabled])

  useEffect(() => {
    void load()
    return () => abortRef.current?.abort()
  }, [load])

  usePolling(() => load(), 60_000, meta.alertsEnabled)

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const activeStates = data?.state.filter((state) => !isResolvedStatus(state.status)) ?? []
  const recentItems = data?.items.slice(0, 5) ?? []

  return (
    <Card
      title="告警"
      className="alerts-card"
      actions={
        <div className="card-actions-inline">
          <Link className="text-link" to="/settings#alerts">配置说明</Link>
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新告警"
            title="刷新"
            loading={refreshing}
            onClick={() => void refresh()}
            icon={<RefreshCw size={16} aria-hidden="true" />}
          />
        </div>
      }
      loading={loading && !data}
      skeleton={<SkeletonText lines={4} />}
      error={!data ? error : null}
      onRetry={() => void load()}
    >
      {!meta.alertsEnabled ? (
        <div className="notice notice-muted">服务端未启用告警功能（/api/version alertsEnabled=false）。</div>
      ) : data ? (
        <div className="alerts-body">
          {error ? <InlineError message={error} onRetry={() => void load()} /> : null}

          <div className="alerts-summary">
            <span className="alerts-summary-icon" aria-hidden="true">
              {activeStates.length > 0 ? <BellRing size={18} /> : <Bell size={18} />}
            </span>
            <span className="alerts-summary-text">
              {activeStates.length > 0
                ? `当前有 ${activeStates.length} 项活跃告警`
                : '当前没有活跃告警'}
            </span>
            <Badge tone={data.config.webhookConfigured ? 'success' : 'warning'}>
              {data.config.webhookConfigured ? 'webhook 已配置' : 'webhook 未配置'}
            </Badge>
            <Badge tone={data.config.enabled ? 'accent' : 'muted'}>
              {data.config.enabled ? '告警已启用' : '告警未启用'}
            </Badge>
          </div>

          {activeStates.length > 0 ? (
            <ul className="alert-state-list">
              {activeStates.map((state) => (
                <li key={state.event} className="alert-state-item">
                  <span className="alert-state-event">{eventLabel(state.event)}</span>
                  <Badge tone={statusTone(state.status)}>{statusLabel(state.status)}</Badge>
                  <span className="alert-state-time">
                    最近触发 <RelativeTime ts={state.lastFiredAt} />
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {recentItems.length > 0 ? (
            <ul className="alert-event-list">
              {recentItems.map((item) => (
                <EventRow key={item.id} item={item} />
              ))}
            </ul>
          ) : (
            <EmptyState compact icon={<Bell size={22} />} title="暂无告警历史" description="触发告警后会在这里显示最近记录。" />
          )}
        </div>
      ) : null}
    </Card>
  )
}
