/**
 * v0.6.2 Bot 目标 QQ 号/群号回归：真实号码来自用户手工填写，仅用于页面识别；
 * 服务端校验数字格式，用户/群组可填，频道不接受。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createQqServiceFixture } from './bot-qq-fixtures.ts'

test('v0.6.2：目标可保存/更新 QQ 号/群号，非法或频道目标被拒绝', () => {
  const fixture = createQqServiceFixture()
  try {
    const target = fixture.service.createTarget(fixture.botId, {
      externalId: 'group-openid-qq-number',
      label: 'QQ 群',
      kind: 'group',
      qqNumber: '123456789',
      allowCommands: false,
      allowNotifications: true,
    })
    assert.equal(target.qqNumber, '123456789')

    const updated = fixture.service.updateTarget(fixture.botId, target.id, { qqNumber: '987654321' })
    assert.equal(updated.qqNumber, '987654321')
    assert.equal(fixture.service.listTargets(fixture.botId).find((item) => item.id === target.id)?.qqNumber, '987654321')

    const cleared = fixture.service.updateTarget(fixture.botId, target.id, { qqNumber: null })
    assert.equal(cleared.qqNumber, null)

    assert.throws(
      () =>
        fixture.service.createTarget(fixture.botId, {
          externalId: 'user-openid-bad-qq',
          label: '非法号码',
          kind: 'user',
          qqNumber: 'abc123',
          allowCommands: false,
          allowNotifications: true,
        }),
      /QQ 号\/群号需为 5–12 位数字/,
    )
    assert.throws(
      () =>
        fixture.service.createTarget(fixture.botId, {
          externalId: 'channel-openid-qq',
          label: '频道不接受号码',
          kind: 'channel',
          qqNumber: '123456789',
          allowCommands: false,
          allowNotifications: true,
        }),
      /仅适用于用户或群组目标/,
    )
  } finally {
    fixture.cleanup()
  }
})
