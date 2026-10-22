/**
 * v6→v11 迁移测试：v0.4.x 生产库（schema v6）升级必须依次创建 Bot 表（v7）、
 * QQ/静默/AI 会话（v8）、Chat/记忆/入站发现（v9）、AI 会话 mode（v10）与私聊角色卡（v11）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SUPPORTED_SCHEMA_VERSION, openDatabase } from '../src/db.ts'

test('v6 库升级到 v11：创建 Bot/QQ/AI/Chat/角色卡表、保留迁移 6 修复并升级会话 mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antifieldcloud-bot-migration-'))
  const path = join(dir, 'db.sqlite')
  try {
    const db = openDatabase({ path })
    assert.equal(SUPPORTED_SCHEMA_VERSION, 11)
    // 模拟 v0.4.2 已升级到 v6、尚无 Bot 表的生产库；v9/v10/v11 新增表必须先删除，避免迁移建表冲突。
    db.exec(`
      DROP TABLE bot_chat_roles;
      DROP TABLE bot_inbound_targets;
      DROP TABLE bot_ai_memories;
      DROP TABLE bot_ai_sessions;
      DROP TABLE bot_events;
      DROP TABLE bot_publish_jobs;
      DROP TABLE bot_deliveries;
      DROP TABLE bot_targets;
      DROP TABLE bots;
      UPDATE meta SET value = '6' WHERE key = 'schema_version';
    `)
    db.close()

    const upgraded = openDatabase({ path })
    try {
      const version = upgraded.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }
      assert.equal(version.value, '11')
      const tables = (
        upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as unknown as { name: string }[]
      ).map((row) => row.name)
      for (const table of [
        'bots',
        'bot_targets',
        'bot_deliveries',
        'bot_publish_jobs',
        'bot_events',
        'bot_ai_sessions',
        'bot_ai_memories',
        'bot_inbound_targets',
        'bot_chat_roles',
      ]) {
        assert.ok(tables.includes(table), `缺少 ${table}`)
      }
      const sessionColumns = (
        upgraded.prepare('PRAGMA table_info(bot_ai_sessions)').all() as unknown as { name: string }[]
      ).map((row) => row.name)
      assert.ok(sessionColumns.includes('mode'))
      const targetColumns = (
        upgraded.prepare('PRAGMA table_info(bot_targets)').all() as unknown as { name: string }[]
      ).map((row) => row.name)
      assert.ok(targetColumns.includes('quiet_start_minute'))
      assert.ok(targetColumns.includes('quiet_end_minute'))
      assert.ok(targetColumns.includes('allow_chat'))
      // v8 的 bots 表 CHECK 必须接受 qq；用最小合法行验证约束已重建。
      upgraded
        .prepare(
          `INSERT INTO bots (id, platform, name, enabled, config_json, secret_ciphertext, secret_iv, secret_tag, key_version, created_at, updated_at)
           VALUES ('migration-qq', 'qq', 'QQ', 0, '{}', 'x', 'x', 'x', 1, '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z')`,
        )
        .run()
      // 既有目标升级后 Chat 默认关闭。
      upgraded
        .prepare(
          `INSERT INTO bot_targets (id, bot_id, external_id, label, kind, allow_commands, allow_notifications, created_at)
           VALUES ('migration-target', 'migration-qq', 'group-1', '群', 'group', 0, 1, '2026-10-21T00:00:00.000Z')`,
        )
        .run()
      const target = upgraded
        .prepare("SELECT allow_chat FROM bot_targets WHERE id = 'migration-target'")
        .get() as { allow_chat: number }
      assert.equal(target.allow_chat, 0)
    } finally {
      upgraded.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('v9 库升级到 v11：旧会话归为 Chat，主键允许 task/chat 两行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antifieldcloud-bot-migration-session-'))
  const path = join(dir, 'db.sqlite')
  try {
    const db = openDatabase({ path })
    db.exec(`
      DROP TABLE bot_chat_roles;
      DROP TABLE bot_ai_sessions;
      CREATE TABLE bot_ai_sessions (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        target_external_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, target_external_id, user_id)
      );
      CREATE INDEX idx_bot_ai_sessions_updated ON bot_ai_sessions(updated_at);
      INSERT INTO bots (id, platform, name, enabled, config_json, secret_ciphertext, secret_iv, secret_tag, key_version, created_at, updated_at)
        VALUES ('bot-1', 'qq', 'QQ', 0, '{}', 'x', 'x', 'x', 1, '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
      INSERT INTO bot_ai_sessions (bot_id, target_external_id, user_id, session_id, model, created_at, updated_at)
        VALUES ('bot-1', 'group-1', 'user-1', 'old-chat-session', 'm', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
      UPDATE meta SET value = '9' WHERE key = 'schema_version';
    `)
    db.close()

    const upgraded = openDatabase({ path })
    try {
      const old = upgraded
        .prepare("SELECT mode, session_id FROM bot_ai_sessions WHERE session_id = 'old-chat-session'")
        .get() as { mode: string; session_id: string }
      assert.equal(old.mode, 'chat')
      upgraded
        .prepare(
          `INSERT INTO bot_ai_sessions
           (bot_id, target_external_id, user_id, mode, session_id, model, created_at, updated_at)
           VALUES ('bot-1', 'group-1', 'user-1', 'task', 'new-task-session', 'm', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z')`,
        )
        .run()
      const rows = upgraded
        .prepare("SELECT mode FROM bot_ai_sessions WHERE bot_id = 'bot-1' ORDER BY mode")
        .all() as unknown as { mode: string }[]
      assert.deepEqual(rows.map((row) => row.mode), ['chat', 'task'])
      const roleTable = upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bot_chat_roles'")
        .get() as { name: string } | undefined
      assert.equal(roleTable?.name, 'bot_chat_roles')
    } finally {
      upgraded.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('v10 库升级到 v11：新增角色卡表且保留会话 mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antifieldcloud-bot-migration-role-'))
  const path = join(dir, 'db.sqlite')
  try {
    const db = openDatabase({ path })
    db.exec(`
      DROP TABLE bot_chat_roles;
      UPDATE meta SET value = '10' WHERE key = 'schema_version';
    `)
    db.close()

    const upgraded = openDatabase({ path })
    try {
      const version = upgraded.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }
      assert.equal(version.value, '11')
      const columns = (
        upgraded.prepare('PRAGMA table_info(bot_chat_roles)').all() as unknown as { name: string }[]
      ).map((row) => row.name)
      assert.deepEqual(columns, ['bot_id', 'user_id', 'name', 'prompt', 'enabled', 'created_at', 'updated_at'])
    } finally {
      upgraded.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})
