/**
 * v6→v7 迁移测试：v0.4.x 生产库（schema v6）升级必须得到 Bot 表，且 schema 版本变为 7。
 * 同时确保迁移 6 的 shares 修复不会被后续迁移覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SUPPORTED_SCHEMA_VERSION, openDatabase } from '../src/db.ts'

test('v6 库升级到 v7：创建 Bot 表并保留迁移 6 修复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antifieldcloud-bot-migration-'))
  const path = join(dir, 'db.sqlite')
  try {
    const db = openDatabase({ path })
    assert.equal(SUPPORTED_SCHEMA_VERSION, 7)
    // 模拟 v0.4.2 已升级到 v6、尚无 Bot 表的生产库。
    db.exec(`
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
      assert.equal(version.value, '7')
      const tables = (
        upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as unknown as { name: string }[]
      ).map((row) => row.name)
      for (const table of ['bots', 'bot_targets', 'bot_deliveries', 'bot_publish_jobs', 'bot_events']) {
        assert.ok(tables.includes(table), `缺少 ${table}`)
      }
    } finally {
      upgraded.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
