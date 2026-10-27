/**
 * v0.5.9 Bot 对话回归（QQ 单平台）：普通 Chat 使用角色卡 + 安全边界 + 共享记忆；
 * /ask 已移除；/help 对非管理员开放且只显示公开命令（管理员显示全量）。
 * 不访问真实平台/模型；AI 与 fetch 均为进程内夹具，事件使用 AppSecret 签名。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SAFETY_BOUNDARY } from '../src/bot/prompts.ts'
import { helpText, publicHelpText } from '../src/bot/templates.ts'
import { c2cWebhook, createQqServiceFixture, lastMessageText, sendWebhook } from './bot-qq-fixtures.ts'

const USER = 'user-openid-1'

function setup(admin = false) {
  const fixture = createQqServiceFixture({ aiEnabled: true, aiHandler: async () => 'AI 回复' })
  fixture.db
    .prepare(
      `INSERT INTO bot_ai_memories (bot_id, user_id, memory_id, summary, summary_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(fixture.botId, USER, '11111111-1111-4111-8111-111111111111', '用户喜欢深色模式', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')
  if (admin) {
    fixture.service.createTarget(fixture.botId, {
      externalId: USER,
      label: '管理员',
      kind: 'user',
      allowCommands: true,
      allowNotifications: false,
    })
  }
  return fixture
}

test('v0.5.9：普通 Chat 使用 lofii 角色卡、安全边界与长期记忆，审计不含记忆正文', async () => {
  const fixture = setup()
  try {
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'chat-1', content: '今天有点累' }))
    assert.equal(fixture.aiCalls.length, 1)
    const prompt = fixture.aiCalls[0]?.prompt ?? ''
    assert.ok(prompt.includes('[角色卡：lofii]'))
    assert.ok(prompt.includes(SAFETY_BOUNDARY))
    assert.ok(prompt.includes('用户喜欢深色模式'))
    assert.match(prompt, /\[用户消息\]\n今天有点累$/)
    assert.match(lastMessageText(fixture), /AI 回复/)
    const audit = fixture.audits.filter((item) => item.action === 'bot.ai.chat').at(-1)
    assert.equal(audit?.detail?.mode, undefined, '审计不再记录已移除的 mode 字段')
    assert.ok(!JSON.stringify(fixture.audits).includes('用户喜欢深色模式'), '审计不含记忆正文')
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.9：个人角色卡覆盖默认 lofii', async () => {
  const fixture = setup()
  try {
    fixture.db
      .prepare(
        `INSERT INTO bot_chat_roles (bot_id, user_id, name, prompt, enabled, created_at, updated_at)
         VALUES (?, ?, '猫娘', '说话简短，偶尔用喵。', 1, ?, ?)`,
      )
      .run(fixture.botId, USER, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'chat-2', content: '你好' }))
    const prompt = fixture.aiCalls[0]?.prompt ?? ''
    assert.ok(prompt.includes('[角色卡：猫娘]'))
    assert.ok(prompt.includes('说话简短，偶尔用喵。'))
    assert.equal(prompt.includes('[角色卡：lofii]'), false)
    assert.ok(prompt.includes(SAFETY_BOUNDARY))
  } finally {
    fixture.cleanup()
  }
})

test('v0.6.4：/help 仅输出命令列表，无标题、说明或用法注释', () => {
  assert.deepEqual(helpText().split('\n'), [
    '/help',
    '/status',
    '/backup',
    '/world',
    '/mc',
    '/files',
    '/role',
    '/reset',
    '/forget',
    '/memory',
    '/search',
  ])
  assert.deepEqual(publicHelpText().split('\n'), [
    '/help',
    '/role',
    '/reset',
    '/forget',
    '/memory',
    '/search',
  ])
  for (const text of [helpText(), publicHelpText()]) {
    assert.equal(text.includes('查看帮助'), false)
    assert.equal(text.includes('命令仅在'), false)
    assert.equal(text.includes('AntifieldComplexx'), false)
    assert.equal(text.includes('Chat'), false)
    assert.equal(text.includes('管理员'), false)
  }
})

test('v0.5.9：/help 对非管理员开放，只显示公开命令；管理员显示全量', async () => {
  const nonAdmin = setup(false)
  try {
    const result = await sendWebhook(nonAdmin, c2cWebhook(nonAdmin.appSecret, { id: 'help-1', content: '/help' }))
    assert.equal(result.status, 200)
    const text = lastMessageText(nonAdmin)
    assert.equal(text, publicHelpText())
    assert.match(text, /\/reset/)
    assert.equal(text.includes('/status'), false, '非管理员帮助不暴露状态命令')
    assert.equal(text.includes('/ask'), false, '/ask 已移除')
  } finally {
    nonAdmin.cleanup()
  }

  const admin = setup(true)
  try {
    await sendWebhook(admin, c2cWebhook(admin.appSecret, { id: 'help-2', content: '/help' }))
    const text = lastMessageText(admin)
    assert.match(text, /\/status/)
    assert.match(text, /\/backup/)
    assert.equal(text.includes('/ask'), false, '/ask 已移除')
    // 已移除的 /ask 作为未知命令，管理员只收到完整帮助，不调用 AI。
    const before = admin.aiCalls.length
    await sendWebhook(admin, c2cWebhook(admin.appSecret, { id: 'ask-1', content: '/ask 你好' }))
    assert.equal(admin.aiCalls.length, before, '/ask 不再调用 AI')
    assert.match(lastMessageText(admin), /\/status/)
  } finally {
    admin.cleanup()
  }
})
