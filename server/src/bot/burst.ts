/**
 * 连续消息合并器：同一会话（Bot×目标×用户）在短窗口内的多条消息合并为一次处理，
 * 不同会话互不阻塞，同一会话严格串行，避免并发回复乱序或上下文互相覆盖。
 *
 * 约束：
 * - 只做内存缓冲，不落库；每条消息的入站事件仍由调用方在收到时写入。
 * - 窗口从首条消息开始计最大等待，后续消息重置防抖计时但不超过 maxWaitMs；
 *   达到 maxItems 立即触发，避免长消息轰炸无限等待。
 * - 处理期间到达的消息进入下一批，当前批结束后再按窗口合并；stop 会丢弃未处理缓冲。
 */
export interface BurstMergerOptions<T> {
  /** 防抖窗口；0 表示不合并（仍保证同一 key 串行）。 */
  windowMs: number
  /** 从首条消息起最长等待，避免持续输入导致永不回复。 */
  maxWaitMs: number
  /** 单批最大消息数；达到后立即触发。 */
  maxItems: number
  onFlush: (key: string, items: T[]) => Promise<void>
  onError?: (error: unknown, key: string) => void
}

interface BurstState<T> {
  items: T[]
  firstAt: number
  timer: NodeJS.Timeout | null
  running: boolean
  windowMs: number
  maxWaitMs: number
  /** 已被 clear 丢弃：运行中的批次在 finally 里不得再为这个 state 排队（/reset 清空语义）。 */
  cancelled: boolean
}

/** 单次入队可覆盖默认窗口（例如全量群聊使用更长合并时间）。 */
export interface BurstTiming {
  windowMs?: number
  maxWaitMs?: number
}

export class BurstMerger<T> {
  private readonly states = new Map<string, BurstState<T>>()
  private readonly inflight = new Set<Promise<void>>()
  private readonly options: BurstMergerOptions<T>

  constructor(options: BurstMergerOptions<T>) {
    this.options = options
  }

  enqueue(key: string, item: T, timing: BurstTiming = {}): void {
    let state = this.states.get(key)
    if (!state) {
      state = {
        items: [],
        firstAt: Date.now(),
        timer: null,
        running: false,
        windowMs: timing.windowMs ?? this.options.windowMs,
        maxWaitMs: timing.maxWaitMs ?? this.options.maxWaitMs,
        cancelled: false,
      }
      this.states.set(key, state)
    } else {
      // 同一会话中途切换模式时，用最新时序覆盖后续批次。
      if (timing.windowMs !== undefined) state.windowMs = timing.windowMs
      if (timing.maxWaitMs !== undefined) state.maxWaitMs = timing.maxWaitMs
    }
    state.items.push(item)
    if (state.windowMs <= 0 || state.items.length >= this.options.maxItems) {
      this.trigger(key, state)
      return
    }
    if (state.running) return
    this.schedule(key, state)
  }

  /** 丢弃某会话（/reset、/forget、角色变更等），避免旧缓冲在操作后继续回复。 */
  clear(key?: string): void {
    const discard = (state: BurstState<T>): void => {
      state.cancelled = true
      if (state.timer) clearTimeout(state.timer)
      state.timer = null
      // 运行中的批次由 flush 持有引用；清空 items 并标记 cancelled，防止其 finally 再为旧消息排队。
      state.items = []
    }
    if (key !== undefined) {
      const state = this.states.get(key)
      if (state) discard(state)
      this.states.delete(key)
      return
    }
    for (const state of this.states.values()) discard(state)
    this.states.clear()
  }

  /** 立即处理所有缓冲并等待当前批次结束（测试/停机使用）；处理期间新到的消息也会排空。 */
  async drain(): Promise<void> {
    for (;;) {
      const tasks: Promise<void>[] = []
      for (const [key, state] of this.states) {
        if (state.items.length > 0) tasks.push(this.flush(key, state))
      }
      if (tasks.length > 0) await Promise.allSettled(tasks)
      while (this.inflight.size > 0) {
        await Promise.allSettled([...this.inflight])
      }
      if (this.states.size === 0) return
      // 处理期间可能又有新消息；继续下一轮，直到没有缓冲。
    }
  }

  /** 立即触发所有缓冲（不等待内部完成），用于测试可控时钟；返回触发后的等待。 */
  flushAll(): Promise<void> {
    const tasks: Promise<void>[] = []
    for (const [key, state] of this.states) {
      if (state.items.length > 0) {
        tasks.push(this.flush(key, state))
      } else {
        this.states.delete(key)
      }
    }
    return Promise.allSettled(tasks).then(() => undefined)
  }

  stop(): void {
    this.clear()
  }

  private schedule(key: string, state: BurstState<T>): void {
    if (state.cancelled) return
    if (state.timer) clearTimeout(state.timer)
    const now = Date.now()
    const deadline = Math.min(now + Math.max(0, state.windowMs), state.firstAt + state.maxWaitMs)
    const delay = Math.max(0, deadline - now)
    state.timer = setTimeout(() => {
      state.timer = null
      void this.flush(key, state)
    }, delay)
  }

  private trigger(key: string, state: BurstState<T>): void {
    if (state.cancelled) return
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    void this.flush(key, state)
  }

  private async flush(key: string, state: BurstState<T>): Promise<void> {
    if (state.cancelled) return
    if (state.running) return
    if (state.items.length === 0) {
      this.states.delete(key)
      return
    }
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    const items = state.items
    state.items = []
    state.firstAt = Date.now()
    state.running = true
    const task = (async () => {
      try {
        await this.options.onFlush(key, items)
      } catch (error) {
        this.options.onError?.(error, key)
      }
    })()
    this.inflight.add(task)
    try {
      await task
    } finally {
      this.inflight.delete(task)
      state.running = false
      if (state.cancelled) {
        this.states.delete(key)
      } else if (state.items.length > 0) {
        if (state.windowMs <= 0) void this.flush(key, state)
        else this.schedule(key, state)
      } else {
        this.states.delete(key)
      }
    }
  }
}
