/**
 * 历史 schema → v18 迁移测试：QQ Bot 子系统全量更名 chatbot 后，
 * 旧库必须按“历史迁移只追加 + v18 表/列/meta 重命名”路径完整升级，数据不丢。
 *
 * 夹具使用导出的 MIGRATIONS 精确构造目标历史版本，避免从最新 schema 反向删列导致漂移。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, SUPPORTED_SCHEMA_VERSION, openDatabase } from '../src/db.ts'

/** 用历史迁移 SQL 构造指定版本（meta.schema_version=version）的旧库，并可选写入测试数据。 */
function createDatabaseAt(path: string, version: number, seed?: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    for (let index = 0; index < version; index++) db.exec(MIGRATIONS[index]!)
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(version))
    seed?.(db)
  } finally {
    db.close()
  }
}

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as unknown as { name: string }[]).map((row) => row.name)
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((row) => row.name)
}

function chatbotVersion(db: DatabaseSync): string {
  return (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value
}

function insertChatbot(db: DatabaseSync, id: string, platform = 'qq'): void {
  db.prepare(
    `INSERT INTO bots (id, platform, name, enabled, config_json, secret_ciphertext, secret_iv, secret_tag, key_version, created_at, updated_at)
     VALUES (?, ?, 'QQ', 1, '{}', 'x', 'x', 'x', 1, '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z')`,
  ).run(id, platform)
}

test('v6 库升级到 v18：创建 chatbot/AI/Chat/角色卡表，并补齐触发策略与事件诊断列', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antifieldcloud-chatbot-migration-'))
  const path = join(dir, 'db.sqlite')
  try {
    createDatabaseAt(path, 6)
    const upgraded = openDatabase({ path })
    try {
      assert.equal(SUPPORTED_SCHEMA_VERSION, 18)
      assert.equal(chatbotVersion(upgraded), '18')
      const tables = tableNames(upgraded)
      for (const table of [
        'chatbots',
        'chatbot_targets',
        'chatbot_deliveries',
        'chatbot_publish_jobs',
        'chatbot_events',
        'chatbot_ai_sessions',
        'chatbot_ai_memories',
        'chatbot_inbound_targets',
        'chatbot_chat_roles',
        'chatbot_group_roles',
      ]) {
        assert.ok(tables.includes(table), `缺少 ${table}`)
      }
      assert.ok(!tables.includes('bots'))
      assert.ok(!tables.includes('bot_targets'))
      assert.ok(tableColumns(upgraded, 'chatbot_ai_sessions').includes('mode'))
      const targetColumns = tableColumns(upgraded, 'chatbot_targets')
      for (const column of ['quiet_start_minute', 'quiet_end_minute', 'allow_chat', 'qq_number', 'chat_trigger', 'chatbot_id']) {
        assert.ok(targetColumns.includes(column), `chatbot_targets 缺少 ${column}`)
      }
      const eventColumns = tableColumns(upgraded, 'chatbot_events')
      for (const column of ['event_kind', 'outcome', 'detail', 'target_external_id', 'user_id', 'updated_at', 'chatbot_id']) {
        assert.ok(eventColumns.includes(column), `chatbot_events 缺少 ${column}`)
      }
      // v8 的 chatbots 表 CHECK 必须接受 qq；用最小合法行验证约束已重建。
      upgraded.prepare(
        `INSERT INTO chatbots (id, platform, name, enabled, config_json, secret_ciphertext, secret_iv, secret_tag, key_version, created_at, updated_at)
         VALUES ('migration-qq', 'qq', 'QQ', 0, '{}', 'x', 'x', 'x', 1, '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z')`,
      ).run()
      // 既有目标升级后 Chat 默认关闭。
      upgraded
        .prepare(
          `INSERT INTO chatbot_targets (id, chatbot_id, external_id, label, kind, allow_commands, allow_notifications, created_at)
           VALUES ('migration-target', 'migration-qq', 'group-1', '群', 'group', 0, 1, '2026-10-21T00:00:00.000Z')`,
        )
        .run()
      const target = upgraded.prepare("SELECT allow_chat FROM chatbot_targets WHERE id = 'migration-target'").get() as { allow_chat: number }
      assert.equal(target.allow_chat, 0)
    } finally {
      upgraded.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('v12 库升级到 v18：删除非 QQ chatbot 及其级联数据，保留 QQ chatbot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antifieldcloud-chatbot-migration-v13-'))
  const path = join(dir, 'db.sqlite')
  try {
    createDatabaseAt(path, 12, (db) => {
      insertChatbot(db, 'bot-qq')
      insertChatbot(db, 'bot-discord', 'discord')
      db.exec(`
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
        INSERT INTO bot_inbound_targets (bot_id, target_external_id, target_kind, user_id, is_direct, last_seen_at)
          VALUES ('bot-qq', 'qq-user', 'user', 'u1', 1, '2026-10-21T00:00:00.000Z');
      `)
    })
    const upgraded = openDatabase({ path })
    try {
      assert.equal(chatbotVersion(upgraded), '18')
      const chatbots = upgraded.prepare('SELECT id FROM chatbots ORDER BY id').all() as unknown as { id: string }[]
      assert.deepEqual(chatbots.map((row) => row.id), ['bot-qq'])
      const count = (table: string, chatbotId: string): number => {
        const row = upgraded.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE chatbot_id = ?`).get(chatbotId) as { c: number }
        return row.c
      }
      for (const table of ['chatbot_targets', 'chatbot_deliveries', 'chatbot_events', 'chatbot_ai_sessions', 'chatbot_ai_memories', 'chatbot_inbound_targets']) {
        assert.equal(count(table, 'bot-discord'), 0, `${table} 仍残留非 QQ chatbot 数据`)
        assert.equal(count(table, 'bot-qq'), 1, `${table} 的 QQ 数据被误删`)
      }
    } finally {
      upgraded.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('v11 库升级到 v18：追加触发策略与事件诊断列，旧行按默认值可读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antifieldcloud-chatbot-migration-v12-'))
  const path = join(dir, 'db.sqlite')
  try {
    createDatabaseAt(path, 11, (db) => {
      insertChatbot(db, 'bot-v11')
      db.exec(`
        INSERT INTO bot_targets (id, bot_id, external_id, label, kind, allow_commands, allow_notifications, created_at)
          VALUES ('target-v11', 'bot-v11', 'group-1', '群', 'group', 0, 1, '2026-10-21T00:00:00.000Z');
        INSERT INTO bot_events (bot_id, platform_event_id, received_at) VALUES ('bot-v11', 'evt-1', '2026-10-21T00:00:00.000Z');
      `)
    })
    const upgraded = openDatabase({ path })
    try {
      assert.equal(chatbotVersion(upgraded), '18')
      const target = upgraded.prepare("SELECT chat_trigger FROM chatbot_targets WHERE id = 'target-v11'").get() as { chat_trigger: string }
      assert.equal(target.chat_trigger, 'mention')
      const event = upgraded
        .prepare("SELECT outcome, event_kind, detail FROM chatbot_events WHERE platform_event_id = 'evt-1'")
        .get() as { outcome: string | null; event_kind: string | null; detail: string | null }
      assert.equal(event.outcome, null)
      assert.equal(event.event_kind, null)
      assert.equal(event.detail, null)
    } finally {
      upgraded.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('v9/v10 库升级到 v18：旧会话归 Chat，主键允许 task/chat 两行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antifieldcloud-chatbot-migration-session-'))
  const path = join(dir, 'db.sqlite')
  try {
    createDatabaseAt(path, 9, (db) => {
      insertChatbot(db, 'bot-1')
      db.exec(`
        INSERT INTO bot_ai_sessions (bot_id, target_external_id, user_id, session_id, model, created_at, updated_at)
          VALUES ('bot-1', 'group-1', 'user-1', 'old-chat-session', 'm', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
      `)
    })
    const upgraded = openDatabase({ path })
    try {
      const old = upgraded
        .prepare("SELECT mode, session_id FROM chatbot_ai_sessions WHERE session_id = 'old-chat-session'")
        .get() as { mode: string; session_id: string }
      assert.equal(old.mode, 'chat')
      upgraded
        .prepare(
          `INSERT INTO chatbot_ai_sessions
           (chatbot_id, target_external_id, user_id, mode, session_id, model, created_at, updated_at)
           VALUES ('bot-1', 'group-1', 'user-1', 'task', 'new-task-session', 'm', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z')`,
        )
        .run()
      const rows = upgraded.prepare("SELECT mode FROM chatbot_ai_sessions WHERE chatbot_id = 'bot-1' ORDER BY mode").all() as unknown as { mode: string }[]
      assert.deepEqual(rows.map((row) => row.mode), ['chat', 'task'])
      const roleTable = upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chatbot_chat_roles'")
        .get() as { name: string } | undefined
      assert.equal(roleTable?.name, 'chatbot_chat_roles')
    } finally {
      upgraded.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('v13 库升级到 v18：创建结构化记忆表并保留旧滚动摘要', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antifieldcloud-chatbot-migration-v14-'))
  const path = join(dir, 'db.sqlite')
  try {
    createDatabaseAt(path, 13, (db) => {
      insertChatbot(db, 'bot-qq')
      db.exec(`
        INSERT INTO bot_ai_memories (bot_id, user_id, memory_id, summary, created_at, updated_at)
          VALUES ('bot-qq', 'user-1', '11111111-1111-4111-8111-111111111111', '旧摘要正文', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
      `)
    })
    const upgraded = openDatabase({ path })
    try {
      assert.equal(chatbotVersion(upgraded), '18')
      const tables = tableNames(upgraded)
      assert.ok(tables.includes('chatbot_memory_items'))
      assert.ok(tables.includes('chatbot_memory_state'))
      const legacy = upgraded
        .prepare("SELECT summary FROM chatbot_ai_memories WHERE chatbot_id = 'bot-qq' AND user_id = 'user-1'")
        .get() as { summary: string }
      assert.equal(legacy.summary, '旧摘要正文')
      upgraded
        .prepare(
          `INSERT INTO chatbot_memory_items (id, chatbot_id, user_id, kind, mem_key, value, confidence, importance, source, created_at, updated_at)
           VALUES ('m1', 'bot-qq', 'user-1', 'preference', 'coffee', '喜欢黑咖啡', 0.9, 3, 'chat', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z')`,
        )
        .run()
      const count = upgraded.prepare('SELECT COUNT(*) AS c FROM chatbot_memory_items').get() as { c: number }
      assert.equal(count.c, 1)
    } finally {
      upgraded.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('v17 库升级到 v18：chatbot 表/列/meta 键全量重命名且数据保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antifieldcloud-chatbot-migration-v18-'))
  const path = join(dir, 'db.sqlite')
  try {
    createDatabaseAt(path, 17, (db) => {
      insertChatbot(db, 'bot-legacy')
      db.exec(`
        INSERT INTO bot_targets (id, bot_id, external_id, label, kind, allow_commands, allow_notifications, created_at)
          VALUES ('t-legacy', 'bot-legacy', 'group-legacy', '旧群', 'group', 1, 1, '2026-10-21T00:00:00.000Z');
        INSERT INTO bot_memory_items (id, bot_id, user_id, kind, mem_key, value, confidence, importance, source, created_at, updated_at)
          VALUES ('m-legacy', 'bot-legacy', 'user-legacy', 'preference', 'coffee', '喜欢黑咖啡', 0.9, 3, 'chat', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
        INSERT INTO bot_group_roles (target_id, bot_id, target_external_id, name, prompt, enabled, created_at, updated_at)
          VALUES ('t-legacy', 'bot-legacy', 'group-legacy', '旧群角色', '设定', 1, '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
        INSERT INTO meta (key, value) VALUES ('bot_ai_tool_mode', 'mcp:send')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value;
        INSERT INTO meta (key, value) VALUES ('bot_group_memory_migrated_v1', '1')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value;
      `)
    })
    const upgraded = openDatabase({ path })
    try {
      assert.equal(chatbotVersion(upgraded), '18')
      const tables = tableNames(upgraded)
      assert.ok(tables.includes('chatbots'))
      assert.ok(!tables.includes('bots'))
      assert.ok(!tables.includes('bot_targets'))
      assert.ok(tableColumns(upgraded, 'chatbot_targets').includes('chatbot_id'))
      assert.ok(!tableColumns(upgraded, 'chatbot_targets').includes('bot_id'))
      const target = upgraded.prepare("SELECT chatbot_id FROM chatbot_targets WHERE id = 't-legacy'").get() as { chatbot_id: string }
      assert.equal(target.chatbot_id, 'bot-legacy')
      const memory = upgraded.prepare("SELECT value FROM chatbot_memory_items WHERE id = 'm-legacy'").get() as { value: string }
      assert.equal(memory.value, '喜欢黑咖啡')
      const role = upgraded.prepare("SELECT name FROM chatbot_group_roles WHERE target_id = 't-legacy'").get() as { name: string }
      assert.equal(role.name, '旧群角色')
      const metaMode = upgraded.prepare("SELECT value FROM meta WHERE key = 'chatbot_ai_tool_mode'").get() as { value: string } | undefined
      assert.equal(metaMode?.value, 'mcp:send')
      const oldMeta = upgraded.prepare("SELECT COUNT(*) AS c FROM meta WHERE key IN ('bot_ai_tool_mode', 'bot_group_memory_migrated_v1')").get() as { c: number }
      assert.equal(oldMeta.c, 0)
      const newMeta = upgraded.prepare("SELECT COUNT(*) AS c FROM meta WHERE key IN ('chatbot_group_memory_migrated_v1')").get() as { c: number }
      assert.equal(newMeta.c, 1)
    } finally {
      upgraded.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
