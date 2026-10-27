/**
 * v0.5.10/v0.5.11 Chatbot 记忆/会话回归（QQ 单平台）：
 * - 高频 Chat 按条数/空闲合并抽取结构化记忆，减少额外模型调用；
 * - 同一用户抽取串行，避免并发覆盖；
 * - /forget 清理结构化条目+状态+旧摘要、会话映射与远端会话；/reset 只清会话；
 * - 过期条目由 memory.cleanup 清理，会话映射由 ai.cleanup 按独立保留期清理。
 * 全部使用进程内夹具，不访问真实 QQ/OpenCode。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { c2cWebhook, createQqServiceFixture, sendWebhook } from './chatbot-qq-fixtures.ts'

const USER = 'user-openid-1'
const LEGACY_ID = '11111111-1111-4111-8111-111111111111'

type Fixture = ReturnType<typeof createQqServiceFixture>

interface MemoryItemSeed {
  kind: 'profile' | 'preference' | 'fact' | 'project' | 'task' | 'relationship' | 'episode'
  key: string
  value: string
  updatedAt?: string
  expiresAt?: string | null
}

function seedItems(fixture: Fixture, userId: string, items: MemoryItemSeed[]): void {
  let index = 0
  for (const item of items) {
    index += 1
    const at = item.updatedAt ?? '2026-10-22T00:00:00.000Z'
    fixture.db
      .prepare(
        `INSERT INTO chatbot_memory_items
           (id, chatbot_id, user_id, kind, mem_key, value, confidence, importance, source, created_at, updated_at, last_used_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 0.8, 3, 'chat', ?, ?, NULL, ?)`,
      )
      .run(`item-${index}-${Date.now()}`, fixture.chatbotId, userId, item.kind, item.key, item.value, at, at, item.expiresAt ?? null)
  }
}

function seedUserState(fixture: Fixture, userId: string, memoryEnabled = 1, legacyMigratedAt: string | null = null): void {
  fixture.db
    .prepare(
      `INSERT INTO chatbot_memory_state (chatbot_id, user_id, memory_enabled, legacy_migrated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')`,
    )
    .run(fixture.chatbotId, userId, memoryEnabled, legacyMigratedAt)
}

function seedLegacy(fixture: Fixture, summary: string, sessionId: string | null = null): string {
  fixture.db
    .prepare(
      `INSERT INTO chatbot_ai_memories (chatbot_id, user_id, memory_id, summary, summary_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')`,
    )
    .run(fixture.chatbotId, USER, LEGACY_ID, summary, sessionId)
  return join(fixture.dir, 'chatbot-memory', `memory-${LEGACY_ID}.md`)
}

function seedSession(fixture: Fixture, target: string, sessionId: string, updatedAt = '2026-10-22T00:00:00.000Z'): void {
  fixture.db
    .prepare(
      `INSERT INTO chatbot_ai_sessions (chatbot_id, target_external_id, user_id, mode, session_id, model, created_at, updated_at)
       VALUES (?, ?, ?, 'chat', ?, 'm', ?, ?)`,
    )
    .run(fixture.chatbotId, target, USER, sessionId, updatedAt, updatedAt)
}

function countItems(fixture: Fixture, userId = USER): number {
  return (fixture.db.prepare('SELECT COUNT(*) AS c FROM chatbot_memory_items WHERE chatbot_id = ? AND user_id = ?').get(fixture.chatbotId, userId) as {
    c: number
  }).c
}

test('v0.5.10：每 3 条 Chat 合并触发一次结构化记忆抽取', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { chatbotAiMemoryBatchMessages: 3, chatbotAiMemoryIdleFlushSeconds: 0 },
  })
  try {
    for (const [index, text] of ['第一句', '第二句', '第三句'].entries()) {
      await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: `batch-${index}`, content: text }))
      await fixture.service.waitForIdle()
      assert.equal(fixture.extractCalls.length, index < 2 ? 0 : 1, `第 ${index + 1} 条后的抽取次数`)
    }
    const call = fixture.extractCalls[0]
    assert.ok(call?.userText.includes('第一句'))
    assert.ok(call?.userText.includes('第三句'))
    assert.equal(call?.maxOps, 20)
    const audit = fixture.audits.filter((item) => item.action === 'chatbot.memory.extract').at(-1)
    assert.equal(audit?.detail?.rounds, 3)
    assert.equal(audit?.detail?.ops, 1)
    assert.equal(audit?.detail?.upserts, 1)
    assert.equal(audit?.detail?.migrated, 0)
    assert.equal(JSON.stringify(audit).includes('第三句'), false, '审计不得包含记忆正文/key/value')
    assert.equal(countItems(fixture), 1, '抽取结果应落库为结构化条目')
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.10：用户空闲后合并触发一次结构化记忆抽取', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { chatbotAiMemoryBatchMessages: 99, chatbotAiMemoryIdleFlushSeconds: 1 },
  })
  try {
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'idle-1', content: '只有一条' }))
    await fixture.service.waitForIdle()
    assert.equal(fixture.extractCalls.length, 0, '空闲计时未到不应抽取')
    await new Promise((resolve) => setTimeout(resolve, 1300))
    await fixture.service.waitForIdle()
    assert.equal(fixture.extractCalls.length, 1)
    assert.equal(countItems(fixture), 1)
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.10：同一用户并发抽取串行执行，不并发覆盖', async () => {
  let active = 0
  let maxActive = 0
  let sequence = 0
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { chatbotAiMemoryBatchMessages: 1, chatbotAiMemoryIdleFlushSeconds: 0 },
    extractHandler: async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      const index = ++sequence
      await new Promise((resolve) => setTimeout(resolve, 15))
      active -= 1
      return [{ op: 'upsert', kind: 'fact', key: `并发${index}`, value: `记忆${index}`, confidence: 0.8, importance: 3 }]
    },
  })
  try {
    for (const [index, text] of ['并发一', '并发二', '并发三'].entries()) {
      await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: `concurrent-${index}`, content: text }))
    }
    await fixture.service.waitForIdle()
    assert.equal(fixture.extractCalls.length, 3)
    assert.equal(maxActive, 1, '同一用户抽取必须串行')
    const keys = fixture.db
      .prepare('SELECT mem_key FROM chatbot_memory_items WHERE chatbot_id = ? AND user_id = ? ORDER BY mem_key')
      .all(fixture.chatbotId, USER) as unknown as { mem_key: string }[]
    assert.deepEqual(keys.map((row) => row.mem_key), ['并发1', '并发2', '并发3'], '三次抽取结果都保留且无覆盖')
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.10：/forget confirm 删除结构化记忆+旧摘要+镜像+本地映射与远端会话', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true })
  try {
    seedItems(fixture, USER, [
      { kind: 'preference', key: '深色模式', value: '用户偏好深色模式。' },
      { kind: 'fact', key: '居住城市', value: '住在上海。' },
    ])
    seedUserState(fixture, USER)
    const mirrorPath = seedLegacy(fixture, '用户喜欢深色模式', 'sess-summary-legacy')
    mkdirSync(join(fixture.dir, 'chatbot-memory'), { recursive: true })
    writeFileSync(mirrorPath, '# memo\n用户喜欢深色模式\n', 'utf8')
    seedSession(fixture, USER, 'sess-chat-1')
    seedSession(fixture, 'group-1', 'sess-chat-2')

    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'forget-1', content: '/forget confirm' }))
    await fixture.service.waitForIdle()
    assert.deepEqual(new Set(fixture.deletedSessions), new Set(['sess-chat-1', 'sess-chat-2', 'sess-summary-legacy']))
    assert.equal(countItems(fixture), 0)
    assert.equal(
      (fixture.db.prepare('SELECT COUNT(*) AS c FROM chatbot_memory_state WHERE chatbot_id = ? AND user_id = ?').get(fixture.chatbotId, USER) as {
        c: number
      }).c,
      0,
      '记忆状态应删除',
    )
    assert.equal(
      (fixture.db.prepare('SELECT COUNT(*) AS c FROM chatbot_ai_memories WHERE chatbot_id = ? AND user_id = ?').get(fixture.chatbotId, USER) as {
        c: number
      }).c,
      0,
      '旧摘要应删除',
    )
    assert.equal(existsSync(mirrorPath), false, '旧摘要镜像应删除')
    assert.equal(
      (fixture.db.prepare('SELECT COUNT(*) AS c FROM chatbot_ai_sessions WHERE chatbot_id = ?').get(fixture.chatbotId) as { c: number }).c,
      0,
    )
    const audit = fixture.audits.filter((item) => item.action === 'chatbot.memory.forget').at(-1)
    assert.equal(audit?.detail?.items, 2)
    assert.equal(audit?.detail?.legacy, 1)
    assert.equal(JSON.stringify(audit).includes('深色模式'), false, '审计不得包含记忆正文')
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.10：/reset 只清理当前目标会话，结构化记忆与旧摘要保留', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true })
  try {
    seedItems(fixture, USER, [{ kind: 'preference', key: '深色模式', value: '用户偏好深色模式。' }])
    seedUserState(fixture, USER)
    seedLegacy(fixture, '旧摘要内容')
    seedSession(fixture, USER, 'sess-reset-1')
    seedSession(fixture, 'group-1', 'sess-reset-2')
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'reset-1', content: '/reset' }))
    await fixture.service.waitForIdle()
    assert.deepEqual(fixture.deletedSessions, ['sess-reset-1'])
    const rows = fixture.db.prepare('SELECT target_external_id FROM chatbot_ai_sessions WHERE chatbot_id = ?').all(fixture.chatbotId) as unknown as {
      target_external_id: string
    }[]
    assert.deepEqual(rows.map((row) => row.target_external_id), ['group-1'], '其他目标的会话映射保留')
    assert.equal(countItems(fixture), 1, '记忆条目保留')
    assert.equal(
      (fixture.db.prepare('SELECT COUNT(*) AS c FROM chatbot_ai_memories WHERE chatbot_id = ?').get(fixture.chatbotId) as { c: number }).c,
      1,
      '旧摘要保留（/reset 不清记忆）',
    )
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.10：过期条目与会话按各自保留期清理，旧摘要不再由服务端按保留期删除', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true, configOverrides: { chatbotAiSessionRetentionDays: 7 } })
  try {
    const past = new Date(Date.now() - 86_400_000).toISOString()
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString()
    const old8 = new Date(Date.now() - 8 * 86_400_000).toISOString()
    const old400 = new Date(Date.now() - 400 * 86_400_000).toISOString()
    seedItems(fixture, USER, [
      { kind: 'episode', key: '过期事件', value: '过期条目', expiresAt: past },
      { kind: 'fact', key: '有效事实', value: '有效条目', expiresAt: future },
    ])
    seedSession(fixture, 'old-target', 'sess-old-8d', old8)
    fixture.db
      .prepare(
        `INSERT INTO chatbot_ai_memories (chatbot_id, user_id, memory_id, summary, summary_session_id, created_at, updated_at)
         VALUES (?, 'user-400d', '33333333-3333-4333-8333-333333333333', '四百天前的旧摘要', NULL, ?, ?)`,
      )
      .run(fixture.chatbotId, old400, old400)
    await fixture.service.tick()
    const keys = fixture.db
      .prepare('SELECT mem_key FROM chatbot_memory_items WHERE chatbot_id = ? AND user_id = ?')
      .all(fixture.chatbotId, USER) as unknown as { mem_key: string }[]
    assert.deepEqual(keys.map((row) => row.mem_key), ['有效事实'], '过期条目清理、未过期条目保留')
    const sessions = fixture.db.prepare('SELECT COUNT(*) AS c FROM chatbot_ai_sessions WHERE chatbot_id = ?').get(fixture.chatbotId) as {
      c: number
    }
    assert.equal(sessions.c, 0, '8 天前的会话映射按 7 天保留期清理')
    const legacy = fixture.db.prepare('SELECT COUNT(*) AS c FROM chatbot_ai_memories WHERE chatbot_id = ?').get(fixture.chatbotId) as {
      c: number
    }
    assert.equal(legacy.c, 1, '旧摘要迁移/清理由 CLI 负责，服务端 tick 不再按保留期删除')
  } finally {
    fixture.cleanup()
  }
})
