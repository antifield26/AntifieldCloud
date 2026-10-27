import { describe, expect, it } from 'vitest'
import {
  mcbotAlertTypeLabel,
  mcbotEventsSupported,
  mcbotSeverityLabel,
  mcbotTaskNameLabel,
  mcbotTaskProgressRows,
  safeLofiiStatus,
} from './mcbot'
import type { McbotSnapshot, McbotStatus } from '../api/types'

const emptySnapshot = (overrides: Partial<McbotSnapshot> = {}): McbotSnapshot => ({
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

describe('mcbot v0.8.0 展示层容错', () => {
  it('status 缺嵌套段时归一化为可渲染默认值', () => {
    const normalized = safeLofiiStatus({} as McbotStatus)
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
    } as unknown as McbotSnapshot
    expect(mcbotEventsSupported(legacy)).toBe(false)
    expect(mcbotEventsSupported({ ...legacy, contractVersion: 1 } as McbotSnapshot)).toBe(true)
    expect(mcbotEventsSupported(null)).toBe(false)
  })

  it('__proto__/constructor 等键不会命中原型链对象', () => {
    expect(mcbotTaskNameLabel('__proto__')).toBe('__proto__')
    expect(mcbotAlertTypeLabel('__proto__')).toBe('__proto__')
    expect(mcbotSeverityLabel('__proto__')).toBe('__proto__')
    expect(mcbotTaskProgressRows({ name: '__proto__' } as never)).toEqual([])
  })
})
