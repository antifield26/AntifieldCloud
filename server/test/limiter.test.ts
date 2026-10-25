/** SEC-07：容量满时不得淘汰已有 key（否则可重置受害者限流计数）。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SlidingWindowLimiter } from '../src/auth/limiter.ts'

test('容量满时新 key 计入 overflow，不驱逐已有 key', () => {
  const limiter = new SlidingWindowLimiter(60_000, 2, 2)
  const t = 1_000_000
  assert.equal(limiter.hit('victim', t), 0)
  assert.equal(limiter.hit('victim', t + 1), 0)
  assert.ok(limiter.hit('victim', t + 2) > 0, '受害 key 应保持限流')
  // 填满容量后再来两个新 key：不得淘汰 victim。
  limiter.hit('a', t + 3)
  limiter.hit('b', t + 4)
  limiter.hit('c', t + 5)
  assert.ok(limiter.retryAfter('victim', t + 6) > 0, 'victim 计数不得因淘汰被重置')
  assert.ok(limiter.size <= 2, '条目数不得超过上限（overflow 独立存放）')
})

test('过期 key 会被清理，容量可恢复', () => {
  const limiter = new SlidingWindowLimiter(1_000, 1, 2)
  limiter.hit('a', 1_000)
  limiter.hit('b', 1_001)
  assert.equal(limiter.size, 2)
  // 窗口过后新 key 可正常进入（sweep 清理过期项）。
  assert.equal(limiter.hit('c', 3_000), 0)
  assert.ok(limiter.size <= 2)
})
