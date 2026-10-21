/**
 * Bot 管理路由安全回归：发布必须 TOTP 再认证（BOT-02），缺失验证码不得外发。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { buildApp } from '../src/app.ts'
import { hotp, currentStep } from '../src/auth/totp.ts'
import { cookieHeader, currentCode, parseSetCookies, seedAdmin, tempDataDir, testConfig, testDb } from './helpers.ts'

test('Bot 发布路由：无 TOTP 400，带有效 TOTP 才创建外发任务', async () => {
  const dir = tempDataDir()
  const config = testConfig(dir, { botEnabled: true, botSecretKey: randomBytes(32).toString('base64') })
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const context = await buildApp(config, db)
  try {
    const login = await context.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { username: seeded.username, password: seeded.password },
    })
    assert.equal(login.statusCode, 200, '密码步骤应成功')
    const challenge = login.json().challenge as string
    const totpLogin = await context.app.inject({
      method: 'POST',
      url: '/api/auth/totp',
      payload: { challenge, code: currentCode(seeded.secret) },
    })
    assert.equal(totpLogin.statusCode, 200, 'TOTP 步骤应成功')
    const cookies = parseSetCookies(totpLogin.headers['set-cookie'] as string[] | undefined)
    const cookie = cookieHeader(cookies)
    const csrf = cookies.af_csrf ?? ''

    const bot = context.bots.createBot({
      platform: 'telegram',
      name: 'route',
      token: 'x'.repeat(40),
      webhookSecret: 'secret-'.repeat(4),
    })
    context.bots.updateBot(bot.id, { enabled: true })
    const target = context.bots.createTarget(bot.id, {
      externalId: '123',
      label: 'chat',
      kind: 'group',
      allowCommands: false,
      allowNotifications: true,
    })

    const missing = await context.app.inject({
      method: 'POST',
      url: `/api/bots/${bot.id}/publish`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { targetId: target.id, text: '不应外发' },
    })
    assert.equal(missing.statusCode, 400)
    assert.equal(missing.json().error.code, 'totp_required')

    // 登录已消费当前 TOTP step，使用下一步窗口的验证码。
    const nextCode = hotp(seeded.secret, currentStep() + 1)
    const created = await context.app.inject({
      method: 'POST',
      url: `/api/bots/${bot.id}/publish`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        targetId: target.id,
        text: '外发测试',
        totpCode: nextCode,
        scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    })
    assert.equal(created.statusCode, 200)
    assert.equal(created.json().job.status, 'queued')
  } finally {
    await context.bots.waitForIdle()
    context.bots.stop()
    await context.bots.waitForIdle()
    await context.app.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
