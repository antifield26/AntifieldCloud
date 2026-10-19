/** 密码哈希：scrypt（N=2^15, r=8, p=1），随机盐，恒定时间比较。 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import type { ScryptOptions } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>
const KEY_LENGTH = 64
const SALT_BYTES = 16
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const

export interface PasswordHash {
  hash: string
  salt: string
}

export function validatePassword(password: string): void {
  if (password.length < 12) throw new Error('密码至少需要 12 个字符')
  if (password.length > 256) throw new Error('密码过长')
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  validatePassword(password)
  const salt = randomBytes(SALT_BYTES)
  const derived = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, SCRYPT_OPTIONS)
  return { hash: derived.toString('base64'), salt: salt.toString('base64') }
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  try {
    const saltBuffer = Buffer.from(salt, 'base64')
    const expected = Buffer.from(hash, 'base64')
    const derived = await scryptAsync(password.normalize('NFKC'), saltBuffer, expected.length, SCRYPT_OPTIONS)
    return expected.length === derived.length && timingSafeEqual(expected, derived)
  } catch {
    return false
  }
}

let dummy: Promise<PasswordHash> | null = null

/** 用户不存在时也执行一次同等代价的哈希，避免通过响应时间枚举用户。 */
export function dummyPasswordHash(): Promise<PasswordHash> {
  dummy ??= hashPassword(randomBytes(18).toString('base64url'))
  return dummy
}
