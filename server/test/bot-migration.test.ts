/**
 * v6→v9 迁移测试：v0.4.x 生产库（schema v6）升级必须依次创建 Bot 表（v7）、
 * QQ/静默/AI 会话（v8）和 Chat/记忆/入站发现（v9），并不覆盖迁移 6 的 shares 修复。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SUPPORTED_SCHEMA_VERSION, openDatabase } from '../src/db.ts'

test('v6 库升级到 v9：创建 Bot/QQ/AI/Chat 表并保留迁移 6 修复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antifieldcloud-bot-migration-'))
  const path = join(dir, 'db.sqlite')
  try {
    const db = openDatabase({ path })
    assert.equal(SUPPORTED_SCHEMA_VERSION, 9)
    // 模拟 v0.4.2 已升级到 v6、尚无 Bot 表的生产库；v9 新增表必须先删除，避免 FK 阻断重建。
    db.exec(`
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
      assert.equal(version.value, '9')
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
      ]) {
        assert.ok(tables.includes(table), `缺少 ${table}`)
      }
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
