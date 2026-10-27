// 工作台告警卡片：当前活跃告警 + 最近历史 + webhook 配置状态。
// 数据来自 GET /api/alerts，不提供修改能力；阈值与配置在设置页只读展示。
// v0.4.0：历史记录支持状态/事件筛选与服务端分页；默认视图（无筛选、第一页）与旧版一致。

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bell, BellRing, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
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

const PAGE_SIZE = 5

const EVENT_LABELS: Record<string, string> = {
  disk: '磁盘空间',
  disk_free: '磁盘空间',
  disk_low: '磁盘空间',
  temp: '温度',
  temperature: '温度',
  temp_high: '温度',
  memory: '内存',
  mem: '内存',
  memory_high: '内存',
  mem_high: '内存',
  service: '服务状态',
  service_down: '服务状态',
  backup: '备份超期',
  backup_age: '备份超期',
  backup_overdue: '备份超期',
  pending_backup: '待确认备份',
  secrets: '密钥包',
  secrets_error: '密钥包',
  minecraft: 'Minecraft 状态',
  mc: 'Minecraft 状态',
  mc_offline: 'Minecraft 状态',
  undervoltage: '电源欠压',
  throttle: '电源欠压',
  world_backup_stale: '世界备份过期',
  world_pull_stale: '世界备份未拉取',
  drill_stale: '恢复演练过期',
  // v0.7.0：备份加密与异地副本
  offsite_overdue: '异地副本超期',
  offsite_stale: '异地副本超期',
  offsite_failed: '异地副本失败',
  backup_encryption_missing: '备份加密公钥缺失',
  backup_encryption_failed: '备份加密失败',
  // v0.8.0：mcbot 事件告警（事件状态 event 只记录，不参与活跃告警）
  mcbot_low_health: 'mcbot 血量过低',
  mcbot_task_failed: 'mcbot 任务失败',
  mcbot_disconnected: 'mcbot 断线',
  mcbot_chest_full: 'mcbot 箱子已满',
  mcbot_defense_retreat: 'mcbot 防御撤退',
  mcbot_alert: 'mcbot 告警',
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
  unknown: '未知',
  /** v0.8.0：mcbot 事件告警只记录状态，不代表当前活跃告警。 */
  event: '已记录',
}

/** 服务端支持的状态筛选值（docs/app/API.md §12）。 */
const STATUS_FILTERS = [
  { value: '', label: '全部状态' },
  { value: 'firing', label: '触发中' },
  { value: 'resolved', label: '已恢复' },
  { value: 'unknown', label: '未知' },
  { value: 'event', label: '已记录' },
]

/** 已知告警条件；服务端新增但前端未映射的条件会从实际数据中补充。 */
const KNOWN_EVENTS = [
  'disk_low',
  'temp_high',
  'memory_high',
  'service_down',
  'backup_age',
  'pending_backup',
  'secrets_error',
  'mc_offline',
  'undervoltage',
  'world_backup_stale',
  'world_pull_stale',
  'drill_stale',
  'offsite_overdue',
  'backup_encryption_missing',
  // v0.8.0：mcbot 事件告警
  'mcbot_low_health',
  'mcbot_task_failed',
  'mcbot_disconnected',
  'mcbot_chest_full',
  'mcbot_defense_retreat',
  'mcbot_alert',
]

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
  // event 表示已记录的事件告警，不代表活跃，使用中性色调。
  return 'muted'
}

function isResolvedStatus(status: string): boolean {
  const value = status.toLowerCase()
  return (
    value === 'ok' ||
    value === 'resolved' ||
    value === 'recovered' ||
    value === 'normal' ||
    value === 'event'
  )
}

function eventLabel(event: string): string {
  return EVENT_LABELS[event] ?? event
}

