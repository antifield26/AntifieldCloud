import test from 'node:test'
import assert from 'node:assert/strict'
import { base32Decode, base32Encode, hotp, otpauthUri, verifyTotp } from '../src/auth/totp.ts'

// RFC 6238 附录 B 的 SHA-1 密钥（ASCII "12345678901234567890"）。
const SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'))

test('base32 编解码可往返', () => {
  const buffer = Buffer.from('hello world', 'utf8')
  assert.deepEqual(base32Decode(base32Encode(buffer)), buffer)
})

test('HOTP 命中 RFC 6238 SHA-1 向量（截断为 6 位）', () => {
  assert.equal(hotp(SECRET, 1), '287082')
  assert.equal(hotp(SECRET, 37037036), '081804')
  assert.equal(hotp(SECRET, 37037037), '050471')
  assert.equal(hotp(SECRET, 41152263), '005924')
})

test('verifyTotp 接受当前步并拒绝重放', () => {
  const at59 = 59_000
  assert.equal(verifyTotp(SECRET, '287082', 0, at59), 1)
  assert.equal(verifyTotp(SECRET, '287082', 1, at59), null)
})

test('verifyTotp 拒绝格式错误与错误验证码', () => {
  assert.equal(verifyTotp(SECRET, '12345', 0, 59_000), null)
  assert.equal(verifyTotp(SECRET, 'abcdef', 0, 59_000), null)
  assert.equal(verifyTotp(SECRET, '000000', 0, 59_000), null)
})

test('otpauth URI 包含密钥、发行方与参数', () => {
  const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'antifield')
  assert.match(uri, /^otpauth:\/\/totp\//)
  assert.match(uri, /secret=JBSWY3DPEHPK3PXP/)
  assert.match(uri, /issuer=AntifieldCloud/)
  assert.match(uri, /digits=6/)
  assert.match(uri, /period=30/)
})
