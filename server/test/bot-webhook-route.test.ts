/**
 * Webhook 路由集成测试（QQ 单平台）：验证 raw body 解析、公开入口验签与错误码，不经真实平台网络。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { buildApp } from '../src/app.ts'
import { tempDataDir, testConfig, testDb } from './helpers.ts'
import { signQqEvent } from './bot-qq-fixtures.ts'

const APP_ID = '102345679'
const APP_SECRET = 'qq-webhook-route-secret-0123456789abcdef'

test('Bot Webhook 路由：op=13 校验、签名事件成功与失败', async () => {
  const dir = tempDataDir()
  const config = testConfig(dir, { botEnabled: true, botSecretKey: randomBytes(32).toString('base64') })
  const db = testDb(dir)
  const context = await buildApp(config, db)
  try {
    const bot = context.bots.createBot({
      platform: 'qq',
      name: 'route',
      token: APP_SECRET,
      config: { appId: APP_ID },
    })
    context.bots.updateBot(bot.id, { enabled: true })
    context.bots.createTarget(bot.id, {
      externalId: 'user-openid-1',
      label: '管理员',
      kind: 'user',
      allowCommands: true,
      allowNotifications: true,
    })

    // op=13 回调地址校验不需要签名，直接返回本地签名。
    const challenge = await context.app.inject({
      method: 'POST',
      url: `/api/bot/webhook/${bot.id}`,
      headers: { 'content-type': 'application/json' },
      payload: { op: 13, d: { plain_token: 'plain-token-abc', event_ts: '1725442341' } },
    })
    assert.equal(challenge.statusCode, 200)
    assert.equal(challenge.json().plain_token, 'plain-token-abc')
    assert.match(challenge.json().signature, /^[0-9a-f]{128}$/)

    // 签名事件（当前时间戳）应通过验签并返回 opcode 12 确认。
    const timestamp = String(Math.floor(Date.now() / 1000))
    const webhook = signQqEvent(
      APP_SECRET,
      {
        op: 0,
        t: 'C2C_MESSAGE_CREATE',
        d: { id: 'webhook-msg-1', content: '/help', author: { user_openid: 'user-openid-1' } },
      },
      timestamp,
    )
    const ok = await context.app.inject({
      method: 'POST',
      url: `/api/bot/webhook/${bot.id}`,
      headers: { 'content-type': 'application/json', ...webhook.headers },
      payload: webhook.body,
    })
    assert.equal(ok.statusCode, 200)
    assert.deepEqual(ok.json(), { opcode: 12 })

    const bad = await context.app.inject({
      method: 'POST',
      url: `/api/bot/webhook/${bot.id}`,
      headers: { 'content-type': 'application/json', ...webhook.headers, 'x-signature-ed25519': '00'.repeat(64) },
      payload: webhook.body,
    })
    assert.equal(bad.statusCode, 401)
    assert.equal(bad.json().error.code, 'invalid_signature')

    const unknown = await context.app.inject({
      method: 'POST',
      url: '/api/bot/webhook/00000000-0000-0000-0000-000000000000',
      headers: { 'content-type': 'application/json' },
      payload: { op: 0, t: 'C2C_MESSAGE_CREATE', d: {} },
    })
    assert.equal(unknown.statusCode, 404)
  } finally {
    context.bots.stop()
    await context.app.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
