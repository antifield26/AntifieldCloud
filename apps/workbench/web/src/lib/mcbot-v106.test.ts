import { describe, expect, it } from 'vitest'
import { safeLofiiStatus } from './mcbot'

describe('mcbot v1.0.6 寻路状态展示', () => {
  it('解析 navigation 状态并容忍非法枚举', () => {
    const status = safeLofiiStatus({
      navigation: {
        state: 'fallback',
        source: 'teleport',
        attempts: 2,
        lastFailureKind: 'no_path',
        lastFallback: 'teleport',
        aiUsed: true,
        updatedAt: '2026-10-30T00:00:00.000Z',
      },
    })
    expect(status?.navigation).toEqual({
      state: 'fallback',
      source: 'teleport',
      attempts: 2,
      lastFailureKind: 'no_path',
      lastFallback: 'teleport',
      aiUsed: true,
      updatedAt: '2026-10-30T00:00:00.000Z',
    })
  })

  it('旧 mcbot 缺少 navigation 时不报错、不伪造状态', () => {
    const status = safeLofiiStatus({})
    expect(status).not.toBeNull()
    expect(status?.navigation).toBeUndefined()
  })

  it('非法 navigation 字段降级为安全默认值', () => {
    const status = safeLofiiStatus({
      navigation: {
        state: 'weird',
        source: 'weird',
        attempts: -2,
        lastFallback: 'weird',
      },
    })
    expect(status?.navigation?.state).toBe('idle')
    expect(status?.navigation?.source).toBeNull()
    expect(status?.navigation?.attempts).toBe(0)
    expect(status?.navigation?.lastFallback).toBeNull()
  })
})
