/**
 * v0.5.10 Bot 记忆/会话修复回归（QQ 单平台）：
 * - 高频 Chat 按条数/空闲合并摘要，减少额外模型调用；
 * - 同一用户摘要串行，避免并发覆盖；
 * - /reset、/forget 清理远端 OpenCode 会话；
 * - 长期记忆使用独立保留期（默认 365 天），与会话 7 天分开。
 * 全部使用进程内夹具，不访问真实 QQ/OpenCode。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { c2cWebhook, createQqServiceFixture, sendWebhook } from './bot-qq-fixtures.ts'

const USER = 'user-openid-1'

function seedMemory(fixture: ReturnType<typeof createQqServiceFixture>, summary: string, sessionId: string | null): void {
  fixture.db
    .prepare(
      `INSERT INTO bot_ai_memories (bot_id, user_id, memory_id, summary, summary_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(fixture.botId, USER, '11111111-1111-4111-8111-111111111111', summary, sessionId, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')
}

function seedSession(
  fixture: ReturnType<typeof createQqServiceFixture>,
  target: string,
  mode: 'chat' | 'task',
  sessionId: string,
  updatedAt = '2026-10-22T00:00:00.000Z',
): void {
  fixture.db
    .prepare(
      `INSERT INTO bot_ai_sessions (bot_id, target_external_id, user_id, mode, session_id, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'm', ?, ?)`,
    )
    .run(fixture.botId, target, USER, mode, sessionId, updatedAt, updatedAt)
}

test('v0.5.10：每 3 条 Chat 合并触发一次记忆摘要', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { botAiMemoryBatchMessages: 3, botAiMemoryIdleFlushSeconds: 0 },
  })
  try {
    for (const [index, text] of ['第一句', '第二句', '第三句'].entries()) {
      await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: `batch-${index}`, content: text }))
      await fixture.service.waitForIdle()
      assert.equal(fixture.memoryCalls.length, index < 2 ? 0 : 1, `第 ${index + 1} 条后的摘要次数`)
    }
    const call = fixture.memoryCalls[0]
    assert.ok(call?.userText.includes('第一句'))
    assert.ok(call?.userText.includes('第三句'))
    const audit = fixture.audits.filter((item) => item.action === 'bot.ai.memory').at(-1)
    assert.equal(audit?.detail?.rounds, 3)
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.10：用户空闲后合并触发一次摘要', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { botAiMemoryBatchMessages: 99, botAiMemoryIdleFlushSeconds: 1 },
  })
  try {
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'idle-1', content: '只有一条' }))
    await fixture.service.waitForIdle()
    assert.equal(fixture.memoryCalls.length, 0, '空闲计时未到不应摘要')
    await new Promise((resolve) => setTimeout(resolve, 1300))
    await fixture.service.waitForIdle()
    assert.equal(fixture.memoryCalls.length, 1)
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.10：同一用户并发摘要串行执行，不并发覆盖', async () => {
  let active = 0
  let maxActive = 0
  let sequence = 0
  const order: number[] = []
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { botAiMemoryBatchMessages: 1, botAiMemoryIdleFlushSeconds: 0 },
    summarizeHandler: async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      const index = ++sequence
      order.push(index)
      await new Promise((resolve) => setTimeout(resolve, 15))
      active -= 1
      return { summary: `记忆${index}` }
    },
  })
  try {
    for (const [index, text] of ['并发一', '并发二', '并发三'].entries()) {
      await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: `concurrent-${index}`, content: text }))
    }
    await fixture.service.waitForIdle()
    assert.equal(fixture.memoryCalls.length, 3)
    assert.equal(order.length, 3)
    assert.equal(maxActive, 1, '同一用户摘要必须串行')
    const row = fixture.db
      .prepare('SELECT summary FROM bot_ai_memories WHERE bot_id = ? AND user_id = ?')
      .get(fixture.botId, USER) as { summary: string } | undefined
    assert.equal(row?.summary, '记忆3', '最后一次摘要应覆盖为最终结果')
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.10：/forget confirm 删除本地映射、长期记忆并尽力删除远端会话', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true })
  try {
    seedSession(fixture, USER, 'chat', 'sess-chat-1')
    seedSession(fixture, 'group-1', 'chat', 'sess-chat-2')
    seedMemory(fixture, '用户喜欢深色模式', 'sess-summary-legacy')
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'forget-1', content: '/forget confirm' }))
    await fixture.service.waitForIdle()
    assert.deepEqual(new Set(fixture.deletedSessions), new Set(['sess-chat-1', 'sess-chat-2', 'sess-summary-legacy']))
    const sessions = fixture.db.prepare('SELECT COUNT(*) AS c FROM bot_ai_sessions WHERE bot_id = ?').get(fixture.botId) as { c: number }
    const memories = fixture.db.prepare('SELECT COUNT(*) AS c FROM bot_ai_memories WHERE bot_id = ?').get(fixture.botId) as { c: number }
    assert.equal(sessions.c, 0)
    assert.equal(memories.c, 0)
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.10：/reset 清理当前目标会话映射与远端会话', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true })
  try {
    seedSession(fixture, USER, 'chat', 'sess-reset-1')
    seedSession(fixture, 'group-1', 'chat', 'sess-reset-2')
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'reset-1', content: '/reset' }))
    await fixture.service.waitForIdle()
    assert.deepEqual(fixture.deletedSessions, ['sess-reset-1'])
    const rows = fixture.db.prepare('SELECT target_external_id FROM bot_ai_sessions WHERE bot_id = ?').all(fixture.botId) as unknown as { target_external_id: string }[]
    assert.deepEqual(rows.map((row) => row.target_external_id), ['group-1'], '其他目标的会话映射保留')
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.10：长期记忆保留期与会话保留期分离', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true, configOverrides: { botAiMemoryRetentionDays: 365, botAiSessionRetentionDays: 7 } })
  try {
    const old8 = new Date(Date.now() - 8 * 86_400_000).toISOString()
    const old400 = new Date(Date.now() - 400 * 86_400_000).toISOString()
    fixture.db
      .prepare(
        `INSERT INTO bot_ai_memories (bot_id, user_id, memory_id, summary, summary_session_id, created_at, updated_at)
         VALUES (?, 'user-8d', '22222222-2222-4222-8222-222222222222', '八天前的记忆', NULL, ?, ?)`,
      )
      .run(fixture.botId, old8, old8)
    fixture.db
      .prepare(
        `INSERT INTO bot_ai_memories (bot_id, user_id, memory_id, summary, summary_session_id, created_at, updated_at)
         VALUES (?, 'user-400d', '33333333-3333-4333-8333-333333333333', '四百天前的记忆', NULL, ?, ?)`,
      )
      .run(fixture.botId, old400, old400)
    seedSession(fixture, 'old-target', 'chat', 'sess-old-8d', old8)
    await fixture.service.tick()
    const users = fixture.db.prepare('SELECT user_id FROM bot_ai_memories WHERE bot_id = ? ORDER BY user_id').all(fixture.botId) as unknown as { user_id: string }[]
    assert.deepEqual(users.map((row) => row.user_id), ['user-8d'], '8 天记忆应保留、400 天记忆应清理')
    const sessions = fixture.db.prepare('SELECT COUNT(*) AS c FROM bot_ai_sessions WHERE bot_id = ?').get(fixture.botId) as { c: number }
    assert.equal(sessions.c, 0, '8 天前的会话映射按 7 天保留期清理')
  } finally {
    fixture.cleanup()
  }
})
