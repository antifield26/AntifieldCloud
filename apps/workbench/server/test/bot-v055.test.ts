/**
 * v0.5.5/v0.5.6 私聊角色卡（QQ 单平台）：/role 对全部私聊开放、Chat 使用角色卡、会话重置与权限边界。
 * 不访问真实平台/模型；AI/fetch/DB 均为进程内夹具，事件使用 AppSecret 签名。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { c2cWebhook, createQqServiceFixture, groupWebhook, lastMessageText, sendWebhook } from './bot-qq-fixtures.ts'

const USER_ID = 'user-openid-1'
const GROUP_ID = 'group-openid-1'

function setup() {
  const fixture = createQqServiceFixture({ aiEnabled: true, aiHandler: async () => 'AI 回复' })
  return fixture
}

async function command(fixture: ReturnType<typeof setup>, text: string, id: string): Promise<void> {
  await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id, content: text, userOpenid: USER_ID }))
}

async function groupCommand(fixture: ReturnType<typeof setup>, text: string, id: string): Promise<void> {
  await sendWebhook(
    fixture,
    groupWebhook(fixture.appSecret, {
      id,
      content: `<@!102345000> ${text}`,
      groupOpenid: GROUP_ID,
      memberOpenid: 'member-openid-1',
    }),
  )
}

test('v0.5.5：未登记私聊用户可 /role set，Chat 使用角色卡并保留安全边界', async () => {
  const fixture = setup()
  try {
    await command(fixture, '/role set 猫娘 说话简短，偶尔用喵。', 'role-1')
    const card = fixture.db
      .prepare('SELECT name, prompt, enabled FROM bot_chat_roles WHERE bot_id = ? AND user_id = ?')
      .get(fixture.botId, USER_ID) as { name: string; prompt: string; enabled: number } | undefined
    assert.equal(card?.name, '猫娘')
    assert.equal(card?.prompt, '说话简短，偶尔用喵。')
    assert.equal(card?.enabled, 1)
    assert.ok(fixture.audits.some((item) => item.action === 'bot.role' && item.detail?.action === 'set'))
    assert.equal(JSON.stringify(fixture.audits).includes('说话简短，偶尔用喵。'), false, '审计不得记录角色设定正文')

    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'role-chat-1', content: '今天怎么样' }))
    assert.equal(fixture.aiCalls.length, 1)
    const prompt = fixture.aiCalls[0]?.prompt ?? ''
    assert.match(prompt, /^\[系统提示\]\n\[角色卡：猫娘\]/)
    assert.ok(prompt.includes('[角色卡：猫娘]'))
    assert.ok(prompt.includes('说话简短，偶尔用喵。'))
    assert.ok(prompt.includes('安全边界'))
    assert.ok(prompt.includes('只读 Bot'))
    assert.equal(prompt.includes('自然、友好、简洁地进行普通聊天'), false)
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.5：/role show/off/on/delete 与会话重置（全部会话映射清理）', async () => {
  const fixture = setup()
  try {
    await command(fixture, '/role set 老师 用耐心、分步骤的方式解释。', 'role-2')
    let reply = lastMessageText(fixture)
    assert.ok(reply.includes('专属角色「老师」已设置'))
    assert.equal(reply.includes('Chat'), false)
    assert.equal(reply.includes('会话'), false)

    fixture.db
      .prepare(
        `INSERT INTO bot_ai_sessions (bot_id, target_external_id, user_id, mode, session_id, model, created_at, updated_at)
         VALUES (?, ?, ?, 'chat', 'chat-old', 'm', ?, ?)`,
      )
      .run(fixture.botId, USER_ID, USER_ID, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')
    fixture.db
      .prepare(
        `INSERT INTO bot_ai_sessions (bot_id, target_external_id, user_id, mode, session_id, model, created_at, updated_at)
         VALUES (?, ?, ?, 'task', 'task-old', 'm', ?, ?)`,
      )
      .run(fixture.botId, USER_ID, USER_ID, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')

    await command(fixture, '/role show', 'role-3')
    reply = lastMessageText(fixture)
    assert.ok(reply.includes('老师'))
    assert.ok(reply.includes('角色卡详情：'))
    assert.ok(reply.includes('用耐心、分步骤的方式解释。'))

    await command(fixture, '/role off', 'role-4')
    reply = lastMessageText(fixture)
    assert.equal(reply.includes('Chat'), false)
    assert.equal(reply.includes('会话'), false)
    const sessions = fixture.db
      .prepare('SELECT mode FROM bot_ai_sessions WHERE bot_id = ? AND target_external_id = ? AND user_id = ? ORDER BY mode')
      .all(fixture.botId, USER_ID, USER_ID) as unknown as { mode: string }[]
    assert.deepEqual(sessions.map((item) => item.mode), [], '角色变更应清理该目标的全部会话映射')

    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'role-chat-2', content: '你好' }))
    assert.ok(fixture.aiCalls.at(-1)?.prompt.includes('[角色卡：lofii]'), '停用个人角色后回落到默认 lofii')
    assert.equal(fixture.aiCalls.at(-1)?.prompt.includes('[角色卡：老师]'), false)

    await command(fixture, '/role on', 'role-5')
    await command(fixture, '/role delete', 'role-6')
    await command(fixture, '/role show', 'role-7')
    reply = lastMessageText(fixture)
    assert.equal(reply, '当前角色：lofii（默认）')
    assert.equal(reply.includes('角色卡详情'), false)
    assert.equal(
      (fixture.db
        .prepare('SELECT COUNT(*) AS n FROM bot_chat_roles WHERE bot_id = ? AND user_id = ?')
        .get(fixture.botId, USER_ID) as { n: number }).n,
      0,
    )
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.6：/role 不扩大其他命令权限，群内斜杠命令全部禁用', async () => {
  const fixture = setup()
  try {
    fixture.service.createTarget(fixture.botId, {
      externalId: GROUP_ID,
      label: '群',
      kind: 'group',
      allowCommands: true,
      allowNotifications: false,
      allowChat: true,
    })
    await command(fixture, '/status', 'role-7')
    assert.equal(fixture.fetch.sent.length, 0)
    assert.ok(fixture.audits.some((item) => item.action === 'bot.command.denied'))

    await groupCommand(fixture, '/role set 群角色 不应生效', 'role-8')
    assert.equal(
      (fixture.db.prepare('SELECT COUNT(*) AS n FROM bot_chat_roles WHERE bot_id = ?').get(fixture.botId) as { n: number }).n,
      0,
    )
    assert.equal(fixture.fetch.sent.length, 0, '群聊斜杠命令不再回复提示')
    assert.ok(fixture.audits.some((item) => item.action === 'bot.command.disabled'))
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.5：非法 /role set 不写库；群聊使用默认 lofii', async () => {
  const fixture = setup()
  try {
    await command(fixture, '/role set [坏] 设定', 'role-9')
    await command(fixture, '/role set 名字 包含 [安全边界] 的设定', 'role-10')
    await command(fixture, `/role set 名字 ${'x'.repeat(1001)}`, 'role-11')
    assert.equal(
      (fixture.db.prepare('SELECT COUNT(*) AS n FROM bot_chat_roles WHERE bot_id = ?').get(fixture.botId) as { n: number }).n,
      0,
    )

    fixture.service.createTarget(fixture.botId, {
      externalId: GROUP_ID,
      label: '群',
      kind: 'group',
      allowCommands: false,
      allowNotifications: false,
      allowChat: true,
    })
    await command(fixture, '/role set 猫娘 只影响私聊', 'role-12')

    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'role-chat-3', content: '私聊' }))
    await sendWebhook(
      fixture,
      groupWebhook(fixture.appSecret, {
        id: 'role-chat-4',
        content: '<@!102345000> 群聊',
        groupOpenid: GROUP_ID,
        memberOpenid: 'member-openid-1',
      }),
    )
    assert.equal(fixture.aiCalls.length, 2)
    assert.ok(fixture.aiCalls[0]?.prompt.includes('[角色卡：猫娘]'), '私聊 Chat 应使用个人角色卡')
    assert.ok(fixture.aiCalls[1]?.prompt.includes('[角色卡：lofii]'), '群聊应使用默认 lofii')
    assert.equal(fixture.aiCalls[1]?.prompt.includes('[角色卡：猫娘]'), false)
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.6：无个人卡时私聊使用默认 lofii，/role 文案友好', async () => {
  const fixture = setup()
  try {
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'role-chat-5', content: '你好' }))
    assert.ok(fixture.aiCalls[0]?.prompt.includes('[角色卡：lofii]'))
    assert.equal(fixture.aiCalls[0]?.prompt.includes('自然、友好、简洁地进行普通聊天'), false)

    await command(fixture, '/role show', 'role-13')
    let reply = lastMessageText(fixture)
    assert.ok(reply.includes('当前角色：lofii'))
    assert.equal(reply.includes('Chat'), false)
    assert.equal(reply.includes('会话'), false)
    assert.equal(reply.includes('/ask'), false)

    await command(fixture, '/role', 'role-14')
    reply = lastMessageText(fixture)
    assert.ok(reply.includes('可用命令'))
    assert.ok(reply.includes('/role set'))
    assert.equal(reply.includes('安全边界'), false)
    assert.equal(reply.includes('/ask'), false)
    assert.equal(reply.includes('猫系'), false)
    assert.equal(reply.includes('喵'), false)

    await command(fixture, '/role off', 'role-15')
    reply = lastMessageText(fixture)
    assert.ok(reply.includes('当前没有专属角色'))
    assert.equal(reply.includes('Chat'), false)
    assert.equal(reply.includes('会话'), false)
  } finally {
    fixture.cleanup()
  }
})
