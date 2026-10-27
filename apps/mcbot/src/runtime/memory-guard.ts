/**
 * 内存治理：周期检查进程 RSS，超过阈值时通过回调告警（带冷却），不抛错、不重启进程。
 * 阈值 0 表示关闭；只看 RSS，避免把临时 heap 波动误判为泄漏。
 */
export interface MemoryGuardOptions {
  limitMb: number
  checkMs: number
  logger: { warn: (message: string, details?: Record<string, unknown>) => void }
  onHigh: (rssMb: number, limitMb: number) => void
  cooldownMs?: number
  now?: () => number
  memoryUsage?: () => NodeJS.MemoryUsage
}

export function toRssMb (usage: Pick<NodeJS.MemoryUsage, 'rss'>): number {
  return Math.round((usage.rss / (1024 * 1024)) * 10) / 10
}

export class MemoryGuard {
  private readonly options: MemoryGuardOptions
  private timer: NodeJS.Timeout | null = null
  private lastAlertAt = Number.NEGATIVE_INFINITY
  private running = false

  constructor (options: MemoryGuardOptions) {
    this.options = { ...options, cooldownMs: options.cooldownMs ?? 5 * 60_000 }
  }

  start (): void {
    if (this.running || this.options.limitMb <= 0) return
    this.running = true
    this.timer = setInterval(() => { this.check() }, Math.max(1000, this.options.checkMs))
    this.timer.unref?.()
    this.check()
  }

  stop (): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 返回本轮是否仍处于超限状态；告警按冷却窗口触发。 */
  check (): boolean {
    if (!this.running || this.options.limitMb <= 0) return false
    const usage = (this.options.memoryUsage ?? process.memoryUsage)()
    const rssMb = toRssMb(usage)
    if (rssMb <= this.options.limitMb) return false
    const now = (this.options.now ?? Date.now)()
    if (now - this.lastAlertAt >= (this.options.cooldownMs ?? 0)) {
      this.lastAlertAt = now
      this.options.logger.warn('memory guard: rss above limit', { rssMb, limitMb: this.options.limitMb })
      this.options.onHigh(rssMb, this.options.limitMb)
    }
    return true
  }
}
