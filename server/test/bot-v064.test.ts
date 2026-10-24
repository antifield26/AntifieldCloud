/**
 * v0.6.4 回归：全量群聊长合并窗口、消息发送工具、会话标题。
 * 全部使用进程内 QQ 事件与 AI 桩，不访问真实平台或模型。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  c2cWebhook,
  createQqServiceFixture,
  groupFullWebhook,
  sendWebhook,
} from './bot-qq-fixtures.ts'
import { BurstMerger } from '../src/bot/burst.ts'

const GROUP_ID = 'group-openid-v064'
const USER_ID = 'user-openid-v064'

function createUserTarget(fixture: ReturnType<typeof createQqServiceFixture>) {
  return fixture.service.createTarget(fixture.botId, {
    externalId: USER_ID,
    label: '私聊目标',
    kind: 'user',
    allowCommands: false,
    allowNotifications: false,
    allowChat: true,
  })
}

function createGroupTarget(fixture: ReturnType<typeof createQqServiceFixture>) {
  return fixture.service.createTarget(fixture.botId, {
    externalId: GROUP_ID,
    label: '全量群',
    kind: 'group',
    allowCommands: false,
    allowNotifications: false,
    allowChat: true,
    groupReplyMode: 'all',
  })
}

function turnFromPrompt(prompt: string): { turnId: string; turnToken: string } | null {
  const id = /turn_id=([A-Za-z0-9_-]+)/.exec(prompt)?.[1]
  const token = /turn_token=([A-Za-z0-9_-]+)/.exec(prompt)?.[1]
  return id && token ? { turnId: id, turnToken: token } : null
}

test('v0.6.4：BurstMerger 支持按入队覆盖合并窗口', async () => {
  const flushes: number[][] = []
  const merger = new BurstMerger<number>({
    windowMs: 0,
    maxWaitMs: 1000,
    maxItems: 10,
    onFlush: async (_key, items) => {
      flushes.push(items)
    },
  })
  merger.enqueue('k', 1, { windowMs: 80, maxWaitMs: 500 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  merger.enqueue('k', 2, { windowMs: 80, maxWaitMs: 500 })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(flushes.length, 0, '覆盖窗口内不得提前 flush')
  await new Promise((resolve) => setTimeout(resolve, 120))
  await merger.drain()
  assert.deepEqual(flushes, [[1, 2]])
})

test('v0.6.4：全量群聊非 @ 消息使用更长窗口合并为一次 AI 调用', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: {
      botChatBurstGroupAllWindowMs: 120,
      botChatBurstGroupAllMaxWaitMs: 500,
    },
  })
  try {
    createGroupTarget(fixture)
    const first = groupFullWebhook(fixture.appSecret, {
      id: 'v064-full-1',
      content: '第一句闲聊',
      groupOpenid: GROUP_ID,
    })
    const second = groupFullWebhook(fixture.appSecret, {
      id: 'v064-full-2',
      content: '第二句闲聊',
      groupOpenid: GROUP_ID,
    })
    await fixture.service.handleWebhook(fixture.botId, first.headers, first.body)
    await new Promise((resolve) => setTimeout(resolve, 40))
    await fixture.service.handleWebhook(fixture.botId, second.headers, second.body)
    await new Promise((resolve) => setTimeout(resolve, 180))
    await fixture.service.waitForIdle()
    assert.equal(fixture.aiCalls.length, 1, '两条非 @ 群消息应合并为一次 AI 调用')
    assert.match(fixture.aiCalls[0]?.prompt ?? '', /第一句闲聊[\s\S]*第二句闲聊/)
    assert.equal(fixture.fetch.sent.length, 1)
  } finally {
    fixture.cleanup()
  }
})

test('v0.6.4：工具拒绝空/无效回合凭据，单轮最多 5 条消息', async () => {
  let fixtureRef: ReturnType<typeof createQqServiceFixture> | null = null
  const statuses: number[] = []
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { botAiSendToolEnabled: true },
    aiHandler: async (call) => {
      const turn = turnFromPrompt(call.prompt)
      assert.ok(turn)
      assert.equal(
        fixtureRef?.service.handleAiSendTool({ turn_id: turn.turnId, turn_token: 'wrong-token', text: 'x' }).status,
        403,
      )
      for (let index = 0; index < 6; index += 1) {
        const result = fixtureRef?.service.handleAiSendTool({
          turn_id: turn.turnId,
          turn_token: turn.turnToken,
          text: `消息${index + 1}`,
        })
        statuses.push(result?.status ?? 0)
      }
      return '不应发送'
    },
  })
  fixtureRef = fixture
  try {
    createUserTarget(fixture)
    await sendWebhook(
      fixture,
      c2cWebhook(fixture.appSecret, { id: 'v064-c2c-limit', userOpenid: USER_ID, content: '你好' }),
    )
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429])
    assert.equal(fixture.fetch.sent.length, 5)
  } finally {
    fixture.cleanup()
  }
})

test('v0.6.4：无活跃回合时工具入口返回 404', () => {
  const fixture = createQqServiceFixture({ aiEnabled: true, configOverrides: { botAiSendToolEnabled: true } })
  try {
    assert.equal(
      fixture.service.handleAiSendTool({ turn_id: 'turn-x', turn_token: 'token-x', text: '你好' }).status,
      404,
    )
  } finally {
    fixture.cleanup()
  }
})

test('v0.6.4：私聊工具连续发送多条消息，并使用目标名称 + Chat 会话标题', async () => {
  let fixtureRef: ReturnType<typeof createQqServiceFixture> | null = null
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { botAiSendToolEnabled: true, botAiMemoryBatchMessages: 1 },
    aiHandler: async (call) => {
      const turn = turnFromPrompt(call.prompt)
      assert.ok(turn, '提示词应包含 turn_id/turn_token')
      assert.equal(fixtureRef?.service.handleAiSendTool({ turn_id: turn.turnId, turn_token: turn.turnToken, text: '第一条' }).status, 200)
      assert.equal(fixtureRef?.service.handleAiSendTool({ turn_id: turn.turnId, turn_token: turn.turnToken, text: '第二条' }).status, 200)
      return '最终文本不应发送'
    },
  })
  fixtureRef = fixture
  try {
    createUserTarget(fixture)
    await sendWebhook(
      fixture,
      c2cWebhook(fixture.appSecret, { id: 'v064-c2c-tool', userOpenid: USER_ID, content: '你好' }),
    )
    assert.equal(fixture.fetch.sent.length, 2)
    assert.deepEqual(
      fixture.fetch.sent.map((item) => item.body.content),
      ['第一条', '第二条'],
    )
    assert.equal(fixture.aiCalls[0]?.sessionTitle, '私聊目标 Chat')
    assert.ok(fixture.audits.some((item) => item.action === 'bot.ai.send' && item.detail?.messages === 2))
    assert.ok(!fixture.audits.some((item) => item.action === 'bot.ai.send_fallback'))
    assert.equal(fixture.extractCalls[0]?.sessionTitle, '私聊目标 Memory')
  } finally {
    fixture.cleanup()
  }
})

test('v0.6.4：私聊未调用工具时兜底发送最终文本', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { botAiSendToolEnabled: true },
    aiHandler: async () => '兜底回复',
  })
  try {
    createUserTarget(fixture)
    await sendWebhook(
      fixture,
      c2cWebhook(fixture.appSecret, { id: 'v064-c2c-fallback', userOpenid: USER_ID, content: '你好' }),
    )
    assert.equal(fixture.fetch.sent.length, 1)
    assert.equal(fixture.fetch.sent[0]?.body.content, '兜底回复')
    assert.ok(fixture.audits.some((item) => item.action === 'bot.ai.send_fallback'))
  } finally {
    fixture.cleanup()
  }
})

test('v0.6.4：全量群聊未调用工具即静默，不发送最终文本', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { botAiSendToolEnabled: true },
    aiHandler: async () => '不应发送',
  })
  try {
    createGroupTarget(fixture)
    await sendWebhook(
      fixture,
      groupFullWebhook(fixture.appSecret, {
        id: 'v064-full-silent',
        content: '群友闲聊',
        groupOpenid: GROUP_ID,
      }),
    )
    assert.equal(fixture.fetch.sent.length, 0)
    assert.equal(fixture.aiCalls.length, 1)
  } finally {
    fixture.cleanup()
  }
})
