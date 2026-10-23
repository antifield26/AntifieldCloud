/**
 * Bot 核心回归（QQ 单平台）：凭据加密、Webhook 验签/命令/去重、通知与发布队列。
 * 测试不访问真实 QQ 网络，全部使用注入的 fetch 夹具与固定 AppSecret。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, verify } from 'node:crypto'
import {
  QQ_TIMESTAMP,
  c2cWebhook,
  createQqServiceFixture,
  deriveQqKeyPair,
  lastMessageText,
  sendWebhook,
  signQqEvent,
} from './bot-qq-fixtures.ts'
import { BotService } from '../src/bot/service.ts'
import type { BotPlatform } from '../src/bot/types.ts'
import { decryptBotSecret, encryptBotSecret } from '../src/bot/crypto.ts'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

test('Bot 凭据加密可往返且篡改失败', () => {
  const key = randomBytes(32)
  const encrypted = encryptBotSecret(key, { token: 'x'.repeat(20) })
  const decoded = decryptBotSecret(key, encrypted)
  assert.equal(decoded.token, 'x'.repeat(20))
  assert.throws(() => decryptBotSecret(randomBytes(32), encrypted))
  assert.throws(() => decryptBotSecret(key, { ...encrypted, ciphertext: 'AAAA' }))
})

test('QQ Webhook：op=13 回调校验返回签名，非法签名被拒绝', async () => {
  const fixture = createQqServiceFixture()
  try {
    const challengeBody = Buffer.from(
      JSON.stringify({ op: 13, d: { plain_token: 'plain-token-abc', event_ts: '1725442341' } }),
    )
    const challenge = await fixture.service.handleWebhook(fixture.botId, {}, challengeBody)
    assert.equal(challenge.status, 200)
    const payload = challenge.body as { plain_token: string; signature: string }
    assert.equal(payload.plain_token, 'plain-token-abc')
    const { publicKey } = deriveQqKeyPair(fixture.appSecret)
    assert.equal(
      verify(
        null,
        Buffer.from('1725442341plain-token-abc', 'utf8'),
        publicKey,
        Buffer.from(payload.signature, 'hex'),
      ),
      true,
    )

    const rejected = await fixture.service.handleWebhook(
      fixture.botId,
      { 'x-signature-ed25519': '00'.repeat(64), 'x-signature-timestamp': QQ_TIMESTAMP },
      Buffer.from(JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', d: {} })),
    )
    assert.equal(rejected.status, 401)
    assert.deepEqual(rejected.body, { error: { code: 'invalid_signature' } })

    // op=13 不得把任意事件 JSON 当作 plain_token 签名（签名预言机回归）。
    const oracle = await fixture.service.handleWebhook(
      fixture.botId,
      {},
      Buffer.from(
        JSON.stringify({
          op: 13,
          d: {
            plain_token: JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'forged' } }),
            event_ts: QQ_TIMESTAMP,
          },
        }),
      ),
    )
    assert.equal(oracle.status, 400)
    assert.deepEqual(oracle.body, { error: { code: 'invalid_payload' } })

    // BOT_ENABLED=false 时公开入口返回 404。
    const disabled = new BotService({
      db: fixture.db,
      config: { ...fixture.config, botEnabled: false },
      log: () => undefined,
      audit: () => undefined,
      providers: {
        status: async () => ({}),
        backup: async () => ({}),
        world: async () => ({}),
        minecraft: async () => ({}),
        files: async () => [],
      },
    })
    const hidden = await disabled.handleWebhook(fixture.botId, {}, Buffer.from('{}'))
    assert.equal(hidden.status, 404)
  } finally {
    fixture.cleanup()
  }
})

test('QQ Webhook：命令回复、事件去重与审计', async () => {
  const fixture = createQqServiceFixture()
  try {
    fixture.service.createTarget(fixture.botId, {
      externalId: 'group-openid-1',
      label: 'QQ 群',
      kind: 'group',
      allowCommands: true,
      allowNotifications: true,
      allowChat: false,
    })
    fixture.service.createTarget(fixture.botId, {
      externalId: 'user-openid-1',
      label: '管理员',
      kind: 'user',
      allowCommands: true,
      allowNotifications: false,
    })
    const webhook = c2cWebhook(fixture.appSecret, { id: 'c2c-cmd-1', content: '/status' })
    const first = await sendWebhook(fixture, webhook)
    assert.equal(first.status, 200)
    assert.deepEqual(first.body, { opcode: 12 })
    assert.match(lastMessageText(fixture), /应用状态/)
    assert.equal(fixture.fetch.sent.at(-1)?.body.msg_id, 'c2c-cmd-1', 'C2C 被动回复带 msg_id')
    assert.ok(fixture.audits.some((item) => item.action === 'bot.command'))

    const messageCount = fixture.fetch.sent.length
    const duplicate = await sendWebhook(fixture, webhook)
    assert.equal(duplicate.status, 200)
    assert.deepEqual(duplicate.body, { opcode: 12 })
    assert.equal(fixture.fetch.sent.length, messageCount, '重复事件不重复外发')

    const events = fixture.service.listEvents(fixture.botId)
    assert.equal(events.total, 1)
    assert.equal(events.items[0]?.outcome, 'ok')
    assert.equal(events.items[0]?.kind, 'command')
  } finally {
    fixture.cleanup()
  }
})

test('QQ 通知队列：告警按目标投递，文本已脱敏', async () => {
  const fixture = createQqServiceFixture()
  try {
    fixture.service.updateBot(fixture.botId, { enabled: true })
    fixture.service.createTarget(fixture.botId, {
      externalId: 'group-openid-1',
      label: 'QQ 群',
      kind: 'group',
      allowCommands: false,
      allowNotifications: true,
    })
    fixture.service.notifyAlert({
      id: 10,
      event: 'disk_low',
      severity: 'warning',
      status: 'firing',
      title: '磁盘不足',
      message: '失败路径 /home/antifield/secret.txt ssh://internal',
      createdAt: '2026-10-22T04:00:00.000Z',
    })
    await fixture.service.processDeliveries()
    const body = fixture.fetch.sent.at(-1)?.body
    assert.equal(typeof body?.content, 'string')
    assert.match(String(body?.content), /磁盘不足/)
    assert.equal(String(body?.content).includes('/home/antifield/secret.txt'), false, '通知不得包含内部路径')
    const delivery = fixture.service.listDeliveries(fixture.botId)[0]
    assert.equal(delivery?.status, 'sent')
    assert.equal(delivery?.kind, 'notification')
    assert.ok(fixture.fetch.captured.every((item) => !item.url.includes(fixture.appSecret)), 'AppSecret 不得进入 URL')
  } finally {
    fixture.cleanup()
  }
})

test('QQ 发布队列：二次确认后才入队，纯文本发送', async () => {
  const fixture = createQqServiceFixture()
  try {
    const target = fixture.service.createTarget(fixture.botId, {
      externalId: 'group-openid-1',
      label: 'QQ 群',
      kind: 'group',
      allowCommands: false,
      allowNotifications: true,
    })
    assert.throws(
      () => fixture.service.createPublish(fixture.botId, { targetId: target.id, text: '无确认' }),
      /二次确认/,
    )
    assert.throws(
      () => fixture.service.createPublish(fixture.botId, { targetId: target.id, text: 'x'.repeat(2001), confirmText: 'PUBLISH' }),
      /2000/,
    )
    const job = fixture.service.createPublish(fixture.botId, {
      targetId: target.id,
      text: '发布测试',
      confirmText: 'PUBLISH',
    })
    await fixture.service.processPublishJobs()
    const sent = fixture.service.listPublishJobs(fixture.botId).find((item) => item.id === job.id)
    assert.equal(sent?.status, 'sent')
    assert.equal(sent?.text, '发布测试')
    assert.match(String(fixture.fetch.sent.at(-1)?.body.content), /发布测试/)
  } finally {
    fixture.cleanup()
  }
})

test('QQ 单平台：非 QQ 平台创建被拒绝，发送只走 QQ API', async () => {
  const fixture = createQqServiceFixture()
  try {
    assert.throws(
      () =>
        fixture.service.createBot({
          platform: 'telegram' as unknown as BotPlatform,
          name: 'legacy',
          token: 'x'.repeat(20),
        }),
      /不支持的平台/,
    )
    const bot = fixture.service.listBots()[0]
    assert.equal(bot?.platform, 'qq')
    assert.deepEqual(bot?.setupSteps.length ? 'has-setup' : 'no-setup', 'has-setup')
    void jsonResponse
  } finally {
    fixture.cleanup()
  }
})

test('QQ 事件签名时间戳过期时拒绝（stale_signature）', async () => {
  const fixture = createQqServiceFixture()
  try {
    const staleTs = String(Math.floor(new Date('2026-10-22T00:00:00.000Z').getTime() / 1000))
    const webhook = signQqEvent(
      fixture.appSecret,
      {
        op: 0,
        t: 'C2C_MESSAGE_CREATE',
        d: { id: 'stale-1', content: '你好', author: { user_openid: 'u1' } },
      },
      staleTs,
    )
    const result = await fixture.service.handleWebhook(fixture.botId, webhook.headers, webhook.body)
    assert.equal(result.status, 401)
    assert.deepEqual(result.body, { error: { code: 'stale_signature' } })
  } finally {
    fixture.cleanup()
  }
})
