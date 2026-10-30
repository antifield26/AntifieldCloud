/**
 * Chatbot 管理路由安全回归（QQ 单平台）：发布必须 TOTP 再认证（CHATBOT-02），缺失验证码不得外发；
 * 检查连接/事件/角色/记忆路由与目标 CRUD（鉴权/CSRF 规则照旧）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.ts'
import { hotp, currentStep } from '../src/auth/totp.ts'
import { ChatbotChatRoleStore } from '../src/chatbot/roles.ts'
import { cookieHeader, currentCode, parseSetCookies, seedAdmin, tempDataDir, testConfig, testDb } from './helpers.ts'
import { signQqEvent, makeQqServiceFetch } from './chatbot-qq-fixtures.ts'

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

test('Chatbot 发布路由：无 TOTP 400，带有效 TOTP 才创建外发任务', async () => {
  const dir = tempDataDir()
  const config = testConfig(dir, { chatbotEnabled: true, chatbotSecretKey: randomBytes(32).toString('base64') })
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const context = await buildApp(config, db)
  try {
    const { cookie, csrf } = await loginAdmin(context.app, seeded)
    const chatbot = context.chatbots.createBot({
      platform: 'qq',
      name: 'route',
      token: APP_SECRET,
      config: { appId: APP_ID },
    })
    context.chatbots.updateBot(chatbot.id, { enabled: true })
    const target = context.chatbots.createTarget(chatbot.id, {
      externalId: 'group-openid-1',
      label: 'QQ 群',
      kind: 'group',
      allowCommands: false,
      allowNotifications: true,
    })

    const missing = await context.app.inject({
      method: 'POST',
      url: `/api/chatbots/${chatbot.id}/publish`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { targetId: target.id, text: '不应外发' },
    })
    assert.equal(missing.statusCode, 400)
    assert.equal(missing.json().error.code, 'totp_required')

    // 登录已消费当前 TOTP step，使用下一步窗口的验证码。
    const nextCode = hotp(seeded.secret, currentStep() + 1)
    const created = await context.app.inject({
      method: 'POST',
      url: `/api/chatbots/${chatbot.id}/publish`,
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

    // v0.6.0：service 层 >2000 明确 400（路由不得先静默截断，端到端用例见下一测试）。
    assert.throws(
      () => context.chatbots.createPublish(chatbot.id, { targetId: target.id, text: '字'.repeat(2001), confirmText: 'PUBLISH' }),
      (error: unknown) =>
        error instanceof Error && 'code' in error && (error as { code: string }).code === 'publish_text_too_long',
    )
    const exact = context.chatbots.createPublish(chatbot.id, {
      targetId: target.id,
      text: '字'.repeat(2000),
      confirmText: 'PUBLISH',
      // 定时到未来，避免测试 tick 真的尝试出站发送。
      scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
    })
    assert.equal(exact.text.length, 2000, '恰好 2000 字符仍可入队')
    await context.chatbots.waitForIdle()
  } finally {
    context.chatbots.stop()
    await context.app.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Chatbot 发布路由：>2000 字符返回 400 publish_text_too_long，不得静默截断外发', async () => {
  const dir = tempDataDir()
  const config = testConfig(dir, { chatbotEnabled: true, chatbotSecretKey: randomBytes(32).toString('base64') })
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const context = await buildApp(config, db)
  try {
    const { cookie, csrf } = await loginAdmin(context.app, seeded)
    const chatbot = context.chatbots.createBot({
      platform: 'qq',
      name: 'publish-length',
      token: APP_SECRET,
      config: { appId: APP_ID },
    })
    context.chatbots.updateBot(chatbot.id, { enabled: true })
    const target = context.chatbots.createTarget(chatbot.id, {
      externalId: 'group-openid-1',
      label: 'QQ 群',
      kind: 'group',
      allowCommands: false,
      allowNotifications: true,
    })
    const totpCode = hotp(seeded.secret, currentStep() + 1)
    const tooLong = await context.app.inject({
      method: 'POST',
      url: `/api/chatbots/${chatbot.id}/publish`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        targetId: target.id,
        text: '字'.repeat(2001),
        totpCode,
        confirmText: 'PUBLISH',
      },
    })
    assert.equal(tooLong.statusCode, 400)
    assert.equal(tooLong.json().error.code, 'publish_text_too_long')
    assert.equal(context.chatbots.listPublishJobs(chatbot.id).length, 0, '超长发布不得创建任务')
  } finally {
    context.chatbots.stop()
    await context.app.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v0.5.8 Chatbot 管理路由：QQ Chatbot CRUD、目标、检查连接、事件、角色与记忆', async () => {
  const dir = tempDataDir()
  const config = testConfig(dir, {
    chatbotEnabled: true,
    chatbotSecretKey: randomBytes(32).toString('base64'),
    chatbotAiEnabled: true,
  })
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const context = await buildApp(config, db)
  try {
    const { cookie, csrf } = await loginAdmin(context.app, seeded)

    // 只允许 QQ 平台。
    const legacy = await context.app.inject({
      method: 'POST',
      url: '/api/chatbots',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { platform: 'telegram', name: 'legacy', token: 'x'.repeat(40) },
    })
    assert.equal(legacy.statusCode, 400)
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/chatbots',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { platform: 'qq', name: 'QQ', token: APP_SECRET, config: { appId: APP_ID } },
    })
    assert.equal(created.statusCode, 200)
    const chatbotId = created.json().chatbot.id as string
    assert.equal(created.json().chatbot.platform, 'qq')
    assert.equal('gateway' in created.json().chatbot, false, 'ChatbotSummary 不应再有 gateway 字段')
    context.chatbots.updateBot(chatbotId, { enabled: true })

    // 目标 CRUD：返回不含 chatTrigger；QQ 群/频道只支持 @Chatbot。
    const target = await context.app.inject({
      method: 'POST',
      url: `/api/chatbots/${chatbotId}/targets`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        externalId: 'group-openid-1',
        label: 'QQ 群',
        kind: 'group',
        allowChat: true,
        allowCommands: true,
        allowNotifications: true,
        groupReplyMode: 'all',
      },
    })
    assert.equal(target.statusCode, 200)
    assert.equal('chatTrigger' in target.json().target, false)
    assert.equal(target.json().target.groupReplyMode, 'all')
    const targetId = target.json().target.id as string
    const patched = await context.app.inject({
      method: 'PATCH',
      url: `/api/chatbots/${chatbotId}/targets/${targetId}`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { label: '新群名' },
    })
    assert.equal(patched.statusCode, 200)
    assert.equal(patched.json().target.label, '新群名')
    assert.equal(patched.json().target.groupReplyMode, 'all')
    const listed = await context.app.inject({ method: 'GET', url: `/api/chatbots/${chatbotId}/targets`, headers: { cookie } })
    assert.equal(listed.json().items.length, 1)

    // 检查连接：伪造适配器 check，路由返回 { health }，CSRF 必需。
    const internals = context.chatbots as unknown as {
      adapterFor: (row: unknown) => unknown
      deps: {
        ai?: { chat: (input: unknown) => Promise<string>; toolIsolation?: () => unknown }
        fetch?: typeof fetch
      }
    }
    const originalAdapterFor = internals.adapterFor
    internals.adapterFor = () => ({
      platform: 'qq',
      check: async () => ({ ok: true, items: [{ name: 'access_token', ok: true, detail: 'access_token 已获取' }] }),
      send: async () => ({ externalId: 'route-sent' }),
    })
    if (internals.deps.ai) {
      internals.deps.ai.chat = async () => 'AI 回复'
      // v0.6.0：/api/chatbots/status 暴露 AI 工具隔离状态（OpenCode 400 降级可见）。
      internals.deps.ai.toolIsolation = () => ({
        supported: true,
        fallbackCount: 0,
        fallbackAt: null,
        retryAt: null,
      })
    }
    const check = await context.app.inject({
      method: 'POST',
      url: `/api/chatbots/${chatbotId}/check`,
      headers: { cookie, 'x-csrf-token': csrf },
    })
    assert.equal(check.statusCode, 200)
    assert.equal(check.json().health.ok, true)
    assert.equal(check.json().health.items[0].detail, 'access_token 已获取')
    assert.ok(check.json().health.checkedAt)
    const checkNoCsrf = await context.app.inject({
      method: 'POST',
      url: `/api/chatbots/${chatbotId}/check`,
      headers: { cookie },
    })
    assert.equal(checkNoCsrf.statusCode, 403)

    // 恢复真实适配器并注入进程内 fetch，避免 Webhook/回复访问真实 QQ 网络。
    internals.adapterFor = originalAdapterFor
    internals.deps.fetch = makeQqServiceFetch().fetchImpl

    // /api/chatbots/status 暴露工具隔离状态（未配置 AI 时为 null，配置 AI 时取 ai.toolIsolation()）。
    const status = await context.app.inject({ method: 'GET', url: '/api/chatbots/status', headers: { cookie } })
    assert.equal(status.statusCode, 200)
    assert.deepEqual(status.json().aiToolIsolation, {
      supported: true,
      fallbackCount: 0,
      fallbackAt: null,
      retryAt: null,
    })

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
      url: `/api/chatbot/webhook/${chatbotId}`,
      headers: { 'content-type': 'application/json', ...webhook.headers },
      payload: webhook.body,
    })
    assert.equal(webhookResult.statusCode, 200)
    await context.chatbots.waitForIdle()
    const events = await context.app.inject({
      method: 'GET',
      url: `/api/chatbots/${chatbotId}/events?hours=24&limit=10&offset=0&outcome=ok`,
      headers: { cookie },
    })
    assert.equal(events.statusCode, 200)
    assert.equal(events.json().total, 1)
    assert.equal(events.json().items[0].eventId, 'route-event-1')
    assert.equal(events.json().items[0].outcome, 'ok')
    const badOutcome = await context.app.inject({
      method: 'GET',
      url: `/api/chatbots/${chatbotId}/events?outcome=bogus`,
      headers: { cookie },
    })
    assert.equal(badOutcome.statusCode, 400)

    // 角色管理：列表只含元数据，启停/删除返回 { ok: true }。
    const roles = new ChatbotChatRoleStore(db)
    roles.save(chatbotId, 'user-1', '猫娘', '这条角色设定正文不应出现在 API。')
    const roleList = await context.app.inject({ method: 'GET', url: `/api/chatbots/${chatbotId}/roles?limit=20&offset=0`, headers: { cookie } })
    assert.equal(roleList.statusCode, 200)
    assert.equal(roleList.json().total, 1)
    assert.equal(roleList.json().items[0].promptLength, '这条角色设定正文不应出现在 API。'.length)
    assert.equal(JSON.stringify(roleList.json()).includes('角色设定正文'), false)
    const rolePatch = await context.app.inject({
      method: 'PATCH',
      url: `/api/chatbots/${chatbotId}/roles/user-1`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { enabled: false },
    })
    assert.equal(rolePatch.statusCode, 200)
    assert.deepEqual(rolePatch.json(), { ok: true })
    assert.equal(roles.get(chatbotId, 'user-1')?.enabled, false)
    const roleBadPatch = await context.app.inject({
      method: 'PATCH',
      url: `/api/chatbots/${chatbotId}/roles/user-1`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { enabled: 'no' },
    })
    assert.equal(roleBadPatch.statusCode, 400)

    // v0.6.3 群聊角色卡：列表/编辑/启停/删除；管理员可读写正文。
    const groupRoleList = await context.app.inject({
      method: 'GET',
      url: `/api/chatbots/${chatbotId}/group-roles`,
      headers: { cookie },
    })
    assert.equal(groupRoleList.statusCode, 200)
    const groupRoleItem = (groupRoleList.json().items as Array<Record<string, unknown>>).find(
      (item) => item.targetId === targetId,
    )
    assert.ok(groupRoleItem)
    assert.equal(groupRoleItem.name, null)
    const groupRoleSaved = await context.app.inject({
      method: 'PUT',
      url: `/api/chatbots/${chatbotId}/group-roles/${targetId}`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: '群助手', prompt: '群聊角色设定正文' },
    })
    assert.equal(groupRoleSaved.statusCode, 200)
    assert.equal(groupRoleSaved.json().groupRole.name, '群助手')
    assert.equal(groupRoleSaved.json().groupRole.prompt, '群聊角色设定正文')
    const groupRoleDetail = await context.app.inject({
      method: 'GET',
      url: `/api/chatbots/${chatbotId}/group-roles/${targetId}`,
      headers: { cookie },
    })
    assert.equal(groupRoleDetail.statusCode, 200)
    assert.equal(groupRoleDetail.json().groupRole.prompt, '群聊角色设定正文')
    const groupRoleDisabled = await context.app.inject({
      method: 'PATCH',
      url: `/api/chatbots/${chatbotId}/group-roles/${targetId}`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { enabled: false },
    })
    assert.deepEqual(groupRoleDisabled.json(), { ok: true })
    const groupRoleRemoved = await context.app.inject({
      method: 'DELETE',
      url: `/api/chatbots/${chatbotId}/group-roles/${targetId}`,
      headers: { cookie, 'x-csrf-token': csrf },
    })
    assert.deepEqual(groupRoleRemoved.json(), { ok: true })

    // 记忆管理：用户级/条目元数据与删除返回 { ok: true }，绝不包含 key/value。
    const insertItem = (id: string, kind: string, key: string, value: string): void => {
      db.prepare(
        `INSERT INTO chatbot_memory_items
           (id, chatbot_id, user_id, kind, mem_key, value, confidence, importance, source, created_at, updated_at, last_used_at, expires_at)
         VALUES (?, ?, 'user-1', ?, ?, ?, 0.8, 3, 'chat', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z', NULL, NULL)`,
      ).run(id, chatbotId, kind, key, value)
    }
    insertItem('item-route-1', 'preference', 'KEY_SECRET_1', 'VALUE_SECRET_1')
    insertItem('item-route-2', 'fact', 'KEY_SECRET_2', 'VALUE_SECRET_2')
    const memoryList = await context.app.inject({ method: 'GET', url: `/api/chatbots/${chatbotId}/memories`, headers: { cookie } })
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
      url: `/api/chatbots/${chatbotId}/memories/user-1/items?limit=20&offset=0`,
      headers: { cookie },
    })
    assert.equal(itemList.statusCode, 200)
    assert.equal(itemList.json().total, 2)
    assert.equal(itemList.json().items[0].mem_key, undefined)
    assert.equal(itemList.json().items[0].value, undefined)
    assert.equal(JSON.stringify(itemList.json()).includes('KEY_SECRET'), false)
    const itemDelete = await context.app.inject({
      method: 'DELETE',
      url: `/api/chatbots/${chatbotId}/memories/user-1/items/item-route-1`,
      headers: { cookie, 'x-csrf-token': csrf },
    })
    assert.equal(itemDelete.statusCode, 200)
    assert.deepEqual(itemDelete.json(), { ok: true })
    const itemDeleteMissing = await context.app.inject({
      method: 'DELETE',
      url: `/api/chatbots/${chatbotId}/memories/user-1/items/item-route-1`,
      headers: { cookie, 'x-csrf-token': csrf },
    })
    assert.equal(itemDeleteMissing.statusCode, 404)
    const itemDeleteNoCsrf = await context.app.inject({
      method: 'DELETE',
      url: `/api/chatbots/${chatbotId}/memories/user-1/items/item-route-2`,
      headers: { cookie },
    })
    assert.equal(itemDeleteNoCsrf.statusCode, 403)

    const memoryDelete = await context.app.inject({
      method: 'DELETE',
      url: `/api/chatbots/${chatbotId}/memories/user-1`,
      headers: { cookie, 'x-csrf-token': csrf },
    })
    assert.equal(memoryDelete.statusCode, 200)
    assert.deepEqual(memoryDelete.json(), { ok: true })
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS c FROM chatbot_memory_items WHERE chatbot_id = ? AND user_id = 'user-1'").get(chatbotId) as {
        c: number
      }).c,
      0,
    )
    const roleDelete = await context.app.inject({
      method: 'DELETE',
      url: `/api/chatbots/${chatbotId}/roles/user-1`,
      headers: { cookie, 'x-csrf-token': csrf },
    })
    assert.equal(roleDelete.statusCode, 200)
    assert.deepEqual(roleDelete.json(), { ok: true })
    assert.equal(roles.get(chatbotId, 'user-1'), null)

    // 管理路由仍需登录。
    const anonymous = await context.app.inject({ method: 'GET', url: `/api/chatbots/${chatbotId}/events` })
    assert.equal(anonymous.statusCode, 401)

    // 投递重试与取消发布路由保持可用。
    const retry = await context.app.inject({
      method: 'POST',
      url: `/api/chatbots/${chatbotId}/deliveries/missing/retry`,
      headers: { cookie, 'x-csrf-token': csrf },
    })
    assert.equal(retry.statusCode, 404)
  } finally {
    context.chatbots.stop()
    await context.app.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('出站健康路由：status 暴露快照，retry-failed 批量重排且排除部分发送', async () => {
  const dir = tempDataDir()
  const config = testConfig(dir, { chatbotEnabled: true, chatbotSecretKey: randomBytes(32).toString('base64') })
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const context = await buildApp(config, db)
  try {
    const { cookie, csrf } = await loginAdmin(context.app, seeded)
    const chatbot = context.chatbots.createBot({
      platform: 'qq',
      name: 'outbound-health',
      token: APP_SECRET,
      config: { appId: APP_ID },
    })
    context.chatbots.updateBot(chatbot.id, { enabled: true })
    const now = new Date().toISOString()
    const insert = (id: string, status: string, lastError: string | null): void => {
      db.prepare(
        `INSERT INTO chatbot_deliveries
         (id, chatbot_id, target_id, kind, payload_json, status, attempts, last_error, created_at, updated_at)
         VALUES (?, ?, NULL, 'notification', '{}', ?, 1, ?, ?, ?)`,
      ).run(id, chatbot.id, status, lastError, now, now)
    }
    insert('failed-1', 'failed', 'network_timeout')
    insert('dead-1', 'dead', 'qq_access_token_failed')
    insert('partial-1', 'failed', 'partial_text_sent: 第一段已发送')

    const statusResponse = await context.app.inject({
      method: 'GET',
      url: '/api/chatbots/status',
      headers: { cookie },
    })
    assert.equal(statusResponse.statusCode, 200)
    const outbound = statusResponse.json().outbound as {
      active: boolean
      degraded: boolean | null
      recentFailures: number
      failedDeliveries: number
      deadDeliveries: number
    }
    assert.equal(outbound.active, true)
    assert.equal(outbound.degraded, true)
    assert.equal(outbound.recentFailures, 3)
    assert.equal(outbound.failedDeliveries, 2)
    assert.equal(outbound.deadDeliveries, 1)

    const withoutCsrf = await context.app.inject({
      method: 'POST',
      url: `/api/chatbots/${chatbot.id}/deliveries/retry-failed`,
      headers: { cookie },
    })
    assert.equal(withoutCsrf.statusCode, 403)

    const retried = await context.app.inject({
      method: 'POST',
      url: `/api/chatbots/${chatbot.id}/deliveries/retry-failed`,
      headers: { cookie, 'x-csrf-token': csrf },
    })
    assert.equal(retried.statusCode, 200)
    assert.equal(retried.json().retried, 2, 'partial_text_sent 不得批量重试')
    const partial = db.prepare("SELECT status FROM chatbot_deliveries WHERE id = 'partial-1'").get() as unknown as {
      status: string
    }
    assert.equal(partial.status, 'failed')
  } finally {
    context.chatbots.stop()
    await context.app.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
