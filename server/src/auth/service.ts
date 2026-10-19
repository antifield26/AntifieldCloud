/**
 * 认证服务：密码挑战 → TOTP/恢复码 → 会话；限流、审计、改密、恢复码。
 * 不直接接触 Cookie/HTTP，路由层负责下发。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../config.ts'
import type { AuthContext, SessionRow, UserRow } from '../types.ts'
import { invalidCode, invalidCredentials, rateLimited, unauthorized, badRequest, challengeExpired } from '../util/errors.ts'
import {
  generateRecoveryCode,
  randomToken,
  recoveryCodeHash,
  sha256Hex,
} from '../util/ids.ts'
import { isoAfterSeconds, nowIso } from '../util/time.ts'
import { audit } from './audit.ts'
import { SlidingWindowLimiter } from './limiter.ts'
import { dummyPasswordHash, hashPassword, validatePassword, verifyPassword } from './password.ts'
import { createSession, deleteAllSessions, deleteOtherSessions, deleteSession, findSession } from './sessions.ts'
import { verifyTotp } from './totp.ts'
import {
  findUserByUsername,
  parseRecoveryHashes,
  updatePassword,
  updateRecoveryCodes,
  updateTotpLastStep,
} from './users.ts'

export interface LoginInput {
  username: string
  password: string
  ip: string
  userAgent: string | null
}

export interface TotpInput {
  challenge: string
  code?: string
  recoveryCode?: string
  ip: string
  userAgent: string | null
}

export interface LoginResult {
  user: { username: string }
  csrfToken: string
  sessionToken: string
  expiresAt: string
}

export class AuthService {
  readonly passwordLimiter = new SlidingWindowLimiter(15 * 60_000, 5)
  readonly totpLimiter = new SlidingWindowLimiter(15 * 60_000, 10)
  readonly globalLimiter = new SlidingWindowLimiter(60 * 60_000, 20)
  private readonly db: DatabaseSync
  private readonly config: Config

  constructor(db: DatabaseSync, config: Config) {
    this.db = db
    this.config = config
  }

  private recordAttempt(ip: string, success: boolean): void {
    this.db.prepare('INSERT INTO login_attempts (ip, ts, success) VALUES (?, ?, ?)').run(ip, nowIso(), success ? 1 : 0)
  }

  private purgeOldAttempts(): void {
    const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString()
    this.db.prepare('DELETE FROM login_attempts WHERE ts < ?').run(cutoff)
  }

  async beginPasswordLogin(input: LoginInput): Promise<{ challenge: string; expiresIn: number }> {
    const retry = this.passwordLimiter.hit(input.ip)
    if (retry > 0) throw rateLimited(retry)
    const globalRetry = this.globalLimiter.hit('global')
    if (globalRetry > 0) throw rateLimited(globalRetry)

    const user = findUserByUsername(this.db, input.username)
    if (!user) {
      const dummy = await dummyPasswordHash()
      await verifyPassword(input.password, dummy.hash, dummy.salt)
      this.recordAttempt(input.ip, false)
      audit(this.db, input.username || '(unknown)', 'login_failed', null, { reason: 'unknown_user' }, input.ip)
      throw invalidCredentials()
    }
    const valid = await verifyPassword(input.password, user.password_hash, user.password_salt)
    if (!valid) {
      this.recordAttempt(input.ip, false)
      audit(this.db, user.username, 'login_failed', null, { reason: 'bad_password' }, input.ip)
      throw invalidCredentials()
    }

    this.recordAttempt(input.ip, true)
    this.purgeOldAttempts()
    const challenge = randomToken(32)
    this.db.prepare(
      'INSERT INTO auth_challenges (id, user_id, token_hash, expires_at, used, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    ).run(randomToken(8), user.id, sha256Hex(challenge), isoAfterSeconds(this.config.challengeTtlSeconds), nowIso())
    return { challenge, expiresIn: this.config.challengeTtlSeconds }
  }

  async completeTotpLogin(input: TotpInput): Promise<LoginResult> {
    const retry = this.totpLimiter.hit(input.ip)
    if (retry > 0) throw rateLimited(retry)

    const row = this.db
      .prepare(
        `SELECT u.*, c.expires_at AS challenge_expires_at, c.used AS challenge_used
         FROM auth_challenges c JOIN users u ON u.id = c.user_id
         WHERE c.token_hash = ?`,
      )
      .get(sha256Hex(input.challenge)) as
      | (UserRow & { challenge_expires_at: string; challenge_used: number })
      | undefined
    if (!row) throw challengeExpired()
    if (row.challenge_used || Date.parse(row.challenge_expires_at) <= Date.now()) throw challengeExpired()

    let usedRecovery = false
    if (input.recoveryCode) {
      const hashes = parseRecoveryHashes(row)
      const target = recoveryCodeHash(input.recoveryCode)
      if (!hashes.includes(target)) {
        this.recordAttempt(input.ip, false)
        audit(this.db, row.username, 'login_failed', null, { reason: 'bad_recovery_code' }, input.ip)
        throw invalidCode()
      }
      updateRecoveryCodes(
        this.db,
        row.id,
        hashes.filter((hash) => hash !== target),
      )
      usedRecovery = true
    } else {
      const step = verifyTotp(row.totp_secret, input.code ?? '', row.totp_last_step)
      if (step === null) {
        this.recordAttempt(input.ip, false)
        audit(this.db, row.username, 'login_failed', null, { reason: 'bad_totp' }, input.ip)
        throw invalidCode()
      }
      updateTotpLastStep(this.db, row.id, step)
    }

    this.db.prepare('UPDATE auth_challenges SET used = 1 WHERE token_hash = ?').run(sha256Hex(input.challenge))
    this.db.prepare('DELETE FROM auth_challenges WHERE user_id = ? AND used = 1').run(row.id)
    const csrfToken = randomToken(24)
    const session = createSession(
      this.db,
      row.id,
      csrfToken,
      this.config.sessionTtlDays,
      input.ip,
      input.userAgent,
    )
    this.recordAttempt(input.ip, true)
    audit(this.db, row.username, 'login', usedRecovery ? 'recovery_code' : 'totp', null, input.ip)
    return {
      user: { username: row.username },
      csrfToken,
      sessionToken: session.token,
      expiresAt: session.expiresAt,
    }
  }

  authenticate(token: string | null): AuthContext | null {
    if (!token) return null
    const session = findSession(this.db, token)
    if (!session) return null
    return { user: { id: session.user_id, username: session.user_username }, session }
  }

  requireAuth(token: string | null): AuthContext {
    const context = this.authenticate(token)
    if (!context) throw unauthorized()
    return context
  }

  logout(context: AuthContext, ip: string): void {
    deleteSession(this.db, context.session.id)
    audit(this.db, context.user.username, 'logout', null, null, ip)
  }

  async changePassword(context: AuthContext, currentPassword: string, newPassword: string): Promise<void> {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(context.user.id) as UserRow | undefined
    if (!row) throw unauthorized()
    const valid = await verifyPassword(currentPassword, row.password_hash, row.password_salt)
    if (!valid) throw invalidCredentials()
    try {
      validatePassword(newPassword)
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : '新密码不合法', 'weak_password')
    }
    const next = await hashPassword(newPassword)
    updatePassword(this.db, row.id, next.hash, next.salt)
    deleteOtherSessions(this.db, row.id, context.session.id)
    audit(this.db, row.username, 'password_change', null, null, null)
  }

  async regenerateRecoveryCodes(context: AuthContext, password: string): Promise<string[]> {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(context.user.id) as UserRow | undefined
    if (!row) throw unauthorized()
    const valid = await verifyPassword(password, row.password_hash, row.password_salt)
    if (!valid) throw invalidCredentials()
    const codes = Array.from({ length: 10 }, () => generateRecoveryCode())
    updateRecoveryCodes(
      this.db,
      row.id,
      codes.map((code) => recoveryCodeHash(code)),
    )
    audit(this.db, row.username, 'recovery_regenerate', null, null, null)
    return codes
  }

  logoutAll(context: AuthContext, ip: string): void {
    deleteAllSessions(this.db, context.user.id)
    audit(this.db, context.user.username, 'logout_all', null, null, ip)
  }

  /** 供测试/审计使用。 */
  loginAttemptCount(ip: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ?')
      .get(ip) as { c: number }
    return row.c
  }

  /** 供测试清理用：删除失效会话与挑战。 */
  cleanup(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso())
    this.db.prepare('DELETE FROM auth_challenges WHERE expires_at <= ?').run(nowIso())
    this.purgeOldAttempts()
  }
}

export type { SessionRow }
