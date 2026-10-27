import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getClockSnapshot, resetSharedClock, subscribeClock } from './clock'

beforeEach(() => {
  vi.useFakeTimers()
  resetSharedClock()
})

afterEach(() => {
  resetSharedClock()
  vi.useRealTimers()
})

describe('共享时钟', () => {
  it('相同间隔的订阅共用同一个定时器', () => {
    const first = vi.fn()
    const second = vi.fn()
    const unsubFirst = subscribeClock(1000, first)
    const unsubSecond = subscribeClock(1000, second)

    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)

    unsubFirst()
    expect(vi.getTimerCount()).toBe(1)
    unsubSecond()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('不同间隔各自计时，快照随时间推进', () => {
    const fast = vi.fn()
    const slow = vi.fn()
    const unsubFast = subscribeClock(1000, fast)
    const unsubSlow = subscribeClock(30_000, slow)
    expect(vi.getTimerCount()).toBe(2)

    const before = getClockSnapshot(1000)
    vi.advanceTimersByTime(1000)
    expect(getClockSnapshot(1000)).toBeGreaterThan(before)
    expect(fast).toHaveBeenCalledTimes(1)
    expect(slow).not.toHaveBeenCalled()

    unsubFast()
    unsubSlow()
  })
})
