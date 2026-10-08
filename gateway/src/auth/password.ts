// 内置密码认证：口令唯一来源是环境变量 AUTH_LOGIN_PASSWORD（/etc/workbench/env，0400）。
// 会话 cookie + 全局失败退避（tunnel 后同源 IP，限流按全局计数）。
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const SESSION_COOKIE = 'wb_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
/** 会话绝对上限：自创建起 7d，滑动续期也不可超越。 */
export const SESSION_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export const slidingOn = (): boolean => (process.env.WB_SESSION_SLIDING ?? '1') !== '0';

export function expectedPassword(): string {
  return process.env.AUTH_LOGIN_PASSWORD ?? '';
}

export function isConfigured(): boolean {
  return expectedPassword().length >= 8;
}

export function verifyPassword(pw: unknown): boolean {
  if (typeof pw !== 'string') return false;
  const want = Buffer.from(expectedPassword());
  const got = Buffer.from(pw);
  if (want.length < 8) return false;
  // 同长缓冲 + timingSafeEqual，避免按长度提前返回造成时序差异。
  const n = Math.max(want.length, got.length);
  const a = Buffer.alloc(n);
  const b = Buffer.alloc(n);
  want.copy(a);
  got.copy(b);
  const lengthOk = want.length === got.length;
  const eq = timingSafeEqual(a, b);
  return lengthOk && eq;
}

export function newSession(db: DatabaseSync): { id: string; expires: number } {
  const id = randomBytes(24).toString('hex');
  const expires = Date.now() + SESSION_TTL_MS;
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN created_at INT');
  } catch {
    // 列已存在
  }
  db.prepare('INSERT INTO sessions(id,expires_at,created_at) VALUES (?,?,?)').run(id, expires, Date.now());
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return { id, expires };
}

export function auditLogin(db: DatabaseSync, result: 'ok' | 'fail' | 'locked'): void {
  db.prepare('INSERT INTO auth_audit(ts,result,note) VALUES (?,?,?)').run(new Date().toISOString(), result, '');
}

export function validSession(db: DatabaseSync, id: string | undefined): boolean {
  if (!id) return false;
  const row = db.prepare('SELECT expires_at,created_at FROM sessions WHERE id=?').get(id) as
    | { expires_at: number; created_at: number | null }
    | undefined;
  if (row === undefined) return false;
  if (row.created_at === null || row.created_at === undefined) return false;
  const now = Date.now();
  if (Number(row.created_at) + SESSION_MAX_AGE_MS <= now) return false;
  return Number(row.expires_at) > now;
}

/** 滑动续期：剩 <24h 时延到 min(now+30d, created+7d)；每天最多写一次。 */
export function touchSession(db: DatabaseSync, id: string): void {
  if (!slidingOn()) return;
  const row = db.prepare('SELECT expires_at,created_at FROM sessions WHERE id=?').get(id) as
    | { expires_at: number; created_at: number }
    | undefined;
  if (row === undefined) return;
  const now = Date.now();
  if (Number(row.expires_at) - now >= 24 * 3600 * 1000) return;
  const cap = Number(row.created_at) + SESSION_MAX_AGE_MS;
  db.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(Math.min(now + SESSION_TTL_MS, cap), id);
}

export function destroySession(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM sessions WHERE id=?').run(id);
}

// 全局失败退避：连续失败越多，等越久；10 次后锁定 5 分钟。
let fails = 0;
let lockedUntil = 0;

export function authDelayMs(): number {
  if (Date.now() < lockedUntil) return -1;
  return Math.min(fails * 500, 3000);
}

export function authFailed(): void {
  fails++;
  if (fails >= 10) {
    lockedUntil = Date.now() + 5 * 60 * 1000;
    fails = 0;
  }
}

export function authOk(): void {
  fails = 0;
  lockedUntil = 0;
}
