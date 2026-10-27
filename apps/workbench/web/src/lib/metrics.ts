// 指标历史展示的纯函数：范围元数据、服务端桶数据的展示侧降采样、SVG 几何与格式化。
// 约束：服务端已按桶聚合（最多 240 点），本模块只做展示侧处理，不改变数据语义；
// 空值（温度不可得）在平均与折线中跳过，不当作 0，避免图表误导。

import type { MetricsPoint, MetricsRange } from '../api/types'
import { formatBytes } from './format'

export interface MetricsRangeOption {
  value: MetricsRange
  label: string
}

/** 时间范围切换项；与 docs/app/API.md §12 的 range 取值一致。 */
export const METRICS_RANGES: MetricsRangeOption[] = [
  { value: '1h', label: '1 小时' },
  { value: '6h', label: '6 小时' },
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
]

export const DEFAULT_METRICS_RANGE: MetricsRange = '24h'

/** 服务端聚合桶默认上限；超过时图表再降采样到该点数。 */
export const MAX_CHART_POINTS = 120

const TIME_ZONE = 'Asia/Shanghai'

export function isMetricsRange(value: string): value is MetricsRange {
  return METRICS_RANGES.some((option) => option.value === value)
}

export function metricsRangeLabel(range: MetricsRange): string {
  return METRICS_RANGES.find((option) => option.value === range)?.label ?? range
}

/* ---------- 指标定义 ---------- */

export type MetricsChartKind = 'cpu' | 'memory' | 'temperature' | 'disk'
export type MetricTone = 'default' | 'warning' | 'danger'

export interface MetricDefinition {
  kind: MetricsChartKind
  label: string
  /** 卡片顶部的一句话说明 */
  description: string
  /** 从聚合点取值的字段访问器 */
  pick: (point: MetricsPoint) => number | null
  format: (value: number) => string
  tone: (value: number | null) => MetricTone
  /** SVG 纵轴范围；百分比类固定 0–100，温度按数据自适应 */
  range: (values: (number | null)[]) => { min: number; max: number }
}

function percentTone(value: number | null, warning: number): MetricTone {
  if (value === null) return 'default'
  return value >= warning ? 'warning' : 'default'
}

export const METRIC_DEFINITIONS: MetricDefinition[] = [
  {
    kind: 'cpu',
    label: 'CPU 使用率',
    description: '近段时间的平均 CPU 占用',
    pick: (point) => point.cpuPercent,
    format: (value) => `${value.toFixed(1)}%`,
    tone: (value) => percentTone(value, 90),
    range: () => ({ min: 0, max: 100 }),
  },
  {
    kind: 'memory',
    label: '内存使用率',
    description: '已用内存占总内存比例',
    pick: (point) => point.memUsedPct,
    format: (value) => `${value.toFixed(1)}%`,
    tone: (value) => percentTone(value, 90),
    range: () => ({ min: 0, max: 100 }),
  },
  {
    kind: 'temperature',
    label: 'CPU 温度',
    description: 'SoC 温度；无法读取时不含数据点',
    pick: (point) => point.tempC,
    format: (value) => `${value.toFixed(1)} ℃`,
    tone: (value) => {
      if (value === null) return 'default'
      if (value >= 85) return 'danger'
      if (value >= 75) return 'warning'
      return 'default'
    },
    range: (values) => {
      const base = metricValueRange(values, { minSpan: 10 })
      return { min: Math.floor(base.min), max: Math.ceil(base.max) }
    },
  },
  {
    kind: 'disk',
    label: '磁盘剩余',
    description: '根分区剩余空间占比（越低越危险）',
    pick: (point) => point.diskFreePct,
    format: (value) => `${value.toFixed(1)}%`,
    tone: (value) => {
      if (value === null) return 'default'
      if (value <= 10) return 'danger'
      if (value <= 20) return 'warning'
      return 'default'
    },
    range: () => ({ min: 0, max: 100 }),
  },
]

export function metricDefinition(kind: MetricsChartKind): MetricDefinition {
  const found = METRIC_DEFINITIONS.find((definition) => definition.kind === kind)
  if (!found) throw new Error(`未知指标类型：${kind}`)
  return found
}

/* ---------- 降采样与统计 ---------- */

export interface SeriesSample {
  /** 毫秒时间戳；服务端 ts 非法时回退到桶序号，保证横轴仍可用 */
  t: number
  value: number | null
}

