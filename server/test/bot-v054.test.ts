/**
 * v0.5.4 双模式 Bot 对话：/ask 任务提示、普通 Chat 对话提示、共享记忆与审计 mode。
 * 不访问真实平台/模型；AI 与 fetch 均为进程内夹具。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tempDataDir, testConfig, testDb } from './helpers.ts'
import { BotService } from '../src/bot/service.ts'
import { DEFAULT_CHAT_PROMPT, DEFAULT_TASK_PROMPT, SAFETY_BOUNDARY } from '../src/bot/prompts.ts'
import type { BotAiMode } from '../src/bot/types.ts'

interface AiCall {
  mode: BotAiMode
  prompt: string
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function setup(overrides: { taskPrompt?: string; chatPrompt?: string } = {}) {
  const dir = tempDataDir()
  const key = randomBytes(32).toString('base64')
  const config = testConfig(dir, {
    botEnabled: true,
    botSecretKey: key,
    botAiEnabled: true,
    botAiTaskPrompt: overrides.taskPrompt ?? '',
    botAiChatPrompt: overrides.chatPrompt ?? '',
  })
  const db = testDb(dir)
  const aiCalls: AiCall[] = []
  const memoryCalls: { userText: string }[] = []
  const audits: { action: string; detail?: Record<string, unknown> | null }[] = []
  const fetchImpl = (async () => jsonResponse({ ok: true, result: { message_id: 1 } })) as typeof fetch
  const service = new BotService({
    db,
    config,
    log: () => undefined,
    audit: (action, _target, detail) => {
      audits.push({ action, detail })
    },
    fetch: fetchImpl,
    now: () => new Date('2026-10-22T04:00:00.000Z'),
    ai: {
      chat: async (input) => {
        aiCalls.push({ mode: input.mode, prompt: input.prompt })
        return 'AI 测试回复'
      },
      summarizeMemory: async (input) => {
        memoryCalls.push({ userText: input.userText })
        return { summary: `记忆：${input.userText}`, sessionId: 'memory-session' }
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
  const created = service.createBot({
    platform: 'telegram',
    name: 'prompt-test',
    token: 'x'.repeat(40),
    webhookSecret: 'secret-'.repeat(4),
  })
  service.updateBot(created.id, { enabled: true })
  const target = service.createTarget(created.id, {
    externalId: '123',
    label: '聊天目标',
    kind: 'group',
    allowCommands: true,
    allowNotifications: false,
    allowChat: true,
  })
  service.createTarget(created.id, {
    externalId: '456',
    label: '管理员',
    kind: 'user',
    allowCommands: true,
    allowNotifications: false,
  })
  db.prepare(
    `INSERT INTO bot_ai_memories (bot_id, user_id, memory_id, summary, summary_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    created.id,
    '456',
    '11111111-1111-4111-8111-111111111111',
    '用户喜欢深色模式',
    '2026-10-22T00:00:00.000Z',
    '2026-10-22T00:00:00.000Z',
  )
  return { dir, db, service, created, target, aiCalls, memoryCalls, audits }
}

async function ask(service: BotService, botId: string, text: string): Promise<void> {
  const body = Buffer.from(
    JSON.stringify({
      update_id: 1,
      message: { text: `/ask ${text}`, chat: { id: 123, type: 'group' }, from: { id: 456 } },
    }),
  )
  const result = await service.handleWebhook(botId, { 'x-telegram-bot-api-secret-token': 'secret-'.repeat(4) }, body)
  assert.equal(result.status, 200)
  await service.waitForIdle()
}

test('v0.5.4：/ask 使用任务提示、共享记忆并审计 mode=task', async () => {
  const { dir, db, service, created, aiCalls, audits } = setup()
  try {
    await ask(service, created.id, '整理备份现状')
    assert.equal(aiCalls.length, 1)
    assert.equal(aiCalls[0]?.mode, 'task')
    const prompt = aiCalls[0]?.prompt ?? ''
    assert.match(prompt, /^\[模式：任务\]/)
    assert.ok(prompt.includes(DEFAULT_TASK_PROMPT))
    assert.ok(prompt.includes(SAFETY_BOUNDARY))
    assert.ok(prompt.includes('用户喜欢深色模式'))
    assert.match(prompt, /\[用户消息\]\n整理备份现状$/)
    const audit = audits.filter((item) => item.action === 'bot.ai.chat').at(-1)
    assert.equal(audit?.detail?.mode, 'task')
    assert.ok(!JSON.stringify(audits).includes('用户喜欢深色模式'), '审计不含记忆正文')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('v0.5.4：普通 Chat 使用对话提示与自定义 Chat 覆盖', async () => {
  const { dir, db, service, created, target, aiCalls } = setup({ chatPrompt: '用轻松语气回答。' })
  try {
    await service.handleGatewayMessage(created.id, {
      eventId: 'gw-chat-prompt-1',
      targetExternalId: target.externalId,
      targetKind: 'group',
      userId: '456',
      userName: '管理员',
      text: '今天有点累',
      isDirect: false,
      chatTrigger: 'mention',
    })
    await service.waitForIdle()
    assert.equal(aiCalls.length, 1)
    assert.equal(aiCalls[0]?.mode, 'chat')
    const prompt = aiCalls[0]?.prompt ?? ''
    assert.match(prompt, /^\[模式：对话\]/)
    assert.ok(prompt.includes('用轻松语气回答。'))
    assert.ok(!prompt.includes(DEFAULT_CHAT_PROMPT))
    assert.ok(prompt.includes(SAFETY_BOUNDARY))
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('v0.5.4：Task 与 Chat 自定义提示词互不串用，且共享记忆', async () => {
  const { dir, db, service, created, target, aiCalls } = setup({
    taskPrompt: '任务自定义提示。',
    chatPrompt: '对话自定义提示。',
  })
  try {
    await ask(service, created.id, '执行计划')
    await service.handleGatewayMessage(created.id, {
      eventId: 'gw-chat-prompt-2',
      targetExternalId: target.externalId,
      targetKind: 'group',
      userId: '456',
      userName: '管理员',
      text: '继续聊',
      isDirect: false,
      chatTrigger: 'mention',
    })
    await service.waitForIdle()
    assert.equal(aiCalls.length, 2)
    assert.ok(aiCalls[0]?.prompt.includes('任务自定义提示。'))
    assert.ok(aiCalls[0]?.prompt.includes('用户喜欢深色模式'))
    assert.ok(!aiCalls[0]?.prompt.includes('对话自定义提示。'))
    assert.ok(aiCalls[1]?.prompt.includes('对话自定义提示。'))
    assert.ok(aiCalls[1]?.prompt.includes('记忆：执行计划'))
    assert.ok(!aiCalls[1]?.prompt.includes('任务自定义提示。'))
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})
