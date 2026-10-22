/**
 * v0.5.7 新命令：/reset 与 /forget confirm。
 * 覆盖全用户开放（不要求目标/用户白名单）、群聊、会话与记忆/镜像清理、幂等与审计无正文。
 * 不访问真实平台或模型；fetch 为进程内夹具。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../src/config.ts'
import { tempDataDir, testConfig, testDb } from './helpers.ts'
import { BotService } from '../src/bot/service.ts'
import { BotMemoryStore } from '../src/bot/memory.ts'

const SECRET = 'secret-'.repeat(4)
const CHAT_ID = '1001'
const GROUP_ID = '3003'
const USER_ID = '2002'

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
    botAiEnabled: false,
    ...overrides,
  })
  const replies: string[] = []
  const audits: AuditRecord[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    // 只记录 Telegram sendMessage 的正文；其它请求返回固定成功。
    if (url.includes('/sendMessage') && typeof init?.body === 'string') {
      try {
        const parsed = JSON.parse(init.body) as { text?: unknown }
        if (typeof parsed.text === 'string') replies.push(parsed.text)
      } catch {
        // 非 JSON 请求体不记录。
      }
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: replies.length + 1 } }), {
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
    name: 'commands',
    token: 'x'.repeat(40),
    webhookSecret: SECRET,
  })
  service.updateBot(bot.id, { enabled: true })
  const memory = new BotMemoryStore(db, dir, config.botAiMemoryMaxChars)
  return { dir, db, config, service, botId: bot.id, replies, audits, memory }
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
  const result = await service.handleWebhook(botId, { 'x-telegram-bot-api-secret-token': SECRET }, body)
  assert.equal(result.status, 200)
  await service.waitForIdle()
}

function sessionModes(db: ReturnType<typeof testDb>, botId: string, target: string, userId: string): string[] {
  const rows = db
    .prepare('SELECT mode FROM bot_ai_sessions WHERE bot_id = ? AND target_external_id = ? AND user_id = ? ORDER BY mode')
    .all(botId, target, userId) as unknown as { mode: string }[]
  return rows.map((row) => row.mode)
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

test('v0.5.7：/reset 对所有用户开放，删除当前目标的 chat+task 会话并保留其他目标/用户', async () => {
  const { dir, db, service, botId, replies, audits } = setup()
  try {
    seedSession(db, botId, CHAT_ID, USER_ID, 'chat', 'chat-old')
    seedSession(db, botId, CHAT_ID, USER_ID, 'task', 'task-old')
    seedSession(db, botId, GROUP_ID, USER_ID, 'chat', 'group-old')
    seedSession(db, botId, CHAT_ID, '9999', 'chat', 'other-user')

    // 未登记目标、无 user 白名单的私聊用户也可执行 /reset。
    await sendCommand(service, botId, '/reset')
    assert.equal(replies.at(-1), '已重置当前对话（长期记忆保留）。')
    assert.deepEqual(sessionModes(db, botId, CHAT_ID, USER_ID), [])
    assert.deepEqual(sessionModes(db, botId, GROUP_ID, USER_ID), ['chat'], '其他目标会话保留')
    assert.deepEqual(sessionModes(db, botId, CHAT_ID, '9999'), ['chat'], '其他用户会话保留')
    assert.ok(audits.some((item) => item.action === 'bot.reset'), '应审计 bot.reset')
    assert.equal(JSON.stringify(audits).includes('chat-old'), false)

    // 没有会话时同样回复固定文案（幂等）。
    await sendCommand(service, botId, '/reset')
    assert.equal(replies.at(-1), '已重置当前对话（长期记忆保留）。')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('v0.5.7：/forget 必须 confirm；清除长期记忆+镜像+该 Bot×用户全部会话，且幂等', async () => {
  const { dir, db, service, botId, replies, audits, memory } = setup()
  try {
    const created = memory.get(botId, USER_ID)
    memory.save(botId, USER_ID, created.memoryId, '用户喜欢深色模式，这是记忆正文。', 'memory-session')
    const mirrorPath = join(dir, 'bot-memory', `memory-${created.memoryId}.md`)
    assert.ok(existsSync(mirrorPath), '记忆镜像文件应已创建')
    seedSession(db, botId, CHAT_ID, USER_ID, 'chat', 'chat-1')
    seedSession(db, botId, CHAT_ID, USER_ID, 'task', 'task-1')
    seedSession(db, botId, GROUP_ID, USER_ID, 'chat', 'chat-2')
    seedSession(db, botId, CHAT_ID, '8888', 'chat', 'other-user')

    await sendCommand(service, botId, '/forget')
    assert.match(replies.at(-1) ?? '', /\/forget confirm/)
    assert.equal(memory.count(botId), 1, '未确认时不得删除记忆')

    await sendCommand(service, botId, '/forget confirm')
    assert.equal(replies.at(-1), '已清除长期记忆与全部对话上下文。')
    assert.equal(memory.count(botId), 0)
    assert.equal(existsSync(mirrorPath), false, '记忆镜像文件应删除')
    const remaining = db
      .prepare('SELECT COUNT(*) AS c FROM bot_ai_sessions WHERE bot_id = ? AND user_id = ?')
      .get(botId, USER_ID) as { c: number }
    assert.equal(remaining.c, 0, '该用户全部 target/mode 会话都应清理')
    assert.deepEqual(sessionModes(db, botId, CHAT_ID, '8888'), ['chat'], '其他用户会话保留')
    const forgetAudit = audits.filter((item) => item.action === 'bot.memory.forget').at(-1)
    assert.ok(forgetAudit, '应审计 bot.memory.forget')
    assert.equal(JSON.stringify(forgetAudit).includes('深色模式'), false, '审计不得包含记忆正文')

    // 幂等：再次确认仍回复同一句且不报错。
    await sendCommand(service, botId, '/forget confirm')
    assert.equal(replies.at(-1), '已清除长期记忆与全部对话上下文。')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test('v0.5.7：群聊 /reset /forget 对未授权目标开放，但 /status 仍被白名单拦截', async () => {
  const { dir, db, service, botId, replies, audits, memory } = setup()
  try {
    service.createTarget(botId, {
      externalId: GROUP_ID,
      label: '群',
      kind: 'group',
      allowCommands: false,
      allowNotifications: false,
      allowChat: false,
    })
    seedSession(db, botId, GROUP_ID, USER_ID, 'chat', 'group-chat')
    memory.get(botId, USER_ID)

    await sendCommand(service, botId, '/status', { chatId: GROUP_ID, chatType: 'group' })
    assert.equal(replies.length, 0, '未授权群不应执行 /status')
    assert.ok(audits.some((item) => item.action === 'bot.command.denied'))

    await sendCommand(service, botId, '/reset', { chatId: GROUP_ID, chatType: 'group' })
    assert.equal(replies.at(-1), '已重置当前对话（长期记忆保留）。')
    assert.deepEqual(sessionModes(db, botId, GROUP_ID, USER_ID), [])

    await sendCommand(service, botId, '/forget confirm', { chatId: GROUP_ID, chatType: 'group' })
    assert.equal(replies.at(-1), '已清除长期记忆与全部对话上下文。')
    assert.equal(memory.count(botId), 0)

    // 群内 /role 仍只给友好提示，不读改角色卡。
    await sendCommand(service, botId, '/role set 群角色 不应生效', { chatId: GROUP_ID, chatType: 'group' })
    assert.match(replies.at(-1) ?? '', /默认角色/)
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS c FROM bot_chat_roles WHERE bot_id = ?').get(botId) as { c: number }).c,
      0,
    )
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})
