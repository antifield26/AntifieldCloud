import { useCallback, useSyncExternalStore } from 'react'
import { getClockSnapshot, subscribeClock } from '../lib/clock'

/**
 * 周期性返回当前时间戳，用于时钟与相对时间刷新。
 * 使用共享时钟：相同 interval 的组件共用一个定时器，避免每行独立 interval。
 * subscribe/getSnapshot 用 useCallback 稳定引用，避免父级重渲染时反复订阅。
 */
export function useNow(intervalMs = 1000): number {
  const subscribe = useCallback(
    (listener: () => void) => subscribeClock(intervalMs, listener),
    [intervalMs],
  )
  const getSnapshot = useCallback(() => getClockSnapshot(intervalMs), [intervalMs])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
