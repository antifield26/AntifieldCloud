/**
 * v0.5.7 管理接口（QQ 单平台，F6/F7）：角色卡与长期记忆元数据分页、启停/删除副作用与审计，
 * 以及 QQ 连接自检 checkBot（成功/失败/不支持/异常兜底、last_checked_at 与 last_error 边界）。
 * 不访问真实 QQ；fetch 与 AI 均为进程内夹具。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tempDataDir, testConfig, testDb } from './helpers.ts'
import { createQqServiceFixture } from './bot-qq-fixtures.ts'
import { BotService } from '../src/bot/service.ts'
import { BotChatRoleStore } from '../src/bot/roles.ts'
import { BotMemoryStore } from '../src/bot/memory.ts'
import { AppError } from '../src/util/errors.ts'
import type { BotHealthCheck } from '../src/bot/types.ts'

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
      `INSERT INTO bot_inbound_targets (bot_id, target_external_id, target_kind, user_id, user_name, is_direct, last_seen_at)
       VALUES (?, ?, 'user', ?, ?, 1, ?)`,
    )
    .run(fixture.botId, targetExternalId, userId, userName, lastSeenAt)
}

function seedSession(fixture: Fixture, target: string, userId: string, mode: 'chat' | 'task', sessionId: string): void {
  fixture.db
    .prepare(
      `INSERT INTO bot_ai_sessions (bot_id, target_external_id, user_id, mode, session_id, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'm', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')`,
    )
    .run(fixture.botId, target, userId, mode, sessionId)
}

test('v0.5.7：listRoles 只返回元数据并用最近入站用户名补 userName；分页 total 正确', () => {
  const fixture = createQqServiceFixture()
  try {
    seedInbound(fixture, 'user-1', '小明')
    seedInbound(fixture, 'user-2', '小红')
    seedInbound(fixture, 'user-3', '旧名字', 'dm-old-3', '2026-10-21T00:00:00.000Z')
    seedInbound(fixture, 'user-3', '新名字', 'dm-new-3', '2026-10-22T00:00:00.000Z')
    const roles = new BotChatRoleStore(fixture.db)
    roles.save(fixture.botId, 'user-1', '猫娘', '这是一段绝不应出现在管理响应里的角色设定正文。')
    roles.save(fixture.botId, 'user-2', '老师', '老师设定正文。')
    roles.save(fixture.botId, 'user-3', '闲置', '第三张卡。')

    const all = fixture.service.listRoles(fixture.botId, { limit: 20, offset: 0 })
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

    const page = fixture.service.listRoles(fixture.botId, { limit: 1, offset: 1 })
    assert.equal(page.total, 3)
    assert.equal(page.items.length, 1)
    const updated = fixture.service.listRoles(fixture.botId, { limit: 20, offset: 0 }).items.find((item) => item.userId === 'user-3')
    assert.equal(updated?.userName, '新名字')
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.7：setRoleEnabled/deleteRole 的副作用与审计；删除角色只清 chat 会话', () => {
  const fixture = createQqServiceFixture()
  try {
    const roles = new BotChatRoleStore(fixture.db)
    roles.save(fixture.botId, 'user-1', '猫娘', '角色设定正文。')
    seedSession(fixture, 'target-a', 'user-1', 'chat', 'chat-a')
    seedSession(fixture, 'target-b', 'user-1', 'chat', 'chat-b')
    seedSession(fixture, 'target-a', 'user-1', 'task', 'task-a')
    seedSession(fixture, 'target-a', 'user-2', 'chat', 'other-user')

    fixture.service.setRoleEnabled(fixture.botId, 'user-1', false)
    assert.equal(roles.get(fixture.botId, 'user-1')?.enabled, false)
    assert.ok(fixture.audits.some((item) => item.action === 'bot.role.admin' && item.detail?.action === 'disable'))
    fixture.service.setRoleEnabled(fixture.botId, 'user-1', true)
    assert.equal(roles.get(fixture.botId, 'user-1')?.enabled, true)
    assert.ok(fixture.audits.some((item) => item.action === 'bot.role.admin' && item.detail?.action === 'enable'))
    assert.equal(JSON.stringify(fixture.audits).includes('角色设定正文'), false, '审计不得包含角色正文')
    assert.throws(
      () => fixture.service.setRoleEnabled(fixture.botId, 'missing-user', true),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    )

    fixture.service.deleteRole(fixture.botId, 'user-1')
    assert.equal(roles.get(fixture.botId, 'user-1'), null)
    const chatRows = fixture.db
      .prepare("SELECT COUNT(*) AS c FROM bot_ai_sessions WHERE bot_id = ? AND user_id = 'user-1' AND mode = 'chat'")
      .get(fixture.botId) as { c: number }
    assert.equal(chatRows.c, 0, '删除角色应清理该用户全部 chat 会话')
    const taskRows = fixture.db
      .prepare("SELECT COUNT(*) AS c FROM bot_ai_sessions WHERE bot_id = ? AND user_id = 'user-1' AND mode = 'task'")
      .get(fixture.botId) as { c: number }
    assert.equal(taskRows.c, 1, 'task 会话保留')
    assert.ok(fixture.audits.some((item) => item.action === 'bot.role.admin' && item.detail?.action === 'delete'))
    assert.throws(
      () => fixture.service.deleteRole(fixture.botId, 'user-1'),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    )
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.7：listMemories 只返回元数据；deleteMemory 清理 DB 行与镜像文件并审计', () => {
  const fixture = createQqServiceFixture()
  try {
    seedInbound(fixture, 'user-1', '小明')
    const memory = new BotMemoryStore(fixture.db, fixture.dir, fixture.config.botAiMemoryMaxChars)
    const one = memory.get(fixture.botId, 'user-1')
    memory.save(fixture.botId, 'user-1', one.memoryId, '用户喜欢深色模式，这是记忆正文。', 'session-1')
    const two = memory.get(fixture.botId, 'user-2')
    memory.save(fixture.botId, 'user-2', two.memoryId, '第二条记忆正文。', null)
    const mirrorPath = join(fixture.dir, 'bot-memory', `memory-${one.memoryId}.md`)
    assert.ok(existsSync(mirrorPath))

    const list = fixture.service.listMemories(fixture.botId, { limit: 20, offset: 0 })
    assert.equal(list.total, 2)
    assert.equal(list.items.length, 2)
    const first = list.items.find((item) => item.userId === 'user-1')
    assert.equal(first?.userName, '小明')
    assert.equal(first?.summaryLength, '用户喜欢深色模式，这是记忆正文。'.length)
    assert.ok(first?.createdAt && first.updatedAt)
    assert.equal(JSON.stringify(list.items).includes('记忆正文'), false, '管理列表不得暴露记忆正文')

    const page = fixture.service.listMemories(fixture.botId, { limit: 1, offset: 1 })
    assert.equal(page.total, 2)
    assert.equal(page.items.length, 1)

    fixture.service.deleteMemory(fixture.botId, 'user-1')
    assert.equal(memory.count(fixture.botId), 1)
    assert.equal(existsSync(mirrorPath), false, '删除记忆应清理镜像文件')
    assert.ok(fixture.audits.some((item) => item.action === 'bot.memory.admin' && item.detail?.action === 'delete'))
    assert.equal(JSON.stringify(fixture.audits).includes('记忆正文'), false)
    assert.throws(
      () => fixture.service.deleteMemory(fixture.botId, 'user-1'),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    )
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.7：checkBot 成功/失败都刷新 last_checked_at 且不覆盖投递 last_error', async () => {
  const ok = createQqServiceFixture()
  try {
    const success = await ok.service.checkBot(ok.botId)
    assert.equal(success.ok, true)
    assert.equal(success.items[0]?.name, 'access_token')
    assert.equal(success.items[0]?.detail, 'access_token 已获取')
    assert.ok(success.checkedAt)
    const row = ok.db.prepare('SELECT last_checked_at, last_error FROM bots WHERE id = ?').get(ok.botId) as {
      last_checked_at: string | null
      last_error: string | null
    }
    assert.ok(row.last_checked_at, '成功自检应刷新 last_checked_at')
    assert.equal(row.last_error, null, '成功自检不应写 last_error')
    assert.ok(ok.audits.some((item) => item.action === 'bot.check' && item.detail?.ok === true))
  } finally {
    ok.cleanup()
  }

  const failed = createQqServiceFixture({ fetchOptions: { tokenFails: 'unauthorized' } })
  try {
    // 投递错误由队列维护；自检失败不得覆盖它。
    failed.db.prepare("UPDATE bots SET last_error = 'bot_ai_timeout: 超时' WHERE id = ?").run(failed.botId)
    const health = await failed.service.checkBot(failed.botId)
    assert.equal(health.ok, false)
    assert.equal(health.items[0]?.ok, false)
    assert.equal(health.items[0]?.detail, 'qq_access_token_failed')
    const checkedAt = health.checkedAt
    const row = failed.db.prepare('SELECT last_checked_at, last_error FROM bots WHERE id = ?').get(failed.botId) as {
      last_checked_at: string | null
      last_error: string | null
    }
    assert.equal(row.last_error, 'bot_ai_timeout: 超时', '自检失败不得覆盖投递错误')
    assert.equal(row.last_checked_at, checkedAt, '失败自检同样刷新 last_checked_at')
    assert.ok(failed.audits.some((item) => item.action === 'bot.check' && item.detail?.ok === false))
  } finally {
    failed.cleanup()
  }

  const offline = createQqServiceFixture({ fetchOptions: { tokenFails: 'network' } })
  try {
    const health = await offline.service.checkBot(offline.botId)
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
      () => fixture.service.checkBot(fixture.botId),
      (error: unknown) => error instanceof AppError && error.code === 'bot_health_unsupported' && error.statusCode === 400,
    )
    const row = fixture.db.prepare('SELECT last_checked_at FROM bots WHERE id = ?').get(fixture.botId) as {
      last_checked_at: string | null
    }
    assert.equal(row.last_checked_at, null, '不支持自检时不刷新检查时间')

    patch.adapterFor = () => ({
      platform: 'qq',
      check: async (): Promise<BotHealthCheck> => {
        throw new Error('上游异常 https://internal.example/secret-token')
      },
    })
    const fallback = await fixture.service.checkBot(fixture.botId)
    assert.equal(fallback.ok, false)
    assert.equal(fallback.items.length, 1)
    assert.equal(fallback.items[0]?.name, '连接自检')
    assert.equal(String(fallback.items[0]?.detail).includes('internal.example'), false, '兜底结果必须脱敏')
    assert.ok(fallback.checkedAt)
    const refreshed = fixture.db.prepare('SELECT last_checked_at FROM bots WHERE id = ?').get(fixture.botId) as {
      last_checked_at: string | null
    }
    assert.equal(refreshed.last_checked_at, fallback.checkedAt)
    assert.ok(fixture.audits.some((item) => item.action === 'bot.check' && item.detail?.ok === false))
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.7：Bot 功能关闭时 checkBot 返回 503 bot_disabled', async () => {
  const dir = tempDataDir()
  const db = testDb(dir)
  const config = testConfig(dir, { botEnabled: false, botSecretKey: randomBytes(32).toString('base64') })
  const service = new BotService({
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
      () => service.checkBot('any-bot'),
      (error: unknown) => error instanceof AppError && error.statusCode === 503 && error.code === 'bot_disabled',
    )
  } finally {
    db.close()
  }
})
