/** 进程内滑动窗口限流。单进程部署，重启后计数清零可接受。 */

interface Entry {
  timestamps: number[]
}

export class SlidingWindowLimiter {
  private readonly windowMs: number
  private readonly maxHits: number
  private readonly entries = new Map<string, Entry>()
  private lastSweep = 0

  constructor(windowMs: number, maxHits: number) {
    this.windowMs = windowMs
    this.maxHits = maxHits
  }

  /** 消耗一次配额；超限时返回需要等待的秒数，否则返回 0。 */
  hit(key: string, now: number = Date.now()): number {
    this.sweep(now)
    const entry = this.entries.get(key) ?? { timestamps: [] }
    const threshold = now - this.windowMs
    entry.timestamps = entry.timestamps.filter((ts) => ts > threshold)
    if (entry.timestamps.length >= this.maxHits) {
      const oldest = entry.timestamps[0] ?? now
      this.entries.set(key, entry)
      return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000))
    }
    entry.timestamps.push(now)
    this.entries.set(key, entry)
    return 0
  }

  /** 仅查询，不消耗配额。 */
  retryAfter(key: string, now: number = Date.now()): number {
    const entry = this.entries.get(key)
    if (!entry) return 0
    const threshold = now - this.windowMs
    const recent = entry.timestamps.filter((ts) => ts > threshold)
    if (recent.length < this.maxHits) return 0
    const oldest = recent[0] ?? now
    return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000))
  }

  reset(key: string): void {
    this.entries.delete(key)
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return
    this.lastSweep = now
    const threshold = now - this.windowMs
    for (const [key, entry] of this.entries) {
      const recent = entry.timestamps.filter((ts) => ts > threshold)
      if (recent.length === 0) this.entries.delete(key)
      else entry.timestamps = recent
    }
  }
}
