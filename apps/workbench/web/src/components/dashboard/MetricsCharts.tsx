// 工作台指标趋势：CPU/内存/温度/磁盘四张自定义 SVG 趋势卡。
// 数据来自 GET /api/metrics（服务端按桶聚合），60s 轮询；页面隐藏时由 usePolling 暂停。
// 不引入图表库：折线/面积/断点与坐标全部由 lib/metrics.ts 的纯函数计算，便于单测。
// 安全边界：只读取受鉴权的只读接口，不执行任何用户提供的 SVG/HTML。

import { memo, useCallback, useEffect, useId, useRef, useState } from 'react'
import { Cpu, HardDrive, MemoryStick, RefreshCw, Thermometer } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { api, isAbortError, isApiError, toErrorMessage } from '../../api/client'
import type { MetricsPoint, MetricsRange, MetricsResult } from '../../api/types'
import { useAppMeta } from '../../meta/MetaContext'
import { usePolling } from '../../hooks/usePolling'
import { Card } from '../Card'
import { Button } from '../Button'
import { EmptyState } from '../EmptyState'
import { InlineError } from '../InlineError'
import { Skeleton } from '../Skeleton'
import { cx } from '../../lib/classnames'
import {
  DEFAULT_METRICS_RANGE,
  METRIC_DEFINITIONS,
  METRICS_RANGES,
  buildChartPaths,
  buildMetricAriaLabel,
  downsampleMetricSeries,
  formatAxisTime,
  metricDetailText,
  metricsRangeLabel,
  summarizeMetricValues,
} from '../../lib/metrics'
import type { MetricDefinition, MetricsChartKind, SeriesSample } from '../../lib/metrics'
import { formatDateTime } from '../../lib/format'

const CHART_WIDTH = 320
const CHART_HEIGHT = 88
const CHART_PADDING = 6

const CHART_ICONS: Record<MetricsChartKind, LucideIcon> = {
  cpu: Cpu,
  memory: MemoryStick,
  temperature: Thermometer,
  disk: HardDrive,
}

interface MetricChartCardProps {
  definition: MetricDefinition
  samples: SeriesSample[]
  lastPoint: MetricsPoint | null
  range: MetricsRange
}

/** 单张趋势卡：当前值 + SVG 折线 + 时间轴 + 统计摘要。 */
const MetricChartCard = memo(function MetricChartCard({ definition, samples, lastPoint, range }: MetricChartCardProps) {
  const rawGradientId = useId()
  const gradientId = `metric-gradient-${rawGradientId.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const values = samples.map((sample) => sample.value)
  const summary = summarizeMetricValues(values)
  const { min, max } = definition.range(values)
  const paths = buildChartPaths(values, CHART_WIDTH, CHART_HEIGHT, min, max, CHART_PADDING)
  const tone = definition.tone(summary.current)
  const first = samples[0] ?? null
  const last = samples[samples.length - 1] ?? null
  const Icon = CHART_ICONS[definition.kind]
  const latestMarker = paths.markers[paths.markers.length - 1] ?? null

  const formatValue = (value: number | null): string =>
    value === null ? '—' : definition.format(value)

  return (
    <article className={cx('metric-card', `metric-card-tone-${tone}`)} aria-label={definition.label}>
      <header className="metric-card-header">
        <span className="metric-card-icon" aria-hidden="true">
          <Icon size={17} />
        </span>
        <div className="metric-card-heading">
          <h3 className="metric-card-title">{definition.label}</h3>
          <p className="metric-card-description">{definition.description}</p>
        </div>
      </header>

      <div className="metric-card-current">
        <span className={cx('metric-current-value', `metric-tone-${tone}`)}>{formatValue(summary.current)}</span>
        <span className="metric-current-detail">{metricDetailText(definition.kind, lastPoint)}</span>
      </div>

      <div className="metric-chart-wrap">
        {paths.markers.length > 0 ? (
          <svg
            className="metric-chart"
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={buildMetricAriaLabel(definition.kind, range, summary)}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity="0.3" />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0.25, 0.5, 0.75].map((ratio) => (
              <line
                key={ratio}
                className="metric-grid-line"
                x1={CHART_PADDING}
                x2={CHART_WIDTH - CHART_PADDING}
                y1={CHART_PADDING + (CHART_HEIGHT - CHART_PADDING * 2) * ratio}
                y2={CHART_PADDING + (CHART_HEIGHT - CHART_PADDING * 2) * ratio}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {paths.areas.map((area, index) => (
              <path key={`area-${index}`} d={area} fill={`url(#${gradientId})`} stroke="none" />
            ))}
            <path
              d={paths.line}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            {latestMarker ? (
              <circle cx={latestMarker.x} cy={latestMarker.y} r="3" fill="currentColor" stroke="none" />
            ) : null}
          </svg>
        ) : (
          <p className="metric-chart-empty">该时段没有有效数据点</p>
        )}
      </div>

      <div className="metric-axis" aria-hidden="true">
        <span>{first ? formatAxisTime(first.t, range) : '—'}</span>
        <span>{last ? formatAxisTime(last.t, range) : '—'}</span>
      </div>

      <dl className="metric-stats">
        <div className="metric-stat">
          <dt>平均</dt>
          <dd>{formatValue(summary.average)}</dd>
        </div>
        <div className="metric-stat">
          <dt>最低</dt>
          <dd>{formatValue(summary.min)}</dd>
        </div>
        <div className="metric-stat">
          <dt>最高</dt>
          <dd>{formatValue(summary.max)}</dd>
        </div>
      </dl>
    </article>
  )
})

