/**
 * Bot 管理路由安全回归：发布必须 TOTP 再认证（BOT-02），缺失验证码不得外发；
 * v0.5.7 新增检查连接/事件/角色/记忆路由与目标触发方式透传（鉴权/CSRF 规则照旧）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { buildApp } from '../src/app.ts'
import { hotp, currentStep } from '../src/auth/totp.ts'
import { BotChatRoleStore } from '../src/bot/roles.ts'
import { BotMemoryStore } from '../src/bot/memory.ts'
import { cookieHeader, currentCode, parseSetCookies, seedAdmin, tempDataDir, testConfig, testDb } from './helpers.ts'

test('Bot 发布路由：无 TOTP 400，带有效 TOTP 才创建外发任务', async () => {
  const dir = tempDataDir()
  const config = testConfig(dir, { botEnabled: true, botSecretKey: randomBytes(32).toString('base64') })
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const context = await buildApp(config, db)
  try {
    const login = await context.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { username: seeded.username, password: seeded.password },
    })
    assert.equal(login.statusCode, 200, '密码步骤应成功')
    const challenge = login.json().challenge as string
    const totpLogin = await context.app.inject({
      method: 'POST',
      url: '/api/auth/totp',
      payload: { challenge, code: currentCode(seeded.secret) },
    })
    assert.equal(totpLogin.statusCode, 200, 'TOTP 步骤应成功')
    const cookies = parseSetCookies(totpLogin.headers['set-cookie'] as string[] | undefined)
    const cookie = cookieHeader(cookies)
    const csrf = cookies.af_csrf ?? ''

    const bot = context.bots.createBot({
      platform: 'telegram',
      name: 'route',
      token: 'x'.repeat(40),
      webhookSecret: 'secret-'.repeat(4),
    })
    context.bots.updateBot(bot.id, { enabled: true })
    const target = context.bots.createTarget(bot.id, {
      externalId: '123',
      label: 'chat',
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
  } finally {
    await context.bots.waitForIdle()
    context.bots.stop()
    await context.bots.waitForIdle()
    await context.app.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

async function loginAdmin(app: import('fastify').FastifyInstance, seeded: { username: string; password: string; secret: string }): Promise<{ cookie: string; csrf: string }> {
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

test('v0.5.7 Bot 管理路由：检查连接/事件/角色/记忆/目标触发方式', async () => {
  const dir = tempDataDir()
  const config = testConfig(dir, { botEnabled: true, botSecretKey: randomBytes(32).toString('base64'), botAiEnabled: true })
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const context = await buildApp(config, db)
  try {
    const { cookie, csrf } = await loginAdmin(context.app, seeded)
    const bot = context.bots.createBot({
      platform: 'telegram',
      name: 'route-v057',
      token: 'x'.repeat(40),
      webhookSecret: 'secret-'.repeat(4),
    })
    context.bots.updateBot(bot.id, { enabled: true })

    // 目标创建/更新透传 chatTrigger；非法值 400。
    const created = await context.app.inject({
      method: 'POST',
      url: `/api/bots/${bot.id}/targets`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { externalId: 'target-1', label: '群', kind: 'group', allowChat: true, chatTrigger: 'all' },
    })
    assert.equal(created.statusCode, 200)
    assert.equal(created.json().target.chatTrigger, 'all')
    const targetId = created.json().target.id as string
    const invalid = await context.app.inject({
      method: 'POST',
      url: `/api/bots/${bot.id}/targets`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { externalId: 'target-bad', label: '群', kind: 'group', chatTrigger: 'sometimes' },
    })
    assert.equal(invalid.statusCode, 400)
    const patched = await context.app.inject({
      method: 'PATCH',
      url: `/api/bots/${bot.id}/targets/${targetId}`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { chatTrigger: 'mention' },
    })
    assert.equal(patched.statusCode, 200)
    assert.equal(patched.json().target.chatTrigger, 'mention')
    const listed = await context.app.inject({ method: 'GET', url: `/api/bots/${bot.id}/targets`, headers: { cookie } })
    assert.equal(listed.json().items[0].chatTrigger, 'mention')

    // QQ 目标不允许 all。
    const qq = context.bots.createBot({ platform: 'qq', name: 'qq-route', token: 'q'.repeat(40), config: { appId: '1905866746' } })
    const qqTarget = await context.app.inject({
      method: 'POST',
      url: `/api/bots/${qq.id}/targets`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { externalId: 'qq-group', label: 'QQ 群', kind: 'group', chatTrigger: 'all' },
    })
    assert.equal(qqTarget.statusCode, 400)
    assert.equal(qqTarget.json().error.code, 'chat_trigger_unsupported')

    // 检查连接：伪造适配器 check，路由返回 { health }。
    const patch = context.bots as unknown as {
      adapterFor: (row: unknown) => unknown
      deps: { ai?: { chat: (input: unknown) => Promise<string> } }
    }
    patch.adapterFor = () => ({
      platform: 'telegram',
      check: async () => ({ ok: true, items: [{ name: 'Bot 账号', ok: true, detail: '@route_bot' }] }),
      send: async () => ({ externalId: 'route-sent' }),
    })
    if (patch.deps.ai) patch.deps.ai.chat = async () => 'AI 回复'
    const check = await context.app.inject({
      method: 'POST',
      url: `/api/bots/${bot.id}/check`,
      headers: { cookie, 'x-csrf-token': csrf },
    })
    assert.equal(check.statusCode, 200)
    assert.equal(check.json().health.ok, true)
    assert.equal(check.json().health.items[0].detail, '@route_bot')
    assert.ok(check.json().health.checkedAt)
    const checkNoCsrf = await context.app.inject({
      method: 'POST',
      url: `/api/bots/${bot.id}/check`,
      headers: { cookie },
    })
    assert.equal(checkNoCsrf.statusCode, 403)

    // 事件列表：gateway 聊天产生 ok 事件，筛选/分页参数按契约返回。
    await context.bots.handleGatewayMessage(bot.id, {
      eventId: 'route-event-1',
      targetExternalId: 'target-1',
      targetKind: 'group',
      userId: 'user-1',
      userName: '用户',
      text: '你好',
      isDirect: false,
      chatTrigger: 'mention',
      messageId: 'msg-1',
    })
    await context.bots.waitForIdle()
    const events = await context.app.inject({
      method: 'GET',
      url: `/api/bots/${bot.id}/events?hours=24&limit=10&offset=0&outcome=ok`,
      headers: { cookie },
    })
    assert.equal(events.statusCode, 200)
    assert.equal(events.json().total, 1)
    assert.equal(events.json().items[0].eventId, 'route-event-1')
    assert.equal(events.json().items[0].outcome, 'ok')
    const badOutcome = await context.app.inject({
      method: 'GET',
      url: `/api/bots/${bot.id}/events?outcome=bogus`,
      headers: { cookie },
    })
    assert.equal(badOutcome.statusCode, 400)

    // 角色管理：列表只含元数据，启停/删除返回 { ok: true }。
    const roles = new BotChatRoleStore(db)
    roles.save(bot.id, 'user-1', '猫娘', '这条角色设定正文不应出现在 API。')
    const roleList = await context.app.inject({ method: 'GET', url: `/api/bots/${bot.id}/roles?limit=20&offset=0`, headers: { cookie } })
    assert.equal(roleList.statusCode, 200)
    assert.equal(roleList.json().total, 1)
    assert.equal(roleList.json().items[0].promptLength, '这条角色设定正文不应出现在 API。'.length)
    assert.equal(JSON.stringify(roleList.json()).includes('角色设定正文'), false)
    const rolePatch = await context.app.inject({
      method: 'PATCH',
      url: `/api/bots/${bot.id}/roles/user-1`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { enabled: false },
    })
    assert.equal(rolePatch.statusCode, 200)
    assert.deepEqual(rolePatch.json(), { ok: true })
    assert.equal(roles.get(bot.id, 'user-1')?.enabled, false)
    const roleBadPatch = await context.app.inject({
      method: 'PATCH',
      url: `/api/bots/${bot.id}/roles/user-1`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { enabled: 'no' },
    })
    assert.equal(roleBadPatch.statusCode, 400)

    // 记忆管理：列表只含长度，删除返回 { ok: true }。
    const memoryStore = new BotMemoryStore(db, dir, config.botAiMemoryMaxChars)
    const memory = memoryStore.get(bot.id, 'user-1')
    memoryStore.save(bot.id, 'user-1', memory.memoryId, '这条记忆正文不应出现在 API。', null)
    const memoryList = await context.app.inject({ method: 'GET', url: `/api/bots/${bot.id}/memories`, headers: { cookie } })
    assert.equal(memoryList.statusCode, 200)
    assert.equal(memoryList.json().total, 1)
    assert.equal(memoryList.json().items[0].summaryLength, '这条记忆正文不应出现在 API。'.length)
    assert.equal(JSON.stringify(memoryList.json()).includes('记忆正文'), false)
    const memoryDelete = await context.app.inject({
      method: 'DELETE',
      url: `/api/bots/${bot.id}/memories/user-1`,
      headers: { cookie, 'x-csrf-token': csrf },
    })
    assert.equal(memoryDelete.statusCode, 200)
    assert.deepEqual(memoryDelete.json(), { ok: true })
    assert.equal(memoryStore.count(bot.id), 0)
    const roleDelete = await context.app.inject({
      method: 'DELETE',
      url: `/api/bots/${bot.id}/roles/user-1`,
      headers: { cookie, 'x-csrf-token': csrf },
    })
    assert.equal(roleDelete.statusCode, 200)
    assert.deepEqual(roleDelete.json(), { ok: true })
    assert.equal(roles.get(bot.id, 'user-1'), null)

    // 管理路由仍需登录。
    const anonymous = await context.app.inject({ method: 'GET', url: `/api/bots/${bot.id}/events` })
    assert.equal(anonymous.statusCode, 401)
  } finally {
    await context.bots.waitForIdle()
    context.bots.stop()
    await context.bots.waitForIdle()
    await context.app.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
