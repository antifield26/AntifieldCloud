/**
 * v6→v13 迁移测试：v0.4.x 生产库（schema v6）升级必须依次创建 Bot 表（v7）、
 * QQ/静默/AI 会话（v8）、Chat/记忆/入站发现（v9）、AI 会话 mode（v10）、
 * 私聊角色卡（v11）、群聊触发策略/事件诊断列（v12），并在 v13 删除非 QQ Bot 及其级联数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SUPPORTED_SCHEMA_VERSION, openDatabase } from '../src/db.ts'

test('v6 库升级到 v14：创建 Bot/AI/Chat/角色卡表，并补齐触发策略与事件诊断列', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antifieldcloud-bot-migration-'))
  const path = join(dir, 'db.sqlite')
  try {
    const db = openDatabase({ path })
    assert.equal(SUPPORTED_SCHEMA_VERSION, 14)
    // 模拟 v0.4.2 已升级到 v6、尚无 Bot 表的生产库；v7+ 新增表必须先删除，避免迁移建表冲突。
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
      assert.equal(version.value, '14')
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
      const eventColumns = (
        upgraded.prepare('PRAGMA table_info(bot_events)').all() as unknown as { name: string }[]
      ).map((row) => row.name)
      for (const column of ['event_kind', 'outcome', 'detail', 'target_external_id', 'user_id', 'updated_at']) {
        assert.ok(eventColumns.includes(column), `bot_events 缺少 ${column}`)
      }
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

test('v12 库升级到 v14：删除非 QQ Bot 及其级联数据，保留 QQ Bot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antifieldcloud-bot-migration-v13-'))
  const path = join(dir, 'db.sqlite')
  try {
    const db = openDatabase({ path })
    db.exec(`
      INSERT INTO bots (id, platform, name, enabled, config_json, secret_ciphertext, secret_iv, secret_tag, key_version, created_at, updated_at)
        VALUES ('bot-qq', 'qq', 'QQ', 1, '{}', 'x', 'x', 'x', 1, '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
      INSERT INTO bots (id, platform, name, enabled, config_json, secret_ciphertext, secret_iv, secret_tag, key_version, created_at, updated_at)
        VALUES ('bot-discord', 'discord', 'Discord', 1, '{}', 'x', 'x', 'x', 1, '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
      INSERT INTO bot_targets (id, bot_id, external_id, label, kind, allow_commands, allow_notifications, created_at)
        VALUES ('t-qq', 'bot-qq', 'qq-user', 'QQ 用户', 'user', 1, 1, '2026-10-21T00:00:00.000Z');
      INSERT INTO bot_targets (id, bot_id, external_id, label, kind, allow_commands, allow_notifications, created_at)
        VALUES ('t-discord', 'bot-discord', 'dc-channel', 'Discord 频道', 'channel', 1, 1, '2026-10-21T00:00:00.000Z');
      INSERT INTO bot_deliveries (id, bot_id, target_id, kind, dedupe_key, payload_json, status, attempts, created_at, updated_at)
        VALUES ('d-qq', 'bot-qq', 't-qq', 'notification', 'k1', '{"text":"x"}', 'sent', 0, '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
      INSERT INTO bot_deliveries (id, bot_id, target_id, kind, dedupe_key, payload_json, status, attempts, created_at, updated_at)
        VALUES ('d-discord', 'bot-discord', 't-discord', 'notification', 'k2', '{"text":"x"}', 'sent', 0, '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
      INSERT INTO bot_events (bot_id, platform_event_id, received_at, event_kind, outcome)
        VALUES ('bot-qq', 'evt-qq', '2026-10-21T00:00:00.000Z', 'chat', 'ok');
      INSERT INTO bot_events (bot_id, platform_event_id, received_at, event_kind, outcome)
        VALUES ('bot-discord', 'evt-dc', '2026-10-21T00:00:00.000Z', 'chat', 'ok');
      INSERT INTO bot_ai_sessions (bot_id, target_external_id, user_id, mode, session_id, created_at, updated_at)
        VALUES ('bot-qq', 'qq-user', 'u1', 'chat', 's-qq', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
      INSERT INTO bot_ai_sessions (bot_id, target_external_id, user_id, mode, session_id, created_at, updated_at)
        VALUES ('bot-discord', 'dc-channel', 'u2', 'chat', 's-dc', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
      INSERT INTO bot_ai_memories (bot_id, user_id, memory_id, summary, created_at, updated_at)
        VALUES ('bot-qq', 'u1', '11111111-1111-4111-8111-111111111111', 'qq memory', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
      INSERT INTO bot_ai_memories (bot_id, user_id, memory_id, summary, created_at, updated_at)
        VALUES ('bot-discord', 'u2', '22222222-2222-4222-8222-222222222222', 'dc memory', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
      INSERT INTO bot_chat_roles (bot_id, user_id, name, prompt, created_at, updated_at)
        VALUES ('bot-qq', 'u1', '角色', '设定', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
      INSERT INTO bot_chat_roles (bot_id, user_id, name, prompt, created_at, updated_at)
        VALUES ('bot-discord', 'u2', '角色', '设定', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
      INSERT INTO bot_inbound_targets (bot_id, target_external_id, target_kind, user_id, is_direct, last_seen_at)
        VALUES ('bot-qq', 'qq-user', 'user', 'u1', 1, '2026-10-21T00:00:00.000Z');
      INSERT INTO bot_inbound_targets (bot_id, target_external_id, target_kind, user_id, is_direct, last_seen_at)
        VALUES ('bot-discord', 'dc-channel', 'channel', 'u2', 0, '2026-10-21T00:00:00.000Z');
      UPDATE meta SET value = '12' WHERE key = 'schema_version';
    `)
    db.close()

    const upgraded = openDatabase({ path })
    try {
      const version = upgraded.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }
      assert.equal(version.value, '14')
      const bots = upgraded.prepare('SELECT id FROM bots ORDER BY id').all() as unknown as { id: string }[]
      assert.deepEqual(bots.map((row) => row.id), ['bot-qq'])
      const count = (table: string): number => {
        const row = upgraded.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE bot_id = 'bot-discord'`).get() as { c: number }
        return row.c
      }
      for (const table of ['bot_targets', 'bot_deliveries', 'bot_events', 'bot_ai_sessions', 'bot_ai_memories', 'bot_chat_roles', 'bot_inbound_targets']) {
        assert.equal(count(table), 0, `${table} 仍残留非 QQ Bot 数据`)
      }
      // QQ 数据必须保留。
      for (const table of ['bot_targets', 'bot_deliveries', 'bot_events', 'bot_ai_sessions', 'bot_ai_memories', 'bot_chat_roles', 'bot_inbound_targets']) {
        const row = upgraded.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE bot_id = 'bot-qq'`).get() as { c: number }
        assert.equal(row.c, 1, `${table} 的 QQ 数据被误删`)
      }
    } finally {
      upgraded.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('v11 库升级到 v14：追加触发策略与事件诊断列，旧行按默认值可读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antifieldcloud-bot-migration-v12-'))
  const path = join(dir, 'db.sqlite')
  try {
    const db = openDatabase({ path })
    // 删除 v12 新增的列/索引，构造 v11 结构后回退版本号。
    db.exec(`
      DROP INDEX idx_bot_events_outcome;
      ALTER TABLE bot_targets DROP COLUMN chat_trigger;
      ALTER TABLE bot_events DROP COLUMN event_kind;
      ALTER TABLE bot_events DROP COLUMN outcome;
      ALTER TABLE bot_events DROP COLUMN detail;
      ALTER TABLE bot_events DROP COLUMN target_external_id;
      ALTER TABLE bot_events DROP COLUMN user_id;
      ALTER TABLE bot_events DROP COLUMN updated_at;
      INSERT INTO bots (id, platform, name, enabled, config_json, secret_ciphertext, secret_iv, secret_tag, key_version, created_at, updated_at)
        VALUES ('bot-v11', 'qq', 'QQ', 0, '{}', 'x', 'x', 'x', 1, '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
      INSERT INTO bot_targets (id, bot_id, external_id, label, kind, allow_commands, allow_notifications, created_at)
        VALUES ('target-v11', 'bot-v11', 'group-1', '群', 'group', 0, 1, '2026-10-21T00:00:00.000Z');
      INSERT INTO bot_events (bot_id, platform_event_id, received_at) VALUES ('bot-v11', 'evt-1', '2026-10-21T00:00:00.000Z');
      UPDATE meta SET value = '11' WHERE key = 'schema_version';
    `)
    db.close()

    const upgraded = openDatabase({ path })
    try {
      const version = upgraded.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }
      assert.equal(version.value, '14')
      const target = upgraded
        .prepare("SELECT chat_trigger FROM bot_targets WHERE id = 'target-v11'")
        .get() as { chat_trigger: string }
      assert.equal(target.chat_trigger, 'mention')
      const event = upgraded
        .prepare("SELECT outcome, event_kind, detail FROM bot_events WHERE platform_event_id = 'evt-1'")
        .get() as { outcome: string | null; event_kind: string | null; detail: string | null }
      assert.equal(event.outcome, null)
      assert.equal(event.event_kind, null)
      assert.equal(event.detail, null)
    } finally {
      upgraded.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('v9/v10 库升级到 v14：旧会话归 Chat，主键允许 task/chat 两行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antifieldcloud-bot-migration-session-'))
  const path = join(dir, 'db.sqlite')
  try {
    const db = openDatabase({ path })
    db.exec(`
      DROP TABLE bot_chat_roles;
      DROP TABLE bot_ai_sessions;
      DROP INDEX idx_bot_events_outcome;
      ALTER TABLE bot_targets DROP COLUMN chat_trigger;
      ALTER TABLE bot_events DROP COLUMN event_kind;
      ALTER TABLE bot_events DROP COLUMN outcome;
      ALTER TABLE bot_events DROP COLUMN detail;
      ALTER TABLE bot_events DROP COLUMN target_external_id;
      ALTER TABLE bot_events DROP COLUMN user_id;
      ALTER TABLE bot_events DROP COLUMN updated_at;
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

test('v13 库升级到 v14：创建结构化记忆表并保留旧滚动摘要', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antifieldcloud-bot-migration-v14-'))
  const path = join(dir, 'db.sqlite')
  try {
    const db = openDatabase({ path })
    db.exec(`
      DROP TABLE IF EXISTS bot_memory_state;
      DROP TABLE IF EXISTS bot_memory_items;
      INSERT INTO bots (id, platform, name, enabled, config_json, secret_ciphertext, secret_iv, secret_tag, key_version, created_at, updated_at)
        VALUES ('bot-qq', 'qq', 'QQ', 1, '{}', 'x', 'x', 'x', 1, '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
      INSERT INTO bot_ai_memories (bot_id, user_id, memory_id, summary, summary_session_id, created_at, updated_at)
        VALUES ('bot-qq', 'user-1', '11111111-1111-4111-8111-111111111111', '旧摘要正文', NULL, '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
      UPDATE meta SET value = '13' WHERE key = 'schema_version';
    `)
    db.close()

    const upgraded = openDatabase({ path })
    try {
      const version = upgraded.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }
      assert.equal(version.value, '14')
      const tables = (
        upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as unknown as { name: string }[]
      ).map((row) => row.name)
      assert.ok(tables.includes('bot_memory_items'))
      assert.ok(tables.includes('bot_memory_state'))
      const legacy = upgraded
        .prepare("SELECT summary FROM bot_ai_memories WHERE bot_id = 'bot-qq' AND user_id = 'user-1'")
        .get() as { summary: string }
      assert.equal(legacy.summary, '旧摘要正文')
      upgraded
        .prepare(
          `INSERT INTO bot_memory_items (id, bot_id, user_id, kind, mem_key, value, confidence, importance, source, created_at, updated_at)
           VALUES ('m1', 'bot-qq', 'user-1', 'preference', 'coffee', '喜欢黑咖啡', 0.9, 3, 'chat', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z')`,
        )
        .run()
      const count = upgraded.prepare('SELECT COUNT(*) AS c FROM bot_memory_items').get() as { c: number }
      assert.equal(count.c, 1)
    } finally {
      upgraded.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})