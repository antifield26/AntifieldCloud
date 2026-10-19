import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.ts'
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
