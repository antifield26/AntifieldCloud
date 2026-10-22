/**
 * v0.5.4 QQ C2C 开放 Chat：未登记 C2C 用户可对话（平台限制 Bot 可添加性），群/频道仍需目标登记。
 * 不访问真实平台/模型；AI 与 fetch 均为进程内夹具。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tempDataDir, testConfig, testDb } from './helpers.ts'
import { BotService } from '../src/bot/service.ts'
import type { BotAiMode } from '../src/bot/types.ts'

interface AiCall {
  mode: BotAiMode
  prompt: string
}

function setup() {
  const dir = tempDataDir()
  const db = testDb(dir)
  const config = testConfig(dir, {
    botEnabled: true,
    botSecretKey: randomBytes(32).toString('base64'),
    botAiEnabled: true,
  })
  const aiCalls: AiCall[] = []
  const audits: { action: string; detail?: Record<string, unknown> | null }[] = []
  const service = new BotService({
    db,
    config,
    log: () => undefined,
    audit: (action, _target, detail) => {
      audits.push({ action, detail })
    },
    fetch: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch,
    now: () => new Date('2026-10-22T04:00:00.000Z'),
    ai: {
      chat: async (input) => {
        aiCalls.push({ mode: input.mode, prompt: input.prompt })
        return '对话回复'
      },
    },
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
  const bot = service.createBot({
    platform: 'qq',
    name: 'qq-c2c',
    token: 'q'.repeat(40),
    config: { appId: '102123456' },
  })
  service.updateBot(bot.id, { enabled: true })
  return { dir, db, service, bot, aiCalls, audits }
}

test('v0.5.4：QQ C2C 未登记用户可直接 Chat，使用对话模式', async () => {
  const { dir, db, service, bot, aiCalls, audits } = setup()
  try {
    await service.handleGatewayMessage(bot.id, {
      eventId: 'qq-c2c-1',
      targetExternalId: 'external-c2c-user',
      targetKind: 'user',
      userId: 'external-c2c-user',
      userName: '外部用户',
      text: '你好',
      isDirect: true,
      chatTrigger: 'direct',
    })
    await service.waitForIdle()
    assert.equal(aiCalls.length, 1)
    assert.equal(aiCalls[0]?.mode, 'chat')
    assert.match(aiCalls[0]?.prompt ?? '', /^\[模式：对话\]/)
    assert.ok(aiCalls[0]?.prompt.includes('不自我介绍或提及产品身份'))
    const chatAudit = audits.filter((item) => item.action === 'bot.chat').at(-1)
    assert.equal(chatAudit?.detail?.open, 'qq_c2c')
    assert.equal(audits.filter((item) => item.action === 'bot.chat.denied').length, 0)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('v0.5.4：QQ 群/频道未登记仍拒绝 Chat', async () => {
  const { dir, db, service, bot, aiCalls, audits } = setup()
  try {
    await service.handleGatewayMessage(bot.id, {
      eventId: 'qq-group-1',
      targetExternalId: 'external-group',
      targetKind: 'group',
      userId: 'external-user',
      userName: '外部用户',
      text: '@Bot 你好',
      isDirect: false,
      chatTrigger: 'mention',
    })
    await service.waitForIdle()
    assert.equal(aiCalls.length, 0)
    assert.ok(audits.some((item) => item.action === 'bot.chat.denied'))
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('v0.5.4：非 QQ 私聊未登记仍拒绝 Chat，开放范围不扩散', async () => {
  const { dir, db, service, aiCalls, audits } = setup()
  try {
    const telegram = service.createBot({
      platform: 'telegram',
      name: 'telegram-dm',
      token: 't'.repeat(40),
      webhookSecret: 'secret-'.repeat(4),
    })
    service.updateBot(telegram.id, { enabled: true })
    await service.handleGatewayMessage(telegram.id, {
      eventId: 'tg-dm-1',
      targetExternalId: 'external-dm-user',
      targetKind: 'user',
      userId: 'external-dm-user',
      userName: '外部用户',
      text: '你好',
      isDirect: true,
      chatTrigger: 'direct',
    })
    await service.waitForIdle()
    assert.equal(aiCalls.length, 0)
    assert.ok(audits.some((item) => item.action === 'bot.chat.denied'))
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})
