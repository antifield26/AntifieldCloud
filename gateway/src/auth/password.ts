// 内置密码认证：scrypt 哈希 + 会话 cookie + 全局失败退避。
// 说明：tunnel 前所有来源 IP 都是 127.0.0.1，故限流按全局连续失败计数，不按 IP。
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { writeFile, rm } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';

const scrypt = promisify(scryptCb);

export const SESSION_COOKIE = 'wb_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = (await scrypt(pw, salt, 64)) as Buffer;
  return `scrypt:${salt.toString('hex')}:${dk.toString('hex')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const want = Buffer.from(parts[2], 'hex');
  const dk = (await scrypt(pw, salt, 64)) as Buffer;
  if (dk.length !== want.length) return false;
  return timingSafeEqual(dk, want);
}

export function newPassword(): string {
  return randomBytes(12).toString('base64url');
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
  const pw = newPassword();
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
  db.prepare('INSERT INTO sessions(id,expires_at) VALUES (?,?)').run(id, expires);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return { id, expires };
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
