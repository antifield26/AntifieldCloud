/** 审计日志：只记录元数据，调用方负责不传入密码/TOTP/Cookie。 */
import type { DatabaseSync } from 'node:sqlite'
import type { AuditRow } from '../types.ts'
import { nowIso } from '../util/time.ts'

/** 单条审计的字段上限：避免超长输入把 audit_log 撑大导致列表接口 OOM（512M MemoryMax）。 */
export const AUDIT_ACTOR_MAX_LENGTH = 64
export const AUDIT_TARGET_MAX_LENGTH = 256
export const AUDIT_DETAIL_MAX_BYTES = 4096

function clampText(value: string | null | undefined, maxLength: number): string | null {
  if (value === null || value === undefined) return null
  return value.length > maxLength ? value.slice(0, maxLength) : value
}

/** detail 序列化后超限时保存合法 JSON 的截断预览，而不是截断出非法 JSON。 */
function clampDetail(detail: Record<string, unknown> | null | undefined): string | null {
  if (!detail) return null
  const raw = JSON.stringify(detail)
  if (raw.length <= AUDIT_DETAIL_MAX_BYTES) return raw
  return JSON.stringify({ truncated: true, preview: raw.slice(0, AUDIT_DETAIL_MAX_BYTES - 64) })
}

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
    clampText(actor, AUDIT_ACTOR_MAX_LENGTH) ?? '(unknown)',
    clampText(action, 64) ?? '(unknown)',
    clampText(target, AUDIT_TARGET_MAX_LENGTH),
    clampDetail(detail),
    clampText(ip, 64),
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
  return {
    id: row.id,
    ts: row.ts,
    action: row.action,
    // 防御历史遗留的超长行：返回前再截断，保证 200 条列表响应大小可控。
    target: row.target === null ? null : row.target.slice(0, AUDIT_TARGET_MAX_LENGTH),
    detail: clampDetailForOutput(detail),
    ip: row.ip,
  }
}

function clampDetailForOutput(detail: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!detail) return null
  const raw = JSON.stringify(detail)
  if (raw.length <= AUDIT_DETAIL_MAX_BYTES) return detail
  return { truncated: true }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

export interface AuditQuery {
  limit: number
  offset: number
  action?: string | null
  /** 对 action/target/ip 做转义 LIKE 的关键字（空串忽略）。 */
  q?: string | null
  /** ISO 8601 时间下界（含）。 */
  from?: string | null
  /** ISO 8601 时间上界（含）。 */
  to?: string | null
}

export function listAudit(
  db: DatabaseSync,
  options: AuditQuery,
): { items: AuditItem[]; total: number } {
  const limit = Math.min(200, Math.max(1, options.limit))
  const offset = Math.max(0, options.offset)
  const clauses: string[] = []
  const params: (string | number)[] = []
  const action = options.action?.trim()
  if (action) {
    clauses.push('action = ?')
    params.push(action)
  }
  const keyword = options.q?.trim()
  if (keyword) {
    const pattern = `%${escapeLike(keyword)}%`
    clauses.push("(action LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\')")
    params.push(pattern, pattern, pattern)
  }
  if (options.from) {
    clauses.push('ts >= ?')
    params.push(options.from)
  }
  if (options.to) {
    clauses.push('ts <= ?')
    params.push(options.to)
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM audit_log ${where}`).get(...params) as { c: number }).c
  const rows = db
    .prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as unknown as AuditRow[]
  return { items: rows.map(toItem), total: Number(total) }
}

export function purgeAudit(db: DatabaseSync, retentionDays: number): number {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
  const result = db.prepare('DELETE FROM audit_log WHERE ts < ?').run(cutoff)
  return Number(result.changes)
}
