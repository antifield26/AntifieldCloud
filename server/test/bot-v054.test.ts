/**
 * v0.5.4 双模式 Bot 对话（QQ 单平台）：/ask 任务提示、普通 Chat 对话提示、共享记忆与审计 mode。
 * 不访问真实平台/模型；AI 与 fetch 均为进程内夹具，事件使用 AppSecret 签名。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CHAT_PROMPT, DEFAULT_TASK_PROMPT, SAFETY_BOUNDARY } from '../src/bot/prompts.ts'
import { c2cWebhook, createQqServiceFixture, sendWebhook } from './bot-qq-fixtures.ts'

function setup(overrides: { taskPrompt?: string; chatPrompt?: string } = {}) {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: {
      botAiTaskPrompt: overrides.taskPrompt ?? '',
      botAiChatPrompt: overrides.chatPrompt ?? '',
    },
  })
  // /ask 命令需要 user 白名单（C2C 的 targetExternalId 即 user openid）。
  fixture.service.createTarget(fixture.botId, {
    externalId: 'user-openid-1',
    label: '管理员',
    kind: 'user',
    allowCommands: true,
    allowNotifications: false,
  })
  fixture.db
    .prepare(
      `INSERT INTO bot_ai_memories (bot_id, user_id, memory_id, summary, summary_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      fixture.botId,
      'user-openid-1',
      '11111111-1111-4111-8111-111111111111',
      '用户喜欢深色模式',
      '2026-10-22T00:00:00.000Z',
      '2026-10-22T00:00:00.000Z',
    )
  return fixture
}

test('v0.5.4：/ask 使用任务提示、共享记忆并审计 mode=task', async () => {
  const fixture = setup()
  try {
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'ask-1', content: '/ask 整理备份现状' }))
    assert.equal(fixture.aiCalls.length, 1)
    assert.equal(fixture.aiCalls[0]?.mode, 'task')
    const prompt = fixture.aiCalls[0]?.prompt ?? ''
    assert.match(prompt, /^\[模式：任务\]/)
    assert.ok(prompt.includes(DEFAULT_TASK_PROMPT))
    assert.ok(prompt.includes(SAFETY_BOUNDARY))
    assert.ok(prompt.includes('用户喜欢深色模式'))
    assert.match(prompt, /\[用户消息\]\n整理备份现状$/)
    const audit = fixture.audits.filter((item) => item.action === 'bot.ai.chat').at(-1)
    assert.equal(audit?.detail?.mode, 'task')
    assert.ok(!JSON.stringify(fixture.audits).includes('用户喜欢深色模式'), '审计不含记忆正文')
    // /ask 回答按 QQ 纯文本发送（Markdown 标记已剥离）。
    assert.match(String(fixture.fetch.sent.at(-1)?.body.content), /AI 回复/)
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.6：普通 Chat 使用 lofii 默认角色，环境 Chat 覆盖不生效', async () => {
  const fixture = setup({ chatPrompt: '用轻松语气回答。' })
  try {
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'chat-1', content: '今天有点累' }))
    assert.equal(fixture.aiCalls.length, 1)
    assert.equal(fixture.aiCalls[0]?.mode, 'chat')
    const prompt = fixture.aiCalls[0]?.prompt ?? ''
    assert.match(prompt, /^\[模式：对话\]/)
    assert.ok(prompt.includes('[角色卡：lofii]'))
    assert.equal(prompt.includes('用轻松语气回答。'), false)
    assert.equal(prompt.includes(DEFAULT_CHAT_PROMPT), false)
    assert.ok(prompt.includes(SAFETY_BOUNDARY))
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.6：Task 自定义与 Chat lofii 默认互不串用，且共享记忆', async () => {
  const fixture = setup({ taskPrompt: '任务自定义提示。', chatPrompt: '对话自定义提示。' })
  try {
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'ask-2', content: '/ask 执行计划' }))
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'chat-2', content: '继续聊' }))
    assert.equal(fixture.aiCalls.length, 2)
    assert.ok(fixture.aiCalls[0]?.prompt.includes('任务自定义提示。'))
    assert.ok(fixture.aiCalls[0]?.prompt.includes('用户喜欢深色模式'))
    assert.equal(fixture.aiCalls[0]?.prompt.includes('对话自定义提示。'), false)
    assert.ok(fixture.aiCalls[1]?.prompt.includes('[角色卡：lofii]'))
    assert.equal(fixture.aiCalls[1]?.prompt.includes('对话自定义提示。'), false)
    assert.ok(fixture.aiCalls[1]?.prompt.includes('记忆：执行计划'), 'Chat 复用 /ask 更新后的长期记忆')
    assert.equal(fixture.aiCalls[1]?.prompt.includes('任务自定义提示。'), false)
  } finally {
    fixture.cleanup()
  }
})
