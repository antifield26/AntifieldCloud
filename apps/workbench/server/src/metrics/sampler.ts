/**
 * 指标采样器：按 METRICS_SAMPLE_SECONDS 周期读取 HostMonitor 快照与文件配额用量并写入历史。
 *
 * 约束：
 * - 定时器在 listen 之后由 main.ts 通过 AppContext.startMetrics() 启动；metricsEnabled=false 时不启动。
 * - 单次采样失败只记 warn，不让定时器异常终止；测试直接调用 sampleOnce()，不启动定时器。
 * - 定时器 unref，不阻止进程退出。
 */
import type { Config } from '../config.ts'
import type { FileService } from '../files/service.ts'
import type { HostMetrics } from '../dashboard/system.ts'
import type { MetricsSampleInput, MetricsService } from './service.ts'

export interface MetricsHost {
  snapshot(): HostMetrics
}

export interface MetricsSamplerDeps {
  config: Config
  metrics: MetricsService
  host: MetricsHost
  files: FileService
  log?: (level: 'warn', message: string, detail?: Record<string, unknown>) => void
}

export interface MetricsSampler {
  /** 立即采样一次；返回是否成功（不抛错）。 */
  sampleOnce(): boolean
  start(): void
  stop(): void
}

export function createMetricsSampler(deps: MetricsSamplerDeps): MetricsSampler {
  const log = deps.log ?? (() => {})
  let timer: ReturnType<typeof setInterval> | null = null

  function sampleOnce(): boolean {
    try {
      const host = deps.host.snapshot()
      // 顺带读取配额用量：磁盘剩余以数据目录 statfs 为准，主机根分区总量用于百分比基准。
      const usage = deps.files.usage()
      const sample: MetricsSampleInput = {
        cpuPercent: host.cpuPercent,
        memUsedBytes: host.mem.totalBytes - host.mem.availableBytes,
        memTotalBytes: host.mem.totalBytes,
        tempC: host.tempC,
        diskFreeBytes: usage.freeBytes > 0 ? usage.freeBytes : host.root.freeBytes,
        diskTotalBytes: host.root.totalBytes,
        load1: host.load[0],
        load5: host.load[1],
        load15: host.load[2],
      }
      deps.metrics.record(sample)
      return true
    } catch (error) {
      log('warn', '指标采样失败', { error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  return {
    sampleOnce,
    start() {
      if (timer) return
      sampleOnce()
      timer = setInterval(() => {
        sampleOnce()
      }, Math.max(10, deps.config.metricsSampleSeconds) * 1000)
      timer.unref?.()
    },
    stop() {
      if (!timer) return
      clearInterval(timer)
      timer = null
    },
  }
}
