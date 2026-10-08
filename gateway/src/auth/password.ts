// 内置密码认证：scrypt 哈希存 wb.db（auth_config），会话 cookie + 全局失败退避。
// 会话绝对上限 7d（created_at 起算），滑动续期可关（WB_SESSION_SLIDING=0）。
// 说明：tunnel 前所有来源 IP 都是 127.0.0.1，故限流按全局连续失败计数，不按 IP。
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { writeFile, rm } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';

const scrypt = promisify(scryptCb);

export const SESSION_COOKIE = 'wb_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
/** 会话绝对上限：自创建起 7d，滑动续期也不可超越。 */
export const SESSION_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export const slidingOn = (): boolean => (process.env.WB_SESSION_SLIDING ?? '1') !== '0';

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = (await scrypt(pw, salt, 64)) as Buffer;
  return `scrypt:${salt.toString('hex')}:${dk.toString('hex')}`;
}

export async function verifyPassword(pw: unknown, stored: string): Promise<boolean> {
  if (typeof pw !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const want = Buffer.from(parts[2], 'hex');
  const dk = (await scrypt(pw, salt, 64)) as Buffer;
  if (dk.length !== want.length) return false;
  return timingSafeEqual(dk, want);
}

export function getHash(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT value FROM auth_config WHERE key='admin_hash'").get() as { value: string } | undefined;
  return row?.value ?? null;
}

export function setHash(db: DatabaseSync, hash: string): void {
  db.prepare("INSERT OR REPLACE INTO auth_config(key,value) VALUES ('admin_hash',?)").run(hash);
  db.prepare('DELETE FROM sessions').run();
}

/** 首启：无口令则生成随机口令，哈希入库，明文只写密封文件（用户首登改密后删除）。 */
export async function ensurePassword(db: DatabaseSync, sealedPath: string): Promise<boolean> {
  if (getHash(db) !== null) return false;
  const pw = randomBytes(12).toString('base64url');
  setHash(db, await hashPassword(pw));
  await writeFile(sealedPath, `AntifieldCloud 初始密码（首登后请改密，改密后本文件自动删除）：\n${pw}\n`, { mode: 0o400 });
  return true;
}

export function sealedPath(): string {
  return process.env.WB_INITIAL_PW_FILE ?? '/var/lib/workbench/initial-password';
}

export async function removeSealed(): Promise<void> {
  await rm(sealedPath(), { force: true });
}

export function newSession(db: DatabaseSync): { id: string; expires: number } {
  const id = randomBytes(24).toString('hex');
  const expires = Date.now() + SESSION_TTL_MS;
  db.prepare('INSERT INTO sessions(id,expires_at,created_at) VALUES (?,?,?)').run(id, expires, Date.now());
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return { id, expires };
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

export function auditLogin(db: DatabaseSync, result: 'ok' | 'fail' | 'locked'): void {
  db.prepare('INSERT INTO auth_audit(ts,result,note) VALUES (?,?,?)').run(new Date().toISOString(), result, '');
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
