/**
 * Bot 管理路由安全回归（QQ 单平台）：发布必须 TOTP 再认证（BOT-02），缺失验证码不得外发；
 * 检查连接/事件/角色/记忆路由与目标 CRUD（鉴权/CSRF 规则照旧）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.ts'
import { hotp, currentStep } from '../src/auth/totp.ts'
import { BotChatRoleStore } from '../src/bot/roles.ts'
import { cookieHeader, currentCode, parseSetCookies, seedAdmin, tempDataDir, testConfig, testDb } from './helpers.ts'
import { signQqEvent, makeQqServiceFetch } from './bot-qq-fixtures.ts'

interface Seeded {
  username: string
  password: string
  secret: string
  userId: string
}

async function loginAdmin(app: FastifyInstance, seeded: Seeded): Promise<{ cookie: string; csrf: string }> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/password',
    payload: { username: seeded.username, password: seeded.password },
  })
  assert.equal(login.statusCode, 200)
  const challenge = login.json().challenge as string
  const totpLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/totp',
    payload: { challenge, code: currentCode(seeded.secret) },
  })
  assert.equal(totpLogin.statusCode, 200)
  const cookies = parseSetCookies(totpLogin.headers['set-cookie'] as string[] | undefined)
  return { cookie: cookieHeader(cookies), csrf: cookies.af_csrf ?? '' }
}

const APP_ID = '102345678'
const APP_SECRET = 'qq-route-app-secret-0123456789abcdef'

test('Bot 发布路由：无 TOTP 400，带有效 TOTP 才创建外发任务', async () => {
  const dir = tempDataDir()
  const config = testConfig(dir, { botEnabled: true, botSecretKey: randomBytes(32).toString('base64') })
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const context = await buildApp(config, db)
  try {
    const { cookie, csrf } = await loginAdmin(context.app, seeded)
    const bot = context.bots.createBot({
      platform: 'qq',
      name: 'route',
      token: APP_SECRET,
      config: { appId: APP_ID },
    })
    context.bots.updateBot(bot.id, { enabled: true })
    const target = context.bots.createTarget(bot.id, {
      externalId: 'group-openid-1',
      label: 'QQ 群',
      kind: 'group',
      allowCommands: false,
      allowNotifications: true,
    })

    const missing = await context.app.inject({
      method: 'POST',
      url: `/api/bots/${bot.id}/publish`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { targetId: target.id, text: '不应外发' },
    })
    assert.equal(missing.statusCode, 400)
    assert.equal(missing.json().error.code, 'totp_required')

    // 登录已消费当前 TOTP step，使用下一步窗口的验证码。
    const nextCode = hotp(seeded.secret, currentStep() + 1)
    const created = await context.app.inject({
      method: 'POST',
      url: `/api/bots/${bot.id}/publish`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        targetId: target.id,
        text: '外发测试',
        totpCode: nextCode,
        confirmText: 'PUBLISH',
        scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    })
    assert.equal(created.statusCode, 200)
    assert.equal(created.json().job.status, 'queued')
    assert.equal(created.json().job.text, '外发测试')
    assert.equal('mediaFileIds' in created.json().job, false, 'QQ 单平台发布不含媒体字段')
  } finally {
    context.bots.stop()
    await context.app.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v0.5.8 Bot 管理路由：QQ Bot CRUD、目标、检查连接、事件、角色与记忆', async () => {
  const dir = tempDataDir()
  const config = testConfig(dir, {
    botEnabled: true,
    botSecretKey: randomBytes(32).toString('base64'),
    botAiEnabled: true,
  })
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const context = await buildApp(config, db)
  try {
    const { cookie, csrf } = await loginAdmin(context.app, seeded)

    // 只允许 QQ 平台。
    const legacy = await context.app.inject({
      method: 'POST',
      url: '/api/bots',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { platform: 'telegram', name: 'legacy', token: 'x'.repeat(40) },
    })
    assert.equal(legacy.statusCode, 400)
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/bots',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { platform: 'qq', name: 'QQ', token: APP_SECRET, config: { appId: APP_ID } },
    })
    assert.equal(created.statusCode, 200)
    const botId = created.json().bot.id as string
    assert.equal(created.json().bot.platform, 'qq')
    assert.equal('gateway' in created.json().bot, false, 'BotSummary 不应再有 gateway 字段')
    context.bots.updateBot(botId, { enabled: true })

    // 目标 CRUD：返回不含 chatTrigger；QQ 群/频道只支持 @Bot。
    const target = await context.app.inject({
      method: 'POST',
      url: `/api/bots/${botId}/targets`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        externalId: 'group-openid-1',
        label: 'QQ 群',
        kind: 'group',
        allowChat: true,
        allowCommands: true,
        allowNotifications: true,
      },
    })
    assert.equal(target.statusCode, 200)
    assert.equal('chatTrigger' in target.json().target, false)
    const targetId = target.json().target.id as string
    const patched = await context.app.inject({
      method: 'PATCH',
      url: `/api/bots/${botId}/targets/${targetId}`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { label: '新群名' },
    })
    assert.equal(patched.statusCode, 200)
    assert.equal(patched.json().target.label, '新群名')
    const listed = await context.app.inject({ method: 'GET', url: `/api/bots/${botId}/targets`, headers: { cookie } })
    assert.equal(listed.json().items.length, 1)

    // 检查连接：伪造适配器 check，路由返回 { health }，CSRF 必需。
    const internals = context.bots as unknown as {
      adapterFor: (row: unknown) => unknown
      deps: { ai?: { chat: (input: unknown) => Promise<string> }; fetch?: typeof fetch }
    }
    const originalAdapterFor = internals.adapterFor
    internals.adapterFor = () => ({
      platform: 'qq',
      check: async () => ({ ok: true, items: [{ name: 'access_token', ok: true, detail: 'access_token 已获取' }] }),
      send: async () => ({ externalId: 'route-sent' }),
    })
    if (internals.deps.ai) internals.deps.ai.chat = async () => 'AI 回复'
    const check = await context.app.inject({
      method: 'POST',
      url: `/api/bots/${botId}/check`,
      headers: { cookie, 'x-csrf-token': csrf },
    })
    assert.equal(check.statusCode, 200)
    assert.equal(check.json().health.ok, true)
    assert.equal(check.json().health.items[0].detail, 'access_token 已获取')
    assert.ok(check.json().health.checkedAt)
    const checkNoCsrf = await context.app.inject({
      method: 'POST',
      url: `/api/bots/${botId}/check`,
      headers: { cookie },
    })
    assert.equal(checkNoCsrf.statusCode, 403)

    // 恢复真实适配器并注入进程内 fetch，避免 Webhook/回复访问真实 QQ 网络。
    internals.adapterFor = originalAdapterFor
    internals.deps.fetch = makeQqServiceFetch().fetchImpl

    // 事件列表：签名 C2C 聊天产生 ok 事件，筛选/分页参数按契约返回。
    const timestamp = String(Math.floor(Date.now() / 1000))
    const webhook = signQqEvent(
      APP_SECRET,
      {
        op: 0,
        t: 'C2C_MESSAGE_CREATE',
        d: { id: 'route-event-1', content: '你好', author: { user_openid: 'user-openid-1' } },
      },
      timestamp,
    )
    const webhookResult = await context.app.inject({
      method: 'POST',
      url: `/api/bot/webhook/${botId}`,
      headers: { 'content-type': 'application/json', ...webhook.headers },
      payload: webhook.body,
    })
    assert.equal(webhookResult.statusCode, 200)
    await context.bots.waitForIdle()
    const events = await context.app.inject({
      method: 'GET',
      url: `/api/bots/${botId}/events?hours=24&limit=10&offset=0&outcome=ok`,
      headers: { cookie },
    })
    assert.equal(events.statusCode, 200)
    assert.equal(events.json().total, 1)
    assert.equal(events.json().items[0].eventId, 'route-event-1')
    assert.equal(events.json().items[0].outcome, 'ok')
    const badOutcome = await context.app.inject({
      method: 'GET',
      url: `/api/bots/${botId}/events?outcome=bogus`,
      headers: { cookie },
    })
    assert.equal(badOutcome.statusCode, 400)

    // 角色管理：列表只含元数据，启停/删除返回 { ok: true }。
    const roles = new BotChatRoleStore(db)
    roles.save(botId, 'user-1', '猫娘', '这条角色设定正文不应出现在 API。')
    const roleList = await context.app.inject({ method: 'GET', url: `/api/bots/${botId}/roles?limit=20&offset=0`, headers: { cookie } })
    assert.equal(roleList.statusCode, 200)
    assert.equal(roleList.json().total, 1)
    assert.equal(roleList.json().items[0].promptLength, '这条角色设定正文不应出现在 API。'.length)
    assert.equal(JSON.stringify(roleList.json()).includes('角色设定正文'), false)
    const rolePatch = await context.app.inject({
      method: 'PATCH',
      url: `/api/bots/${botId}/roles/user-1`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { enabled: false },
    })
    assert.equal(rolePatch.statusCode, 200)
    assert.deepEqual(rolePatch.json(), { ok: true })
    assert.equal(roles.get(botId, 'user-1')?.enabled, false)
    const roleBadPatch = await context.app.inject({
      method: 'PATCH',
      url: `/api/bots/${botId}/roles/user-1`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { enabled: 'no' },
    })
    assert.equal(roleBadPatch.statusCode, 400)

    // 记忆管理：用户级/条目元数据与删除返回 { ok: true }，绝不包含 key/value。
    const insertItem = (id: string, kind: string, key: string, value: string): void => {
      db.prepare(
        `INSERT INTO bot_memory_items
           (id, bot_id, user_id, kind, mem_key, value, confidence, importance, source, created_at, updated_at, last_used_at, expires_at)
         VALUES (?, ?, 'user-1', ?, ?, ?, 0.8, 3, 'chat', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z', NULL, NULL)`,
      ).run(id, botId, kind, key, value)
    }
    insertItem('item-route-1', 'preference', 'KEY_SECRET_1', 'VALUE_SECRET_1')
    insertItem('item-route-2', 'fact', 'KEY_SECRET_2', 'VALUE_SECRET_2')
    const memoryList = await context.app.inject({ method: 'GET', url: `/api/bots/${botId}/memories`, headers: { cookie } })
    assert.equal(memoryList.statusCode, 200)
    // Chat 事件会为用户创建空状态，这里断言目标用户的结构化元数据存在。
    const seededMemory = (memoryList.json().items as Array<Record<string, unknown>>).find(
      (item) => item.userId === 'user-1',
    )
    assert.ok(seededMemory)
    assert.equal(seededMemory.itemCount, 2)
    assert.deepEqual(seededMemory.kinds, { preference: 1, fact: 1 })
    assert.equal(typeof seededMemory.updatedAt, 'string')
    const memoryJson = JSON.stringify(memoryList.json())
    assert.equal(memoryJson.includes('KEY_SECRET'), false)
    assert.equal(memoryJson.includes('VALUE_SECRET'), false)

    const itemList = await context.app.inject({
      method: 'GET',
      url: `/api/bots/${botId}/memories/user-1/items?limit=20&offset=0`,
      headers: { cookie },
    })
    assert.equal(itemList.statusCode, 200)
    assert.equal(itemList.json().total, 2)
    assert.equal(itemList.json().items[0].mem_key, undefined)
    assert.equal(itemList.json().items[0].value, undefined)
    assert.equal(JSON.stringify(itemList.json()).includes('KEY_SECRET'), false)
    const itemDelete = await context.app.inject({
      method: 'DELETE',
      url: `/api/bots/${botId}/memories/user-1/items/item-route-1`,
      headers: { cookie, 'x-csrf-token': csrf },
    })
    assert.equal(itemDelete.statusCode, 200)
    assert.deepEqual(itemDelete.json(), { ok: true })
    const itemDeleteMissing = await context.app.inject({
      method: 'DELETE',
      url: `/api/bots/${botId}/memories/user-1/items/item-route-1`,
      headers: { cookie, 'x-csrf-token': csrf },
    })
    assert.equal(itemDeleteMissing.statusCode, 404)
    const itemDeleteNoCsrf = await context.app.inject({
      method: 'DELETE',
      url: `/api/bots/${botId}/memories/user-1/items/item-route-2`,
      headers: { cookie },
    })
    assert.equal(itemDeleteNoCsrf.statusCode, 403)

    const memoryDelete = await context.app.inject({
      method: 'DELETE',
      url: `/api/bots/${botId}/memories/user-1`,
      headers: { cookie, 'x-csrf-token': csrf },
    })
    assert.equal(memoryDelete.statusCode, 200)
    assert.deepEqual(memoryDelete.json(), { ok: true })
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS c FROM bot_memory_items WHERE bot_id = ? AND user_id = 'user-1'").get(botId) as {
        c: number
      }).c,
      0,
    )
    const roleDelete = await context.app.inject({
      method: 'DELETE',
      url: `/api/bots/${botId}/roles/user-1`,
      headers: { cookie, 'x-csrf-token': csrf },
    })
    assert.equal(roleDelete.statusCode, 200)
    assert.deepEqual(roleDelete.json(), { ok: true })
    assert.equal(roles.get(botId, 'user-1'), null)

    // 管理路由仍需登录。
    const anonymous = await context.app.inject({ method: 'GET', url: `/api/bots/${botId}/events` })
    assert.equal(anonymous.statusCode, 401)

    // 投递重试与取消发布路由保持可用。
    const retry = await context.app.inject({
      method: 'POST',
      url: `/api/bots/${botId}/deliveries/missing/retry`,
      headers: { cookie, 'x-csrf-token': csrf },
    })
    assert.equal(retry.statusCode, 404)
  } finally {
    context.bots.stop()
    await context.app.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
