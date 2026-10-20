/**
 * 认证服务：密码挑战 → TOTP/恢复码 → 会话；限流、审计、改密、恢复码。
 * 不直接接触 Cookie/HTTP，路由层负责下发。
 *
 * 再认证（改密/恢复码重生成）：必须同时提供当前密码 + TOTP；失败统一延迟、
 * 限流并审计（password_change_failed / recovery_regenerate_failed）。
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
import { createSession, deleteAllSessions, deleteOtherSessions, deleteSession, findSession, updateSessionCsrf } from './sessions.ts'
import { verifyTotp, verifyTotpForReauth } from './totp.ts'
import {
  findUserByUsername,
  parseRecoveryHashes,
  updatePassword,
  updateRecoveryCodes,
  updateTotpLastStep,
} from './users.ts'

/** 生产环境再认证失败的恒定延迟（测试环境为 0，避免拖慢用例）。 */
const REAUTH_FAILURE_DELAY_MS = 300
/** 登录用户名最大长度：避免未认证输入整串进入查找/审计（audit 层另有兜底）。 */
export const MAX_LOGIN_USERNAME_LENGTH = 64
/** TOTP 全局限流：登录/再认证的所有第二因素尝试共享，防分布式爆破。 */
export const TOTP_GLOBAL_MAX = 120
/** 再认证全局限流：防止多来源同时猜当前密码。 */
const REAUTH_GLOBAL_MAX = 30

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

export interface ReauthInput {
  /** 当前密码（再认证的第一因素）。 */
  password: string
  /** 当前 TOTP 验证码（再认证的第二因素）。 */
  totpCode: string
  ip: string
}

export interface ChangePasswordInput {
  currentPassword: string
  newPassword: string
  totpCode: string
  ip: string
}

export interface LoginResult {
  user: { username: string }
  csrfToken: string
  sessionToken: string
  expiresAt: string
}

/** 判断来源 IP 是否为 loopback（本机开发/运维，免占全局限流桶）。 */
export function isLoopbackAddress(ip: string): boolean {
  const value = ip.trim().toLowerCase()
  if (!value) return false
  if (value === '::1' || value === 'localhost' || value === '::ffff:127.0.0.1') return true
  return value === '127.0.0.1' || value.startsWith('127.')
}

export class AuthService {
  readonly passwordLimiter = new SlidingWindowLimiter(15 * 60_000, 5)
  readonly totpLimiter = new SlidingWindowLimiter(15 * 60_000, 10)
  /** 全局桶提高阈值：避免单个 IP 打满后管理员会话过期也无法登录；loopback 不占全局桶。 */
  readonly globalLimiter = new SlidingWindowLimiter(60 * 60_000, 60)
  readonly totpGlobalLimiter = new SlidingWindowLimiter(60 * 60_000, TOTP_GLOBAL_MAX)
  readonly reauthLimiter = new SlidingWindowLimiter(15 * 60_000, 5)
  readonly reauthGlobalLimiter = new SlidingWindowLimiter(60 * 60_000, REAUTH_GLOBAL_MAX)
  private readonly db: DatabaseSync
  private readonly config: Config
  private readonly reauthDelayMs: number

  constructor(db: DatabaseSync, config: Config) {
    this.db = db
    this.config = config
    this.reauthDelayMs = config.nodeEnv === 'test' ? 0 : REAUTH_FAILURE_DELAY_MS
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
    // loopback（本机开发/运维）不占全局桶，避免本机调试把全局配额耗尽。
    if (!isLoopbackAddress(input.ip)) {
      const globalRetry = this.globalLimiter.hit('global')
      if (globalRetry > 0) throw rateLimited(globalRetry)
    }
    // 防御性截断：路由已限制长度，服务层再兜底一次，避免超长输入进入查找/审计。
    const username = input.username.slice(0, MAX_LOGIN_USERNAME_LENGTH)

    const user = findUserByUsername(this.db, username)
    if (!user) {
      const dummy = await dummyPasswordHash()
      await verifyPassword(input.password, dummy.hash, dummy.salt)
      this.recordAttempt(input.ip, false)
      audit(this.db, username || '(unknown)', 'login_failed', null, { reason: 'unknown_user' }, input.ip)
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
    if (!isLoopbackAddress(input.ip)) {
      const globalRetry = this.totpGlobalLimiter.hit('global')
      if (globalRetry > 0) throw rateLimited(globalRetry)
    }

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

  /**
   * 再认证：限流（IP + 全局）→ 当前密码（scrypt）→ TOTP（允许当前步）。
   * 任一失败：记录尝试、审计失败动作、恒定延迟后抛错。
   */
  private async requireReauth(context: AuthContext, input: ReauthInput, failureAction: string): Promise<UserRow> {
    const retry = this.reauthLimiter.hit(input.ip)
    if (retry > 0) throw rateLimited(retry)
    const globalRetry = this.reauthGlobalLimiter.hit('global')
    if (globalRetry > 0) throw rateLimited(globalRetry)
    const totpRetry = this.totpGlobalLimiter.hit('global')
    if (totpRetry > 0) throw rateLimited(totpRetry)

    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(context.user.id) as UserRow | undefined
    if (!row) throw unauthorized()

    const valid = await verifyPassword(input.password, row.password_hash, row.password_salt)
    if (!valid) {
      this.recordAttempt(input.ip, false)
      audit(this.db, row.username, failureAction, null, { reason: 'bad_password' }, input.ip)
      await this.delayReauthFailure()
      throw invalidCredentials()
    }

    const step = verifyTotpForReauth(row.totp_secret, input.totpCode, row.totp_last_step)
    if (step === null) {
      this.recordAttempt(input.ip, false)
      audit(this.db, row.username, failureAction, null, { reason: 'bad_totp' }, input.ip)
      await this.delayReauthFailure()
      throw invalidCode()
    }
    if (step > row.totp_last_step) updateTotpLastStep(this.db, row.id, step)
    return row
  }

  private async delayReauthFailure(): Promise<void> {
    if (this.reauthDelayMs <= 0) return
    await new Promise<void>((resolve) => {
      setTimeout(resolve, this.reauthDelayMs)
    })
  }

  async changePassword(context: AuthContext, input: ChangePasswordInput): Promise<void> {
    const row = await this.requireReauth(
      context,
      { password: input.currentPassword, totpCode: input.totpCode, ip: input.ip },
      'password_change_failed',
    )
    try {
      validatePassword(input.newPassword)
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : '新密码不合法', 'weak_password')
    }
    const next = await hashPassword(input.newPassword)
    updatePassword(this.db, row.id, next.hash, next.salt)
    deleteOtherSessions(this.db, row.id, context.session.id)
    audit(this.db, row.username, 'password_change', null, null, input.ip)
  }

  async regenerateRecoveryCodes(context: AuthContext, input: ReauthInput): Promise<string[]> {
    const row = await this.requireReauth(context, input, 'recovery_regenerate_failed')
    const codes = Array.from({ length: 10 }, () => generateRecoveryCode())
    updateRecoveryCodes(
      this.db,
      row.id,
      codes.map((code) => recoveryCodeHash(code)),
    )
    audit(this.db, row.username, 'recovery_regenerate', null, null, input.ip)
    return codes
  }

  /** 会话存在但 CSRF Cookie 丢失时轮换 token 并返回新值（/api/auth/me 用）。 */
  rotateCsrfToken(context: AuthContext): string {
    const token = randomToken(24)
    updateSessionCsrf(this.db, context.session.id, token)
    context.session.csrf_hash = sha256Hex(token)
    return token
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
