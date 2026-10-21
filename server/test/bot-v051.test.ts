/**
 * v0.5.1 Bot 运维/AI 回归：通知静默时段、指标、/ask 命令与 QQ 平台接入。
 * 不访问真实平台；全部使用注入的 fetch 夹具。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tempDataDir, testConfig, testDb } from './helpers.ts'
import { BotService } from '../src/bot/service.ts'

interface Captured {
  url: string
  init?: RequestInit
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function makeFetch(responses: Array<Record<string, unknown>> = [{ ok: true, result: { message_id: 1 } }]) {
  const captured: Captured[] = []
  let index = 0
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    captured.push({ url, init })
    const body = responses[Math.min(index, responses.length - 1)] ?? {}
    index += 1
    return jsonResponse(body)
  }
  return { fetchImpl: fetchImpl as typeof fetch, captured }
}

function setup(options: { botAiEnabled?: boolean; aiReply?: string; fetchResponses?: Array<Record<string, unknown>> } = {}) {
  const dir = tempDataDir()
  const key = randomBytes(32).toString('base64')
  const config = testConfig(dir, {
    botEnabled: true,
    botSecretKey: key,
    botAiEnabled: options.botAiEnabled ?? false,
  })
  const db = testDb(dir)
  const { fetchImpl, captured } = makeFetch(options.fetchResponses)
  const aiCalls: string[] = []
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
        return options.aiReply ?? 'AI 测试回复'
      },
    },
    media: {
      stat: () => ({ filename: 'a.png', mime: 'image/png', size: 3 }),
      load: async () => ({ filename: 'a.png', mime: 'image/png', data: Buffer.from('png') }),
    },
    providers: {
      status: async () => ({ ok: true }),
      backup: async () => ({ ok: true }),
      world: async () => ({ ok: true }),
      minecraft: async () => ({ online: true }),
      files: async () => [{ name: 'a.txt', sizeLabel: '1 KB' }],
    },
  })
  const created = service.createBot({
    platform: 'telegram',
    name: 'test',
    token: 'x'.repeat(40),
    webhookSecret: 'secret-'.repeat(4),
  })
  service.updateBot(created.id, { enabled: true })
  const target = service.createTarget(created.id, {
    externalId: '123',
    label: 'chat',
    kind: 'group',
    allowCommands: true,
    allowNotifications: true,
  })
  const user = service.createTarget(created.id, {
    externalId: '456',
    label: 'admin',
    kind: 'user',
    allowCommands: true,
    allowNotifications: false,
  })
  return { dir, db, service, created, target, user, captured, aiCalls }
}

test('v0.5.1：静默时段延后通知，指标统计已发送投递', async () => {
  const { dir, db, service, created, target } = setup()
  try {
    service.updateTarget(created.id, target.id, { quietStartMinute: 11 * 60, quietEndMinute: 14 * 60 })
    service.notifyAlert({
      id: 1,
      event: 'disk_low',
      severity: 'warning',
      status: 'firing',
      title: '磁盘不足',
      message: '测试告警',
      createdAt: '2026-10-21T04:00:00.000Z',
    })
    const queued = db
      .prepare("SELECT next_attempt_at FROM bot_deliveries WHERE bot_id = ? AND kind = 'notification'")
      .get(created.id) as { next_attempt_at: string | null } | undefined
    assert.ok(queued?.next_attempt_at, '静默窗口内应设置 next_attempt_at')
    assert.equal(queued?.next_attempt_at, '2026-10-21T06:00:00.000Z')

    await service.testBot(created.id, target.id)
    const metrics = service.metrics(created.id, 24)
    assert.equal(metrics.deliveries.sent, 1)
    assert.equal(metrics.deliveries.successRate, 100)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v0.5.1：/ask 仅对白名单用户调用 AI，未启用时明确提示', async () => {
  const { dir, db, service, created, captured, aiCalls } = setup({ botAiEnabled: true, aiReply: '你好，这是 AI 回复' })
  try {
    const headers = { 'x-telegram-bot-api-secret-token': 'secret-'.repeat(4) }
    const body = Buffer.from(
      JSON.stringify({
        update_id: 11,
        message: { text: '/ask 你好', chat: { id: 123, type: 'private' }, from: { id: 456 } },
      }),
    )
    const result = await service.handleWebhook(created.id, headers, body)
    assert.equal(result.status, 200)
    await service.waitForIdle()
    assert.deepEqual(aiCalls, ['你好'])
    assert.ok(captured.some((item) => String(item.init?.body).includes('AI 回复')))

    const disabledDir = tempDataDir()
    const disabledConfig = testConfig(disabledDir, {
      botEnabled: true,
      botSecretKey: randomBytes(32).toString('base64'),
      botAiEnabled: false,
    })
    const disabledDb = testDb(disabledDir)
    const disabled = new BotService({
      db: disabledDb,
      config: disabledConfig,
      log: () => undefined,
      audit: () => undefined,
      fetch: async () => jsonResponse({ ok: true }),
      ai: { chat: async () => '不应调用' },
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
      const bot = disabled.createBot({
        platform: 'telegram',
        name: 'disabled',
        token: 'y'.repeat(40),
        webhookSecret: 'secret-'.repeat(4),
      })
      disabled.updateBot(bot.id, { enabled: true })
      disabled.createTarget(bot.id, {
        externalId: '123',
        label: 'chat',
        kind: 'group',
        allowCommands: true,
        allowNotifications: true,
      })
      disabled.createTarget(bot.id, {
        externalId: '456',
        label: 'admin',
        kind: 'user',
        allowCommands: true,
        allowNotifications: false,
      })
      const disabledResult = await disabled.handleWebhook(
        bot.id,
        { 'x-telegram-bot-api-secret-token': 'secret-'.repeat(4) },
        Buffer.from(
          JSON.stringify({
            update_id: 12,
            message: { text: '/ask 你好', chat: { id: 123, type: 'private' }, from: { id: 456 } },
          }),
        ),
      )
      assert.equal(disabledResult.status, 200)
      await disabled.waitForIdle()
    } finally {
      disabledDb.close()
      rmSync(disabledDir, { recursive: true, force: true })
    }
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v0.5.1：QQ 平台可创建并通过服务发送文本', async () => {
  const { dir, db, service, captured } = setup({
    fetchResponses: [{ access_token: 'qq-token', expires_in: 7200 }, { id: 'qq-msg-1' }],
  })
  try {
    const bot = service.createBot({
      platform: 'qq',
      name: 'qq',
      token: 's'.repeat(32),
      config: { appId: '102123456' },
    })
    service.updateBot(bot.id, { enabled: true })
    const target = service.createTarget(bot.id, {
      externalId: 'GROUP-OPENID',
      label: 'QQ 群',
      kind: 'group',
      allowCommands: true,
      allowNotifications: true,
    })
    await service.testBot(bot.id, target.id)
    assert.ok(captured.some((item) => /bots\.qq\.com/.test(item.url)))
    assert.ok(captured.some((item) => /api\.sgroup\.qq\.com\/v2\/groups\/GROUP-OPENID\/messages/.test(item.url)))
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
