/**
 * v0.5.7 群聊触发策略（F4）：目标 chatTrigger 校验（QQ 400 / user 目标拒绝 all）、
 * message 触发静默拒绝与 all 放行、Gateway 回复引用/textMode 透传、Webhook 触发策略回调。
 * 不访问真实平台或模型；AI/fetch 均为进程内夹具。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import type { Config } from '../src/config.ts'
import { tempDataDir, testConfig, testDb } from './helpers.ts'
import { BotService } from '../src/bot/service.ts'
import { AppError } from '../src/util/errors.ts'
import type { BotAiImage } from '../src/bot/types.ts'

const SECRET = 'secret-'.repeat(4)

interface Captured {
  url: string
  body: string
}

interface AiCall {
  mode: string
  prompt: string
  image?: BotAiImage
}

interface AuditRecord {
  action: string
  target: string | null
  detail?: Record<string, unknown> | null
}

function setup(overrides: Partial<Config> = {}) {
  const dir = tempDataDir()
  const db = testDb(dir)
  const config = testConfig(dir, {
    botEnabled: true,
    botSecretKey: randomBytes(32).toString('base64'),
    botAiEnabled: true,
    ...overrides,
  })
  const captured: Captured[] = []
  const aiCalls: AiCall[] = []
  const audits: AuditRecord[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const body = typeof init?.body === 'string' ? init.body : ''
    captured.push({ url, body })
    return new Response(JSON.stringify({ ok: true, result: { message_id: captured.length } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
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
    ai: {
      chat: async (input) => {
        aiCalls.push({ mode: input.mode, prompt: input.prompt, ...(input.image ? { image: input.image } : {}) })
        return '**粗体** 回复'
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
      files: async () => [],
    },
  })
  const telegram = service.createBot({
    platform: 'telegram',
    name: 'trigger-telegram',
    token: 'x'.repeat(40),
    webhookSecret: SECRET,
  })
  service.updateBot(telegram.id, { enabled: true })
  const qq = service.createBot({ platform: 'qq', name: 'trigger-qq', token: 'q'.repeat(40), config: { appId: '1905866746' } })
  service.updateBot(qq.id, { enabled: true })
  return { dir, db, service, telegramId: telegram.id, qqId: qq.id, captured, aiCalls, audits }
}

let eventSeq = 1

async function gatewayChat(
  service: BotService,
  botId: string,
  input: Partial<{
    targetExternalId: string
    targetKind: 'channel' | 'user' | 'group'
    userId: string
    text: string
    isDirect: boolean
    chatTrigger: 'direct' | 'mention' | 'reply' | 'message'
    messageId: string
  }> = {},
): Promise<void> {
  eventSeq += 1
  await service.handleGatewayMessage(botId, {
    eventId: `gw-trigger-${eventSeq}`,
    targetExternalId: input.targetExternalId ?? 'group-1',
    targetKind: input.targetKind ?? 'group',
    userId: input.userId ?? 'user-1',
    userName: '用户',
    text: input.text ?? '你好',
    isDirect: input.isDirect ?? false,
    chatTrigger: input.chatTrigger ?? 'mention',
    messageId: input.messageId ?? `msg-${eventSeq}`,
  })
  await service.waitForIdle()
}

function createGroupTarget(service: BotService, botId: string, input: { externalId: string; chatTrigger?: 'mention' | 'all'; allowChat?: boolean }) {
  return service.createTarget(botId, {
    externalId: input.externalId,
    label: '群目标',
    kind: 'group',
    allowCommands: false,
    allowNotifications: false,
    allowChat: input.allowChat ?? true,
    ...(input.chatTrigger ? { chatTrigger: input.chatTrigger } : {}),
  })
}

test('v0.5.7：目标 chatTrigger 落库/返回；QQ 与 user 目标设 all 返回 chat_trigger_unsupported', () => {
  const { dir, db, service, telegramId, qqId } = setup()
  try {
    const target = createGroupTarget(service, telegramId, { externalId: 'group-a', chatTrigger: 'all' })
    assert.equal(target.chatTrigger, 'all')
    const listed = service.listTargets(telegramId).find((item) => item.id === target.id)
    assert.equal(listed?.chatTrigger, 'all')
    assert.equal(
      (db.prepare('SELECT chat_trigger FROM bot_targets WHERE id = ?').get(target.id) as { chat_trigger: string }).chat_trigger,
      'all',
    )
    // 更新回 mention 再改回 all。
    assert.equal(service.updateTarget(telegramId, target.id, { chatTrigger: 'mention' }).chatTrigger, 'mention')
    assert.equal(service.updateTarget(telegramId, target.id, { chatTrigger: 'all' }).chatTrigger, 'all')

    const qqTarget = createGroupTarget(service, qqId, { externalId: 'qq-group' })
    assert.throws(
      () => service.updateTarget(qqId, qqTarget.id, { chatTrigger: 'all' }),
      (error: unknown) => error instanceof AppError && error.code === 'chat_trigger_unsupported' && error.statusCode === 400,
    )
    assert.throws(
      () =>
        service.createTarget(qqId, {
          externalId: 'qq-group-2',
          label: 'QQ 群',
          kind: 'group',
          allowCommands: false,
          allowNotifications: false,
          chatTrigger: 'all',
        }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'chat_trigger_unsupported' &&
        error.message === 'QQ 群/频道仅支持 @Bot 触发',
    )

    // user 目标不支持 all；把 all 群目标改成 user 类型时同样拒绝。
    assert.throws(
      () =>
        service.createTarget(telegramId, {
          externalId: 'dm-user',
          label: '私聊',
          kind: 'user',
          allowCommands: false,
          allowNotifications: false,
          chatTrigger: 'all',
        }),
      (error: unknown) => error instanceof AppError && error.code === 'chat_trigger_unsupported',
    )
    assert.throws(
      () => service.updateTarget(telegramId, target.id, { kind: 'user' }),
      (error: unknown) => error instanceof AppError && error.code === 'chat_trigger_unsupported',
    )
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('v0.5.7：message 触发在目标未开启 all/未登记时静默忽略，不写 bot.chat.denied 审计', async () => {
  const { dir, db, service, telegramId, captured, aiCalls, audits } = setup()
  try {
    const mentionTarget = createGroupTarget(service, telegramId, { externalId: 'group-mention', chatTrigger: 'mention' })
    await gatewayChat(service, telegramId, { targetExternalId: mentionTarget.externalId, chatTrigger: 'message' })
    assert.equal(aiCalls.length, 0)
    assert.equal(captured.length, 0)
    assert.equal(audits.filter((item) => item.action === 'bot.chat.denied').length, 0)

    await gatewayChat(service, telegramId, { targetExternalId: 'unregistered-group', chatTrigger: 'message' })
    assert.equal(aiCalls.length, 0)
    assert.equal(captured.length, 0)
    assert.equal(audits.filter((item) => item.action === 'bot.chat.denied').length, 0)

    const events = service.listEvents(telegramId, { outcome: 'ignored' })
    assert.ok(events.items.length >= 2)
    assert.ok(events.items.every((item) => item.detail === 'trigger_not_allowed'))
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('v0.5.7：all 策略放行 message 触发；mention 触发被拒仍审计 bot.chat.denied', async () => {
  const { dir, db, service, telegramId, aiCalls, audits } = setup()
  try {
    const allTarget = createGroupTarget(service, telegramId, { externalId: 'group-all', chatTrigger: 'all' })
    await gatewayChat(service, telegramId, { targetExternalId: allTarget.externalId, chatTrigger: 'message', text: '全部消息模式' })
    assert.equal(aiCalls.length, 1)
    assert.ok(aiCalls[0]?.prompt.includes('全部消息模式'))
    const okEvent = service.listEvents(telegramId, { outcome: 'ok' }).items.at(-1)
    assert.equal(okEvent?.kind, 'chat')

    const closedTarget = createGroupTarget(service, telegramId, { externalId: 'group-closed', allowChat: false })
    await gatewayChat(service, telegramId, { targetExternalId: closedTarget.externalId, chatTrigger: 'mention' })
    assert.equal(aiCalls.length, 1, '未授权目标不得进入 AI')
    assert.ok(audits.some((item) => item.action === 'bot.chat.denied'))
    const denied = service.listEvents(telegramId, { outcome: 'denied' })
    assert.equal(denied.items[0]?.detail, 'chat_denied')

    // 群内 direct 触发属于异常组合：静默忽略且不写拒绝审计。
    const deniedBefore = audits.filter((item) => item.action === 'bot.chat.denied').length
    await gatewayChat(service, telegramId, { targetExternalId: allTarget.externalId, chatTrigger: 'direct' })
    assert.equal(aiCalls.length, 1)
    assert.equal(audits.filter((item) => item.action === 'bot.chat.denied').length, deniedBefore)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('v0.5.7：Gateway 回复透传 replyTo（群聊引用）与 textMode（Telegram HTML）；私聊不带引用', async () => {
  const { dir, db, service, telegramId, captured } = setup()
  try {
    const group = createGroupTarget(service, telegramId, { externalId: '5005' })
    await gatewayChat(service, telegramId, {
      targetExternalId: group.externalId,
      chatTrigger: 'mention',
      messageId: '4242',
    })
    const groupSend = captured.at(-1)
    assert.ok(groupSend && groupSend.url.includes('/sendMessage'))
    const groupPayload = JSON.parse(groupSend!.body) as Record<string, unknown>
    assert.equal(groupPayload.parse_mode, 'HTML')
    assert.match(String(groupPayload.text), /<b>粗体<\/b>/)
    assert.equal(groupPayload.reply_to_message_id, 4242, 'Telegram 要求 reply_to_message_id 为整数')

    service.createTarget(telegramId, {
      externalId: '6006',
      label: '私聊',
      kind: 'user',
      allowCommands: false,
      allowNotifications: false,
      allowChat: true,
    })
    await gatewayChat(service, telegramId, {
      targetExternalId: '6006',
      targetKind: 'user',
      userId: '6006',
      isDirect: true,
      chatTrigger: 'direct',
      messageId: '4243',
    })
    const dmPayload = JSON.parse(captured.at(-1)!.body) as Record<string, unknown>
    assert.equal(dmPayload.reply_to_message_id, undefined, '私聊不传 replyTo')
    assert.equal(dmPayload.parse_mode, 'HTML')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('v0.5.7：Webhook 按 chatTriggerFor 解析 all 策略；非 all 群消息忽略但记录 ignored 事件', async () => {
  const { dir, db, service, telegramId, aiCalls, audits } = setup()
  try {
    const allTarget = service.createTarget(telegramId, {
      externalId: '7007',
      label: '全部消息群',
      kind: 'group',
      allowCommands: false,
      allowNotifications: false,
      allowChat: true,
      chatTrigger: 'all',
    })
    let updateId = 900
    const plainGroupMessage = (chatId: number, text: string): Buffer =>
      Buffer.from(
        JSON.stringify({
          update_id: (updateId += 1),
          message: { text, chat: { id: chatId, type: 'group' }, from: { id: 7007, username: 'u' } },
        }),
      )
    const headers = { 'x-telegram-bot-api-secret-token': SECRET }

    await service.handleWebhook(telegramId, headers, plainGroupMessage(Number(allTarget.externalId), '普通群消息'))
    await service.waitForIdle()
    assert.equal(aiCalls.length, 1, 'all 策略下普通群消息应进入 Chat')
    assert.ok(audits.some((item) => item.action === 'bot.chat'))

    const defaultTarget = createGroupTarget(service, telegramId, { externalId: '8008', chatTrigger: 'mention' })
    await service.handleWebhook(telegramId, headers, plainGroupMessage(Number(defaultTarget.externalId), '不该触发'))
    await service.waitForIdle()
    assert.equal(aiCalls.length, 1, '默认 mention 策略下普通群消息不应进入 Chat')
    const ignored = service.listEvents(telegramId, { outcome: 'ignored' })
    assert.ok(ignored.items.some((item) => item.eventId.startsWith('tg:update:')), 'ignored 事件应带事件 ID 入库')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})
