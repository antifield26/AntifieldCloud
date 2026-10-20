/**
 * 迁移 v4→v5 兼容性测试：files.origin 追加、唯一索引重建、share_items 回填与 v0.4.0 新表。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SUPPORTED_SCHEMA_VERSION, openDatabase } from '../src/db.ts'

function columnsOf(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((row) => row.name)
}

/** 构造 schema_version=4 的最小旧库（只含迁移 5 依赖的表与索引）。 */
function createV4Database(path: string): void {
  const old = new DatabaseSync(path)
  try {
    old.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_version', '4');

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

      INSERT INTO files (id, parent_id, name, kind, size, mime, sha256, storage_key, created_at, updated_at, deleted_at, deleted_parent_id)
        VALUES ('file-1', NULL, 'a.txt', 'file', 3, 'text/plain', '${'a'.repeat(64)}', 'file-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL);
      INSERT INTO shares (id, file_id, token_hash, expires_at, max_downloads, download_count, created_at, revoked_at, created_by)
        VALUES ('share-1', 'file-1', '${'b'.repeat(64)}', '2099-01-01T00:00:00.000Z', 0, 2, '2026-01-01T00:00:00.000Z', NULL, 'admin');
    `)
  } finally {
    old.close()
  }
}

test('v4 旧库升级到 v5：origin 默认 user、唯一索引含 origin、share_items 回填、新表可用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afc-v5-migration-'))
  const path = join(dir, 'old.sqlite')
  try {
    createV4Database(path)
    const db = openDatabase({ path })
    try {
      const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }
      assert.equal(version.value, String(SUPPORTED_SCHEMA_VERSION))

      // files 追加 origin，历史行默认 user；索引已重建为含 origin 的三列索引。
      assert.ok(columnsOf(db, 'files').includes('origin'))
      const file = db.prepare("SELECT origin FROM files WHERE id = 'file-1'").get() as { origin: string }
      assert.equal(file.origin, 'user', '历史文件默认 origin=user，保持可见')
      const indexSql = (
        db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_files_unique_active_name'").get() as {
          sql: string
        }
      ).sql
      assert.match(indexSql, /origin/i)

      // 同父目录、同 origin 名称唯一仍生效；不同 origin 可同名。
      db.exec(`
        INSERT INTO files (id, parent_id, name, kind, size, mime, sha256, storage_key, created_at, updated_at, deleted_at, deleted_parent_id, origin)
          VALUES ('file-note', NULL, 'a.txt', 'file', 1, 'text/plain', '${'c'.repeat(64)}', 'file-note', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', NULL, NULL, 'note');
      `)
      assert.throws(() => {
        db.exec(`
          INSERT INTO files (id, parent_id, name, kind, size, mime, sha256, storage_key, created_at, updated_at, deleted_at, deleted_parent_id, origin)
            VALUES ('file-dup', NULL, 'A.TXT', 'file', 1, 'text/plain', '${'d'.repeat(64)}', 'file-dup', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', NULL, NULL, 'user');
        `)
      }, /UNIQUE/, '同 origin 同名应冲突')

      // share_items 回填旧 shares 行。
      const items = db.prepare("SELECT share_id, file_id FROM share_items WHERE share_id = 'share-1'").all() as unknown as {
        share_id: string
        file_id: string
      }[]
      assert.deepEqual(
        items.map((item) => [item.share_id, item.file_id]),
        [['share-1', 'file-1']],
      )

      for (const table of ['note_attachments', 'note_versions', 'metrics_samples']) {
        assert.ok(columnsOf(db, table).length > 0, `缺少表 ${table}`)
      }
      assert.ok(columnsOf(db, 'note_versions').includes('tags_json'))
      assert.ok(columnsOf(db, 'metrics_samples').includes('ts_epoch'))
    } finally {
      db.close()
    }

    // 再次打开不重复迁移，回填数据保留。
    const reopened = openDatabase({ path })
    try {
      assert.equal((reopened.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, String(SUPPORTED_SCHEMA_VERSION))
      assert.equal((reopened.prepare('SELECT COUNT(*) AS c FROM share_items').get() as { c: number }).c, 1)
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

test('schema 版本高于程序支持：拒绝启动而不是静默跳过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afc-schema-ahead-'))
  const path = join(dir, 'future.sqlite')
  try {
    const raw = new DatabaseSync(path)
    try {
      raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '99');")
    } finally {
      raw.close()
    }
    assert.throws(() => openDatabase({ path }), /高于当前程序支持/)
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 句柄释放可能滞后。
    }
  }
})

test('迁移前修复孤儿 shares 并回填 share_items；其它外键损坏拒绝启动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afc-orphan-repair-'))
  try {
    // 先建立最新 schema 的库，再用 foreign_keys=OFF 注入历史孤儿行（模拟旧版本异常写入）。
    const path = join(dir, 'db.sqlite')
    const seed = openDatabase({ path })
    seed.close()
    const raw = new DatabaseSync(path)
    try {
      raw.exec('PRAGMA foreign_keys = OFF')
      raw
        .prepare(
          `INSERT INTO shares (id, file_id, token_hash, expires_at, max_downloads, download_count, created_at, revoked_at, created_by, note)
           VALUES ('orphan-share', 'missing-file', ?, '2099-01-01T00:00:00.000Z', 0, 0, '2026-01-01T00:00:00.000Z', NULL, 'admin', NULL)`,
        )
        .run('c'.repeat(64))
      raw
        .prepare(
          `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, created_at, expires_at, last_seen_at, ip, user_agent)
           VALUES ('orphan-session', 'missing-user', ?, ?, '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL)`,
        )
        .run('d'.repeat(64), 'e'.repeat(64))
    } finally {
      raw.close()
    }
    // 孤儿 session 不属于可自动修复范围：先删掉它验证修复，再单独验证拒绝启动。
    const cleanup = new DatabaseSync(path)
    try {
      cleanup.exec('PRAGMA foreign_keys = OFF')
      cleanup.prepare("DELETE FROM sessions WHERE id = 'orphan-session'").run()
    } finally {
      cleanup.close()
    }

    const repaired = openDatabase({ path })
    try {
      assert.equal(
        (repaired.prepare("SELECT COUNT(*) AS c FROM shares WHERE id = 'orphan-share'").get() as { c: number }).c,
        0,
        '孤儿分享应被清理',
      )
      assert.equal(
        (repaired.prepare("SELECT COUNT(*) AS c FROM share_items WHERE share_id = 'orphan-share'").get() as { c: number }).c,
        0,
      )
    } finally {
      repaired.close()
    }

    const broken = new DatabaseSync(path)
    try {
      broken.exec('PRAGMA foreign_keys = OFF')
      broken
        .prepare(
          `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, created_at, expires_at, last_seen_at, ip, user_agent)
           VALUES ('broken-session', 'missing-user', ?, ?, '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL)`,
        )
        .run('f'.repeat(64), 'a'.repeat(64))
    } finally {
      broken.close()
    }
    assert.throws(() => openDatabase({ path }), /外键一致性检查失败/)
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 句柄释放可能滞后。
    }
  }
})

