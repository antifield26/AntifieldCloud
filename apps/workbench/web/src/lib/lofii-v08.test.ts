import { describe, expect, it } from 'vitest'
import {
  lofiiAlertTypeLabel,
  lofiiEventsSupported,
  lofiiSeverityLabel,
  lofiiTaskNameLabel,
  lofiiTaskProgressRows,
  safeLofiiStatus,
} from './lofii'
import type { LofiiSnapshot, LofiiStatus } from '../api/types'

const emptySnapshot = (overrides: Partial<LofiiSnapshot> = {}): LofiiSnapshot => ({
  enabled: true,
  reachable: true,
  stale: false,
  controlEnabled: true,
  alertsEnabled: true,
  eventsSupported: true,
  version: '0.6.0',
  contractVersion: 1,
  lastPollAt: null,
  error: null,
  status: null,
  events: [],
  ...overrides,
})

describe('Lofii v0.8.0 展示层容错', () => {
  it('status 缺嵌套段时归一化为可渲染默认值', () => {
    const normalized = safeLofiiStatus({} as LofiiStatus)
    expect(normalized).not.toBeNull()
    expect(normalized?.task.queue).toEqual([])
    expect(normalized?.task.progress.fishCaught).toBe(0)
    expect(normalized?.admin.tps.one).toBeNull()
    expect(normalized?.admin.online.players).toEqual([])
  })

  it('旧服务端缺 eventsSupported/contractVersion 时不误判为支持事件流', () => {
    const legacy = {
      ...emptySnapshot(),
      eventsSupported: undefined,
      contractVersion: undefined,
    } as unknown as LofiiSnapshot
    expect(lofiiEventsSupported(legacy)).toBe(false)
    expect(lofiiEventsSupported({ ...legacy, contractVersion: 1 } as LofiiSnapshot)).toBe(true)
    expect(lofiiEventsSupported(null)).toBe(false)
  })

  it('__proto__/constructor 等键不会命中原型链对象', () => {
    expect(lofiiTaskNameLabel('__proto__')).toBe('__proto__')
    expect(lofiiAlertTypeLabel('__proto__')).toBe('__proto__')
    expect(lofiiSeverityLabel('__proto__')).toBe('__proto__')
    expect(lofiiTaskProgressRows({ name: '__proto__' } as never)).toEqual([])
  })
})