/** 合并已知条件与实际出现的条件，避免服务端新增条件无法筛选。 */
function buildEventOptions(data: AlertsResult | null): { value: string; label: string }[] {
  const seen = new Set<string>(KNOWN_EVENTS)
  for (const state of data?.state ?? []) seen.add(state.event)
  for (const item of data?.items ?? []) seen.add(item.event)
  const options = [...seen]
    .map((value) => ({ value, label: eventLabel(value) }))
    .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'))
  return [{ value: '', label: '全部事件' }, ...options]
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
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [statusFilter, setStatusFilter] = useState('')
  const [eventFilter, setEventFilter] = useState('')
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
      const result = await api.alerts.list(
        PAGE_SIZE,
        {
          offset: (page - 1) * PAGE_SIZE,
          event: eventFilter || undefined,
          status: statusFilter || undefined,
        },
        controller.signal,
      )
      if (requestId !== requestIdRef.current) return
      const rawItems = Array.isArray(result.items) ? result.items : []
      const serverTotal = typeof result.total === 'number' ? result.total : null
      // 旧服务端不支持分页/筛选：只取首页 5 条，避免翻页出现重复内容
      const normalized: AlertsResult = serverTotal === null
        ? { ...result, items: rawItems.slice(0, PAGE_SIZE) }
        : result
      dataRef.current = normalized
      setData(normalized)
      setTotal(serverTotal ?? Math.min(rawItems.length, PAGE_SIZE))
      setError(null)
    } catch (loadError) {
      if (isAbortError(loadError) || requestId !== requestIdRef.current) return
      setError(toErrorMessage(loadError, '加载告警失败'))
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [meta.alertsEnabled, page, eventFilter, statusFilter])

  useEffect(() => {
    void load()
    return () => abortRef.current?.abort()
  }, [load])

  useEffect(() => {
    setPage(1)
  }, [eventFilter, statusFilter])

  // 筛选后总数变少时回到最后一页
  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
    if (page > totalPages) setPage(totalPages)
  }, [total, page])

  usePolling(() => load(), 60_000, meta.alertsEnabled)

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const activeStates = data?.state.filter((state) => !isResolvedStatus(state.status)) ?? []
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const hasFilters = Boolean(statusFilter || eventFilter)
  const eventOptions = buildEventOptions(data)

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

          <div className="alerts-filters" role="group" aria-label="告警历史筛选">
            <div className="select-field">
              <label className="sr-only" htmlFor="alerts-status-filter">按状态筛选告警历史</label>
              <select
                id="alerts-status-filter"
                className="select alerts-filter-select"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
              >
                {STATUS_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <div className="select-field">
              <label className="sr-only" htmlFor="alerts-event-filter">按事件筛选告警历史</label>
              <select
                id="alerts-event-filter"
                className="select alerts-filter-select"
                value={eventFilter}
                onChange={(event) => setEventFilter(event.target.value)}
              >
                {eventOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <span className="alerts-filter-count">
              共 {total} 条{hasFilters ? '匹配记录' : '记录'}
            </span>
          </div>

          {data.items.length > 0 ? (
            <ul className="alert-event-list">
              {data.items.map((item) => (
                <EventRow key={item.id} item={item} />
              ))}
            </ul>
          ) : (
            <EmptyState
              compact
              icon={<Bell size={22} />}
              title={hasFilters ? '没有匹配的告警历史' : '暂无告警历史'}
              description={
                hasFilters
                  ? '调整状态或事件筛选后再试。'
                  : '触发告警后会在这里显示最近记录。'
              }
            />
          )}

          {total > PAGE_SIZE ? (
            <div className="alerts-pager">
              <Button
                variant="ghost"
                size="icon"
                aria-label="上一页告警历史"
                title="上一页"
                disabled={page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                icon={<ChevronLeft size={16} aria-hidden="true" />}
              />
              <span className="alerts-pager-info">第 {page} / {totalPages} 页</span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="下一页告警历史"
                title="下一页"
                disabled={page >= totalPages}
                onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                icon={<ChevronRight size={16} aria-hidden="true" />}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  )
}
