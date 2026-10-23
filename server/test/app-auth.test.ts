test('AI SSO ticket：一次性、过期、origin 绑定与容量上限', async () => {
  const dir = tempDataDir()
  const config = testConfig(dir)
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const context = await buildApp(config, db)
  try {
    const session = createSession(db, seeded.userId, 'csrf-ticket', 7, '127.0.0.1', 'test')
    const auth = context.auth
    const ticket = auth.createAiSsoTicket(session.token, 'https://ai.test')
    assert.match(ticket, /^[A-Za-z0-9_-]{43}$/)
    // 错误 origin 消费失败，且票据被销毁（一次性，防跨 origin 重试）。
    assert.equal(auth.consumeAiSsoTicket(ticket, 'https://other.test'), null)
    assert.equal(auth.consumeAiSsoTicket(ticket, 'https://ai.test'), null)
    // 过期（创建时间回拨 61 秒，超过 60 秒 TTL）。
    const expired = auth.createAiSsoTicket(session.token, 'https://ai.test', Date.now() - 61_000)
    assert.equal(auth.consumeAiSsoTicket(expired, 'https://ai.test'), null)
    // 正常消费返回原会话 token。
    const ok = auth.createAiSsoTicket(session.token, 'https://ai.test')
    assert.equal(auth.consumeAiSsoTicket(ok, 'https://ai.test'), session.token)
    // 容量上限 1000：最旧被淘汰，最新仍可消费。
    const codes: string[] = []
    for (let index = 0; index < 1001; index += 1) codes.push(auth.createAiSsoTicket(session.token, 'https://ai.test'))
    assert.equal(auth.consumeAiSsoTicket(codes[0]!, 'https://ai.test'), null)
    assert.equal(auth.consumeAiSsoTicket(codes[1000]!, 'https://ai.test'), session.token)
  } finally {
    await context.app.close()
    db.close()
    cleanupDir(dir)
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.ts'
import { createSession } from '../src/auth/sessions.ts'
import { cleanupDir, cookieHeader, currentCode, parseSetCookies, seedAdmin, tempDataDir, testConfig, testDb } from './helpers.ts'

test('登录两步、CSRF、会话与登出', async () => {
  const dir = tempDataDir()
  const config = testConfig(dir)
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const context = await buildApp(config, db)
  const app = context.app
  try {
    const health = await app.inject({ method: 'GET', url: '/healthz' })
    assert.equal(health.statusCode, 200)
    assert.equal(health.json().ok, true)

    const unknown = await app.inject({ method: 'GET', url: '/healthz', headers: { host: 'evil.test' } })
    assert.equal(unknown.statusCode, 404)

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { username: seeded.username, password: 'wrong-password' },
    })
    assert.equal(wrong.statusCode, 401)
    assert.equal(wrong.json().error.code, 'invalid_credentials')

    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { username: seeded.username, password: seeded.password },
    })
    assert.equal(first.statusCode, 200)
    const challenge = first.json().challenge as string

    const badTotp = await app.inject({
      method: 'POST',
      url: '/api/auth/totp',
      payload: { challenge, code: '000000' },
    })
    assert.equal(badTotp.statusCode, 401)

    const good = await app.inject({
      method: 'POST',
      url: '/api/auth/totp',
      payload: { challenge, code: currentCode(seeded.secret) },
    })
    assert.equal(good.statusCode, 200)
    const cookies = parseSetCookies(good.headers['set-cookie'] as string[] | undefined)
    assert.ok(cookies.af_session)
    assert.ok(cookies.af_csrf)
    const setCookie = (good.headers['set-cookie'] as string[]).join('\n')
    assert.match(setCookie, /af_session=[^;]+;[\s\S]*HttpOnly/i)
    assert.match(setCookie, /af_csrf=[^;]+/i)
    const cookie = cookieHeader(cookies)
    const csrf = cookies.af_csrf!

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    assert.equal(me.statusCode, 200)
    assert.equal(me.json().user.username, seeded.username)

    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/files/folder',
      headers: { cookie },
      payload: { name: '文档' },
    })
    assert.equal(noCsrf.statusCode, 403)
    assert.equal(noCsrf.json().error.code, 'csrf_failed')

    const created = await app.inject({
      method: 'POST',
      url: '/api/files/folder',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: '文档' },
    })
    assert.equal(created.statusCode, 201)
    assert.equal(created.json().name, '文档')

    const list = await app.inject({ method: 'GET', url: '/api/files', headers: { cookie } })
    assert.equal(list.statusCode, 200)
    assert.equal(list.json().total, 1)

    const aiHtml = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'ai.test', accept: 'text/html' },
    })
    assert.equal(aiHtml.statusCode, 302)
    assert.match(String(aiHtml.headers.location), /app\.test\/login/)

    const aiApi = await app.inject({ method: 'GET', url: '/api/session', headers: { host: 'ai.test' } })
    assert.equal(aiApi.statusCode, 401)

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, 'x-csrf-token': csrf },
    })
    assert.equal(logout.statusCode, 200)
    const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    assert.equal(after.statusCode, 401)
  } finally {
    await context.app.close()
    db.close()
    cleanupDir(dir)
  }
})
