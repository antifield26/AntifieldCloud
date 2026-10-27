import { describe, expect, it } from 'vitest'
import type { MetricsPoint } from '../api/types'
import {
  METRICS_RANGES,
  buildChartPaths,
  buildMetricAriaLabel,
  downsampleMetricSeries,
  formatAxisTime,
  isMetricsRange,
  metricDefinition,
  metricDetailText,
  metricValueRange,
  metricsRangeLabel,
  summarizeMetricValues,
} from './metrics'

function point(overrides: Partial<MetricsPoint> = {}): MetricsPoint {
  return {
    ts: '2026-10-20T00:00:00.000Z',
    cpuPercent: 10,
    memUsedBytes: 1024,
    memTotalBytes: 4096,
    memUsedPct: 25,
    tempC: 45,
    diskFreeBytes: 2048,
    diskTotalBytes: 4096,
    diskFreePct: 50,
    load1: 0.5,
    ...overrides,
  }
}

describe('metrics 范围元数据', () => {
  it('五个范围与 API 契约一致', () => {
    expect(METRICS_RANGES.map((item) => item.value)).toEqual(['1h', '6h', '24h', '7d', '30d'])
    expect(metricsRangeLabel('24h')).toBe('24 小时')
  })

  it('合法范围判定', () => {
    expect(isMetricsRange('1h')).toBe(true)
    expect(isMetricsRange('2h')).toBe(false)
  })
})

describe('downsampleMetricSeries', () => {
  it('点数不足时原样返回并提取字段', () => {
    const series = [point({ cpuPercent: 1 }), point({ cpuPercent: 2 })]
    const samples = downsampleMetricSeries(series, (item) => item.cpuPercent, 120)
    expect(samples.map((sample) => sample.value)).toEqual([1, 2])
  })

  it('超过上限时按桶平均并保留时间顺序', () => {
    const series = Array.from({ length: 240 }, (_, index) =>
      point({ ts: new Date(Date.UTC(2026, 9, 20, 0, index, 0)).toISOString(), cpuPercent: index }),
    )
    const samples = downsampleMetricSeries(series, (item) => item.cpuPercent, 120)
    expect(samples).toHaveLength(120)
    expect(samples[0]?.value).toBeCloseTo(0.5)
    expect(samples[1]?.value).toBeCloseTo(2.5)
    expect(samples[119]?.value).toBeCloseTo(238.5)
    expect(samples[0]?.t).toBeLessThan(samples[samples.length - 1]?.t ?? 0)
  })

  it('桶内没有有效值时保留 null，不按 0 处理', () => {
    const series = Array.from({ length: 4 }, (_, index) =>
      point({ ts: new Date(Date.UTC(2026, 9, 20, 0, index, 0)).toISOString(), tempC: null }),
    )
    const samples = downsampleMetricSeries(series, (item) => item.tempC, 2)
    expect(samples.map((sample) => sample.value)).toEqual([null, null])
  })

  it('空序列返回空数组，非法时间戳回退到桶序号', () => {
    expect(downsampleMetricSeries([], (item) => item.cpuPercent)).toEqual([])
    const samples = downsampleMetricSeries([point({ ts: 'not-a-time', cpuPercent: 7 })], (item) => item.cpuPercent)
    expect(samples[0]).toEqual({ t: 0, value: 7 })
  })
})

describe('summarizeMetricValues', () => {
  it('忽略 null 并回溯最近有效值', () => {
    const summary = summarizeMetricValues([10, null, 20, 30, null])
    expect(summary.count).toBe(3)
    expect(summary.current).toBe(30)
    expect(summary.average).toBe(20)
    expect(summary.min).toBe(10)
    expect(summary.max).toBe(30)
  })

  it('全部为 null 时返回空统计', () => {
    const summary = summarizeMetricValues([null, null])
    expect(summary).toEqual({ count: 0, current: null, average: null, min: null, max: null })
  })
})

