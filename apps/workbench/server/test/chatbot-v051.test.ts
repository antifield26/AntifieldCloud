/**
 * v0.5.1 Chatbot 运维/AI 回归（QQ 单平台）：通知静默时段、指标、Chat AI 与发送链路。
 * 不访问真实平台；全部使用注入的 fetch 夹具与签名事件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  QQ_TOKEN_URL,
  c2cWebhook,
  createQqServiceFixture,
  lastMessageText,
  sendWebhook,
} from './chatbot-qq-fixtures.ts'

test('v0.5.1：静默时段延后通知，指标统计已发送投递', async () => {
  const fixture = createQqServiceFixture()
  try {
    fixture.service.createTarget(fixture.chatbotId, {
      externalId: 'group-openid-1',
      label: 'QQ 群',
      kind: 'group',
      allowCommands: false,
      allowNotifications: true,
    })
    const target = fixture.service.listTargets(fixture.chatbotId)[0]!
    // QQ_NOW = 2026-10-22T04:00Z = 上海 12:00；静默 11:00-14:00。
    fixture.service.updateTarget(fixture.chatbotId, target.id, { quietStartMinute: 11 * 60, quietEndMinute: 14 * 60 })
    fixture.service.notifyAlert({
      id: 1,
      event: 'disk_low',
      severity: 'warning',
      status: 'firing',
      title: '磁盘不足',
      message: '测试告警',
      createdAt: '2026-10-22T04:00:00.000Z',
    })
    const queued = fixture.db
      .prepare("SELECT next_attempt_at FROM chatbot_deliveries WHERE chatbot_id = ? AND kind = 'notification'")
      .get(fixture.chatbotId) as { next_attempt_at: string | null } | undefined
    assert.ok(queued?.next_attempt_at, '静默窗口内应设置 next_attempt_at')
    assert.equal(queued?.next_attempt_at, '2026-10-22T06:00:00.000Z')

    await fixture.service.testBot(fixture.chatbotId, target.id)
    const metrics = fixture.service.metrics(fixture.chatbotId, 24)
    assert.equal(metrics.deliveries.sent, 1)
    assert.equal(metrics.deliveries.successRate, 100)
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.9：C2C Chat 调用 AI（角色卡+安全边界），AI 关闭时不调用', async () => {
  const enabled = createQqServiceFixture({ aiEnabled: true, aiHandler: async () => '你好，这是 AI 回复' })
  try {
    const result = await sendWebhook(enabled, c2cWebhook(enabled.appSecret, { id: 'chat-1', content: '你好' }))
    assert.equal(result.status, 200)
    assert.equal(enabled.aiCalls.length, 1)
    assert.match(enabled.aiCalls[0]?.prompt ?? '', /\[角色卡：mcbot\][\s\S]*\[安全边界\][\s\S]*你好$/)
    assert.match(lastMessageText(enabled), /AI 回复/)
  } finally {
    enabled.cleanup()
  }

  const disabled = createQqServiceFixture({ aiEnabled: false })
  try {
    const result = await sendWebhook(disabled, c2cWebhook(disabled.appSecret, { id: 'chat-2', content: '你好' }))
    assert.equal(result.status, 200)
    assert.equal(disabled.aiCalls.length, 0)
  } finally {
    disabled.cleanup()
  }
})
test('v0.5.1：QQ Chatbot 可创建并通过服务发送文本', async () => {
  const fixture = createQqServiceFixture()
  try {
    const target = fixture.service.createTarget(fixture.chatbotId, {
      externalId: 'GROUP-OPENID',
      label: 'QQ 群',
      kind: 'group',
      allowCommands: true,
      allowNotifications: true,
    })
    await fixture.service.testBot(fixture.chatbotId, target.id)
    const urls = fixture.fetch.captured.map((item) => item.url)
    assert.ok(urls.includes(QQ_TOKEN_URL))
    assert.ok(urls.some((url) => url === 'https://api.sgroup.qq.com/v2/groups/GROUP-OPENID/messages'))
    const body = fixture.fetch.sent.at(-1)?.body
    assert.match(String(body?.content), /测试消息/)
    assert.equal(body?.msg_type, 0)
    assert.equal(body?.msg_id, undefined, '主动发送不带 msg_id')
  } finally {
    fixture.cleanup()
  }
})
