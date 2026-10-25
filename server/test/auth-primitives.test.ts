import test from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword, hashSecret, validatePassword, verifyPassword, verifySecret } from '../src/auth/password.ts'
import { SlidingWindowLimiter } from '../src/auth/limiter.ts'
import { base32Encode, hotp, verifyTotpForReauth } from '../src/auth/totp.ts'
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

test('限流 Map 有容量上限，不会无限增长', () => {
  const limiter = new SlidingWindowLimiter(60_000, 2, 50)
  for (let index = 0; index < 500; index += 1) limiter.hit(`key-${index}`)
  assert.ok(limiter.size <= 50)
  // 容量满后新 key 共享 overflow 桶：攻击洪泛期间新来源也被统一限流，不会因淘汰重置计数。
  assert.ok(limiter.hit('fresh') > 0)
})

test('hashSecret/verifySecret：分享密码 1–256 字符，不受用户密码 ≥12 限制', async () => {
  assert.throws(() => validatePassword('short'), /至少需要 12/)
  const hashed = await hashSecret('abc')
  assert.equal(await verifySecret('abc', hashed.hash, hashed.salt), true)
  assert.equal(await verifySecret('abd', hashed.hash, hashed.salt), false)
  const unicode = await hashSecret('分享密码')
  assert.equal(await verifySecret('分享密码', unicode.hash, unicode.salt), true)
  await assert.rejects(() => hashSecret(''))
  await assert.rejects(() => hashSecret('x'.repeat(257)))
  const max = await hashSecret('x'.repeat(256))
  assert.equal(await verifySecret('x'.repeat(256), max.hash, max.salt), true)
})

test('verifyTotpForReauth：允许当前步（含已用于登录的步），拒绝更早步', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890', 'ascii'))
  // atMs=59000 → 当前步为 1；step 1 的验证码为 287082（RFC 6238 向量）。
  assert.equal(hotp(secret, 1), '287082')
  assert.equal(verifyTotpForReauth(secret, '287082', 1, 59_000), 1)
  assert.equal(verifyTotpForReauth(secret, '287082', 2, 59_000), null)
  assert.equal(verifyTotpForReauth(secret, hotp(secret, 2), 1, 59_000), 2)
  assert.equal(verifyTotpForReauth(secret, '12345', 0, 59_000), null)
})
