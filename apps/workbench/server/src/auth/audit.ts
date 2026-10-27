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

export interface AuditDiagnostics {
  /** 进程启动以来审计写入失败次数（DB 忙/磁盘满等）；有持久化行时为累计值。 */
  failureCount: number
  /** 最近一次失败的错误摘要（不含敏感内容）；无失败为 null。 */
  lastError: string | null
  /** 最近一次失败时间（ISO 8601）；无失败为 null。 */
  lastFailureAt: string | null
  /** 是否来自 DB 持久化行；DB 不可用时为 false，仅内存诊断。 */
  persisted: boolean
}

let auditFailureCount = 0
let auditLastError: string | null = null
let auditLastFailureAt: string | null = null

/**
 * 审计写入诊断：优先读 DB 持久化行，DB 不可用时回退进程内计数。
 * 持久化写入本身失败时只保留内存值，不递归审计、不阻断业务。
 */
export function getAuditDiagnostics(db?: DatabaseSync): AuditDiagnostics {
  if (db) {
    try {
      const row = db
        .prepare('SELECT failure_count, last_error, last_failure_at FROM audit_write_failures WHERE id = 1')
        .get() as { failure_count: number; last_error: string | null; last_failure_at: string | null } | undefined
      if (row) {
        return {
          failureCount: Number(row.failure_count),
          lastError: row.last_error,
          lastFailureAt: row.last_failure_at,
          persisted: true,
        }
      }
    } catch {
      // DB 不可用时回退内存诊断。
    }
  }
  return {
    failureCount: auditFailureCount,
    lastError: auditLastError,
    lastFailureAt: auditLastFailureAt,
    persisted: false,
  }
}

/** 测试/维护用：重置诊断计数；传入 db 时同时清零持久化行。 */
export function resetAuditDiagnostics(db?: DatabaseSync): void {
  auditFailureCount = 0
  auditLastError = null
  auditLastFailureAt = null
  if (!db) return
  try {
    db.prepare(
      "UPDATE audit_write_failures SET failure_count = 0, last_error = NULL, last_failure_at = NULL, updated_at = ? WHERE id = 1",
    ).run(nowIso())
  } catch {
    // DB 不可用时只清内存。
  }
}

/** 记录审计写入失败：内存诊断必更新，DB 持久化 best-effort。 */
function recordAuditFailure(db: DatabaseSync, error: unknown): void {
  auditFailureCount += 1
  auditLastFailureAt = nowIso()
  auditLastError = (error instanceof Error ? error.message : String(error)).slice(0, 200)
  try {
    db.prepare(
      `INSERT INTO audit_write_failures (id, failure_count, last_error, last_failure_at, updated_at)
       VALUES (1, 1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         failure_count = audit_write_failures.failure_count + 1,
         last_error = excluded.last_error,
         last_failure_at = excluded.last_failure_at,
         updated_at = excluded.updated_at`,
    ).run(auditLastError, auditLastFailureAt, auditLastFailureAt)
  } catch {
    // DB 故障时保留内存诊断；不能因持久化失败再次抛错。
  }
}

/**
 * 写审计：审计失败不阻断已完成的业务，但必须可见（计数 + 最近错误）。
 * 安全关键审计（登录/发布/工具隔离）由调用方在返回值/状态中体现，不靠抛错。
 */
export function audit(
  db: DatabaseSync,
  actor: string,
  action: string,
  target?: string | null,
  detail?: Record<string, unknown> | null,
  ip?: string | null,
): void {
  try {
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
  } catch (error) {
    // 审计失败不静默：内存计数 + 最近错误 + best-effort 持久化，交由 /api/version 诊断观察。
    recordAuditFailure(db, error)
  }
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
