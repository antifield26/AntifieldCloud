/**
 * v0.6.3 群聊角色卡 / 群消息模式 / 群聊命令禁用回归。
 * 全部使用进程内 QQ 事件与 AI 桩，不访问真实平台或模型。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createQqServiceFixture,
  groupFullWebhook,
  groupWebhook,
  lastMessageText,
  sendWebhook,
} from './bot-qq-fixtures.ts'

const GROUP_ID = 'group-openid-v063'

function createGroupTarget(
  fixture: ReturnType<typeof createQqServiceFixture>,
  mode: 'mention' | 'all' = 'mention',
) {
  return fixture.service.createTarget(fixture.botId, {
    externalId: GROUP_ID,
    label: 'v0.6.3 群',
    kind: 'group',
    allowCommands: false,
    allowNotifications: false,
    allowChat: true,
    groupReplyMode: mode,
  })
}

test('v0.6.3：群聊角色卡/群消息模式输入校验', () => {
  const fixture = createQqServiceFixture({ aiEnabled: true })
  try {
    const group = createGroupTarget(fixture)
    assert.throws(() => fixture.service.saveGroupRole(fixture.botId, group.id, '', '设定'), /名字/)
    assert.throws(() => fixture.service.saveGroupRole(fixture.botId, group.id, '角色', ''), /设定/)
    assert.throws(
      () => fixture.service.saveGroupRole(fixture.botId, group.id, '角色', 'x'.repeat(1001)),
      /设定/,
    )
    const user = fixture.service.createTarget(fixture.botId, {
      externalId: 'user-openid-v063',
      label: '用户',
      kind: 'user',
      allowCommands: false,
      allowNotifications: false,
    })
    assert.throws(() => fixture.service.saveGroupRole(fixture.botId, user.id, '角色', '设定'), /仅群聊目标/)
    assert.throws(
      () =>
        fixture.service.createTarget(fixture.botId, {
          externalId: 'user-openid-v063-2',
          label: '用户2',
          kind: 'user',
          allowCommands: false,
          allowNotifications: false,
          groupReplyMode: 'all',
        }),
      /仅群聊目标支持接收全部消息/,
    )
    assert.throws(
      () => fixture.service.updateTarget(fixture.botId, user.id, { groupReplyMode: 'all' }),
      /仅群聊目标支持接收全部消息/,
    )
  } finally {
    fixture.cleanup()
  }
})

test('v0.6.3：群聊角色卡保存/查询/启停/删除，目标改非群聊时移除', () => {
  const fixture = createQqServiceFixture({ aiEnabled: true })
  try {
    const target = createGroupTarget(fixture)
    const saved = fixture.service.saveGroupRole(
      fixture.botId,
      target.id,
      '群助手',
      '你是本群的运维助手，回答简洁。',
    )
    assert.equal(saved.name, '群助手')
    assert.equal(saved.prompt, '你是本群的运维助手，回答简洁。')
    const list = fixture.service.listGroupRoles(fixture.botId)
    assert.equal(list.items.length, 1)
    assert.equal(list.items[0]?.targetLabel, 'v0.6.3 群')
    assert.equal(list.items[0]?.name, '群助手')
    assert.equal(list.items[0]?.enabled, true)
    assert.equal(fixture.service.getGroupRole(fixture.botId, target.id)?.prompt, '你是本群的运维助手，回答简洁。')

    fixture.service.setGroupRoleEnabled(fixture.botId, target.id, false)
    assert.equal(fixture.service.getGroupRole(fixture.botId, target.id)?.enabled, false)

    fixture.service.updateTarget(fixture.botId, target.id, { kind: 'user' })
    assert.equal(fixture.service.listGroupRoles(fixture.botId).items.length, 0)
    assert.throws(
      () => fixture.service.getGroupRole(fixture.botId, target.id),
      /仅群聊目标支持独立角色卡/,
    )
  } finally {
    fixture.cleanup()
  }
})

test('v0.6.3：群聊角色卡覆盖该群 AI 提示词', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true })
  try {
    const target = createGroupTarget(fixture)
    fixture.service.saveGroupRole(fixture.botId, target.id, '群助手', '群聊专用设定：先给结论。')
    await sendWebhook(
      fixture,
      groupWebhook(fixture.appSecret, {
        id: 'group-role-msg-1',
        content: '<@!102345000> 你好',
        groupOpenid: GROUP_ID,
      }),
    )
    const prompt = fixture.aiCalls[0]?.prompt ?? ''
    assert.match(prompt, /\[角色卡：群助手\]/)
    assert.match(prompt, /群聊专用设定：先给结论。/)
    assert.match(lastMessageText(fixture), /AI 回复/)
  } finally {
    fixture.cleanup()
  }
})

test('v0.6.3：仅@/名字提及模式过滤全量群消息；@或名字命中才进入 AI', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true })
  try {
    createGroupTarget(fixture, 'mention')
    await sendWebhook(
      fixture,
      groupFullWebhook(fixture.appSecret, {
        id: 'group-full-ignore-1',
        content: '大家随便聊聊',
        groupOpenid: GROUP_ID,
      }),
    )
    assert.equal(fixture.aiCalls.length, 0)
    assert.equal(fixture.fetch.sent.length, 0)
    const ignored = fixture.service.listEvents(fixture.botId, { outcome: 'ignored' }).items
    assert.ok(ignored.some((item) => item.detail === 'mention_filtered'))

    await sendWebhook(
      fixture,
      groupFullWebhook(fixture.appSecret, {
        id: 'group-full-name-1',
        content: 'qq-test 帮忙看看状态',
        groupOpenid: GROUP_ID,
      }),
    )
    assert.equal(fixture.aiCalls.length, 1)

    await sendWebhook(
      fixture,
      groupFullWebhook(fixture.appSecret, {
        id: 'group-full-mention-1',
        content: '<@102345000> 帮忙看看状态',
        groupOpenid: GROUP_ID,
        mentions: [{ id: '102345000', bot: true }],
      }),
    )
    assert.equal(fixture.aiCalls.length, 2)
  } finally {
    fixture.cleanup()
  }
})

test('v0.6.3：全量消息模式由模型 NO_REPLY 决定不发送，正常回答则发送', async () => {
  let reply = 'NO_REPLY'
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    aiHandler: async () => reply,
  })
  try {
    createGroupTarget(fixture, 'all')
    await sendWebhook(
      fixture,
      groupFullWebhook(fixture.appSecret, {
        id: 'group-all-silent-1',
        content: '今天天气不错',
        groupOpenid: GROUP_ID,
      }),
    )
    assert.equal(fixture.aiCalls.length, 1)
    assert.equal(fixture.fetch.sent.length, 0)
    const ignored = fixture.service.listEvents(fixture.botId, { outcome: 'ignored' }).items
    assert.ok(ignored.some((item) => item.detail === 'no_reply'))

    reply = '需要我帮忙可以叫我。'
    await sendWebhook(
      fixture,
      groupFullWebhook(fixture.appSecret, {
        id: 'group-all-reply-1',
        content: '有人会修打印机吗',
        groupOpenid: GROUP_ID,
      }),
    )
    assert.equal(fixture.aiCalls.length, 2)
    assert.match(lastMessageText(fixture), /需要我帮忙/)
  } finally {
    fixture.cleanup()
  }
})

test('v0.6.3：群聊 @ 消息即使全量模式也不受 NO_REPLY 影响；群聊命令仍被忽略', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true, aiHandler: async () => '已收到' })
  try {
    createGroupTarget(fixture, 'all')
    await sendWebhook(
      fixture,
      groupFullWebhook(fixture.appSecret, {
        id: 'group-all-mentioned-1',
        content: '<@102345000> 在吗',
        groupOpenid: GROUP_ID,
        mentions: [{ id: '102345000', bot: true }],
      }),
    )
    assert.match(lastMessageText(fixture), /已收到/)

    const sentBefore = fixture.fetch.sent.length
    await sendWebhook(
      fixture,
      groupWebhook(fixture.appSecret, {
        id: 'group-command-1',
        content: '<@!102345000> /status',
        groupOpenid: GROUP_ID,
      }),
    )
    assert.equal(fixture.fetch.sent.length, sentBefore)
    assert.ok(fixture.audits.some((item) => item.action === 'bot.command.disabled'))
  } finally {
    fixture.cleanup()
  }
})
