/**
 * Webhook 路由集成测试：验证 raw body 解析、公开入口验签与错误码，不经真实平台网络。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { buildApp } from '../src/app.ts'
import { tempDataDir, testConfig, testDb } from './helpers.ts'

test('Bot Webhook 路由：raw body 验签成功/失败', async () => {
  const dir = tempDataDir()
  const config = testConfig(dir, { botEnabled: true, botSecretKey: randomBytes(32).toString('base64') })
  const db = testDb(dir)
  const context = await buildApp(config, db)
  try {
    const bot = context.bots.createBot({
      platform: 'telegram',
      name: 'route',
      token: 'x'.repeat(40),
      webhookSecret: 'secret-'.repeat(4),
    })
    context.bots.updateBot(bot.id, { enabled: true })
    context.bots.createTarget(bot.id, {
      externalId: '123',
      label: 'chat',
      kind: 'group',
      allowCommands: false,
      allowNotifications: true,
    })
    const payload = JSON.stringify({
      update_id: 7,
      message: { text: '/help', chat: { id: 123, type: 'private' }, from: { id: 456 } },
    })
    const ok = await context.app.inject({
      method: 'POST',
      url: `/api/bot/webhook/${bot.id}`,
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'secret-'.repeat(4) },
      payload,
    })
    assert.equal(ok.statusCode, 200)
    const bad = await context.app.inject({
      method: 'POST',
      url: `/api/bot/webhook/${bot.id}`,
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'bad' },
      payload,
    })
    assert.equal(bad.statusCode, 401)
    const unknown = await context.app.inject({
      method: 'POST',
      url: '/api/bot/webhook/00000000-0000-0000-0000-000000000000',
      headers: { 'content-type': 'application/json' },
      payload,
    })
    assert.equal(unknown.statusCode, 404)
  } finally {
    context.bots.stop()
    await context.app.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
