/**
 * v0.5.7 管理接口（F6/F7）：角色卡与长期记忆元数据分页、启停/删除副作用与审计，
 * 以及平台连接自检 checkBot（成功/失败/不支持/异常兜底、last_checked_at 与 last_error 边界）。
 * 不访问真实平台；fetch 与 AI 均为进程内夹具。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tempDataDir, testConfig, testDb } from './helpers.ts'
import { BotService } from '../src/bot/service.ts'
import { BotChatRoleStore } from '../src/bot/roles.ts'
import { BotMemoryStore } from '../src/bot/memory.ts'
import { AppError } from '../src/util/errors.ts'
import type { BotHealthCheck } from '../src/bot/types.ts'

const SECRET = 'secret-'.repeat(4)

interface AuditRecord {
  action: string
  target: string | null
  detail?: Record<string, unknown> | null
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

interface FakeState {
  /** 健康检查模式：ok / unauthorized / 抛异常。 */
  healthMode: 'ok' | 'unauthorized' | 'network_error'
  webhookUrl: string
}

function setup(overrides: Record<string, unknown> = {}) {
  const dir = tempDataDir()
  const db = testDb(dir)
  const config = testConfig(dir, {
    botEnabled: true,
    botSecretKey: randomBytes(32).toString('base64'),
    botAiEnabled: true,
    ...overrides,
  })
  const audits: AuditRecord[] = []
  const healthUrls: string[] = []
  const state: FakeState = { healthMode: 'ok', webhookUrl: '' }
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('getMe')) {
      healthUrls.push(url)
      if (state.healthMode === 'unauthorized') return jsonResponse({ ok: false, description: 'Unauthorized' }, 401)
      if (state.healthMode === 'network_error') throw new Error('connect ECONNREFUSED 127.0.0.1')
      return jsonResponse({ ok: true, result: { id: 1, username: 'afc_bot' } })
    }
    if (url.includes('getWebhookInfo')) {
      healthUrls.push(url)
      return jsonResponse({
        ok: true,
        result: { url: state.webhookUrl, pending_update_count: 2 },
      })
    }
    if (url.includes('sendMessage')) return jsonResponse({ ok: true, result: { message_id: 1 } })
    return jsonResponse({ ok: true })
  }) as typeof fetch
  const service = new BotService({
    db,
    config,
    log: () => undefined,
    audit: (action, target, detail) => {
      audits.push({ action, target, detail })
    },
    fetch: fetchImpl,
    now: () => new Date('2026-10-22T04:00:00.000Z'),
    ai: { chat: async () => 'AI 回复' },
    media: {
      stat: () => ({ filename: 'a.png', mime: 'image/png', size: 3 }),
      load: async () => ({ filename: 'a.png', mime: 'image/png', data: Buffer.from('png') }),
    },
    providers: {
      status: async () => ({ ok: true }),
      backup: async () => ({ ok: true }),
      world: async () => ({ ok: true }),
      minecraft: async () => ({ online: true }),
      files: async () => [],
    },
  })
  const bot = service.createBot({
    platform: 'telegram',
    name: 'admin',
    token: 'x'.repeat(40),
    webhookSecret: SECRET,
  })
  service.updateBot(bot.id, { enabled: true })
  state.webhookUrl = `https://app.test/api/bot/webhook/${bot.id}`
  const roles = new BotChatRoleStore(db)
  const memory = new BotMemoryStore(db, dir, config.botAiMemoryMaxChars)
  return { dir, db, config, service, botId: bot.id, audits, state, healthUrls, roles, memory }
}

function seedInbound(
  db: ReturnType<typeof testDb>,
  botId: string,
  userId: string,
  userName: string,
  targetExternalId = `dm-${userId}`,
  lastSeenAt = '2026-10-22T00:00:00.000Z',
): void {
  db.prepare(
    `INSERT INTO bot_inbound_targets (bot_id, target_external_id, target_kind, user_id, user_name, is_direct, last_seen_at)
     VALUES (?, ?, 'user', ?, ?, 1, ?)`,
  ).run(botId, targetExternalId, userId, userName, lastSeenAt)
}

function seedSession(
  db: ReturnType<typeof testDb>,
  botId: string,
  target: string,
  userId: string,
  mode: 'chat' | 'task',
  sessionId: string,
): void {
  db.prepare(
    `INSERT INTO bot_ai_sessions (bot_id, target_external_id, user_id, mode, session_id, model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'm', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')`,
  ).run(botId, target, userId, mode, sessionId)
}

