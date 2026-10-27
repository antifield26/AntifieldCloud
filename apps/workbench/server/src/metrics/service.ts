/**
 * 主机指标历史：采样落库、按时间范围聚合查询与保留期清理。
 *
 * 约束：
 * - 采样来自 HostMonitor（CPU/内存/温度/磁盘/负载），由 sampler 定时写入；本服务不启动定时器。
 * - 查询只读 metrics_samples，按桶聚合：CPU/内存/温度取平均、磁盘剩余取最小值、load1 取平均；
 *   桶宽按「范围秒数 / 240」向上取整，保证最多 240 个点。
 * - range 非法抛 400 invalid_range；空数据返回空 series（前端按空态展示）。
 * - 时间统一 ISO 8601 UTC；ts_epoch 为整数秒，便于按桶整除聚合。
 */
import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../util/errors.ts'

export const METRICS_RANGES = ['1h', '6h', '24h', '7d', '30d'] as const
export type MetricsRange = (typeof METRICS_RANGES)[number]
export const DEFAULT_METRICS_RANGE: MetricsRange = '24h'
/** 每个范围允许的最大返回点数。 */
export const MAX_METRICS_POINTS = 240

const RANGE_SECONDS: Record<MetricsRange, number> = {
  '1h': 3_600,
  '6h': 21_600,
  '24h': 86_400,
  '7d': 604_800,
  '30d': 2_592_000,
}

/** 单条采样输入：与 sampler 采集的 HostMonitor 快照对应。 */
export interface MetricsSampleInput {
  ts?: string
  cpuPercent: number
  memUsedBytes: number
  memTotalBytes: number
  tempC: number | null
  diskFreeBytes: number
  diskTotalBytes: number
  load1: number
  load5: number
  load15: number
}

export interface MetricsSeriesPoint {
  ts: string
  cpuPercent: number
  memUsedBytes: number
  memTotalBytes: number
  memUsedPct: number
  tempC: number | null
  diskFreeBytes: number
  diskTotalBytes: number
  diskFreePct: number
  load1: number
}

export interface MetricsQueryResult {
  range: MetricsRange
  from: string
  to: string
  bucketSeconds: number
  sampleCount: number
  series: MetricsSeriesPoint[]
}

interface AggregateRow {
  bucket: number
  cpu: number | null
  mem_used: number | null
  mem_total: number | null
  temp: number | null
  disk_free: number | null
  disk_total: number | null
  load1: number | null
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

export function parseMetricsRange(input: unknown): MetricsRange {
  if (input === undefined || input === null || input === '') return DEFAULT_METRICS_RANGE
  if (typeof input === 'string' && (METRICS_RANGES as readonly string[]).includes(input)) {
    return input as MetricsRange
  }
  throw new AppError(400, 'invalid_range', 'range 只支持 1h/6h/24h/7d/30d')
}

export class MetricsService {
  private readonly db: DatabaseSync
  private readonly clock: () => Date

  constructor(db: DatabaseSync, options: { now?: () => Date } = {}) {
    this.db = db
    this.clock = options.now ?? (() => new Date())
  }

