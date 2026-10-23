/**
 * v0.5.11 结构化记忆存储单元测试：upsert/delete、TTL、容量清理、敏感过滤、
 * 关闭记忆、分层召回、legacy fallback/清理、整用户删除。全部使用临时 DB，不访问网络/模型。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupDir, tempDataDir, testDb } from './helpers.ts'
import { BotMemoryStore } from '../src/bot/memory.ts'

const BOT_ID = 'bot-memory-test'
const USER = 'user-1'
const DAY = 86_400_000

function setup(maxItems = 200) {
  const dir = tempDataDir()
  const db = testDb(dir)
  const now = '2026-10-22T00:00:00.000Z'
  db.prepare(
    `INSERT INTO bots (id, platform, name, enabled, config_json, secret_ciphertext, secret_iv, secret_tag, key_version, created_at, updated_at)
     VALUES (?, 'qq', 'QQ', 1, '{}', 'x', 'x', 'x', 1, ?, ?)`,
  ).run(BOT_ID, now, now)
  const memory = new BotMemoryStore(db, join(dir, 'data'), {
    maxItems,
    promptMaxChars: 3000,
    promptMaxItems: 12,
    factProjectTtlDays: 365,
    episodeTtlDays: 90,
    taskTtlDays: 30,
    legacyMaxChars: 4096,
  })
  return { dir, db, memory }
}

function upsert(memory: BotMemoryStore, kind: Parameters<BotMemoryStore['applyOperations']>[2][number]['kind'], key: string, value: string, importance = 3) {
  return memory.applyOperations(BOT_ID, USER, [{ op: 'upsert', kind, key, value, confidence: 0.9, importance }])
}

test('v0.5.11 记忆：upsert 唯一键更新、delete、元数据列表不泄漏 key/value', () => {
  const fixture = setup()
  try {
    upsert(fixture.memory, 'preference', 'coffee', '喜欢黑咖啡', 4)
    upsert(fixture.memory, 'preference', 'coffee', '喜欢拿铁', 5)
    const items = fixture.memory.listItems(BOT_ID, USER)
    assert.equal(items.total, 1)
    assert.equal(items.items[0]!.kind, 'preference')
    assert.equal(items.items[0]!.importance, 5)
    assert.ok(!JSON.stringify(items).includes('拿铁'))
    assert.ok(!JSON.stringify(items).includes('coffee'))
    const users = fixture.memory.listUsers(BOT_ID)
    assert.equal(users.total, 1)
    assert.equal(users.items[0]!.itemCount, 1)
    assert.equal(users.items[0]!.kinds.preference, 1)
    upsert(fixture.memory, 'fact', 'city', '常驻杭州', 3)
    const deleted = fixture.memory.applyOperations(BOT_ID, USER, [{ op: 'delete', kind: 'fact', key: 'city' }])
    assert.equal(deleted.deletes, 1)
    assert.equal(fixture.memory.listItems(BOT_ID, USER).total, 1)
  } finally {
    fixture.db.close()
    cleanupDir(fixture.dir)
  }
})

test('v0.5.11 记忆：按类型计算 TTL，profile/preference 不过期', () => {
  const fixture = setup()
  try {
    upsert(fixture.memory, 'profile', 'nickname', '称呼小明')
    upsert(fixture.memory, 'preference', 'dark_mode', '喜欢深色模式')
    upsert(fixture.memory, 'fact', 'city', '常驻杭州')
    upsert(fixture.memory, 'episode', 'trip', '去了杭州')
    upsert(fixture.memory, 'task', 'report', '下周交报告')
    const rows = fixture.db
      .prepare('SELECT kind, expires_at, created_at FROM bot_memory_items WHERE bot_id = ? AND user_id = ?')
      .all(BOT_ID, USER) as unknown as { kind: string; expires_at: string | null; created_at: string }[]
    const byKind = new Map(rows.map((row) => [row.kind, row]))
    assert.equal(byKind.get('profile')!.expires_at, null)
    assert.equal(byKind.get('preference')!.expires_at, null)
    const created = new Date(byKind.get('fact')!.created_at).getTime()
    const factExpiry = new Date(byKind.get('fact')!.expires_at!).getTime()
    const episodeExpiry = new Date(byKind.get('episode')!.expires_at!).getTime()
    const taskExpiry = new Date(byKind.get('task')!.expires_at!).getTime()
    assert.ok(Math.abs(factExpiry - created - 365 * DAY) < 1000)
    assert.ok(Math.abs(episodeExpiry - created - 90 * DAY) < 1000)
    assert.ok(Math.abs(taskExpiry - created - 30 * DAY) < 1000)
  } finally {
    fixture.db.close()
    cleanupDir(fixture.dir)
  }
})

test('v0.5.11 记忆：敏感内容/非法操作被过滤，数值范围收敛', () => {
  const fixture = setup()
  try {
    const result = fixture.memory.applyOperations(BOT_ID, USER, [
      { op: 'upsert', kind: 'fact', key: 'password', value: 'password: abc123', confidence: 2, importance: 9 },
      { op: 'upsert', kind: 'fact', key: 'url', value: '见 https://example.com/secret', confidence: 0.5, importance: 3 },
      { op: 'upsert', kind: 'fact', key: 'path', value: '文件在 /home/user/a.txt', confidence: 0.5, importance: 3 },
      { op: 'upsert', kind: 'unknown' as 'fact', key: 'x', value: '非法类型' },
      { op: 'upsert', kind: 'fact', key: '', value: '空 key' },
      { op: 'upsert', kind: 'fact', key: 'normal', value: '正常事实', confidence: 2, importance: 9 },
    ])
    assert.ok(result.skipped >= 4)
    const row = fixture.db
      .prepare("SELECT value, confidence, importance FROM bot_memory_items WHERE bot_id = ? AND user_id = ? AND mem_key = 'normal'")
      .get(BOT_ID, USER) as { value: string; confidence: number; importance: number } | undefined
    assert.ok(row)
    assert.equal(row!.confidence, 1)
    assert.equal(row!.importance, 5)
  } finally {
    fixture.db.close()
    cleanupDir(fixture.dir)
  }
})

test('v0.5.11 记忆：超出上限时清理低重要度条目，保留核心类型', () => {
  const fixture = setup(20)
  try {
    upsert(fixture.memory, 'profile', 'nickname', '称呼小明', 5)
    for (let i = 0; i < 25; i += 1) {
      upsert(fixture.memory, 'episode', `episode_${i}`, `事件 ${i}`, 1)
    }
    const count = fixture.db
      .prepare('SELECT COUNT(*) AS c FROM bot_memory_items WHERE bot_id = ? AND user_id = ?')
      .get(BOT_ID, USER) as { c: number }
    assert.ok(count.c <= 20)
    const profile = fixture.db
      .prepare("SELECT COUNT(*) AS c FROM bot_memory_items WHERE bot_id = ? AND user_id = ? AND kind = 'profile'")
      .get(BOT_ID, USER) as { c: number }
    assert.equal(profile.c, 1)
  } finally {
    fixture.db.close()
    cleanupDir(fixture.dir)
  }
})

test('v0.5.11 记忆：/memory off 时 buildPromptContext 为空，on 后恢复', () => {
  const fixture = setup()
  try {
    upsert(fixture.memory, 'preference', 'coffee', '喜欢黑咖啡', 4)
    assert.ok(fixture.memory.buildPromptContext(BOT_ID, USER, '想喝点什么').text.includes('黑咖啡'))
    fixture.memory.setMemoryEnabled(BOT_ID, USER, false)
    assert.equal(fixture.memory.buildPromptContext(BOT_ID, USER, '想喝点什么').text, '')
    fixture.memory.setMemoryEnabled(BOT_ID, USER, true)
    assert.ok(fixture.memory.buildPromptContext(BOT_ID, USER, '想喝点什么').text.includes('黑咖啡'))
  } finally {
    fixture.db.close()
    cleanupDir(fixture.dir)
  }
})

test('v0.5.11 记忆：分层召回包含核心条目与关键词命中的事实，未迁移时附旧摘要 fallback', () => {
  const fixture = setup()
  try {
    upsert(fixture.memory, 'preference', 'coffee', '喜欢黑咖啡', 5)
    upsert(fixture.memory, 'fact', 'cat_name', '猫叫团子', 3)
    upsert(fixture.memory, 'fact', 'car', '开一辆灰色轿车', 2)
    const now = '2026-10-22T00:00:00.000Z'
    fixture.db
      .prepare(
        `INSERT INTO bot_ai_memories (bot_id, user_id, memory_id, summary, summary_session_id, created_at, updated_at)
         VALUES (?, ?, '11111111-1111-4111-8111-111111111111', '旧摘要：用户喜欢深色模式', NULL, ?, ?)`,
      )
      .run(BOT_ID, USER, now, now)
    const context = fixture.memory.buildPromptContext(BOT_ID, USER, '团子今天怎么样')
    assert.ok(context.text.includes('黑咖啡'), '核心类型应注入')
    assert.ok(context.text.includes('猫叫团子'), '关键词命中的事实应注入')
    assert.ok(!context.text.includes('灰色轿车'), '未命中的事实不应注入')
    assert.ok(context.text.includes('旧记忆（待迁移）'))
    assert.ok(context.legacyFallback)
    fixture.memory.markLegacyMigrated(BOT_ID, USER)
    const after = fixture.memory.buildPromptContext(BOT_ID, USER, '团子今天怎么样')
    assert.ok(!after.text.includes('旧摘要'))
    assert.equal(after.legacyFallback, false)
  } finally {
    fixture.db.close()
    cleanupDir(fixture.dir)
  }
})

test('v0.5.11 记忆：legacy 清理只删已迁移用户的行与镜像，dry-run 不删除', () => {
  const fixture = setup()
  try {
    upsert(fixture.memory, 'preference', 'coffee', '喜欢黑咖啡')
    fixture.memory.markLegacyMigrated(BOT_ID, USER)
    const memoryId = '22222222-2222-4222-8222-222222222222'
    fixture.db
      .prepare(
        `INSERT INTO bot_ai_memories (bot_id, user_id, memory_id, summary, summary_session_id, created_at, updated_at)
         VALUES (?, ?, ?, '旧摘要正文', NULL, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')`,
      )
      .run(BOT_ID, USER, memoryId)
    const mirror = join(fixture.memory.dir, `memory-${memoryId}.md`)
    mkdirSync(fixture.memory.dir, { recursive: true })
    writeFileSync(mirror, '# legacy\n旧摘要正文\n')
    const dry = fixture.memory.cleanupLegacyMigrated(true)
    assert.deepEqual(dry, { users: 1, files: 1 })
    assert.ok(existsSync(mirror))
    const done = fixture.memory.cleanupLegacyMigrated(false)
    assert.equal(done.users, 1)
    assert.equal(done.files, 1)
    assert.equal(existsSync(mirror), false)
    assert.equal(fixture.memory.legacySummary(BOT_ID, USER), null)
  } finally {
    fixture.db.close()
    cleanupDir(fixture.dir)
  }
})

test('v0.5.11 记忆：deleteUser 清空条目、状态与旧摘要并删除镜像', () => {
  const fixture = setup()
  try {
    upsert(fixture.memory, 'preference', 'coffee', '喜欢黑咖啡')
    const memoryId = '33333333-3333-4333-8333-333333333333'
    fixture.db
      .prepare(
        `INSERT INTO bot_ai_memories (bot_id, user_id, memory_id, summary, summary_session_id, created_at, updated_at)
         VALUES (?, ?, ?, '旧摘要正文', NULL, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')`,
      )
      .run(BOT_ID, USER, memoryId)
    const mirror = join(fixture.memory.dir, `memory-${memoryId}.md`)
    mkdirSync(fixture.memory.dir, { recursive: true })
    writeFileSync(mirror, '# legacy\n')
    const result = fixture.memory.deleteUser(BOT_ID, USER)
    assert.equal(result.deletedItems, 1)
    assert.equal(result.deletedLegacy, true)
    assert.equal(result.deletedState, true)
    assert.equal(existsSync(mirror), false)
    assert.equal(fixture.memory.listItems(BOT_ID, USER).total, 0)
    assert.equal(fixture.memory.legacySummary(BOT_ID, USER), null)
  } finally {
    fixture.db.close()
    cleanupDir(fixture.dir)
  }
})