function MetricsSkeleton() {
  return (
    <div className="metrics-grid" aria-hidden="true">
      {Array.from({ length: METRIC_DEFINITIONS.length }, (_, index) => (
        <div className="metric-card metric-card-skeleton" key={index}>
          <Skeleton height={16} width="42%" />
          <Skeleton height={28} width="55%" />
          <Skeleton height={88} radius="8px" />
          <Skeleton height={11} width="100%" />
        </div>
      ))}
    </div>
  )
}

/** 指标趋势区：范围切换、60s 轮询、加载/空数据/错误降级；对父级重渲染做 memo 隔离。 */
export const MetricsCharts = memo(function MetricsCharts() {
  const { meta } = useAppMeta()
  const [range, setRange] = useState<MetricsRange>(DEFAULT_METRICS_RANGE)
  const [data, setData] = useState<MetricsResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  // 旧服务端没有 /api/metrics（404）：显示“未启用”，不当作错误
  const [unavailable, setUnavailable] = useState(false)
  const dataRef = useRef<MetricsResult | null>(null)
  const requestIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const enabled = meta.metricsEnabled

  const load = useCallback(
    async (mode: 'initial' | 'refresh'): Promise<void> => {
      if (!enabled) {
        setLoading(false)
        return
      }
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      const requestId = requestIdRef.current + 1
      requestIdRef.current = requestId
      if (mode === 'initial') setLoading(true)
      else setRefreshing(true)
      try {
        const result = await api.getMetrics(range, controller.signal)
        if (requestId !== requestIdRef.current) return
        dataRef.current = result
        setData(result)
        setUnavailable(false)
        setError(null)
        setRefreshError(null)
      } catch (loadError) {
        if (isAbortError(loadError) || requestId !== requestIdRef.current) return
        if (isApiError(loadError) && loadError.status === 404) {
          setUnavailable(true)
          setError(null)
          setRefreshError(null)
          return
        }
        const message = toErrorMessage(loadError, '加载指标历史失败')
        if (dataRef.current) setRefreshError(message)
        else setError(message)
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    },
    [enabled, range],
  )

  // 切换范围时丢弃旧范围的数据，避免横轴与数值错配
  useEffect(() => {
    dataRef.current = null
    setData(null)
    setError(null)
    setRefreshError(null)
    void load('initial')
  }, [load])

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  usePolling(() => load('refresh'), 60_000, enabled)

  if (!enabled) {
    return (
      <Card title="指标趋势" description="服务端未启用历史采样">
        <div className="notice notice-muted">
          指标历史未启用（/api/version metricsEnabled=false），工作台仍显示实时主机指标。
        </div>
      </Card>
    )
  }

  if (unavailable) {
    return (
      <Card title="指标趋势" description="指标历史接口不可用">
        <div className="notice notice-muted">
          服务端尚未提供指标历史接口（GET /api/metrics 返回 404）；升级服务端后会自动显示趋势。
        </div>
      </Card>
    )
  }

  const series = data?.series ?? []
  const samplesByKind = new Map<MetricsChartKind, { samples: SeriesSample[]; lastPoint: MetricsPoint | null }>()
  if (data) {
    const lastPoint = series.length > 0 ? (series[series.length - 1] ?? null) : null
    for (const definition of METRIC_DEFINITIONS) {
      samplesByKind.set(definition.kind, {
        samples: downsampleMetricSeries(series, definition.pick),
        lastPoint,
      })
    }
  }

  return (
    <Card
      title="指标趋势"
      description={
        data
          ? `${metricsRangeLabel(range)}历史 · 每 ${meta.metricsSampleSeconds} 秒采样 · 最近刷新 ${formatDateTime(data.to)}`
          : `按范围查看 ${metricsRangeLabel(range)}历史指标`
      }
      className="metrics-card-container"
      actions={
        <>
          <div className="segmented metric-range-tabs" role="group" aria-label="指标时间范围">
            {METRICS_RANGES.map((option) => (
              <button
                key={option.value}
                type="button"
                className={cx('segmented-button', range === option.value && 'segmented-button-active')}
                aria-pressed={range === option.value}
                onClick={() => {
                  if (range !== option.value) setRange(option.value)
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新指标历史"
            title="刷新"
            loading={refreshing}
            onClick={() => void load('refresh')}
            icon={<RefreshCw size={16} aria-hidden="true" />}
          />
        </>
      }
    >
      {refreshError ? (
        <div className="notice notice-warning" role="alert">
          <span>指标刷新失败：{refreshError}，当前显示上次成功的数据。</span>
          <Button size="sm" variant="secondary" onClick={() => void load('refresh')}>重试</Button>
        </div>
      ) : null}

      {loading && !data ? (
        <MetricsSkeleton />
      ) : error && !data ? (
        <InlineError message={error} onRetry={() => void load('initial')} />
      ) : data && series.length === 0 ? (
        <EmptyState
          compact
          icon={<Cpu size={22} />}
          title="暂无历史指标"
          description={
            meta.metricsEnabled
              ? '服务端每分钟采样一次，稍后再回来查看；关闭采样不会影响已有历史数据。'
              : '服务端未启用指标采样。'
          }
          action={<Button variant="secondary" size="sm" onClick={() => void load('initial')}>刷新</Button>}
        />
      ) : (
        <div className="metrics-grid">
          {METRIC_DEFINITIONS.map((definition) => {
            const entry = samplesByKind.get(definition.kind)
            return (
              <MetricChartCard
                key={definition.kind}
                definition={definition}
                samples={entry?.samples ?? []}
                lastPoint={entry?.lastPoint ?? null}
                range={range}
              />
            )
          })}
        </div>
      )}
    </Card>
  )
})
