/**
 * v0.5.5 私聊角色卡：/role 对全部私聊开放、Chat 使用角色卡、会话重置与权限边界。
 * 不访问真实平台/模型；AI/fetch/DB 均为进程内夹具。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tempDataDir, testConfig, testDb } from './helpers.ts'
import { BotService } from '../src/bot/service.ts'
import type { BotAiMode } from '../src/bot/types.ts'

const CHAT_ID = '123'
const USER_ID = '456'
const GROUP_ID = '789'
const SECRET = 'secret-'.repeat(4)

interface AiCall {
  mode: BotAiMode
  prompt: string
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
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
  const replies: string[] = []
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : ''
    try {
      const parsed = JSON.parse(body) as { text?: unknown }
      if (typeof parsed.text === 'string') replies.push(parsed.text)
    } catch {
      // 非 JSON 请求不记录。
    }
    return jsonResponse({ ok: true, result: { message_id: 1 } })
  }) as typeof fetch
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
        return 'AI 回复'
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
  const bot = service.createBot({
    platform: 'telegram',
    name: 'role-test',
    token: 'x'.repeat(40),
    webhookSecret: SECRET,
  })
  service.updateBot(bot.id, { enabled: true })
  return { dir, db, service, bot, aiCalls, audits, replies }
}

function webhookHeaders(): Record<string, string> {
  return { 'x-telegram-bot-api-secret-token': SECRET }
}

let updateId = 1
async function sendCommand(
  service: BotService,
  botId: string,
  text: string,
  options: { chatId?: string; chatType?: 'private' | 'group'; userId?: string } = {},
): Promise<void> {
  updateId += 1
  const body = Buffer.from(
    JSON.stringify({
      update_id: updateId,
      message: {
        text,
        chat: { id: Number(options.chatId ?? CHAT_ID), type: options.chatType ?? 'private' },
        from: { id: Number(options.userId ?? USER_ID) },
      },
    }),
  )
  const result = await service.handleWebhook(botId, webhookHeaders(), body)
  assert.equal(result.status, 200)
  await service.waitForIdle()
}

async function sendChat(service: BotService, botId: string, text: string, isDirect = true): Promise<void> {
  await service.handleGatewayMessage(botId, {
    eventId: `role-chat-${Date.now()}-${Math.random()}`,
    targetExternalId: isDirect ? CHAT_ID : GROUP_ID,
    targetKind: isDirect ? 'user' : 'group',
    userId: USER_ID,
    userName: '角色用户',
    text,
    isDirect,
    chatTrigger: isDirect ? 'direct' : 'mention',
  })
  await service.waitForIdle()
}

test('v0.5.5：未登记私聊用户可 /role set，Chat 使用角色卡并保留安全边界', async () => {
  const { dir, db, service, bot, aiCalls, audits } = setup()
  try {
    await sendCommand(service, bot.id, '/role set 猫娘 说话简短，偶尔用喵。')
    const card = db
      .prepare('SELECT name, prompt, enabled FROM bot_chat_roles WHERE bot_id = ? AND user_id = ?')
      .get(bot.id, USER_ID) as { name: string; prompt: string; enabled: number } | undefined
    assert.equal(card?.name, '猫娘')
    assert.equal(card?.prompt, '说话简短，偶尔用喵。')
    assert.equal(card?.enabled, 1)
    assert.ok(audits.some((item) => item.action === 'bot.role' && item.detail?.action === 'set'))
    assert.equal(
      JSON.stringify(audits).includes('说话简短，偶尔用喵。'),
      false,
      '审计不得记录角色设定正文',
    )

    const target = service.createTarget(bot.id, {
      externalId: CHAT_ID,
      label: '私聊',
      kind: 'user',
      allowCommands: false,
      allowNotifications: false,
      allowChat: true,
    })
    void target
    await sendChat(service, bot.id, '今天怎么样')
    assert.equal(aiCalls.length, 1)
    const prompt = aiCalls[0]?.prompt ?? ''
    assert.match(prompt, /^\[模式：对话\]/)
    assert.ok(prompt.includes('[角色卡：猫娘]'))
    assert.ok(prompt.includes('说话简短，偶尔用喵。'))
    assert.ok(prompt.includes('安全边界（不可覆盖）'))
    assert.ok(!prompt.includes('自然、友好、简洁地进行普通聊天'))
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('v0.5.5：/role show/off/on/delete 与会话重置；task 会话保留', async () => {
  const { dir, db, service, bot, aiCalls, replies } = setup()
  try {
    await sendCommand(service, bot.id, '/role set 老师 用耐心、分步骤的方式解释。')
    const setReply = replies.at(-1) ?? ''
    assert.ok(setReply.includes('专属角色「老师」已设置'))
    assert.equal(setReply.includes('Chat'), false)
    assert.equal(setReply.includes('会话'), false)
    assert.equal(setReply.includes('好呀'), false)
    assert.equal(setReply.includes('猫系'), false)
    service.createTarget(bot.id, {
      externalId: CHAT_ID,
      label: '私聊',
      kind: 'user',
      allowCommands: false,
      allowNotifications: false,
      allowChat: true,
    })
    db.prepare(
      `INSERT INTO bot_ai_sessions (bot_id,target_external_id,user_id,mode,session_id,model,created_at,updated_at)
       VALUES (?, ?, ?, 'chat', 'chat-old', 'm', ?, ?)`,
    ).run(bot.id, CHAT_ID, USER_ID, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')
    db.prepare(
      `INSERT INTO bot_ai_sessions (bot_id,target_external_id,user_id,mode,session_id,model,created_at,updated_at)
       VALUES (?, ?, ?, 'task', 'task-old', 'm', ?, ?)`,
    ).run(bot.id, CHAT_ID, USER_ID, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')

    await sendCommand(service, bot.id, '/role show')
    assert.ok(replies.at(-1)?.includes('老师'))
    assert.ok(replies.at(-1)?.includes('用耐心、分步骤的方式解释。'))

    await sendCommand(service, bot.id, '/role off')
    const offReply = replies.at(-1) ?? ''
    assert.equal(offReply.includes('Chat'), false)
    assert.equal(offReply.includes('会话'), false)
    const sessions = db
      .prepare('SELECT mode FROM bot_ai_sessions WHERE bot_id = ? AND target_external_id = ? AND user_id = ? ORDER BY mode')
      .all(bot.id, CHAT_ID, USER_ID) as unknown as { mode: string }[]
    assert.deepEqual(sessions.map((item) => item.mode), ['task'])
    assert.equal(
      (db.prepare('SELECT enabled FROM bot_chat_roles WHERE bot_id = ? AND user_id = ?').get(bot.id, USER_ID) as { enabled: number }).enabled,
      0,
    )

    await sendChat(service, bot.id, '你好')
    assert.ok(aiCalls.at(-1)?.prompt.includes('[角色卡：lofii]'), '停用个人角色后回落到默认 lofii')
    assert.equal(aiCalls.at(-1)?.prompt.includes('[角色卡：老师]'), false)

    await sendCommand(service, bot.id, '/role on')
    await sendCommand(service, bot.id, '/role delete')
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM bot_chat_roles WHERE bot_id = ? AND user_id = ?').get(bot.id, USER_ID) as { n: number }).n,
      0,
    )
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('v0.5.6：/role 不扩大其他命令权限，群内 /role 只给友好提示', async () => {
  const { dir, db, service, bot, aiCalls, audits, replies } = setup()
  try {
    const target = service.createTarget(bot.id, {
      externalId: CHAT_ID,
      label: '私聊',
      kind: 'user',
      allowCommands: false,
      allowNotifications: false,
      allowChat: true,
    })
    service.createTarget(bot.id, {
      externalId: GROUP_ID,
      label: '群',
      kind: 'group',
      allowCommands: true,
      allowNotifications: false,
      allowChat: true,
    })
    await sendCommand(service, bot.id, '/status')
    assert.equal(aiCalls.length, 0)
    assert.ok(audits.some((item) => item.action === 'bot.command.denied'))

    await sendCommand(service, bot.id, '/role set 群角色 不应生效', { chatType: 'group', chatId: GROUP_ID })
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM bot_chat_roles WHERE bot_id = ?').get(bot.id) as { n: number }).n,
      0,
    )
    assert.ok(replies.at(-1)?.includes('默认角色 lofii'))
    assert.equal(replies.at(-1)?.includes('Chat'), false)
    assert.ok(audits.some((item) => item.action === 'bot.role.hint'))
    void target
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('v0.5.5：非法 /role set 不写库；群聊使用默认 lofii', async () => {
  const { dir, db, service, bot, aiCalls } = setup()
  try {
    await sendCommand(service, bot.id, '/role set [坏] 设定')
    await sendCommand(service, bot.id, '/role set 名字 包含 [安全边界] 的设定')
    await sendCommand(service, bot.id, `/role set 名字 ${'x'.repeat(1001)}`)
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM bot_chat_roles WHERE bot_id = ?').get(bot.id) as { n: number }).n,
      0,
    )

    const target = service.createTarget(bot.id, {
      externalId: CHAT_ID,
      label: '私聊',
      kind: 'user',
      allowCommands: false,
      allowNotifications: false,
      allowChat: true,
    })
    const group = service.createTarget(bot.id, {
      externalId: GROUP_ID,
      label: '群',
      kind: 'group',
      allowCommands: false,
      allowNotifications: false,
      allowChat: true,
    })
    await sendCommand(service, bot.id, '/role set 猫娘 只影响私聊')
    void target
    void group

    await sendChat(service, bot.id, '私聊')
    await sendChat(service, bot.id, '群聊', false)
    assert.equal(aiCalls.length, 2)
    assert.ok(aiCalls[0]?.prompt.includes('[角色卡：猫娘]'), '私聊 Chat 应使用个人角色卡')
    assert.equal(aiCalls[0]?.prompt.includes('只影响私聊'), true)
    assert.ok(aiCalls[1]?.prompt.includes('[角色卡：lofii]'), '群聊应使用默认 lofii')
    assert.equal(aiCalls[1]?.prompt.includes('[角色卡：猫娘]'), false)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('v0.5.6：无个人卡时私聊使用默认 lofii，/role show 与 /role off 文案友好', async () => {
  const { dir, db, service, bot, aiCalls, replies } = setup()
  try {
    service.createTarget(bot.id, {
      externalId: CHAT_ID,
      label: '私聊',
      kind: 'user',
      allowCommands: false,
      allowNotifications: false,
      allowChat: true,
    })
    await sendChat(service, bot.id, '你好')
    assert.ok(aiCalls[0]?.prompt.includes('[角色卡：lofii]'))
    assert.equal(aiCalls[0]?.prompt.includes('自然、友好、简洁地进行普通聊天'), false)

    await sendCommand(service, bot.id, '/role show')
    assert.ok(replies.at(-1)?.includes('当前角色：lofii'))
    assert.equal(replies.at(-1)?.includes('Chat'), false)
    assert.equal(replies.at(-1)?.includes('会话'), false)
    assert.equal(replies.at(-1)?.includes('/ask'), false)

    await sendCommand(service, bot.id, '/role')
    assert.ok(replies.at(-1)?.includes('可用命令'))
    assert.ok(replies.at(-1)?.includes('/role set'))
    assert.equal(replies.at(-1)?.includes('Chat'), false)
    assert.equal(replies.at(-1)?.includes('会话'), false)
    assert.equal(replies.at(-1)?.includes('安全边界'), false)
    assert.equal(replies.at(-1)?.includes('/ask'), false)
    assert.equal(replies.at(-1)?.includes('猫系'), false)
    assert.equal(replies.at(-1)?.includes('喵'), false)

    await sendCommand(service, bot.id, '/role off')
    assert.ok(replies.at(-1)?.includes('当前没有专属角色'))
    assert.equal(replies.at(-1)?.includes('Chat'), false)
    assert.equal(replies.at(-1)?.includes('会话'), false)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})