describe('metricValueRange', () => {
  it('默认包含 0 并保证最小跨度', () => {
    expect(metricValueRange([50, 60], { minSpan: 10 })).toEqual({ min: 0, max: 60 })
    expect(metricValueRange([55, 56], { includeZero: false, minSpan: 10 })).toEqual({ min: 50.5, max: 60.5 })
    expect(metricValueRange([])).toEqual({ min: 0, max: 1 })
  })

  it('温度范围不包含 0 时按数据自适应', () => {
    const range = metricValueRange([42, 44], { includeZero: false, minSpan: 5 })
    expect(range.min).toBeCloseTo(40.5)
    expect(range.max).toBeCloseTo(45.5)
  })

  it('平坦数据仍给出可渲染区间', () => {
    const range = metricValueRange([0, 0, 0], { includeZero: true, minSpan: 0 })
    expect(range.max).toBeGreaterThan(range.min)
  })

  it('默认包含 0；显式关闭时支持负值区间', () => {
    // 默认 includeZero=true：负数数据也会把 0 纳入范围
    expect(metricValueRange([5, 20])).toEqual({ min: 0, max: 20 })
    expect(metricValueRange([-5, 5])).toEqual({ min: -5, max: 5 })
    expect(metricValueRange([-10, -5], { includeZero: false })).toEqual({ min: -10, max: -5 })
    // 全 null / 空数组统一回退到可渲染的非零区间
    expect(metricValueRange([null, null])).toEqual({ min: 0, max: 1 })
    expect(metricValueRange([null, null], { includeZero: false })).toEqual({ min: 0, max: 1 })
  })
})

describe('buildChartPaths', () => {
  it('把数值映射到 SVG 坐标并标记最后一点', () => {
    const paths = buildChartPaths([0, 50, 100], 320, 88, 0, 100, 0)
    expect(paths.line).toBe('M0 88 L160 44 L320 0')
    expect(paths.markers).toHaveLength(3)
    expect(paths.markers[2]).toEqual({ x: 320, y: 0, value: 100 })
    expect(paths.areas[0]).toBe('M0 88 L160 44 L320 0 L320 88 L0 88 Z')
  })

  it('null 处断开折线，不连接缺失区间', () => {
    const paths = buildChartPaths([10, null, 30], 100, 40, 0, 40, 0)
    expect(paths.line).toBe('M0 30 M100 10')
    expect(paths.markers).toHaveLength(2)
    expect(paths.areas).toHaveLength(0)
  })

  it('单点序列居中且不出面积', () => {
    const paths = buildChartPaths([5], 100, 40, 0, 10, 0)
    expect(paths.line).toBe('M50 20')
    expect(paths.areas).toEqual([])
  })

  it('空序列返回空路径', () => {
    expect(buildChartPaths([], 100, 40, 0, 1)).toEqual({ line: '', areas: [], markers: [] })
  })
})

describe('格式化与描述', () => {
  it('横轴时间按范围切换格式（Asia/Shanghai）', () => {
    const timestamp = Date.parse('2026-10-20T00:00:00.000Z')
    expect(formatAxisTime(timestamp, '1h')).toBe('08:00')
    expect(formatAxisTime(timestamp, '24h')).toBe('08:00')
    expect(formatAxisTime(timestamp, '7d')).toBe('10-20')
    expect(formatAxisTime(Number.NaN, '1h')).toBe('—')
  })

  it('指标定义输出百分比/温度与阈值色调', () => {
    const cpu = metricDefinition('cpu')
    expect(cpu.format(12.34)).toBe('12.3%')
    expect(cpu.tone(95)).toBe('warning')
    expect(cpu.tone(null)).toBe('default')
    const temp = metricDefinition('temperature')
    expect(temp.format(48.25)).toBe('48.3 ℃')
    expect(temp.tone(80)).toBe('warning')
    expect(temp.tone(90)).toBe('danger')
    const disk = metricDefinition('disk')
    expect(disk.tone(8)).toBe('danger')
    expect(disk.tone(18)).toBe('warning')
    expect(disk.tone(60)).toBe('default')
  })

  it('无障碍描述包含当前/平均/极值', () => {
    const label = buildMetricAriaLabel('cpu', '24h', {
      count: 3,
      current: 30,
      average: 20,
      min: 10,
      max: 30,
    })
    expect(label).toContain('CPU 使用率趋势，24 小时')
    expect(label).toContain('当前 30.0%')
    expect(label).toContain('平均 20.0%')
    expect(label).toContain('最高 30.0%')
  })

  it('卡片明细展示内存与磁盘用量', () => {
    expect(metricDetailText('memory', point({ memUsedBytes: 1024, memTotalBytes: 4096 }))).toBe('1 KB / 4 KB')
    expect(metricDetailText('disk', point({ diskFreeBytes: 2048, diskTotalBytes: 4096 }))).toBe('剩余 2 KB / 4 KB')
    expect(metricDetailText('cpu', point({ load1: 0.5 }))).toContain('1 分钟负载 0.50')
    expect(metricDetailText('cpu', null)).toBe('暂无数据')
  })
})
