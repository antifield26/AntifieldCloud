import test from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword, validatePassword, verifyPassword } from '../src/auth/password.ts'
import { SlidingWindowLimiter } from '../src/auth/limiter.ts'
import { generateRecoveryCode, normalizeRecoveryCode, recoveryCodeHash } from '../src/util/ids.ts'

test('scrypt 哈希可校验且拒绝错误密码', async () => {
  const hashed = await hashPassword('correct horse battery staple')
  assert.equal(await verifyPassword('correct horse battery staple', hashed.hash, hashed.salt), true)
  assert.equal(await verifyPassword('wrong password', hashed.hash, hashed.salt), false)
})

test('密码长度限制', async () => {
  assert.throws(() => validatePassword('short'), /至少需要 12/)
  assert.throws(() => validatePassword('x'.repeat(257)))
  await assert.doesNotReject(() => hashPassword('长密码-' + 'a'.repeat(20)))
})

test('滑动窗口限流在第 N+1 次返回等待秒数，窗口过后恢复', () => {
  const limiter = new SlidingWindowLimiter(1000, 2)
  assert.equal(limiter.hit('ip', 1000), 0)
  assert.equal(limiter.hit('ip', 1100), 0)
  assert.ok(limiter.hit('ip', 1200) > 0)
  assert.equal(limiter.hit('ip', 2101), 0)
})

test('恢复码格式与哈希稳定', () => {
  const code = generateRecoveryCode()
  assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/)
  assert.equal(normalizeRecoveryCode(code.toLowerCase()), code.replace('-', ''))
  assert.equal(recoveryCodeHash(code.toLowerCase()), recoveryCodeHash(code))
})
