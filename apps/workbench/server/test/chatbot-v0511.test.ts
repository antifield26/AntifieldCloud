/**
 * v0.5.11 结构化长期记忆（QQ 单平台）：
 * - /memory 状态只展示计数/类型/启停/时间，绝不泄漏 key/value；off 取消批次且停止注入与抽取，on 恢复；
 * - /forget 清空条目/状态/旧摘要；legacy 旧摘要 fallback 与迁移标记；
 * - 管理 API 用户级/条目元数据与单条删除；审计不含 key/value；
 * - TTL 分类（preference 永久、fact/project 长保留、episode/task 短保留）；
 * - generation 防止 /memory off 后在途抽取回写。
 * 全部使用进程内夹具，不访问真实 QQ/OpenCode。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { c2cWebhook, createQqServiceFixture, lastMessageText, sendWebhook } from './chatbot-qq-fixtures.ts'
import { AppError } from '../src/util/errors.ts'

const USER = 'user-openid-1'
const LEGACY_ID = '11111111-1111-4111-8111-111111111111'
type Fixture = ReturnType<typeof createQqServiceFixture>

function seedItem(
  fixture: Fixture,
  userId: string,
  kind: string,
  key: string,
  value: string,
  extra: { expiresAt?: string | null; updatedAt?: string; id?: string } = {},
): string {
  const id = extra.id ?? `item-${Math.random().toString(16).slice(2)}`
  const at = extra.updatedAt ?? '2026-10-22T00:00:00.000Z'
  fixture.db
    .prepare(
      `INSERT INTO chatbot_memory_items
         (id, chatbot_id, user_id, kind, mem_key, value, confidence, importance, source, created_at, updated_at, last_used_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 0.8, 3, 'chat', ?, ?, NULL, ?)`,
    )
    .run(id, fixture.chatbotId, userId, kind, key, value, at, at, extra.expiresAt ?? null)
  return id
}

function seedLegacy(fixture: Fixture, summary: string): void {
  fixture.db
    .prepare(
      `INSERT INTO chatbot_ai_memories (chatbot_id, user_id, memory_id, summary, summary_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')`,
    )
    .run(fixture.chatbotId, USER, LEGACY_ID, summary)
}

function countRows(fixture: Fixture, table: 'chatbot_memory_items' | 'chatbot_memory_state' | 'chatbot_ai_memories'): number {
  const where = table === 'chatbot_memory_items' ? 'chatbot_id = ? AND user_id = ?' : table === 'chatbot_memory_state' ? 'chatbot_id = ? AND user_id = ?' : 'chatbot_id = ? AND user_id = ?'
  return (fixture.db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get(fixture.chatbotId, USER) as { c: number }).c
}

function memoryEnabled(fixture: Fixture): number {
  const row = fixture.db
    .prepare('SELECT memory_enabled FROM chatbot_memory_state WHERE chatbot_id = ? AND user_id = ?')
    .get(fixture.chatbotId, USER) as { memory_enabled: number } | undefined
  return row?.memory_enabled ?? 1
}

function auditDetail(fixture: Fixture, action: string): Record<string, unknown> | null {
  return fixture.audits.filter((item) => item.action === action).at(-1)?.detail ?? null
}

test('v0.5.11：/memory 展示条数/类型/启停/最近更新，不泄漏 key/value', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true })
  try {
    seedItem(fixture, USER, 'preference', 'KEY_SECRET_1', 'VALUE_SECRET_1')
    seedItem(fixture, USER, 'preference', 'KEY_SECRET_2', 'VALUE_SECRET_2', {
      updatedAt: '2026-10-22T03:00:00.000Z',
    })
    seedItem(fixture, USER, 'fact', 'KEY_SECRET_3', 'VALUE_SECRET_3', { updatedAt: '2026-10-22T02:00:00.000Z' })
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'mem-status-1', content: '/memory' }))
    const reply = String(fixture.fetch.sent.at(-1)?.body.content)
    assert.match(reply, /【长期记忆】/)
    assert.match(reply, /状态：已开启/)
    assert.match(reply, /条目：3 条/)
    assert.match(reply, /偏好 2/)
    assert.match(reply, /事实 1/)
    assert.match(reply, /最近更新：2026-10-22T03:00:00.000Z/)
    assert.equal(reply.includes('KEY_SECRET'), false, '不得展示 key')
    assert.equal(reply.includes('VALUE_SECRET'), false, '不得展示 value')
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.11：/memory off 取消待处理批次、停止抽取与注入；/memory on 恢复', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { chatbotAiMemoryBatchMessages: 1, chatbotAiMemoryIdleFlushSeconds: 0 },
  })
  try {
    seedItem(fixture, USER, 'preference', 'KEY_SECRET_1', 'VALUE_SECRET_1')
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'mem-chat-1', content: '你好' }))
    assert.equal(fixture.extractCalls.length, 1, '开启时正常抽取')

    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'mem-off-1', content: '/memory off' }))
    assert.match(String(fixture.fetch.sent.at(-1)?.body.content), /已关闭长期记忆/)
    assert.equal(memoryEnabled(fixture), 0)
    const toggle = auditDetail(fixture, 'chatbot.memory.toggle')
    assert.equal(toggle?.enabled, false)
    assert.equal(JSON.stringify(toggle).includes('VALUE_SECRET'), false)

    const before = fixture.extractCalls.length
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'mem-chat-2', content: '关闭后的对话' }))
    assert.equal(fixture.extractCalls.length, before, '关闭后不再抽取')
    const prompt = fixture.aiCalls.at(-1)?.prompt ?? ''
    assert.equal(prompt.includes('VALUE_SECRET_1'), false, '关闭后不注入记忆')
    assert.equal(prompt.includes('关闭后的对话'), true, '用户消息仍进入提示词')

    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'mem-on-1', content: '/memory on' }))
    assert.match(String(fixture.fetch.sent.at(-1)?.body.content), /已开启长期记忆/)
    assert.equal(memoryEnabled(fixture), 1)
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'mem-chat-3', content: '恢复后的对话' }))
    assert.equal(fixture.extractCalls.length, before + 1, '恢复后重新抽取')
    assert.match(fixture.aiCalls.at(-1)?.prompt ?? '', /VALUE_SECRET_1/, '恢复后注入记忆')
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.11：/memory off 取消待处理批次，不会在空闲触发后抽取', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { chatbotAiMemoryBatchMessages: 99, chatbotAiMemoryIdleFlushSeconds: 1 },
  })
  try {
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'pending-1', content: '先聊一句' }))
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'pending-off', content: '/memory off' }))
    await new Promise((resolve) => setTimeout(resolve, 1300))
    await fixture.service.waitForIdle()
    assert.equal(fixture.extractCalls.length, 0, '待处理批次应被 /memory off 取消')
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.11：/forget confirm 清空条目、状态与旧摘要', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true })
  try {
    seedItem(fixture, USER, 'fact', 'KEY_SECRET_1', 'VALUE_SECRET_1')
    fixture.db
      .prepare(
        `INSERT INTO chatbot_memory_state (chatbot_id, user_id, memory_enabled, legacy_migrated_at, created_at, updated_at)
         VALUES (?, ?, 1, NULL, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')`,
      )
      .run(fixture.chatbotId, USER)
    seedLegacy(fixture, '旧摘要正文')
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'forget-1', content: '/forget confirm' }))
    assert.equal(countRows(fixture, 'chatbot_memory_items'), 0)
    assert.equal(countRows(fixture, 'chatbot_memory_state'), 0)
    assert.equal(countRows(fixture, 'chatbot_ai_memories'), 0)
    assert.match(lastMessageText(fixture), /记忆条目 1 条/)
    assert.match(lastMessageText(fixture), /旧摘要已删除/)
    const audit = auditDetail(fixture, 'chatbot.memory.forget')
    assert.equal(audit?.items, 1)
    assert.equal(audit?.legacy, 1)
    assert.equal(JSON.stringify(fixture.audits).includes('旧摘要正文'), false, '审计不含记忆正文')
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.11：legacy 旧摘要注入 fallback，抽取成功后标记迁移并停止 fallback', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true })
  try {
    seedLegacy(fixture, 'LEGACY_SECRET 旧摘要内容')
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'legacy-chat-1', content: '开始对话' }))
    const prompt = fixture.aiCalls.at(-1)?.prompt ?? ''
    assert.match(prompt, /\[旧记忆（待迁移）\]/)
    assert.ok(prompt.includes('LEGACY_SECRET'))
    assert.equal(fixture.extractCalls[0]?.legacySummary.includes('LEGACY_SECRET'), true, '旧摘要作为迁移输入')
    const state = fixture.db
      .prepare('SELECT legacy_migrated_at FROM chatbot_memory_state WHERE chatbot_id = ? AND user_id = ?')
      .get(fixture.chatbotId, USER) as { legacy_migrated_at: string | null } | undefined
    assert.ok(state?.legacy_migrated_at, '抽取成功后标记旧摘要已迁移')
    const audit = auditDetail(fixture, 'chatbot.memory.extract')
    assert.equal(audit?.migrated, 1)
    assert.equal(JSON.stringify(audit).includes('LEGACY_SECRET'), false, '审计不含旧摘要正文')

    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'legacy-chat-2', content: '继续对话' }))
    assert.equal((fixture.aiCalls.at(-1)?.prompt ?? '').includes('[旧记忆（待迁移）]'), false, '迁移后不再注入旧摘要')
    assert.equal(fixture.extractCalls[1]?.legacySummary, '', '迁移后不再传旧摘要')
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.11：抽取失败不落数据、不迁移旧摘要，下一批重试', async () => {
  let calls = 0
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    extractHandler: async () => {
      calls += 1
      if (calls === 1) throw new Error('extract failed')
      return [{ op: 'upsert', kind: 'fact', key: '重试成功', value: '第二次成功', confidence: 0.8, importance: 3 }]
    },
  })
  try {
    seedLegacy(fixture, 'LEGACY_SECRET 旧摘要')
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'retry-1', content: '第一批' }))
    assert.equal(countRows(fixture, 'chatbot_memory_items'), 0, '失败不落任何数据')
    const stateAfterFail = fixture.db
      .prepare('SELECT legacy_migrated_at FROM chatbot_memory_state WHERE chatbot_id = ? AND user_id = ?')
      .get(fixture.chatbotId, USER) as { legacy_migrated_at: string | null } | undefined
    assert.equal(stateAfterFail?.legacy_migrated_at, null, '失败不标记迁移')
    assert.equal(fixture.audits.some((item) => item.action === 'chatbot.memory.extract'), false)

    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'retry-2', content: '第二批' }))
    assert.equal(calls, 2)
    assert.equal(countRows(fixture, 'chatbot_memory_items'), 1, '下一批重试成功并落库')
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.11：TTL 分类（preference 永久、fact 长保留、episode 短保留）', async () => {
  const extract = createQqServiceFixture({
    aiEnabled: true,
    extractHandler: async () => [
      { op: 'upsert', kind: 'preference', key: '风格', value: '偏好简洁', confidence: 0.9, importance: 4 },
      { op: 'upsert', kind: 'fact', key: '城市', value: '住在上海', confidence: 0.9, importance: 3 },
      { op: 'upsert', kind: 'episode', key: '今天', value: '今天聊了天气', confidence: 0.7, importance: 2 },
    ],
  })
  try {
    await sendWebhook(extract, c2cWebhook(extract.appSecret, { id: 'ttl-1', content: '记录一下' }))
    const rows = extract.db
      .prepare('SELECT kind, mem_key, expires_at FROM chatbot_memory_items WHERE chatbot_id = ? AND user_id = ?')
      .all(extract.chatbotId, USER) as unknown as { kind: string; mem_key: string; expires_at: string | null }[]
    const map = new Map(rows.map((row) => [row.kind, row.expires_at]))
    assert.equal(map.get('preference'), null, '偏好永久保留')
    assert.ok(map.get('fact'), '事实按长保留期设置 expires_at')
    assert.ok(map.get('episode'), '事件按短保留期设置 expires_at')
    const now = Date.now()
    const factDays = (new Date(map.get('fact')!).getTime() - now) / 86_400_000
    const episodeDays = (new Date(map.get('episode')!).getTime() - now) / 86_400_000
    assert.ok(factDays > 300, '事实 TTL 约 365 天')
    assert.ok(episodeDays > 80 && episodeDays < 100, '事件 TTL 约 90 天')
  } finally {
    extract.cleanup()
  }
})

test('v0.5.11：管理 API 用户级/条目元数据与删除；不含 key/value，审计无正文', () => {
  const fixture = createQqServiceFixture({ aiEnabled: true })
  try {
    fixture.db
      .prepare(
        `INSERT INTO chatbot_inbound_targets (chatbot_id, target_external_id, target_kind, user_id, user_name, is_direct, last_seen_at)
         VALUES (?, 'dm-user-1', 'user', ?, '小明', 1, '2026-10-22T00:00:00.000Z')`,
      )
      .run(fixture.chatbotId, USER)
    const itemId = seedItem(fixture, USER, 'preference', 'KEY_SECRET_1', 'VALUE_SECRET_1')
    seedItem(fixture, USER, 'fact', 'KEY_SECRET_2', 'VALUE_SECRET_2')
    seedItem(fixture, 'other-user', 'fact', 'KEY_SECRET_3', 'VALUE_SECRET_3')

    const users = fixture.service.listMemories(fixture.chatbotId, { limit: 20, offset: 0 })
    assert.equal(users.total, 2)
    const target = users.items.find((item) => item.userId === USER)
    assert.equal(target?.userName, '小明')
    assert.equal(target?.itemCount, 2)
    assert.equal(target?.kinds.preference, 1)
    assert.equal(target?.kinds.fact, 1)
    assert.equal(target?.memoryEnabled, true)
    assert.ok(target?.updatedAt)
    const userJson = JSON.stringify(users)
    assert.equal(userJson.includes('KEY_SECRET'), false)
    assert.equal(userJson.includes('VALUE_SECRET'), false)

    const items = fixture.service.listMemoryItems(fixture.chatbotId, USER, { limit: 20, offset: 0 })
    assert.equal(items.total, 2)
    assert.equal(items.items.length, 2)
    const typed = items.items.find((item) => item.id === itemId)
    assert.equal(typed?.kind, 'preference')
    assert.equal(typed?.importance, 3)
    assert.equal(typed?.confidence, 0.8)
    assert.ok(typed?.updatedAt)
    const itemJson = JSON.stringify(items)
    assert.equal(itemJson.includes('KEY_SECRET'), false)
    assert.equal(itemJson.includes('VALUE_SECRET'), false)
    assert.equal(itemJson.includes('mem_key'), false)
    const page = fixture.service.listMemoryItems(fixture.chatbotId, USER, { limit: 1, offset: 1 })
    assert.equal(page.total, 2)
    assert.equal(page.items.length, 1)

    fixture.service.deleteMemoryItem(fixture.chatbotId, USER, itemId)
    assert.equal(fixture.service.listMemoryItems(fixture.chatbotId, USER).total, 1)
    const deleteAudit = auditDetail(fixture, 'chatbot.memory.delete_item')
    assert.equal(deleteAudit?.user, USER)
    assert.equal(JSON.stringify(deleteAudit).includes('KEY_SECRET'), false)
    assert.throws(
      () => fixture.service.deleteMemoryItem(fixture.chatbotId, USER, itemId),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    )

    fixture.service.deleteMemory(fixture.chatbotId, USER)
    assert.equal(fixture.service.listMemories(fixture.chatbotId).items.every((item) => item.userId !== USER), true)
    const userAudit = auditDetail(fixture, 'chatbot.memory.delete_user')
    assert.equal(userAudit?.items, 1)
    assert.equal(JSON.stringify(userAudit).includes('KEY_SECRET'), false)
    assert.throws(
      () => fixture.service.deleteMemory(fixture.chatbotId, USER),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    )
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.11：generation 防止 /memory off 后在途抽取回写', async () => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { chatbotAiMemoryBatchMessages: 1, chatbotAiMemoryIdleFlushSeconds: 0 },
    extractHandler: async () => {
      await gate
      return [{ op: 'upsert', kind: 'fact', key: '在途结果', value: '不应写回', confidence: 0.8, importance: 3 }]
    },
  })
  try {
    // 不等待完成：第一条抽取会停在 gate 上，第二条排队等待，模拟在途+排队批次。
    const inflight = c2cWebhook(fixture.appSecret, { id: 'inflight-1', content: '在途对话' })
    await fixture.service.handleWebhook(fixture.chatbotId, inflight.headers, inflight.body)
    const queued = c2cWebhook(fixture.appSecret, { id: 'inflight-2', content: '排队对话' })
    await fixture.service.handleWebhook(fixture.chatbotId, queued.headers, queued.body)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(fixture.extractCalls.length, 1, '第一条抽取已开始')
    const offWebhook = c2cWebhook(fixture.appSecret, { id: 'inflight-off', content: '/memory off' })
    await fixture.service.handleWebhook(fixture.chatbotId, offWebhook.headers, offWebhook.body)
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    await fixture.service.waitForIdle()
    assert.equal(
      (fixture.db.prepare('SELECT COUNT(*) AS c FROM chatbot_memory_items WHERE chatbot_id = ? AND user_id = ?').get(fixture.chatbotId, USER) as {
        c: number
      }).c,
      0,
      '/memory off 后在途与排队抽取结果都不得写回',
    )
    assert.equal(fixture.extractCalls.length, 1, '被取消的排队批次不再调用模型')
    assert.equal(fixture.audits.some((item) => item.action === 'chatbot.memory.extract'), false)
  } finally {
    fixture.cleanup()
  }
})
