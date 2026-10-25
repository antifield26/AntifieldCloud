/**
 * 进程内滑动窗口限流。单进程部署，重启后计数清零可接受。
 * 内存上限：entries 到上限后先清理过期项；若仍满，新 key 统一计入共享 overflow 桶，
 * 不淘汰已有 key（否则攻击者可用大量伪造 key 把受害者计数清零，SEC-07）。
 */

interface Entry {
  timestamps: number[]
}

const SWEEP_INTERVAL_MS = 60_000
const DEFAULT_MAX_ENTRIES = 10_000
/** 容量满时新来源共用的桶；独立于任何 IP/用户 key。 */
const OVERFLOW_KEY = '\u0000overflow'

export class SlidingWindowLimiter {
  private readonly windowMs: number
  private readonly maxHits: number
  private readonly maxEntries: number
  private readonly entries = new Map<string, Entry>()
  /** 容量满时新 key 的共享桶；独立存放，不计入 entries 上限（size 仍 ≤ maxEntries）。 */
  private overflow: Entry | null = null
  private lastSweep = 0

  constructor(windowMs: number, maxHits: number, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.windowMs = windowMs
    this.maxHits = maxHits
    this.maxEntries = Math.max(1, maxEntries)
  }

  /** 容量满且 key 不在表中时映射到 overflow 桶（不驱逐已有 key）。 */
  private bucketKey(key: string, now: number): string {
    if (this.entries.has(key)) return key
    if (this.entries.size < this.maxEntries) return key
    this.sweep(now, true)
    return this.entries.has(key) || this.entries.size < this.maxEntries ? key : OVERFLOW_KEY
  }

  /** 消耗一次配额；超限时返回需要等待的秒数，否则返回 0。 */
  hit(key: string, now: number = Date.now()): number {
    this.sweep(now)
    const bucket = this.bucketKey(key, now)
    const isOverflow = bucket === OVERFLOW_KEY
    const entry = (isOverflow ? this.overflow : this.entries.get(bucket)) ?? { timestamps: [] }
    const threshold = now - this.windowMs
    entry.timestamps = entry.timestamps.filter((ts) => ts > threshold)
    if (entry.timestamps.length >= this.maxHits) {
      const oldest = entry.timestamps[0] ?? now
      if (isOverflow) this.overflow = entry
      else this.entries.set(bucket, entry)
      return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000))
    }
    entry.timestamps.push(now)
    if (isOverflow) this.overflow = entry
    else this.entries.set(bucket, entry)
    return 0
  }

  /** 仅查询，不消耗配额。 */
  retryAfter(key: string, now: number = Date.now()): number {
    const entry = this.entries.get(key) ?? this.overflow
    if (!entry) return 0
    const threshold = now - this.windowMs
    const recent = entry.timestamps.filter((ts) => ts > threshold)
    if (recent.length < this.maxHits) return 0
    const oldest = recent[0] ?? now
    return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000))
  }

  reset(key: string): void {
    this.entries.delete(key)
    this.overflow = null
  }

  /** 当前条目数（测试/诊断用）。 */
  get size(): number {
    return this.entries.size
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
