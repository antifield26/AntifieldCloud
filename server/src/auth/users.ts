/** 用户表访问：认证服务与 provisioning CLI 共用。 */
import type { DatabaseSync } from 'node:sqlite'
import type { UserRow } from '../types.ts'
import { newId } from '../util/ids.ts'
import { nowIso } from '../util/time.ts'

export function findUserByUsername(db: DatabaseSync, username: string): UserRow | null {
  const row = db
    .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .get(username.trim()) as UserRow | undefined
  return row ?? null
}

export function findUserById(db: DatabaseSync, id: string): UserRow | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
  return row ?? null
}

export function countUsers(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }
  return row.c
}

export interface NewUser {
  username: string
  passwordHash: string
  passwordSalt: string
  totpSecret: string
  recoveryCodeHashes: string[]
}

export function createUser(db: DatabaseSync, input: NewUser): UserRow {
  const id = newId()
  const now = nowIso()
  db.prepare(
    `INSERT INTO users
       (id, username, password_hash, password_salt, totp_secret, totp_last_step, recovery_codes_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    id,
    input.username,
    input.passwordHash,
    input.passwordSalt,
    input.totpSecret,
    JSON.stringify(input.recoveryCodeHashes),
    now,
    now,
  )
  const user = findUserById(db, id)
  if (!user) throw new Error('创建用户失败')
  return user
}

export function updatePassword(db: DatabaseSync, userId: string, passwordHash: string, passwordSalt: string): void {
  db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?').run(
    passwordHash,
    passwordSalt,
    nowIso(),
    userId,
  )
}

export function updateTotpSecret(db: DatabaseSync, userId: string, secret: string): void {
  db.prepare('UPDATE users SET totp_secret = ?, totp_last_step = 0, updated_at = ? WHERE id = ?').run(
    secret,
    nowIso(),
    userId,
  )
}

export function updateTotpLastStep(db: DatabaseSync, userId: string, step: number): void {
  db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?').run(step, userId, step)
}

export function updateRecoveryCodes(db: DatabaseSync, userId: string, hashes: string[]): void {
  db.prepare('UPDATE users SET recovery_codes_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(hashes),
    nowIso(),
    userId,
  )
}

export function parseRecoveryHashes(user: UserRow): string[] {
  try {
    const value = JSON.parse(user.recovery_codes_json) as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}
