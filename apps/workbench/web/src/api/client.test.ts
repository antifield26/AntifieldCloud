import { describe, expect, it } from 'vitest'
import { parseApiError, parseRetryAfter } from './client'

describe('parseApiError', () => {
  it('解析标准错误体并保留 details', () => {
    const error = parseApiError(
      { error: { code: 'rate_limited', message: '尝试过多', details: { retryAfterSec: 42 } } },
      429,
      10,
    )
    expect(error.status).toBe(429)
    expect(error.code).toBe('rate_limited')
    expect(error.message).toBe('尝试过多')
    expect(error.retryAfterSec).toBe(42)
    expect(error.details).toEqual({ retryAfterSec: 42 })
  })

  it('429 details.retryAfterSec 优先于 Retry-After 头', () => {
    const error = parseApiError({ error: { code: 'rate_limited', details: { retryAfterSec: 7 } } }, 429, 99)
    expect(error.retryAfterSec).toBe(7)
  })

  it('缺少 code 时按状态回退', () => {
    expect(parseApiError(null, 401, null).code).toBe('unauthenticated')
    expect(parseApiError({}, 403, null).code).toBe('forbidden')
    expect(parseApiError(null, 500, null).code).toBe('internal_error')
  })

  it('无 message 时使用中文兜底文案', () => {
    const error = parseApiError({ error: { code: 'quota_exceeded' } }, 409, null)
    expect(error.message).toContain('空间不足')
  })

  it('顶层 retryAfterSec 与 header 回退', () => {
    expect(parseApiError({ retryAfterSec: 3 }, 429, 9).retryAfterSec).toBe(3)
    expect(parseApiError(null, 429, 9).retryAfterSec).toBe(9)
  })
})

describe('parseRetryAfter', () => {
  it('解析秒数与 HTTP 日期', () => {
    expect(parseRetryAfter('60')).toBe(60)
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('not-a-date')).toBeNull()
    const seconds = parseRetryAfter(new Date(Date.now() + 5000).toUTCString())
    expect(seconds).not.toBeNull()
    expect(seconds ?? 0).toBeGreaterThanOrEqual(3)
    expect(seconds ?? 0).toBeLessThanOrEqual(6)
  })
})
