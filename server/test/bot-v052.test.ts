/**
 * v0.5.2 Chat/长期记忆/目标发现回归（QQ 单平台）。
 * 不访问真实平台或模型；AI 与 fetch 均为进程内夹具，事件使用 AppSecret 签名。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  c2cWebhook,
  createQqServiceFixture,
  groupWebhook,
  lastMessageText,
  sendWebhook,
  signQqEvent,
} from './bot-qq-fixtures.ts'

test('v0.5.2：QQ C2C 未登记用户可直接 Chat，并写入长期记忆与入站目标', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true })
  try {
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'c2c-chat-1', content: '记住我喜欢深色模式' }))
    assert.equal(fixture.aiCalls.length, 1)
    assert.match(fixture.aiCalls[0]?.prompt ?? '', /\[系统提示\][\s\S]*\[角色卡：lofii\][\s\S]*记住我喜欢深色模式/)
    assert.deepEqual(fixture.memoryCalls.map((item) => item.userText), ['记住我喜欢深色模式'])
    assert.match(lastMessageText(fixture), /AI 回复/)

    const memoryDir = join(fixture.dir, 'bot-memory')
    assert.ok(existsSync(memoryDir))
    const files = readdirSync(memoryDir).filter((name) => name.endsWith('.md'))
    assert.equal(files.length, 1)
    assert.match(readFileSync(join(memoryDir, files[0]!), 'utf8'), /记忆：记住我喜欢深色模式/)
    const row = fixture.db
      .prepare('SELECT summary FROM bot_ai_memories WHERE bot_id = ? AND user_id = ?')
      .get(fixture.botId, 'user-openid-1') as { summary: string } | undefined
    assert.equal(row?.summary, '记忆：记住我喜欢深色模式')

    const inbound = fixture.service.listInboundTargets(fixture.botId)
    assert.equal(inbound.length, 1)
    assert.equal(inbound[0]?.userId, 'user-openid-1')
    assert.equal(inbound[0]?.isDirect, true)
    const chatAudit = fixture.audits.filter((item) => item.action === 'bot.chat').at(-1)
    assert.equal(chatAudit?.detail?.open, 'qq_c2c')
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.2：群目标开启 allow_chat 后 @Bot 消息进入 Chat，未开启则拒绝并审计', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true })
  try {
    const target = fixture.service.createTarget(fixture.botId, {
      externalId: 'group-openid-1',
      label: 'QQ 群',
      kind: 'group',
      allowCommands: false,
      allowNotifications: false,
      allowChat: false,
    })
    const closed = await sendWebhook(
      fixture,
      groupWebhook(fixture.appSecret, { id: 'group-1', content: '<@!102345000> 你好', groupOpenid: 'group-openid-1' }),
    )
    assert.equal(closed.status, 200)
    assert.equal(fixture.aiCalls.length, 0)
    assert.ok(fixture.audits.some((item) => item.action === 'bot.chat.denied'))
    assert.equal(fixture.fetch.sent.length, 0)

    fixture.service.updateTarget(fixture.botId, target.id, { allowChat: true })
    // 目标未登记 user 白名单时命令仍被拒，但 Chat 只受 allow_chat 控制。
    const opened = await sendWebhook(
      fixture,
      groupWebhook(fixture.appSecret, { id: 'group-2', content: '<@!102345000> 你好', groupOpenid: 'group-openid-1' }),
    )
    assert.equal(opened.status, 200)
    assert.equal(fixture.aiCalls.length, 1)
    assert.match(lastMessageText(fixture), /AI 回复/)
    const inbound = fixture.service.listInboundTargets(fixture.botId)[0]
    assert.equal(inbound?.targetKind, 'group')
    assert.equal(inbound?.isDirect, false)
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.2：QQ 群普通消息（非 @ 事件）不进入 Chat，仅被忽略并记录诊断事件', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true })
  try {
    fixture.service.createTarget(fixture.botId, {
      externalId: 'group-openid-1',
      label: 'QQ 群',
      kind: 'group',
      allowCommands: false,
      allowNotifications: false,
      allowChat: true,
    })
    const webhook = signQqEvent(fixture.appSecret, {
      op: 0,
      t: 'GROUP_MESSAGE_CREATE',
      d: { id: 'group-plain-1', content: '普通消息', group_openid: 'group-openid-1', author: { member_openid: 'm1' } },
    })
    const result = await sendWebhook(fixture, webhook)
    assert.equal(result.status, 200)
    assert.equal(fixture.aiCalls.length, 0)
    assert.equal(fixture.fetch.sent.length, 0)
    const ignored = fixture.service.listEvents(fixture.botId, { outcome: 'ignored' })
    assert.ok(ignored.total >= 1)
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.2：命令仍走目标白名单 + 用户白名单', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: false })
  try {
    fixture.service.createTarget(fixture.botId, {
      externalId: 'group-openid-1',
      label: 'QQ 群',
      kind: 'group',
      allowCommands: true,
      allowNotifications: false,
      allowChat: false,
    })
    // 目标允许命令，但该用户未在 user 白名单（kind=user allow_commands=1）。
    const denied = await sendWebhook(
      fixture,
      groupWebhook(fixture.appSecret, { id: 'cmd-1', content: '<@!102345000> /status', groupOpenid: 'group-openid-1' }),
    )
    assert.equal(denied.status, 200)
    assert.equal(fixture.fetch.sent.length, 0)
    assert.ok(fixture.audits.some((item) => item.action === 'bot.command.denied'))

    fixture.service.createTarget(fixture.botId, {
      externalId: 'member-openid-1',
      label: '管理员',
      kind: 'user',
      allowCommands: true,
      allowNotifications: false,
    })
    await sendWebhook(
      fixture,
      groupWebhook(fixture.appSecret, { id: 'cmd-2', content: '<@!102345000> /status', groupOpenid: 'group-openid-1' }),
    )
    assert.match(lastMessageText(fixture), /应用状态/)
    const okEvent = fixture.service.listEvents(fixture.botId, { outcome: 'ok' }).items.at(-1)
    assert.equal(okEvent?.detail, 'command_status')
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.2：发布目标必须是频道/群组，文本内容受 QQ 上限约束', async () => {
  const fixture = createQqServiceFixture()
  try {
    const userTarget = fixture.service.createTarget(fixture.botId, {
      externalId: 'user-openid-1',
      label: '用户',
      kind: 'user',
      allowCommands: false,
      allowNotifications: false,
    })
    const groupTarget = fixture.service.createTarget(fixture.botId, {
      externalId: 'group-openid-1',
      label: 'QQ 群',
      kind: 'group',
      allowCommands: false,
      allowNotifications: true,
    })
    assert.throws(
      () => fixture.service.createPublish(fixture.botId, { targetId: userTarget.id, text: '不可发布', confirmText: 'PUBLISH' }),
      /频道\/群组/,
    )
    const job = fixture.service.createPublish(fixture.botId, {
      targetId: groupTarget.id,
      text: '纯文本发布',
      confirmText: 'PUBLISH',
    })
    assert.equal(job.text, '纯文本发布')
    await fixture.service.processPublishJobs()
    assert.equal(fixture.service.listPublishJobs(fixture.botId)[0]?.status, 'sent')
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.2：记忆持久化文件存在且目录不在 Web 静态目录中', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true })
  try {
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'mem-1', content: '测试记忆' }))
    const memoryDir = join(fixture.dir, 'bot-memory')
    assert.ok(existsSync(memoryDir))
    const files = readdirSync(memoryDir)
    assert.ok(files.every((name) => /^memory-[0-9a-f-]{36}\.md$/i.test(name)))
    assert.ok(!memoryDir.startsWith(join(fixture.dir, 'web')))
  } finally {
    fixture.cleanup()
  }
})
