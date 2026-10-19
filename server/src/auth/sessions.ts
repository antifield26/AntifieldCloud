/** 会话：不透明 token 存 Cookie，数据库只存 SHA-256；过期/滑动续期在此处理。 */
import type { DatabaseSync } from 'node:sqlite'
import type { SessionRow } from '../types.ts'
import { newId, randomToken, sha256Hex } from '../util/ids.ts'
import { isoAfterDays, nowIso } from '../util/time.ts'

export interface CreatedSession {
  token: string
  sessionId: string
  expiresAt: string
}

export function createSession(
  db: DatabaseSync,
  userId: string,
  csrfToken: string,
  ttlDays: number,
  ip: string | null,
  userAgent: string | null,
): CreatedSession {
  const token = randomToken(32)
  const sessionId = newId()
  const now = nowIso()
  const expiresAt = isoAfterDays(ttlDays)
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, created_at, expires_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, userId, sha256Hex(token), sha256Hex(csrfToken), now, expiresAt, now, ip, userAgent)
  return { token, sessionId, expiresAt }
}

export interface SessionWithUser extends SessionRow {
  user_username: string
}

export function findSession(db: DatabaseSync, token: string): SessionWithUser | null {
  if (!token) return null
  const row = db
    .prepare(
      `SELECT s.*, u.username AS user_username
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(sha256Hex(token)) as SessionWithUser | undefined
  if (!row) return null
  if (Date.parse(row.expires_at) <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id)
    return null
  }
  const lastSeen = Date.parse(row.last_seen_at)
  if (!Number.isFinite(lastSeen) || Date.now() - lastSeen > 60_000) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(nowIso(), row.id)
    row.last_seen_at = nowIso()
  }
  return row
}

export function deleteSession(db: DatabaseSync, sessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
}

export function deleteOtherSessions(db: DatabaseSync, userId: string, keepSessionId: string): number {
  const result = db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, keepSessionId)
  return Number(result.changes)
}

export function deleteAllSessions(db: DatabaseSync, userId: string): number {
  const result = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
  return Number(result.changes)
}

export function purgeExpiredSessions(db: DatabaseSync): number {
  const result = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso())
  return Number(result.changes)
}
