/**
 * v0.7.1：群聊共享会话。
 *
 * 同一群内不同成员必须进入同一个 AI 会话（模型可见多用户历史），但限流/记忆/审计仍按真实用户；
 * 私聊保持每个用户独立会话。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  c2cWebhook,
  createQqServiceFixture,
  groupWebhook,
  sendWebhook,
} from './bot-qq-fixtures.ts'
import { GROUP_CHAT_SESSION_USER_ID } from '../src/bot/session.ts'

const GROUP_ID = 'group-openid-v071'

function createGroupTarget(fixture: ReturnType<typeof createQqServiceFixture>) {
  return fixture.service.createTarget(fixture.botId, {
    externalId: GROUP_ID,
    label: 'v0.7.1 群',
    kind: 'group',
    allowCommands: false,
    allowNotifications: false,
    allowChat: true,
    groupReplyMode: 'mention',
  })
}

test('v0.7.1：同一群不同成员的 AI 调用使用共享会话键，真实用户仍分别记账', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    aiHandler: async () => 'AI 回复',
    configOverrides: { botChatBurstWindowMs: 0 },
  })
  try {
    createGroupTarget(fixture)
    await sendWebhook(
      fixture,
      groupWebhook(fixture.appSecret, {
        id: 'v071-group-a',
        content: `<@!${fixture.appId}> 你好，我是甲`,
        groupOpenid: GROUP_ID,
        memberOpenid: 'member-openid-a',
        userName: '甲',
      }),
    )
    await sendWebhook(
      fixture,
      groupWebhook(fixture.appSecret, {
        id: 'v071-group-b',
        content: `<@!${fixture.appId}> 你好，我是乙`,
        groupOpenid: GROUP_ID,
        memberOpenid: 'member-openid-b',
        userName: '乙',
      }),
    )
    assert.equal(fixture.aiCalls.length, 2)
    assert.equal(fixture.aiCalls[0]?.sessionUserId, GROUP_CHAT_SESSION_USER_ID)
    assert.equal(fixture.aiCalls[1]?.sessionUserId, GROUP_CHAT_SESSION_USER_ID)
    assert.equal(fixture.aiCalls[0]?.userId, 'member-openid-a')
    assert.equal(fixture.aiCalls[1]?.userId, 'member-openid-b')
    assert.equal(fixture.aiCalls[0]?.sharedSession, true)
    assert.equal(fixture.aiCalls[1]?.sharedSession, true)
    assert.match(fixture.aiCalls[0]?.prompt ?? '', /\[用户消息\]\n甲：/)
    assert.match(fixture.aiCalls[1]?.prompt ?? '', /\[用户消息\]\n乙：/)
  } finally {
    fixture.cleanup()
  }
})

test('v0.7.1：私聊仍按真实用户独立会话，不传共享会话键', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    aiHandler: async () => 'AI 回复',
    configOverrides: { botChatBurstWindowMs: 0 },
  })
  try {
    await sendWebhook(
      fixture,
      c2cWebhook(fixture.appSecret, { id: 'v071-c2c-a', content: '你好', userOpenid: 'user-a' }),
    )
    await sendWebhook(
      fixture,
      c2cWebhook(fixture.appSecret, { id: 'v071-c2c-b', content: '你好', userOpenid: 'user-b' }),
    )
    assert.equal(fixture.aiCalls.length, 2)
    assert.equal(fixture.aiCalls[0]?.sessionUserId, undefined)
    assert.equal(fixture.aiCalls[1]?.sessionUserId, undefined)
    assert.equal(fixture.aiCalls[0]?.userId, 'user-a')
    assert.equal(fixture.aiCalls[1]?.userId, 'user-b')
  } finally {
    fixture.cleanup()
  }
})
