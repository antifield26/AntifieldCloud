/** migration 兼容性测试：v2 旧库逐级升级到最新 schema、旧行默认 origin=pi、新表/列可用。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SUPPORTED_SCHEMA_VERSION, openDatabase } from '../src/db.ts'

function columnsOf(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((row) => row.name)
}

test('schema v2 旧库升级到 v5：追加列、旧行 origin=pi、restore_plans/upload/笔记/分享/指标表可用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afc-backup-migration-'))
  const path = join(dir, 'old.sqlite')
  try {
    const old = new DatabaseSync(path)
    old.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_version', '2');
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
      CREATE UNIQUE INDEX idx_files_unique_active_name
        ON files(COALESCE(parent_id, ''), name COLLATE NOCASE)
        WHERE deleted_at IS NULL;
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body_md TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE shares (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        password_salt TEXT,
        expires_at TEXT NOT NULL,
        max_downloads INTEGER NOT NULL DEFAULT 0,
        download_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        created_by TEXT NOT NULL,
        note TEXT
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
      INSERT INTO backup_archives (name, mode, created_at, sha256, size, file_count, pulled_at, acked_at, deleted_at)
        VALUES ('snapshot-20260101T000000Z-full.tar.gz', 'full', '2026-01-01T00:00:00.000Z', '${'a'.repeat(64)}', 1024, 1, NULL, NULL, NULL);
    `)
    old.close()

    const db = openDatabase({ path })
    try {
      const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }
      assert.equal(version.value, String(SUPPORTED_SCHEMA_VERSION))
      const columns = columnsOf(db, 'backup_archives')
      for (const column of ['verified_at', 'origin', 'manifest_json', 'last_error']) {
        assert.ok(columns.includes(column), `backup_archives 缺少列 ${column}`)
      }
      const oldRow = db.prepare("SELECT * FROM backup_archives WHERE name = 'snapshot-20260101T000000Z-full.tar.gz'").get() as {
        origin: string
        verified_at: string | null
      }
      assert.equal(oldRow.origin, 'pi', '旧行默认 origin 应为 pi')
      assert.equal(oldRow.verified_at, null)

      assert.deepEqual(columnsOf(db, 'restore_plans').sort(), [
        'archives_json',
        'completed_at',
        'created_at',
        'created_by',
        'error',
        'expires_at',
        'id',
        'selection_json',
        'status',
        'target_name',
      ])

      // v0.3.1：分片会话表随迁移创建，旧备份数据不受影响。
      assert.ok(columnsOf(db, 'upload_sessions').includes('received'))
      assert.ok(columnsOf(db, 'upload_chunks').includes('sha256'))

      // 导入归档行可以写入新字段，且旧数据仍可查询。
      db.prepare(
        `INSERT INTO backup_archives (name, mode, created_at, sha256, size, file_count, origin, verified_at)
         VALUES ('snapshot-20260102T000000Z-inc.tar.gz', 'inc', '2026-01-02T00:00:00.000Z', '${'b'.repeat(64)}', 2048, 2, 'import', '2026-01-02T01:00:00.000Z')`,
      ).run()
      const rows = db.prepare('SELECT origin FROM backup_archives ORDER BY name').all() as unknown as { origin: string }[]
      assert.deepEqual(rows.map((row) => row.origin), ['pi', 'import'])
    } finally {
      db.close()
    }

    // 再次打开不应重复执行迁移，数据保留。
    const reopened = openDatabase({ path })
    try {
      assert.equal((reopened.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, String(SUPPORTED_SCHEMA_VERSION))
      assert.equal((reopened.prepare('SELECT COUNT(*) AS c FROM backup_archives').get() as { c: number }).c, 2)
    } finally {
      reopened.close()
    }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 上 DB 句柄释放可能滞后，测试目录由系统临时目录清理。
    }
  }
})


