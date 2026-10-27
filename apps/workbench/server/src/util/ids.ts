/** 随机 ID / token / 哈希工具。所有安全随机值均来自 node:crypto。 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

export function newId(): string {
  return randomUUID()
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

export function safeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** 恢复码：去混淆字符集，10 位分两段展示；存储时只存 SHA-256。 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generateRecoveryCode(): string {
  const bytes = randomBytes(10)
  let value = ''
  for (let i = 0; i < 10; i += 1) {
    value += RECOVERY_ALPHABET[bytes[i]! % RECOVERY_ALPHABET.length]
  }
  return `${value.slice(0, 5)}-${value.slice(5)}`
}

export function normalizeRecoveryCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function recoveryCodeHash(input: string): string {
  return sha256Hex(`antifieldcloud:recovery:${normalizeRecoveryCode(input)}`)
}
