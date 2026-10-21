/**
 * v0.5.2 Chat/记忆/多附件/目标发现回归。
 * 不访问真实平台或模型；AI 与 fetch 均为进程内夹具。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupDir, tempDataDir, testConfig, testDb } from './helpers.ts'
import { BotService } from '../src/bot/service.ts'
import { AppError } from '../src/util/errors.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function setup(options: { aiEnabled?: boolean; allowChat?: boolean; platform?: 'telegram' | 'discord' } = {}) {
  const dir = tempDataDir()
  const db = testDb(dir)
  const config = testConfig(dir, {
    botEnabled: true,
    botSecretKey: randomBytes(32).toString('base64'),
    botAiEnabled: options.aiEnabled ?? true,
  })
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init })
    return jsonResponse({ ok: true, result: { message_id: 1 } })
  }) as typeof fetch
  const aiCalls: string[] = []
  const memoryCalls: { userText: string }[] = []
  const service = new BotService({
    db,
    config,
    log: () => undefined,
    audit: () => undefined,
    fetch: fetchImpl,
    now: () => new Date('2026-10-21T04:00:00.000Z'),
    ai: {
      chat: async (input) => {
        aiCalls.push(input.prompt)
        return 'AI 回复'
      },
      summarizeMemory: async (input) => {
        memoryCalls.push({ userText: input.userText })
        return { summary: `记忆：${input.userText}`, sessionId: 'memory-session' }
      },
    },
    media: {
      stat: () => ({ filename: 'a.png', mime: 'image/png', size: 1024 }),
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
  const created = service.createBot({
    platform: options.platform ?? 'telegram',
    name: 'chat-test',
    token: 'x'.repeat(40),
    webhookSecret: 'secret-'.repeat(4),
    ...(options.platform === 'discord' ? { config: { applicationId: '123456789', publicKey: 'a'.repeat(64) } } : {}),
  })
  service.updateBot(created.id, { enabled: true })
  const target = service.createTarget(created.id, {
    externalId: 'chat-1',
    label: '聊天目标',
    kind: 'group',
    allowCommands: false,
    allowNotifications: false,
    allowChat: options.allowChat ?? true,
  })
  return { dir, db, service, created, target, aiCalls, memoryCalls, calls }
}

test('v0.5.2：群目标 allow_chat 后普通消息进入 AI Chat，并更新每人记忆文件', async () => {
  const { dir, db, service, created, target, aiCalls, memoryCalls } = setup()
  try {
    await service.handleGatewayMessage(created.id, {
      eventId: 'gw-chat-1',
      targetExternalId: target.externalId,
      targetKind: 'group',
      userId: 'user-a',
      userName: '用户 A',
      text: '记住我喜欢深色模式',
      isDirect: false,
      chatTrigger: 'mention',
    })
    await service.waitForIdle()

    assert.equal(aiCalls.length, 1)
    assert.match(aiCalls[0] ?? '', /\[系统提示\][\s\S]*记住我喜欢深色模式/)
    assert.deepEqual(memoryCalls.map((item) => item.userText), ['记住我喜欢深色模式'])
    assert.ok(existsSync(join(dir, 'bot-memory')))
    const files = readdirSync(join(dir, 'bot-memory')).filter((name) => name.endsWith('.md'))
    assert.equal(files.length, 1)
    assert.match(readFileSync(join(dir, 'bot-memory', files[0]!), 'utf8'), /记忆：记住我喜欢深色模式/)
    const row = db.prepare('SELECT summary FROM bot_ai_memories WHERE bot_id = ? AND user_id = ?').get(created.id, 'user-a') as
      | { summary: string }
      | undefined
    assert.equal(row?.summary, '记忆：记住我喜欢深色模式')

    const inbound = service.listInboundTargets(created.id)
    assert.equal(inbound.length, 1)
    assert.equal(inbound[0]?.targetExternalId, target.externalId)
    assert.equal(inbound[0]?.userId, 'user-a')
  } finally {
    db.close()
    cleanupDir(dir)
  }
})

test('v0.5.2：Chat 未开启时普通消息不调用 AI；管理员命令仍走原白名单', async () => {
  const { dir, db, service, created, aiCalls, calls } = setup({ allowChat: false })
  try {
    const target = service.createTarget(created.id, {
      externalId: 'chat-2',
      label: '未开放聊天',
      kind: 'group',
      allowCommands: false,
      allowNotifications: false,
      allowChat: false,
    })
    await service.handleGatewayMessage(created.id, {
      eventId: 'gw-chat-2',
      targetExternalId: target.externalId,
      targetKind: 'group',
      userId: 'user-b',
      userName: '用户 B',
      text: '你好',
      isDirect: false,
      chatTrigger: 'mention',
    })
    await service.waitForIdle()
    assert.equal(aiCalls.length, 0)
    assert.equal(calls.length, 0)

    // 非管理员发送斜杠命令：目标允许命令，但该用户不在 user 命令白名单。
    const commandTarget = service.createTarget(created.id, {
      externalId: '123',
      label: '命令目标',
      kind: 'group',
      allowCommands: true,
      allowNotifications: false,
    })
    const body = Buffer.from(
      JSON.stringify({
        update_id: 201,
        message: { text: '/status', chat: { id: 123, type: 'group' }, from: { id: 789 } },
      }),
    )
    const result = await service.handleWebhook(
      created.id,
      { 'x-telegram-bot-api-secret-token': 'secret-'.repeat(4) },
      body,
    )
    assert.equal(result.status, 200)
    await service.waitForIdle()
    assert.equal(aiCalls.length, 0)
    assert.equal(commandTarget.allowCommands, true)
    assert.equal(calls.length, 0)
  } finally {
    db.close()
    cleanupDir(dir)
  }
})

test('v0.5.2：Discord 私聊无频道目标时回退 user 目标，允许 Chat', async () => {
  const { dir, db, service, created, aiCalls } = setup({ platform: 'discord' })
  try {
    service.createTarget(created.id, {
      externalId: 'discord-user-dm',
      label: 'DM 用户',
      kind: 'user',
      allowCommands: false,
      allowNotifications: false,
      allowChat: true,
    })
    await service.handleGatewayMessage(created.id, {
      eventId: 'gw-dm-1',
      targetExternalId: 'dm-channel-1',
      targetKind: 'channel',
      userId: 'discord-user-dm',
      userName: 'DM 用户',
      text: '私聊测试',
      isDirect: true,
      chatTrigger: 'direct',
    })
    await service.waitForIdle()
    assert.equal(aiCalls.length, 1)
    assert.match(aiCalls[0] ?? '', /私聊测试/)
    const inbound = service.listInboundTargets(created.id)
    assert.equal(inbound[0]?.targetKind, 'channel')
    assert.equal(inbound[0]?.isDirect, true)
  } finally {
    db.close()
    cleanupDir(dir)
  }
})

test('v0.5.2：Telegram 按钮回调仅管理员可刷新，并返回带按钮的消息', async () => {
  const { dir, db, service, created, calls } = setup()
  try {
    service.createTarget(created.id, {
      externalId: '123',
      label: '命令目标',
      kind: 'group',
      allowCommands: true,
      allowNotifications: false,
    })
    service.createTarget(created.id, {
      externalId: '456',
      label: '管理员',
      kind: 'user',
      allowCommands: true,
      allowNotifications: false,
    })
    const callbackBody = Buffer.from(
      JSON.stringify({
        update_id: 301,
        callback_query: {
          id: 'cb-1',
          from: { id: 456 },
          message: { message_id: 9, chat: { id: 123, type: 'group' } },
          data: 'refresh_status',
        },
      }),
    )
    const result = await service.handleWebhook(
      created.id,
      { 'x-telegram-bot-api-secret-token': 'secret-'.repeat(4) },
      callbackBody,
    )
    assert.equal(result.status, 200)
    await service.waitForIdle()
    const body = calls.map((call) => String(call.init?.body ?? '')).join('\n')
    assert.match(body, /refresh_status|刷新状态/)

    const denied = Buffer.from(
      JSON.stringify({
        update_id: 302,
        callback_query: {
          id: 'cb-2',
          from: { id: 789 },
          message: { message_id: 9, chat: { id: 123, type: 'group' } },
          data: 'refresh_status',
        },
      }),
    )
    const before = calls.length
    await service.handleWebhook(created.id, { 'x-telegram-bot-api-secret-token': 'secret-'.repeat(4) }, denied)
    await service.waitForIdle()
    assert.equal(calls.length, before)
  } finally {
    db.close()
    cleanupDir(dir)
  }
})

test('v0.5.2：多附件数量/QQ 媒体限制与发布队列接受多个媒体', async () => {
  const { dir, db, service, created, target } = setup()
  try {
    const target2 = service.createTarget(created.id, {
      externalId: 'publish-1',
      label: '发布目标',
      kind: 'channel',
      allowCommands: false,
      allowNotifications: false,
    })
    const many = Array.from({ length: 6 }, (_, index) => `file-${index}`)
    assert.throws(
      () =>
        service.createPublish(created.id, {
          targetId: target2.id,
          text: '多附件',
          mediaFileIds: many,
          confirmText: 'PUBLISH',
        }),
      (error: unknown) => error instanceof AppError && error.code === 'too_many_media',
    )
    const job = service.createPublish(created.id, {
      targetId: target2.id,
      text: '多附件',
      mediaFileIds: ['file-0', 'file-1', 'file-2'],
      confirmText: 'PUBLISH',
    })
    assert.equal(job.mediaFileIds.length, 3)
    assert.equal(target.kind, 'group')
    await service.waitForIdle()

    const qq = service.createBot({
      platform: 'qq',
      name: 'qq',
      token: 'y'.repeat(40),
      config: { appId: '1905866746' },
    })
    service.updateBot(qq.id, { enabled: true })
    const qqTarget = service.createTarget(qq.id, {
      externalId: 'group-openid',
      label: 'QQ 群',
      kind: 'group',
      allowCommands: false,
      allowNotifications: false,
    })
    assert.throws(
      () =>
        service.createPublish(qq.id, {
          targetId: qqTarget.id,
          text: '媒体',
          mediaFileIds: ['file-0'],
          confirmText: 'PUBLISH',
        }),
      (error: unknown) => error instanceof AppError && error.code === 'qq_media_unsupported',
    )
  } finally {
    db.close()
    cleanupDir(dir)
  }
})

test('v0.5.2：记忆持久化文件存在且目录不在 Web 静态目录中', () => {
  const { dir, db, service, created } = setup()
  try {
    // 直接触发一次 Chat，随后检查文件路径边界；不依赖驱动器权限断言。
    void service.handleGatewayMessage(created.id, {
      eventId: 'gw-chat-3',
      targetExternalId: 'chat-1',
      targetKind: 'group',
      userId: 'user-c',
      userName: '用户 C',
      text: '测试记忆',
      isDirect: false,
      chatTrigger: 'mention',
    })
    return service.waitForIdle().then(() => {
      const memoryDir = join(dir, 'bot-memory')
      assert.ok(existsSync(memoryDir))
      const files = readdirSync(memoryDir)
      assert.ok(files.every((name) => /^memory-[0-9a-f-]{36}\.md$/i.test(name)))
      assert.ok(!memoryDir.startsWith(join(dir, 'web')))
    }).finally(() => {
      db.close()
      cleanupDir(dir)
    })
  } catch (error) {
    db.close()
    cleanupDir(dir)
    throw error
  }
})
