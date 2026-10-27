import { useEffect, useRef } from 'react'

/**
 * 轮询调度：页面隐藏时暂停请求，重新可见时立即拉取一次。
 * 回调内的异常由调用方处理，本 hook 不吞掉业务错误提示。
 */
export function usePolling(callback: () => void | Promise<void>, intervalMs: number, enabled = true): void {
  const savedCallback = useRef(callback)
  useEffect(() => {
    savedCallback.current = callback
  })

  useEffect(() => {
    if (!enabled) return
    let stopped = false
    let inFlight = false
    let timer: number | undefined

    const schedule = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void tick()
      }, intervalMs)
    }

    const tick = async (): Promise<void> => {
      if (stopped) return
      if (document.visibilityState === 'visible' && !inFlight) {
        inFlight = true
        try {
          await savedCallback.current()
        } catch {
          // 错误由调用方写入状态并展示
        } finally {
          inFlight = false
        }
      }
      schedule()
    }

    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') return
      // 页面恢复可见时立即补一次；若上次请求仍在进行则跳过，避免重复/乱序。
      if (!inFlight) void tick()
    }

    schedule()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      stopped = true
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [enabled, intervalMs])
}
