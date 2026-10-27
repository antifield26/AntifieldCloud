// 共享时钟：按间隔分组的 useSyncExternalStore 数据源。
// 用途：RelativeTime 等大量叶子组件共享同一个定时器，避免每行一个 interval；
// 页面级时钟放在叶子组件中，父级不再因每秒 tick 重渲染。

type ClockListener = () => void

interface ClockStore {
  now: number
  intervalMs: number
  timer: number | null
  listeners: Set<ClockListener>
}

const stores = new Map<number, ClockStore>()

function getStore(intervalMs: number): ClockStore {
  const normalized = Math.max(250, Math.round(intervalMs))
  const existing = stores.get(normalized)
  if (existing) return existing
  const store: ClockStore = { now: Date.now(), intervalMs: normalized, timer: null, listeners: new Set() }
  stores.set(normalized, store)
  return store
}

function startTimer(store: ClockStore): void {
  if (store.timer !== null || typeof window === 'undefined') return
  store.timer = window.setInterval(() => {
    store.now = Date.now()
    for (const listener of store.listeners) listener()
  }, store.intervalMs)
}

function stopTimerIfIdle(store: ClockStore): void {
  if (store.listeners.size > 0 || store.timer === null) return
  window.clearInterval(store.timer)
  store.timer = null
}

/** 订阅共享时钟；返回取消订阅函数。 */
export function subscribeClock(intervalMs: number, listener: ClockListener): () => void {
  const store = getStore(intervalMs)
  // 订阅时刷新一次，保证新挂载组件拿到当前时间
  store.now = Date.now()
  store.listeners.add(listener)
  startTimer(store)
  return () => {
    store.listeners.delete(listener)
    stopTimerIfIdle(store)
  }
}

/** 读取共享时钟快照（同一 interval 的所有组件共享同一时间戳）。 */
export function getClockSnapshot(intervalMs: number): number {
  return getStore(intervalMs).now
}

/** 测试辅助：清空所有定时器与订阅（仅测试使用）。 */
export function resetSharedClock(): void {
  for (const store of stores.values()) {
    if (store.timer !== null) window.clearInterval(store.timer)
    store.timer = null
    store.listeners.clear()
    store.now = Date.now()
  }
  stores.clear()
}
