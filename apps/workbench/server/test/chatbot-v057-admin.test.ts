/**
 * v0.5.7 管理接口（QQ 单平台，F6/F7）：角色卡与长期记忆元数据分页、启停/删除副作用与审计，
 * 以及 QQ 连接自检 checkBot（成功/失败/不支持/异常兜底、last_checked_at 与 last_error 边界）。
 * 不访问真实 QQ；fetch 与 AI 均为进程内夹具。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { tempDataDir, testConfig, testDb } from './helpers.ts'
import { createQqServiceFixture } from './chatbot-qq-fixtures.ts'
import { ChatbotService } from '../src/chatbot/service.ts'
import { ChatbotChatRoleStore } from '../src/chatbot/roles.ts'
import { AppError } from '../src/util/errors.ts'
import type { ChatbotHealthCheck } from '../src/chatbot/types.ts'

type Fixture = ReturnType<typeof createQqServiceFixture>

function seedInbound(
  fixture: Fixture,
  userId: string,
  userName: string,
  targetExternalId = `dm-${userId}`,
  lastSeenAt = '2026-10-22T00:00:00.000Z',
): void {
  fixture.db
    .prepare(
      `INSERT INTO chatbot_inbound_targets (chatbot_id, target_external_id, target_kind, user_id, user_name, is_direct, last_seen_at)
       VALUES (?, ?, 'user', ?, ?, 1, ?)`,
    )
    .run(fixture.chatbotId, targetExternalId, userId, userName, lastSeenAt)
}

function seedSession(fixture: Fixture, target: string, userId: string, mode: 'chat' | 'task', sessionId: string): void {
  fixture.db
    .prepare(
      `INSERT INTO chatbot_ai_sessions (chatbot_id, target_external_id, user_id, mode, session_id, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'm', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')`,
    )
    .run(fixture.chatbotId, target, userId, mode, sessionId)
}

test('v0.5.7：listRoles 只返回元数据并用最近入站用户名补 userName；分页 total 正确', () => {
  const fixture = createQqServiceFixture()
  try {
    seedInbound(fixture, 'user-1', '小明')
    seedInbound(fixture, 'user-2', '小红')
    seedInbound(fixture, 'user-3', '旧名字', 'dm-old-3', '2026-10-21T00:00:00.000Z')
    seedInbound(fixture, 'user-3', '新名字', 'dm-new-3', '2026-10-22T00:00:00.000Z')
    const roles = new ChatbotChatRoleStore(fixture.db)
    roles.save(fixture.chatbotId, 'user-1', '猫娘', '这是一段绝不应出现在管理响应里的角色设定正文。')
    roles.save(fixture.chatbotId, 'user-2', '老师', '老师设定正文。')
    roles.save(fixture.chatbotId, 'user-3', '闲置', '第三张卡。')

    const all = fixture.service.listRoles(fixture.chatbotId, { limit: 20, offset: 0 })
    assert.equal(all.total, 3)
    assert.equal(all.items.length, 3)
    const first = all.items.find((item) => item.userId === 'user-1')
    assert.equal(first?.userName, '小明')
    assert.equal(first?.name, '猫娘')
    assert.equal(first?.enabled, true)
    assert.equal(first?.promptLength, '这是一段绝不应出现在管理响应里的角色设定正文。'.length)
    assert.ok(first?.createdAt)
    assert.ok(first?.updatedAt)
    assert.equal(JSON.stringify(all.items).includes('角色设定正文'), false, '管理列表不得暴露正文')

    const page = fixture.service.listRoles(fixture.chatbotId, { limit: 1, offset: 1 })
    assert.equal(page.total, 3)
    assert.equal(page.items.length, 1)
    const updated = fixture.service.listRoles(fixture.chatbotId, { limit: 20, offset: 0 }).items.find((item) => item.userId === 'user-3')
    assert.equal(updated?.userName, '新名字')
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.7：setRoleEnabled/deleteRole 的副作用与审计；删除角色清理该用户全部会话', () => {
  const fixture = createQqServiceFixture()
  try {
    const roles = new ChatbotChatRoleStore(fixture.db)
    roles.save(fixture.chatbotId, 'user-1', '猫娘', '角色设定正文。')
    seedSession(fixture, 'target-a', 'user-1', 'chat', 'chat-a')
    seedSession(fixture, 'target-b', 'user-1', 'chat', 'chat-b')
    seedSession(fixture, 'target-a', 'user-1', 'task', 'task-a')
    seedSession(fixture, 'target-a', 'user-2', 'chat', 'other-user')

    fixture.service.setRoleEnabled(fixture.chatbotId, 'user-1', false)
    assert.equal(roles.get(fixture.chatbotId, 'user-1')?.enabled, false)
    assert.ok(fixture.audits.some((item) => item.action === 'chatbot.role.admin' && item.detail?.action === 'disable'))
    fixture.service.setRoleEnabled(fixture.chatbotId, 'user-1', true)
    assert.equal(roles.get(fixture.chatbotId, 'user-1')?.enabled, true)
    assert.ok(fixture.audits.some((item) => item.action === 'chatbot.role.admin' && item.detail?.action === 'enable'))
    assert.equal(JSON.stringify(fixture.audits).includes('角色设定正文'), false, '审计不得包含角色正文')
    assert.throws(
      () => fixture.service.setRoleEnabled(fixture.chatbotId, 'missing-user', true),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    )

    fixture.service.deleteRole(fixture.chatbotId, 'user-1')
    assert.equal(roles.get(fixture.chatbotId, 'user-1'), null)
    const chatRows = fixture.db
      .prepare("SELECT COUNT(*) AS c FROM chatbot_ai_sessions WHERE chatbot_id = ? AND user_id = 'user-1' AND mode = 'chat'")
      .get(fixture.chatbotId) as { c: number }
    assert.equal(chatRows.c, 0, '删除角色应清理该用户全部 chat 会话')
    const taskRows = fixture.db
      .prepare("SELECT COUNT(*) AS c FROM chatbot_ai_sessions WHERE chatbot_id = ? AND user_id = 'user-1' AND mode = 'task'")
      .get(fixture.chatbotId) as { c: number }
    assert.equal(taskRows.c, 0, '删除角色应清理该用户全部会话映射')
    assert.ok(fixture.audits.some((item) => item.action === 'chatbot.role.admin' && item.detail?.action === 'delete'))
    assert.throws(
      () => fixture.service.deleteRole(fixture.chatbotId, 'user-1'),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    )
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.7/v0.5.11：记忆用户级/条目元数据与删除，只返回元数据并审计', () => {
  const fixture = createQqServiceFixture()
  try {
    seedInbound(fixture, 'user-1', '小明')
    const insertItem = (id: string, userId: string, kind: string, key: string, value: string): void => {
      fixture.db
        .prepare(
          `INSERT INTO chatbot_memory_items
             (id, chatbot_id, user_id, kind, mem_key, value, confidence, importance, source, created_at, updated_at, last_used_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, 0.8, 3, 'chat', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z', NULL, NULL)`,
        )
        .run(id, fixture.chatbotId, userId, kind, key, value)
    }
    insertItem('item-1', 'user-1', 'preference', '深色模式', '用户喜欢深色模式，这是记忆正文。')
    insertItem('item-2', 'user-1', 'fact', '城市', '第二条记忆正文。')
    insertItem('item-3', 'user-2', 'fact', '城市', '第三条记忆正文。')

    const list = fixture.service.listMemories(fixture.chatbotId, { limit: 20, offset: 0 })
    assert.equal(list.total, 2)
    assert.equal(list.items.length, 2)
    const first = list.items.find((item) => item.userId === 'user-1')
    assert.equal(first?.userName, '小明')
    assert.equal(first?.itemCount, 2)
    assert.equal(first?.kinds.preference, 1)
    assert.equal(first?.kinds.fact, 1)
    assert.equal(first?.memoryEnabled, true)
    assert.ok(first?.updatedAt)
    assert.equal(JSON.stringify(list.items).includes('记忆正文'), false, '管理列表不得暴露记忆正文')

    const page = fixture.service.listMemories(fixture.chatbotId, { limit: 1, offset: 1 })
    assert.equal(page.total, 2)
    assert.equal(page.items.length, 1)

    const items = fixture.service.listMemoryItems(fixture.chatbotId, 'user-1', { limit: 20, offset: 0 })
    assert.equal(items.total, 2)
    assert.equal(JSON.stringify(items).includes('记忆正文'), false, '条目元数据不得暴露 key/value')
    fixture.service.deleteMemoryItem(fixture.chatbotId, 'user-1', 'item-1')
    assert.equal(fixture.service.listMemoryItems(fixture.chatbotId, 'user-1').total, 1)
    assert.ok(fixture.audits.some((item) => item.action === 'chatbot.memory.delete_item'))

    fixture.service.deleteMemory(fixture.chatbotId, 'user-1')
    assert.equal(fixture.service.listMemoryItems(fixture.chatbotId, 'user-1').total, 0)
    assert.ok(fixture.audits.some((item) => item.action === 'chatbot.memory.delete_user'))
    assert.equal(JSON.stringify(fixture.audits).includes('记忆正文'), false)
    assert.throws(
      () => fixture.service.deleteMemory(fixture.chatbotId, 'user-1'),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    )
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.7：checkBot 成功/失败都刷新 last_checked_at 且不覆盖投递 last_error', async () => {
  const ok = createQqServiceFixture()
  try {
    const success = await ok.service.checkBot(ok.chatbotId)
    assert.equal(success.ok, true)
    assert.equal(success.items[0]?.name, 'access_token')
    assert.equal(success.items[0]?.detail, 'access_token 已获取')
    assert.ok(success.checkedAt)
    const row = ok.db.prepare('SELECT last_checked_at, last_error FROM chatbots WHERE id = ?').get(ok.chatbotId) as {
      last_checked_at: string | null
      last_error: string | null
    }
    assert.ok(row.last_checked_at, '成功自检应刷新 last_checked_at')
    assert.equal(row.last_error, null, '成功自检不应写 last_error')
    assert.ok(ok.audits.some((item) => item.action === 'chatbot.check' && item.detail?.ok === true))
  } finally {
    ok.cleanup()
  }

  const failed = createQqServiceFixture({ fetchOptions: { tokenFails: 'unauthorized' } })
  try {
    // 投递错误由队列维护；自检失败不得覆盖它。
    failed.db.prepare("UPDATE chatbots SET last_error = 'chatbot_ai_timeout: 超时' WHERE id = ?").run(failed.chatbotId)
    const health = await failed.service.checkBot(failed.chatbotId)
    assert.equal(health.ok, false)
    assert.equal(health.items[0]?.ok, false)
    assert.equal(health.items[0]?.detail, 'qq_access_token_failed')
    const checkedAt = health.checkedAt
    const row = failed.db.prepare('SELECT last_checked_at, last_error FROM chatbots WHERE id = ?').get(failed.chatbotId) as {
      last_checked_at: string | null
      last_error: string | null
    }
    assert.equal(row.last_error, 'chatbot_ai_timeout: 超时', '自检失败不得覆盖投递错误')
    assert.equal(row.last_checked_at, checkedAt, '失败自检同样刷新 last_checked_at')
    assert.ok(failed.audits.some((item) => item.action === 'chatbot.check' && item.detail?.ok === false))
  } finally {
    failed.cleanup()
  }

  const offline = createQqServiceFixture({ fetchOptions: { tokenFails: 'network' } })
  try {
    const health = await offline.service.checkBot(offline.chatbotId)
    assert.equal(health.ok, false)
    assert.equal(health.items[0]?.detail, 'network_error')
  } finally {
    offline.cleanup()
  }
})

test('v0.5.7：checkBot 对无 check 的适配器 400，适配器抛错时返回脱敏兜底结果', async () => {
  const fixture = createQqServiceFixture()
  const patch = fixture.service as unknown as { adapterFor: (row: unknown) => unknown }
  try {
    patch.adapterFor = () => ({ platform: 'qq' })
    await assert.rejects(
      () => fixture.service.checkBot(fixture.chatbotId),
      (error: unknown) => error instanceof AppError && error.code === 'chatbot_health_unsupported' && error.statusCode === 400,
    )
    const row = fixture.db.prepare('SELECT last_checked_at FROM chatbots WHERE id = ?').get(fixture.chatbotId) as {
      last_checked_at: string | null
    }
    assert.equal(row.last_checked_at, null, '不支持自检时不刷新检查时间')

    patch.adapterFor = () => ({
      platform: 'qq',
      check: async (): Promise<ChatbotHealthCheck> => {
        throw new Error('上游异常 https://internal.example/secret-token')
      },
    })
    const fallback = await fixture.service.checkBot(fixture.chatbotId)
    assert.equal(fallback.ok, false)
    assert.equal(fallback.items.length, 1)
    assert.equal(fallback.items[0]?.name, '连接自检')
    assert.equal(String(fallback.items[0]?.detail).includes('internal.example'), false, '兜底结果必须脱敏')
    assert.ok(fallback.checkedAt)
    const refreshed = fixture.db.prepare('SELECT last_checked_at FROM chatbots WHERE id = ?').get(fixture.chatbotId) as {
      last_checked_at: string | null
    }
    assert.equal(refreshed.last_checked_at, fallback.checkedAt)
    assert.ok(fixture.audits.some((item) => item.action === 'chatbot.check' && item.detail?.ok === false))
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.7：Chatbot 功能关闭时 checkBot 返回 503 chatbot_disabled', async () => {
  const dir = tempDataDir()
  const db = testDb(dir)
  const config = testConfig(dir, { chatbotEnabled: false, chatbotSecretKey: randomBytes(32).toString('base64') })
  const service = new ChatbotService({
    db,
    config,
    log: () => undefined,
    audit: () => undefined,
    providers: {
      status: async () => ({}),
      backup: async () => ({}),
      world: async () => ({}),
      minecraft: async () => ({}),
      files: async () => [],
    },
  })
  try {
    await assert.rejects(
      () => service.checkBot('any-chatbot'),
      (error: unknown) => error instanceof AppError && error.statusCode === 503 && error.code === 'chatbot_disabled',
    )
  } finally {
    db.close()
  }
})
