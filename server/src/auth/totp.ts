/** TOTP（RFC 6238）：SHA-1 / 6 位 / 30 秒；base32 编解码与防重放。 */
import { createHmac, randomBytes } from 'node:crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const STEP_SECONDS = 30
const DIGITS = 6

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return output.replace(/=+$/, '')
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index < 0) continue
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret)
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', key).update(buffer).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff)
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0')
}

export function currentStep(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / STEP_SECONDS)
}

/**
 * 校验 TOTP；返回命中的 step，失败返回 null。
 * 要求 step > lastStep，防止同一验证码重放。
 */
export function verifyTotp(secret: string, code: string, lastStep: number, atMs: number = Date.now()): number | null {
  const normalized = code.replace(/\s+/g, '')
  if (!/^\d{6}$/.test(normalized)) return null
  const base = currentStep(atMs)
  for (let offset = -1; offset <= 1; offset += 1) {
    const step = base + offset
    if (step <= lastStep) continue
    if (hotp(secret, step) === normalized) return step
  }
  return null
}

/**
 * 再认证校验（改密/恢复码重生成）：允许命中「当前时间步」本身（登录刚用过的步也可），
 * 返回命中 step；调用方仅在 step > lastStep 时推进 last_step。
 */
export function verifyTotpForReauth(secret: string, code: string, lastStep: number, atMs: number = Date.now()): number | null {
  const normalized = code.replace(/\s+/g, '')
  if (!/^\d{6}$/.test(normalized)) return null
  const base = currentStep(atMs)
  for (let offset = -1; offset <= 1; offset += 1) {
    const step = base + offset
    if (step < lastStep) continue
    if (hotp(secret, step) === normalized) return step
  }
  return null
}

export function otpauthUri(secret: string, username: string, issuer = 'AntifieldCloud'): string {
  const label = encodeURIComponent(`${issuer}:${username}`)
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}
