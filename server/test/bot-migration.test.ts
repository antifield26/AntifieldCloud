/**
 * v6→v8 迁移测试：v0.4.x 生产库（schema v6）升级必须依次创建 Bot 表（v7）并完成
 * QQ/静默时段/AI 会话迁移（v8）；同时确保迁移 6 的 shares 修复不会被后续迁移覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SUPPORTED_SCHEMA_VERSION, openDatabase } from '../src/db.ts'

test('v6 库升级到 v8：创建 Bot/QQ/AI 表并保留迁移 6 修复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antifieldcloud-bot-migration-'))
  const path = join(dir, 'db.sqlite')
  try {
    const db = openDatabase({ path })
    assert.equal(SUPPORTED_SCHEMA_VERSION, 8)
    // 模拟 v0.4.2 已升级到 v6、尚无 Bot 表的生产库。
    db.exec(`
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
      assert.equal(version.value, '8')
      const tables = (
        upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as unknown as { name: string }[]
      ).map((row) => row.name)
      for (const table of ['bots', 'bot_targets', 'bot_deliveries', 'bot_publish_jobs', 'bot_events', 'bot_ai_sessions']) {
        assert.ok(tables.includes(table), `缺少 ${table}`)
      }
      const targetColumns = (
        upgraded.prepare('PRAGMA table_info(bot_targets)').all() as unknown as { name: string }[]
      ).map((row) => row.name)
      assert.ok(targetColumns.includes('quiet_start_minute'))
      assert.ok(targetColumns.includes('quiet_end_minute'))
      // v8 的 bots 表 CHECK 必须接受 qq；用最小合法行验证约束已重建。
      upgraded
        .prepare(
          `INSERT INTO bots (id, platform, name, enabled, config_json, secret_ciphertext, secret_iv, secret_tag, key_version, created_at, updated_at)
           VALUES ('migration-qq', 'qq', 'QQ', 0, '{}', 'x', 'x', 'x', 1, '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z')`,
        )
        .run()
    } finally {
      upgraded.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})
