// 工作台库（wb.db）—— 与 OpenCode 库物理分离。
// SQLite WAL + synchronous=NORMAL（SD 写入减负）。
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS todos(id TEXT PRIMARY KEY, title TEXT NOT NULL, done INT DEFAULT 0, due_at TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, title TEXT, body TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS bookmarks(id TEXT PRIMARY KEY, title TEXT, url TEXT NOT NULL, created_at TEXT);
CREATE TABLE IF NOT EXISTS files_meta(id TEXT PRIMARY KEY, name TEXT, path TEXT, size INT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS metrics_ts(ts INT, cpu REAL, mem_used INT, mem_total INT, temp_c REAL, disk_written_kb INT);
CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics_ts(ts);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, name TEXT, cron TEXT, kind TEXT, payload TEXT, enabled INT, last_run TEXT, last_status TEXT);
CREATE TABLE IF NOT EXISTS job_runs(id TEXT PRIMARY KEY, job_id TEXT, started_at TEXT, finished_at TEXT, status TEXT, log TEXT);
CREATE TABLE IF NOT EXISTS service_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, actor TEXT, unit TEXT, action TEXT, allowed INT, reason TEXT);
CREATE TABLE IF NOT EXISTS backups(id TEXT PRIMARY KEY, ts TEXT, target TEXT, bytes INT, sha256 TEXT, status TEXT, log TEXT);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, expires_at INT);
CREATE TABLE IF NOT EXISTS auth_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, result TEXT, note TEXT);
`;

let db: DatabaseSync | null = null;

export function openDb(path: string): DatabaseSync {
  if (db !== null) return db;
  const d = new DatabaseSync(path);
  d.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  d.exec(SCHEMA);
  db = d;
  return d;
}

export function dbModes(d: DatabaseSync): { journal_mode: string; synchronous: string } {
  const jm = d.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
  const sy = d.prepare('PRAGMA synchronous').get() as { synchronous: string };
  return { journal_mode: jm.journal_mode, synchronous: String(sy.synchronous) };
}
