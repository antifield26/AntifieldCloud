/** 审计日志：只记录元数据，调用方负责不传入密码/TOTP/Cookie。 */
import type { DatabaseSync } from 'node:sqlite'
import type { AuditRow } from '../types.ts'
import { nowIso } from '../util/time.ts'

export function audit(
  db: DatabaseSync,
  actor: string,
  action: string,
  target?: string | null,
  detail?: Record<string, unknown> | null,
  ip?: string | null,
): void {
  db.prepare(
    'INSERT INTO audit_log (ts, actor, action, target, detail_json, ip) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    nowIso(),
    actor,
    action,
    target ?? null,
    detail ? JSON.stringify(detail) : null,
    ip ?? null,
  )
}

export interface AuditItem {
  id: number
  ts: string
  action: string
  target: string | null
  detail: Record<string, unknown> | null
  ip: string | null
}

function toItem(row: AuditRow): AuditItem {
  let detail: Record<string, unknown> | null = null
  if (row.detail_json) {
    try {
      detail = JSON.parse(row.detail_json) as Record<string, unknown>
    } catch {
      detail = null
    }
  }
  return { id: row.id, ts: row.ts, action: row.action, target: row.target, detail, ip: row.ip }
}

export function listAudit(
  db: DatabaseSync,
  options: { limit: number; offset: number; action?: string | null },
): { items: AuditItem[]; total: number } {
  const limit = Math.min(200, Math.max(1, options.limit))
  const offset = Math.max(0, options.offset)
  const action = options.action?.trim()
  if (action) {
    const total = db.prepare('SELECT COUNT(*) AS c FROM audit_log WHERE action = ?').get(action) as { c: number }
    const rows = db
      .prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(action, limit, offset) as unknown as AuditRow[]
    return { items: rows.map(toItem), total: total.c }
  }
  const total = db.prepare('SELECT COUNT(*) AS c FROM audit_log').get() as { c: number }
  const rows = db
    .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(limit, offset) as unknown as AuditRow[]
  return { items: rows.map(toItem), total: total.c }
}

export function purgeAudit(db: DatabaseSync, retentionDays: number): number {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
  const result = db.prepare('DELETE FROM audit_log WHERE ts < ?').run(cutoff)
  return Number(result.changes)
}