  /** 写入一条采样；ts 缺省为当前时间。数值非法时抛错（由 sampler 捕获并记日志）。 */
  record(sample: MetricsSampleInput): void {
    const tsRaw = sample.ts ?? this.clock().toISOString()
    const epochMs = Date.parse(tsRaw)
    if (!Number.isFinite(epochMs)) throw new Error('指标采样时间不合法')
    const cpu = finiteNumber(sample.cpuPercent)
    const memUsed = finiteNumber(sample.memUsedBytes)
    const memTotal = finiteNumber(sample.memTotalBytes)
    const diskFree = finiteNumber(sample.diskFreeBytes)
    const diskTotal = finiteNumber(sample.diskTotalBytes)
    const load1 = finiteNumber(sample.load1)
    const load5 = finiteNumber(sample.load5)
    const load15 = finiteNumber(sample.load15)
    if (cpu === null || memUsed === null || memTotal === null || diskFree === null || diskTotal === null) {
      throw new Error('指标采样缺少必要数值')
    }
    if (load1 === null || load5 === null || load15 === null) throw new Error('指标采样缺少负载数值')
    this.db
      .prepare(
        `INSERT INTO metrics_samples (ts, ts_epoch, cpu_percent, mem_used, mem_total, temp_c, disk_free, disk_total, load1, load5, load15)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date(epochMs).toISOString(),
        Math.floor(epochMs / 1000),
        cpu,
        Math.round(memUsed),
        Math.round(memTotal),
        sample.tempC === null ? null : finiteNumber(sample.tempC),
        Math.round(diskFree),
        Math.round(diskTotal),
        load1,
        load5,
        load15,
      )
  }

  /** 按 range 聚合查询；非法 range 抛 400 invalid_range。 */
  query(rangeInput: unknown): MetricsQueryResult {
    const range = parseMetricsRange(rangeInput)
    const toMs = this.clock().getTime()
    const fromMs = toMs - RANGE_SECONDS[range] * 1000
    const bucketSeconds = Math.max(1, Math.ceil(RANGE_SECONDS[range] / MAX_METRICS_POINTS))
    const fromEpoch = Math.floor(fromMs / 1000)
    const toEpoch = Math.floor(toMs / 1000)
    const sampleCount = Number(
      (
        this.db
          .prepare('SELECT COUNT(*) AS c FROM metrics_samples WHERE ts_epoch >= ? AND ts_epoch <= ?')
          .get(fromEpoch, toEpoch) as { c: number }
      ).c,
    )
    const rows = this.db
      .prepare(
        `SELECT CAST(((ts_epoch - ?) / ?) AS INTEGER) AS bucket,
                AVG(cpu_percent) AS cpu,
                AVG(mem_used) AS mem_used,
                MAX(mem_total) AS mem_total,
                AVG(temp_c) AS temp,
                MIN(disk_free) AS disk_free,
                MAX(disk_total) AS disk_total,
                AVG(load1) AS load1
         FROM metrics_samples
         WHERE ts_epoch >= ? AND ts_epoch <= ?
         GROUP BY bucket
         ORDER BY bucket ASC`,
      )
      .all(fromEpoch, bucketSeconds, fromEpoch, toEpoch) as unknown as AggregateRow[]
    const series: MetricsSeriesPoint[] = rows.map((row) => {
      const bucket = Number(row.bucket)
      const memTotal = Number(row.mem_total ?? 0)
      const memUsed = Number(row.mem_used ?? 0)
      const diskTotal = Number(row.disk_total ?? 0)
      const diskFree = Number(row.disk_free ?? 0)
      const temp = row.temp === null ? null : round(Number(row.temp), 1)
      return {
        ts: new Date((fromEpoch + bucket * bucketSeconds) * 1000).toISOString(),
        cpuPercent: round(Number(row.cpu ?? 0), 1),
        memUsedBytes: Math.round(memUsed),
        memTotalBytes: Math.round(memTotal),
        memUsedPct: memTotal > 0 ? round((memUsed / memTotal) * 100, 1) : 0,
        tempC: temp,
        diskFreeBytes: Math.round(diskFree),
        diskTotalBytes: Math.round(diskTotal),
        diskFreePct: diskTotal > 0 ? round((diskFree / diskTotal) * 100, 1) : 0,
        load1: round(Number(row.load1 ?? 0), 2),
      }
    })
    return {
      range,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      bucketSeconds,
      sampleCount,
      series,
    }
  }

  /** 删除超过保留期的采样；返回删除行数。 */
  prune(retentionDays: number): number {
    const days = Math.max(1, Math.floor(retentionDays))
    const cutoffEpoch = Math.floor((this.clock().getTime() - days * 86_400_000) / 1000)
    const result = this.db.prepare('DELETE FROM metrics_samples WHERE ts_epoch < ?').run(cutoffEpoch)
    return Number(result.changes)
  }
}
