import { chmod, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Logger } from '../logger.ts'

export interface HistorySample {
  ts: string
  connected: boolean
  state: string
  taskName: string | null
  taskState: string | null
  health: number | null
  food: number | null
  memoryMb: number | null
  tps: number | null
  queueLen: number
  rssMb: number | null
}

export interface HistoryAlert {
  ts: string
  type: string
  severity: string
  message: string
  details: Record<string, unknown>
}

export interface StoredAlert extends HistoryAlert {
  id: number
}

export interface HistoryQuery {
  from?: string
  to?: string
  limit?: number
}

const MAX_LIMIT = 1000

function clampLimit (limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 100
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit as number)))
}

function validateIso (value: string | undefined): string | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error('timestamp must be ISO-8601')
  return new Date(parsed).toISOString()
}

function rowToSample (row: Record<string, unknown>): HistorySample {
  return {
    ts: String(row.ts),
    connected: Number(row.connected) !== 0,
    state: String(row.state),
    taskName: row.task_name === null ? null : String(row.task_name),
    taskState: row.task_state === null ? null : String(row.task_state),
    health: row.health === null ? null : Number(row.health),
    food: row.food === null ? null : Number(row.food),
    memoryMb: row.memory_mb === null ? null : Number(row.memory_mb),
    tps: row.tps === null ? null : Number(row.tps),
    queueLen: Number(row.queue_len),
    rssMb: row.rss_mb === null ? null : Number(row.rss_mb)
  }
}

function rowToAlert (row: Record<string, unknown>): StoredAlert {
  let details: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(String(row.details_json)) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) details = parsed as Record<string, unknown>
  } catch {
    // keep empty details
  }
  return {
    id: Number(row.id),
    ts: String(row.ts),
    type: String(row.type),
    severity: String(row.severity),
    message: String(row.message),
    details
  }
}

export class HistoryStore {
  private readonly file: string
  private readonly retentionDays: number
  private readonly logger: Logger
  private db: DatabaseSync | null = null

  constructor (file: string, retentionDays: number, logger: Logger) {
    this.file = file
    this.retentionDays = retentionDays
    this.logger = logger
  }

  async init (): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    try {
      this.open()
    } catch (error) {
      this.logger.warn('history: database open failed; quarantining', {
        error: error instanceof Error ? error.message : String(error)
      })
      await rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {})
      this.open()
    }
    await chmod(this.file, 0o600).catch(() => {})
    this.db?.exec(`
      CREATE TABLE IF NOT EXISTS samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        connected INTEGER NOT NULL,
        state TEXT NOT NULL,
        task_name TEXT,
        task_state TEXT,
        health REAL,
        food REAL,
        memory_mb REAL,
        tps REAL,
        queue_len INTEGER NOT NULL,
        rss_mb REAL
      );
      CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);
    `)
    this.cleanup()
  }

  private open (): void {
    this.db = new DatabaseSync(this.file)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;')
  }

  insertSample (sample: HistorySample): void {
    const db = this.db
    if (!db) return
    try {
      db.prepare(`
        INSERT INTO samples (ts, connected, state, task_name, task_state, health, food, memory_mb, tps, queue_len, rss_mb)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sample.ts,
        sample.connected ? 1 : 0,
        sample.state,
        sample.taskName,
        sample.taskState,
        sample.health,
        sample.food,
        sample.memoryMb,
        sample.tps,
        sample.queueLen,
        sample.rssMb
      )
    } catch (error) {
      this.logger.warn('history: sample insert failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  insertAlert (alert: HistoryAlert): number | null {
    const db = this.db
    if (!db) return null
    try {
      const result = db.prepare(`
        INSERT INTO alerts (ts, type, severity, message, details_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(alert.ts, alert.type, alert.severity, alert.message, JSON.stringify(alert.details))
      return Number(result.lastInsertRowid)
    } catch (error) {
      this.logger.warn('history: alert insert failed', { error: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  querySamples (query: HistoryQuery = {}): HistorySample[] {
    const db = this.db
    if (!db) return []
    const from = validateIso(query.from)
    const to = validateIso(query.to)
    const limit = clampLimit(query.limit)
    const conditions: string[] = []
    const params: Array<string | number> = []
    if (from) { conditions.push('ts >= ?'); params.push(from) }
    if (to) { conditions.push('ts <= ?'); params.push(to) }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(limit)
    const rows = db.prepare(`SELECT * FROM samples ${where} ORDER BY id DESC LIMIT ?`).all(...params) as Record<string, unknown>[]
    return rows.map(rowToSample).reverse()
  }

  queryAlerts (query: HistoryQuery = {}): StoredAlert[] {
    const db = this.db
    if (!db) return []
    const from = validateIso(query.from)
    const to = validateIso(query.to)
    const limit = clampLimit(query.limit)
    const conditions: string[] = []
    const params: Array<string | number> = []
    if (from) { conditions.push('ts >= ?'); params.push(from) }
    if (to) { conditions.push('ts <= ?'); params.push(to) }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(limit)
    const rows = db.prepare(`SELECT * FROM alerts ${where} ORDER BY id DESC LIMIT ?`).all(...params) as Record<string, unknown>[]
    return rows.map(rowToAlert).reverse()
  }

  cleanup (): void {
    const db = this.db
    if (!db) return
    const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000).toISOString()
    try {
      db.prepare('DELETE FROM samples WHERE ts < ?').run(cutoff)
      db.prepare('DELETE FROM alerts WHERE ts < ?').run(cutoff)
    } catch (error) {
      this.logger.warn('history: cleanup failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  close (): void {
    try {
      this.db?.close()
    } catch {
      // ignore
    }
    this.db = null
  }
}
