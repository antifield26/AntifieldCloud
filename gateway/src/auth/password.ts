// 内置密码认证：口令唯一来源是环境变量 AUTH_LOGIN_PASSWORD（/etc/workbench/env，0400）。
// 会话 cookie + 全局失败退避（tunnel 后同源 IP，限流按全局计数）。
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const SESSION_COOKIE = 'wb_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

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
  if (want.length < 8 || got.length !== want.length) return false;
  return timingSafeEqual(got, want);
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
  const row = db.prepare('SELECT expires_at FROM sessions WHERE id=?').get(id) as { expires_at: number } | undefined;
  return row !== undefined && Number(row.expires_at) > Date.now();
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