function toTimestamp(ts: string, fallback: number): number {
  const parsed = Date.parse(ts)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * 按桶平均降采样到最多 maxPoints 个点。
 * - 点数不足时原样返回，只做时间戳解析与字段提取；
 * - 桶内没有有效值时保留 null，让图表出现断点而不是掉到 0。
 */
export function downsampleMetricSeries(
  series: MetricsPoint[],
  pick: (point: MetricsPoint) => number | null,
  maxPoints = MAX_CHART_POINTS,
): SeriesSample[] {
  if (series.length === 0) return []
  const limit = Math.max(1, Math.floor(maxPoints))
  if (series.length <= limit) {
    return series.map((point, index) => ({
      t: toTimestamp(point.ts, index),
      value: normalizeValue(pick(point)),
    }))
  }

  const bucketSize = Math.ceil(series.length / limit)
  const samples: SeriesSample[] = []
  for (let start = 0; start < series.length; start += bucketSize) {
    const end = Math.min(series.length, start + bucketSize)
    let sum = 0
    let count = 0
    let timeSum = 0
    let timeCount = 0
    for (let index = start; index < end; index += 1) {
      const point = series[index]
      if (!point) continue
      const timestamp = Date.parse(point.ts)
      if (Number.isFinite(timestamp)) {
        timeSum += timestamp
        timeCount += 1
      }
      const value = normalizeValue(pick(point))
      if (value !== null) {
        sum += value
        count += 1
      }
    }
    samples.push({
      t: timeCount > 0 ? Math.round(timeSum / timeCount) : start,
      value: count > 0 ? roundTo(sum / count, 3) : null,
    })
  }
  return samples
}

function normalizeValue(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export interface MetricSummary {
  /** 有效数据点数量 */
  count: number
  /** 最近一个有效值（末尾为 null 时向前回溯） */
  current: number | null
  average: number | null
  min: number | null
  max: number | null
}

/** 汇总一段指标序列（忽略 null）：当前值取最近有效点，其余为有效点统计。 */
export function summarizeMetricValues(values: (number | null)[]): MetricSummary {
  let sum = 0
  let count = 0
  let min: number | null = null
  let max: number | null = null
  let current: number | null = null
  for (const raw of values) {
    const value = normalizeValue(raw)
    if (value === null) continue
    sum += value
    count += 1
    if (min === null || value < min) min = value
    if (max === null || value > max) max = value
    current = value
  }
  return {
    count,
    current,
    average: count > 0 ? roundTo(sum / count, 2) : null,
    min,
    max,
  }
}

/**
 * 计算纵轴范围：默认包含 0 并保证最小跨度，避免平坦数据被放大成剧烈波动。
 */
export function metricValueRange(
  values: (number | null)[],
  options: { includeZero?: boolean; minSpan?: number } = {},
): { min: number; max: number } {
  const includeZero = options.includeZero ?? true
  const minSpan = Math.max(0, options.minSpan ?? 1)
  const finite = values
    .map((value) => normalizeValue(value))
    .filter((value): value is number => value !== null)
  if (finite.length === 0) return { min: 0, max: Math.max(1, minSpan) }
  let min = Math.min(...finite)
  let max = Math.max(...finite)
  if (includeZero) min = Math.min(0, min)
  let span = max - min
  if (span < minSpan) {
    const center = (min + max) / 2
    min = center - minSpan / 2
    max = center + minSpan / 2
    span = max - min
  }
  // 极端情况下（全 0 等）给出可渲染的非零区间
  if (span <= 0) {
    min -= 0.5
    max += 0.5
  }
  return { min, max }
}

/* ---------- SVG 几何 ---------- */

export interface ChartMarker {
  x: number
  y: number
  value: number
}

export interface ChartPaths {
  /** 折线路径（null 处断开，使用多段 M 指令） */
  line: string
  /** 面积路径（每段独立闭合到底边） */
  areas: string[]
  /** 有效数据点的像素坐标，用于当前值圆点 */
  markers: ChartMarker[]
}

/**
 * 将数值序列映射为 SVG 路径。横轴按点序号均匀分布，纵轴按 [min,max] 线性映射，
 * null 值会切断折线与面积，避免把缺失数据画成 0。
 */
export function buildChartPaths(
  values: (number | null)[],
  width: number,
  height: number,
  min: number,
  max: number,
  padding = 6,
): ChartPaths {
  const safeWidth = Math.max(1, width)
  const safeHeight = Math.max(1, height)
  const pad = Math.max(0, Math.min(padding, safeWidth / 4, safeHeight / 4))
  const innerWidth = Math.max(0, safeWidth - pad * 2)
  const innerHeight = Math.max(0, safeHeight - pad * 2)
  const span = max - min
  const count = values.length
  const step = count > 1 ? innerWidth / (count - 1) : 0
  const bottom = safeHeight - pad

  const mapY = (value: number): number => {
    const ratio = span > 0 ? (value - min) / span : 0.5
    const clamped = Math.min(1, Math.max(0, ratio))
    return pad + (1 - clamped) * innerHeight
  }

  const segments: ChartMarker[][] = []
  let currentSegment: ChartMarker[] = []
  const markers: ChartMarker[] = []
  values.forEach((raw, index) => {
    const value = normalizeValue(raw)
    if (value === null) {
      if (currentSegment.length > 0) {
        segments.push(currentSegment)
        currentSegment = []
      }
      return
    }
    const x = count > 1 ? pad + step * index : pad + innerWidth / 2
    const marker = { x: roundTo(x, 2), y: roundTo(mapY(value), 2), value }
    currentSegment.push(marker)
    markers.push(marker)
  })
  if (currentSegment.length > 0) segments.push(currentSegment)

  const toLine = (points: ChartMarker[]): string =>
    points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join(' ')

  const lines: string[] = []
  const areas: string[] = []
  for (const segment of segments) {
    lines.push(toLine(segment))
    const first = segment[0]
    const last = segment[segment.length - 1]
    if (!first || !last) continue
    if (segment.length === 1) continue
    const line = toLine(segment)
    areas.push(`${line} L${last.x} ${bottom} L${first.x} ${bottom} Z`)
  }

  return { line: lines.join(' '), areas, markers }
}

/* ---------- 格式化 ---------- */

const clockFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  month: '2-digit',
  day: '2-digit',
})