test('v0.5.7：listRoles 只返回元数据并用最近入站用户名补 userName；分页 total 正确', () => {
  const { dir, db, service, botId, roles } = setup()
  try {
    seedInbound(db, botId, 'user-1', '小明')
    seedInbound(db, botId, 'user-2', '小红')
    seedInbound(db, botId, 'user-3', '旧名字', 'dm-old-3', '2026-10-21T00:00:00.000Z')
    seedInbound(db, botId, 'user-3', '新名字', 'dm-new-3', '2026-10-22T00:00:00.000Z')
    roles.save(botId, 'user-1', '猫娘', '这是一段绝不应出现在管理响应里的角色设定正文。')
    roles.save(botId, 'user-2', '老师', '老师设定正文。')
    roles.save(botId, 'user-3', '闲置', '第三张卡。')

    const all = service.listRoles(botId, { limit: 20, offset: 0 })
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

    const page = service.listRoles(botId, { limit: 1, offset: 1 })
    assert.equal(page.total, 3)
    assert.equal(page.items.length, 1)
    // 同用户多入站记录取最近一次名字。
    const updated = service.listRoles(botId, { limit: 20, offset: 0 }).items.find((item) => item.userId === 'user-3')
    assert.equal(updated?.userName, '新名字')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('v0.5.7：setRoleEnabled/deleteRole 的副作用与审计；删除角色只清 chat 会话', () => {
  const { dir, db, service, botId, roles, audits } = setup()
  try {
    roles.save(botId, 'user-1', '猫娘', '角色设定正文。')
    seedSession(db, botId, 'target-a', 'user-1', 'chat', 'chat-a')
    seedSession(db, botId, 'target-b', 'user-1', 'chat', 'chat-b')
    seedSession(db, botId, 'target-a', 'user-1', 'task', 'task-a')
    seedSession(db, botId, 'target-a', 'user-2', 'chat', 'other-user')

    service.setRoleEnabled(botId, 'user-1', false)
    assert.equal(roles.get(botId, 'user-1')?.enabled, false)
    assert.ok(audits.some((item) => item.action === 'bot.role.admin' && item.detail?.action === 'disable'))
    service.setRoleEnabled(botId, 'user-1', true)
    assert.equal(roles.get(botId, 'user-1')?.enabled, true)
    assert.ok(audits.some((item) => item.action === 'bot.role.admin' && item.detail?.action === 'enable'))
    assert.equal(JSON.stringify(audits).includes('角色设定正文'), false, '审计不得包含角色正文')

    assert.throws(
      () => service.setRoleEnabled(botId, 'missing-user', true),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    )

    service.deleteRole(botId, 'user-1')
    assert.equal(roles.get(botId, 'user-1'), null)
    const chatRows = db
      .prepare("SELECT COUNT(*) AS c FROM bot_ai_sessions WHERE bot_id = ? AND user_id = 'user-1' AND mode = 'chat'")
      .get(botId) as { c: number }
    assert.equal(chatRows.c, 0, '删除角色应清理该用户全部 chat 会话')
    const taskRows = db
      .prepare("SELECT COUNT(*) AS c FROM bot_ai_sessions WHERE bot_id = ? AND user_id = 'user-1' AND mode = 'task'")
      .get(botId) as { c: number }
    assert.equal(taskRows.c, 1, 'task 会话保留')
    assert.ok(audits.some((item) => item.action === 'bot.role.admin' && item.detail?.action === 'delete'))
    assert.throws(
      () => service.deleteRole(botId, 'user-1'),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    )
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('v0.5.7：listMemories 只返回元数据；deleteMemory 清理 DB 行与镜像文件并审计', () => {
  const { dir, db, service, botId, memory, audits } = setup()
  try {
    seedInbound(db, botId, 'user-1', '小明')
    const one = memory.get(botId, 'user-1')
    memory.save(botId, 'user-1', one.memoryId, '用户喜欢深色模式，这是记忆正文。', 'session-1')
    const two = memory.get(botId, 'user-2')
    memory.save(botId, 'user-2', two.memoryId, '第二条记忆正文。', null)
    const mirrorPath = join(dir, 'bot-memory', `memory-${one.memoryId}.md`)
    assert.ok(existsSync(mirrorPath))

    const list = service.listMemories(botId, { limit: 20, offset: 0 })
    assert.equal(list.total, 2)
    assert.equal(list.items.length, 2)
    const first = list.items.find((item) => item.userId === 'user-1')
    assert.equal(first?.userName, '小明')
    assert.equal(first?.summaryLength, '用户喜欢深色模式，这是记忆正文。'.length)
    assert.ok(first?.createdAt && first.updatedAt)
    assert.equal(JSON.stringify(list.items).includes('记忆正文'), false, '管理列表不得暴露记忆正文')

    const page = service.listMemories(botId, { limit: 1, offset: 1 })
    assert.equal(page.total, 2)
    assert.equal(page.items.length, 1)

    service.deleteMemory(botId, 'user-1')
    assert.equal(memory.count(botId), 1)
    assert.equal(existsSync(mirrorPath), false, '删除记忆应清理镜像文件')
    assert.ok(audits.some((item) => item.action === 'bot.memory.admin' && item.detail?.action === 'delete'))
    assert.equal(JSON.stringify(audits).includes('记忆正文'), false)
    assert.throws(
      () => service.deleteMemory(botId, 'user-1'),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    )
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('v0.5.7：checkBot 成功/失败都刷新 last_checked_at 且不覆盖投递 last_error', async () => {
  const { dir, db, service, botId, state, audits } = setup()
  try {
    const success = await service.checkBot(botId)
    assert.equal(success.ok, true)
    assert.deepEqual(success.items.map((item) => item.name), ['Bot 账号', 'Webhook'])
    assert.equal(success.items[0]?.detail, '@afc_bot')
    assert.ok(success.checkedAt)
    let row = db.prepare('SELECT last_checked_at, last_error FROM bots WHERE id = ?').get(botId) as {
      last_checked_at: string | null
      last_error: string | null
    }
    assert.ok(row.last_checked_at, '成功自检应刷新 last_checked_at')
    assert.equal(row.last_error, null, '成功自检不应写 last_error')
    assert.ok(audits.some((item) => item.action === 'bot.check' && item.detail?.ok === true))

    // 投递错误由队列维护；自检失败不得覆盖它。
    db.prepare("UPDATE bots SET last_error = 'bot_ai_timeout: 超时' WHERE id = ?").run(botId)
    state.healthMode = 'unauthorized'
    const failed = await service.checkBot(botId)
    assert.equal(failed.ok, false)
    assert.equal(failed.items[0]?.ok, false)
    assert.equal(failed.items[0]?.detail, 'telegram_unauthorized')
    const checkedAfterFailure = failed.checkedAt
    row = db.prepare('SELECT last_checked_at, last_error FROM bots WHERE id = ?').get(botId) as {
      last_checked_at: string | null
      last_error: string | null
    }
    assert.equal(row.last_error, 'bot_ai_timeout: 超时', '自检失败不得覆盖投递错误')
    assert.equal(row.last_checked_at, checkedAfterFailure, '失败自检同样刷新 last_checked_at')
    assert.ok(audits.some((item) => item.action === 'bot.check' && item.detail?.ok === false))

    state.healthMode = 'network_error'
    const network = await service.checkBot(botId)
    assert.equal(network.ok, false)
    assert.match(String(network.items[0]?.detail), /network_error/)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('v0.5.7：checkBot 对无 check 的适配器 400，适配器抛错时返回脱敏兜底结果', async () => {
  const { dir, db, service, botId, audits } = setup()
  const patch = service as unknown as { adapterFor: (row: unknown) => unknown }
  try {
    patch.adapterFor = () => ({ platform: 'telegram' })
    await assert.rejects(
      () => service.checkBot(botId),
      (error: unknown) => error instanceof AppError && error.code === 'bot_health_unsupported' && error.statusCode === 400,
    )
    const row = db.prepare('SELECT last_checked_at FROM bots WHERE id = ?').get(botId) as { last_checked_at: string | null }
    assert.equal(row.last_checked_at, null, '不支持自检时不刷新检查时间')

    patch.adapterFor = () => ({
      platform: 'telegram',
      check: async (): Promise<BotHealthCheck> => {
        throw new Error('上游异常 https://internal.example/secret-token')
      },
    })
    const fallback = await service.checkBot(botId)
    assert.equal(fallback.ok, false)
    assert.equal(fallback.items.length, 1)
    assert.equal(fallback.items[0]?.name, '连接自检')
    assert.equal(String(fallback.items[0]?.detail).includes('internal.example'), false, '兜底结果必须脱敏')
    assert.ok(fallback.checkedAt)
    const refreshed = db.prepare('SELECT last_checked_at FROM bots WHERE id = ?').get(botId) as { last_checked_at: string | null }
    assert.equal(refreshed.last_checked_at, fallback.checkedAt)
    assert.ok(audits.some((item) => item.action === 'bot.check' && item.detail?.ok === false))
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
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
    media: {
      stat: () => ({ filename: 'a.png', mime: 'image/png', size: 3 }),
      load: async () => ({ filename: 'a.png', mime: 'image/png', data: Buffer.from('png') }),
    },
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
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})
