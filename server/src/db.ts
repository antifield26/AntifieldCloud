/**
 * SQLite 数据库：打开、PRAGMA、版本化迁移。
 *
 * 约束：
 * - 时间统一 ISO 8601 UTC 字符串。
 * - 迁移只追加，不修改历史 SQL；启动时按 meta.schema_version 顺序执行。
 * - 所有服务共享同一个 DatabaseSync 实例（单进程）。
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    totp_secret TEXT NOT NULL,
    totp_last_step INTEGER NOT NULL DEFAULT 0,
    recovery_codes_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE auth_challenges (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_challenges_expires ON auth_challenges(expires_at);

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);
  CREATE INDEX idx_sessions_expires ON sessions(expires_at);

  CREATE TABLE files (
    id TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES files(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('file', 'dir')),
    size INTEGER NOT NULL DEFAULT 0,
    mime TEXT,
    sha256 TEXT,
    storage_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    deleted_parent_id TEXT
  );
  CREATE INDEX idx_files_parent ON files(parent_id, deleted_at);
  CREATE INDEX idx_files_name ON files(name COLLATE NOCASE);
  CREATE INDEX idx_files_updated ON files(updated_at);
  CREATE INDEX idx_files_deleted ON files(deleted_at);
  CREATE UNIQUE INDEX idx_files_unique_active_name
    ON files(COALESCE(parent_id, ''), name COLLATE NOCASE)
    WHERE deleted_at IS NULL;

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail_json TEXT,
    ip TEXT
  );
  CREATE INDEX idx_audit_ts ON audit_log(ts);
  CREATE INDEX idx_audit_action ON audit_log(action);

  CREATE TABLE login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    ts TEXT NOT NULL,
    success INTEGER NOT NULL
  );
  CREATE INDEX idx_login_ip_ts ON login_attempts(ip, ts);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE backup_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_backup_at TEXT,
    last_archive TEXT,
    last_sha256 TEXT,
    last_size INTEGER
  );
  INSERT OR IGNORE INTO backup_state (id) VALUES (1);
  `,
  `
  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body_md TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_notes_updated ON notes(updated_at DESC);
  CREATE INDEX idx_notes_pinned ON notes(pinned, updated_at DESC);

  CREATE TABLE bookmarks (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_bookmarks_updated ON bookmarks(updated_at DESC);
  CREATE INDEX idx_bookmarks_pinned ON bookmarks(pinned, updated_at DESC);

  CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE
  );

  CREATE TABLE note_tags (
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, tag_id)
  );
  CREATE INDEX idx_note_tags_tag ON note_tags(tag_id, note_id);

  CREATE TABLE bookmark_tags (
    bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (bookmark_id, tag_id)
  );
  CREATE INDEX idx_bookmark_tags_tag ON bookmark_tags(tag_id, bookmark_id);

  CREATE VIRTUAL TABLE notes_fts USING fts5(
    title,
    body_md,
    content='notes',
    content_rowid='rowid'
  );
  CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
  END;
  CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body_md) VALUES ('delete', old.rowid, old.title, old.body_md);
  END;
  CREATE TRIGGER notes_fts_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body_md) VALUES ('delete', old.rowid, old.title, old.body_md);
    INSERT INTO notes_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
  END;

  CREATE VIRTUAL TABLE bookmarks_fts USING fts5(
    title,
    url,
    description,
    content='bookmarks',
    content_rowid='rowid'
  );
  CREATE TRIGGER bookmarks_fts_ai AFTER INSERT ON bookmarks BEGIN
    INSERT INTO bookmarks_fts(rowid, title, url, description) VALUES (new.rowid, new.title, new.url, new.description);
  END;
  CREATE TRIGGER bookmarks_fts_ad AFTER DELETE ON bookmarks BEGIN
    INSERT INTO bookmarks_fts(bookmarks_fts, rowid, title, url, description) VALUES ('delete', old.rowid, old.title, old.url, old.description);
  END;
  CREATE TRIGGER bookmarks_fts_au AFTER UPDATE ON bookmarks BEGIN
    INSERT INTO bookmarks_fts(bookmarks_fts, rowid, title, url, description) VALUES ('delete', old.rowid, old.title, old.url, old.description);
    INSERT INTO bookmarks_fts(rowid, title, url, description) VALUES (new.rowid, new.title, new.url, new.description);
  END;

  CREATE TABLE shares (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    password_salt TEXT,
    expires_at TEXT NOT NULL,
    max_downloads INTEGER NOT NULL DEFAULT 0 CHECK (max_downloads >= 0),
    download_count INTEGER NOT NULL DEFAULT 0 CHECK (download_count >= 0),
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    created_by TEXT NOT NULL,
    note TEXT
  );
  CREATE INDEX idx_shares_file ON shares(file_id, created_at DESC);
  CREATE INDEX idx_shares_expires ON shares(expires_at);

  CREATE TABLE share_sessions (
    id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    downloaded INTEGER NOT NULL DEFAULT 0 CHECK (downloaded IN (0, 1))
  );
  CREATE INDEX idx_share_sessions_expires ON share_sessions(expires_at);
  CREATE INDEX idx_share_sessions_share ON share_sessions(share_id);

  CREATE TABLE alert_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    details_json TEXT,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    delivery_error TEXT
  );
  CREATE INDEX idx_alert_events_created ON alert_events(created_at DESC);
  CREATE INDEX idx_alert_events_event ON alert_events(event, created_at DESC);

  CREATE TABLE alert_state (
    event TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    last_fired_at TEXT,
    last_ok_at TEXT
  );

  CREATE TABLE backup_archives (
    name TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('full', 'inc')),
    created_at TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    file_count INTEGER NOT NULL,
    pulled_at TEXT,
    acked_at TEXT,
    deleted_at TEXT
  );
  CREATE INDEX idx_backup_archives_pending ON backup_archives(acked_at, created_at);
  `,
  `
  -- v0.3.0：备份管理/文件级恢复。仅追加列与新表，旧库（schema v2）可直接升级。
  ALTER TABLE backup_archives ADD COLUMN verified_at TEXT;
  ALTER TABLE backup_archives ADD COLUMN origin TEXT NOT NULL DEFAULT 'pi';
  ALTER TABLE backup_archives ADD COLUMN manifest_json TEXT;
  ALTER TABLE backup_archives ADD COLUMN last_error TEXT;
  CREATE INDEX idx_backup_archives_origin ON backup_archives(origin);

  CREATE TABLE restore_plans (
    id TEXT PRIMARY KEY,
    archives_json TEXT NOT NULL,
    selection_json TEXT NOT NULL,
    target_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('planned', 'executing', 'completed', 'failed', 'expired')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    completed_at TEXT,
    error TEXT
  );
  CREATE INDEX idx_restore_plans_status ON restore_plans(status, expires_at);
  `,
]

export interface OpenOptions {
  /** 测试可传入 :memory:；生产为文件路径。 */
  path: string
  /** 是否输出迁移日志，默认 false。 */
  verbose?: boolean
}

function migrate(db: DatabaseSync, verbose: boolean): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined
  let current = row ? Number(row.value) : 0
  if (!Number.isInteger(current) || current < 0) current = 0
  while (current < MIGRATIONS.length) {
    const sql = MIGRATIONS[current]!
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(sql)
      db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run('schema_version', String(current + 1))
      db.exec('COMMIT')
      current += 1
      if (verbose) console.log(`[db] migrated to schema v${current}`)
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}

export function openDatabase(options: OpenOptions): DatabaseSync {
  if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true })
  const db = new DatabaseSync(options.path)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  if (options.path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
  }
  migrate(db, options.verbose ?? false)
  return db
}

/** 简单事务封装；fn 抛错自动回滚。 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = fn()
    db.exec('COMMIT')
    return value
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value)
}