function formatterParts(timestamp: number, formatter: Intl.DateTimeFormat): Record<string, string> {
  const result: Record<string, string> = {}
  if (!Number.isFinite(timestamp)) return result
  for (const part of formatter.formatToParts(new Date(timestamp))) {
    if (part.type !== 'literal') result[part.type] = part.value
  }
  return result
}

/** 横轴时间标签：小时级范围显示 HH:mm，长范围显示 MM-DD（Asia/Shanghai）。 */
export function formatAxisTime(timestamp: number, range: MetricsRange): string {
  if (!Number.isFinite(timestamp)) return '—'
  const longRange = range === '7d' || range === '30d'
  const parts = formatterParts(timestamp, longRange ? dateFormatter : clockFormatter)
  if (longRange) return `${parts.month ?? '--'}-${parts.day ?? '--'}`
  return `${parts.hour ?? '--'}:${parts.minute ?? '--'}`
}

/** 图表无障碍描述：说明指标、范围、当前/平均/极值，供读屏用户理解趋势。 */
export function buildMetricAriaLabel(
  kind: MetricsChartKind,
  range: MetricsRange,
  summary: MetricSummary,
): string {
  const definition = metricDefinition(kind)
  const format = (value: number | null): string => (value === null ? '无数据' : definition.format(value))
  return [
    `${definition.label}趋势，${metricsRangeLabel(range)}`,
    `当前 ${format(summary.current)}`,
    `平均 ${format(summary.average)}`,
    `最低 ${format(summary.min)}`,
    `最高 ${format(summary.max)}`,
  ].join('，')
}

/** 卡片底部提示：内存显示已用/总量，磁盘显示剩余量提示。 */
export function metricDetailText(kind: MetricsChartKind, point: MetricsPoint | null): string {
  if (!point) return '暂无数据'
  if (kind === 'memory') {
    return `${formatBytes(point.memUsedBytes)} / ${formatBytes(point.memTotalBytes)}`
  }
  if (kind === 'disk') {
    return `剩余 ${formatBytes(point.diskFreeBytes)} / ${formatBytes(point.diskTotalBytes)}`
  }
  if (kind === 'cpu') return `1 分钟负载 ${point.load1.toFixed(2)}`
  return point.tempC === null ? '温度不可用' : '树莓派 SoC 温度'
}
