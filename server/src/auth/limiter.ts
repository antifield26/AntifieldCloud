/**
 * 进程内滑动窗口限流。单进程部署，重启后计数清零可接受。
 * 内存上限：entries 超过 maxEntries 时先清理过期项，再按最近最少使用顺序淘汰，
 * 避免伪造 IP/大量来源把内存打满（被淘汰的 key 会重新获得全新计数）。
 */

interface Entry {
  timestamps: number[]
}

const SWEEP_INTERVAL_MS = 60_000
const DEFAULT_MAX_ENTRIES = 10_000

export class SlidingWindowLimiter {
  private readonly windowMs: number
  private readonly maxHits: number
  private readonly maxEntries: number
  private readonly entries = new Map<string, Entry>()
  private lastSweep = 0

  constructor(windowMs: number, maxHits: number, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.windowMs = windowMs
    this.maxHits = maxHits
    this.maxEntries = Math.max(1, maxEntries)
  }

  /** 消耗一次配额；超限时返回需要等待的秒数，否则返回 0。 */
  hit(key: string, now: number = Date.now()): number {
    this.sweep(now)
    this.ensureCapacity(now)
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

  /** 当前条目数（测试/诊断用）。 */
  get size(): number {
    return this.entries.size
  }

  private ensureCapacity(now: number): void {
    if (this.entries.size < this.maxEntries) return
    this.sweep(now, true)
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }

  private sweep(now: number, force = false): void {
    if (!force && now - this.lastSweep < SWEEP_INTERVAL_MS) return
    this.lastSweep = now
    const threshold = now - this.windowMs
    for (const [key, entry] of this.entries) {
      const recent = entry.timestamps.filter((ts) => ts > threshold)
      if (recent.length === 0) this.entries.delete(key)
      else entry.timestamps = recent
    }
  }
}
