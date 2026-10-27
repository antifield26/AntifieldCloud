/**
 * 密码与秘密哈希：scrypt（N=2^15, r=8, p=1），随机盐，恒定时间比较。
 *
 * - 用户密码：最少 12 字符（validatePassword），登录/改密使用。
 * - 分享链接等低价值秘密：1–256 字符（hashSecret/verifySecret），不入用户密码策略。
 */
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
const SECRET_MIN_LENGTH = 1
const SECRET_MAX_LENGTH = 256

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

function validateSecret(secret: unknown): string {
  if (typeof secret !== 'string' || secret.length < SECRET_MIN_LENGTH || secret.length > SECRET_MAX_LENGTH) {
    throw new Error(`密码长度需为 ${SECRET_MIN_LENGTH}–${SECRET_MAX_LENGTH} 个字符`)
  }
  return secret.normalize('NFKC')
}

/** 哈希分享链接密码等低价值秘密（不做用户密码的 ≥12 字符限制）。 */
export async function hashSecret(secret: string): Promise<PasswordHash> {
  const normalized = validateSecret(secret)
  const salt = randomBytes(SALT_BYTES)
  const derived = await scryptAsync(normalized, salt, KEY_LENGTH, SCRYPT_OPTIONS)
  return { hash: derived.toString('base64'), salt: salt.toString('base64') }
}

/** 校验分享链接密码；长度非法或哈希损坏一律返回 false。 */
export async function verifySecret(secret: string, hash: string, salt: string): Promise<boolean> {
  try {
    const normalized = validateSecret(secret)
    const saltBuffer = Buffer.from(salt, 'base64')
    const expected = Buffer.from(hash, 'base64')
    const derived = await scryptAsync(normalized, saltBuffer, expected.length, SCRYPT_OPTIONS)
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
