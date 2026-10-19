import test from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { buildApp } from '../src/app.ts'
import { createSession } from '../src/auth/sessions.ts'
import { cleanupDir, cookieHeader, currentCode, parseSetCookies, seedAdmin, tempDataDir, testConfig, testDb } from './helpers.ts'

interface Fixture {
  context: Awaited<ReturnType<typeof buildApp>>
  dir: string
  db: ReturnType<typeof testDb>
  seeded: Awaited<ReturnType<typeof seedAdmin>>
  close: () => Promise<void>
}

async function fixture(overrides: Parameters<typeof testConfig>[1] = {}): Promise<Fixture> {
  const dir = tempDataDir()
  const config = testConfig(dir, overrides)
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const context = await buildApp(config, db)
  return {
    context,
    dir,
    db,
    seeded,
    close: async () => {
      await context.app.close()
      db.close()
      cleanupDir(dir)
    },
  }
}

async function login(fx: Fixture, extraHeaders: Record<string, string> = {}): Promise<{ cookie: string; csrf: string; setCookie: string }> {
  const passwordRes = await fx.context.app.inject({
    method: 'POST',
    url: '/api/auth/password',
    headers: { host: 'app.test' },
    payload: { username: fx.seeded.username, password: fx.seeded.password },
  })
  assert.equal(passwordRes.statusCode, 200)
  const totpRes = await fx.context.app.inject({
    method: 'POST',
    url: '/api/auth/totp',
    headers: { host: 'app.test', ...extraHeaders },
    payload: {
      challenge: passwordRes.json().challenge,
      code: currentCode(fx.seeded.secret),
    },
  })
  assert.equal(totpRes.statusCode, 200, totpRes.body)
  const setCookie = (totpRes.headers['set-cookie'] as string[] | undefined)?.join('\n') ?? ''
  const cookies = parseSetCookies(totpRes.headers['set-cookie'] as string[] | undefined)
  return { cookie: cookieHeader(cookies), csrf: cookies.af_csrf!, setCookie }
}

function multipartBody(filename: string, content: Buffer): { body: Buffer; boundary: string } {
  const boundary = '----afauditboundary'
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\n` +
        'Content-Type: application/pdf\r\n\r\n',
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { body, boundary }
}

test('安全头：HSTS（无 includeSubDomains）、CSP manifest/worker、HTML XFO', async () => {
  const fx = await fixture()
  try {
    const health = await fx.context.app.inject({ method: 'GET', url: '/healthz', headers: { host: 'app.test' } })
    assert.equal(health.headers['strict-transport-security'], 'max-age=31536000')
    assert.doesNotMatch(String(health.headers['strict-transport-security']), /includeSubDomains/i)

    const html = await fx.context.app.inject({ method: 'GET', url: '/', headers: { host: 'app.test', accept: 'text/html' } })
    const csp = String(html.headers['content-security-policy'])
    assert.match(csp, /manifest-src 'self'/)
    assert.match(csp, /worker-src 'self'/)
    assert.equal(html.headers['x-frame-options'], 'SAMEORIGIN')
  } finally {
    await fx.close()
  }
})

test('AI 主机应用层响应补 nosniff/referrer/cache（302 与 401）', async () => {
  const fx = await fixture()
  try {
    const redirect = await fx.context.app.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'ai.test', accept: 'text/html' },
    })
    assert.equal(redirect.statusCode, 302)
    assert.equal(redirect.headers['x-content-type-options'], 'nosniff')
    assert.equal(redirect.headers['referrer-policy'], 'no-referrer')
    assert.equal(redirect.headers['cache-control'], 'no-store')

    const unauthorized = await fx.context.app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { host: 'ai.test', accept: 'application/json' },
    })
    assert.equal(unauthorized.statusCode, 401)
    assert.equal(unauthorized.headers['x-content-type-options'], 'nosniff')
    assert.equal(unauthorized.headers['cache-control'], 'no-store')
  } finally {
    await fx.close()
  }
})

test('AI 反代上游不可达时 502 也带安全头', async () => {
  const fx = await fixture({ opencodeUrl: 'http://127.0.0.1:1', opencodePassword: 'x' })
  await fx.context.app.listen({ host: '127.0.0.1', port: 0 })
  const address = fx.context.app.server.address()
  assert.ok(address && typeof address === 'object')
  const session = createSession(fx.db, fx.seeded.userId, 'csrf-502', 7, '127.0.0.1', 'test')
  try {
    const response = await new Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: address.port,
          path: '/api/session',
          method: 'GET',
          headers: { host: 'ai.test', cookie: `af_session=${session.token}`, accept: 'application/json' },
        },
        (res) => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers }),
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(response.statusCode, 502)
    assert.equal(response.headers['x-content-type-options'], 'nosniff')
    assert.equal(response.headers['referrer-policy'], 'no-referrer')
    assert.equal(response.headers['cache-control'], 'no-store')
  } finally {
    await fx.close()
  }
})

test('错误映射：未知 4xx 不回显原始 message/路径，FST 错误稳定', async () => {
  const fx = await fixture()
  try {
    const badJson = await fx.context.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { host: 'app.test', 'content-type': 'application/json' },
      payload: '{"username":',
    })
    assert.equal(badJson.statusCode, 400)
    assert.equal(badJson.json().error.code, 'invalid_request')
    assert.doesNotMatch(JSON.stringify(badJson.json()), /Unexpected|JSON.parse|position|server\/src/i)

    const badMedia = await fx.context.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { host: 'app.test', 'content-type': 'application/xml' },
      payload: '<x/>',
    })
    assert.equal(badMedia.statusCode, 415)
    assert.equal(badMedia.json().error.code, 'unsupported_media_type')

    const missing = await fx.context.app.inject({ method: 'GET', url: '/api/does-not-exist', headers: { host: 'app.test' } })
    assert.equal(missing.statusCode, 404)
    assert.equal(missing.json().error.code, 'not_found')
  } finally {
    await fx.close()
  }
})

test('内联 PDF 补 XFO 与 frame-ancestors CSP', async () => {
  const fx = await fixture()
  try {
    const session = await login(fx)
    const { body, boundary } = multipartBody('doc.pdf', Buffer.from('%PDF-1.4\n%audit\n'))
    const upload = await fx.context.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: {
        host: 'app.test',
        cookie: session.cookie,
        'x-csrf-token': session.csrf,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    })
    assert.equal(upload.statusCode, 200, upload.body)
    const item = upload.json().items[0] as { id: string }
    const content = await fx.context.app.inject({
      method: 'GET',
      url: `/api/files/${item.id}/content?inline=1`,
      headers: { host: 'app.test', cookie: session.cookie },
    })
    assert.equal(content.statusCode, 200)
    assert.equal(content.headers['content-type'], 'application/pdf')
    assert.match(String(content.headers['content-disposition']), /^inline/)
    assert.equal(content.headers['x-frame-options'], 'SAMEORIGIN')
    assert.match(String(content.headers['content-security-policy']), /frame-ancestors 'self'/)
  } finally {
    await fx.close()
  }
})

test('trustProxy 收紧：X-Forwarded-Host 不再影响 Cookie 域，XFP/CF-IP 仅在 loopback 对端可信', async () => {
  const fx = await fixture()
  try {
    const session = await login(fx, {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': '127.0.0.1',
      'cf-connecting-ip': '203.0.113.9',
    })
    // XFP=true（来自 loopback 对端）→ Secure；XFH 被忽略 → 仍按 Host(app.test) 设置 Domain。
    assert.match(session.setCookie, /Secure/i)
    assert.match(session.setCookie, /Domain=\.test/i)
    assert.doesNotMatch(session.setCookie, /Domain=127\.0\.0\.1/i)
    const me = await fx.context.app.inject({ method: 'GET', url: '/api/auth/me', headers: { host: 'app.test', cookie: session.cookie } })
    assert.equal(me.statusCode, 200)
    assert.equal(me.json().session.ip, '203.0.113.9')
  } finally {
    await fx.close()
  }
})

test('/api/auth/me 在 CSRF Cookie 缺失时轮换补发，旧 token 失效、新 token 可写', async () => {
  const fx = await fixture()
  try {
    const session = createSession(fx.db, fx.seeded.userId, 'old-csrf-token', 7, '127.0.0.1', 'test')
    const me = await fx.context.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { host: 'app.test', cookie: `af_session=${session.token}` },
    })
    assert.equal(me.statusCode, 200)
    const body = me.json() as { csrfToken: string }
    assert.ok(body.csrfToken)
    const rawSetCookie = me.headers['set-cookie']
    const setCookie = Array.isArray(rawSetCookie) ? rawSetCookie.join('\n') : String(rawSetCookie ?? '')
    assert.match(setCookie, /af_csrf=/)

    const created = await fx.context.app.inject({
      method: 'POST',
      url: '/api/files/folder',
      headers: { host: 'app.test', cookie: `af_session=${session.token}`, 'x-csrf-token': body.csrfToken },
      payload: { name: '补发后创建' },
    })
    assert.equal(created.statusCode, 201)

    const stale = await fx.context.app.inject({
      method: 'POST',
      url: '/api/files/folder',
      headers: { host: 'app.test', cookie: `af_session=${session.token}`, 'x-csrf-token': 'old-csrf-token' },
      payload: { name: '旧 token' },
    })
    assert.equal(stale.statusCode, 403)
  } finally {
    await fx.close()
  }
})

test('登录限流 429 带 Retry-After 与 details.retryAfterSec', async () => {
  const fx = await fixture()
  try {
    let lastStatus = 0
    let lastBody: unknown = null
    for (let index = 0; index < 6; index += 1) {
      const response = await fx.context.app.inject({
        method: 'POST',
        url: '/api/auth/password',
        headers: { host: 'app.test' },
        payload: { username: fx.seeded.username, password: 'wrong-password-123' },
      })
      lastStatus = response.statusCode
      lastBody = response.json()
      if (index < 5) {
        assert.equal(response.statusCode, 401)
      } else {
        assert.ok(Number(response.headers['retry-after']) >= 1)
      }
    }
    assert.equal(lastStatus, 429)
    const body = lastBody as { error: { code: string; details: { retryAfterSec: number } } }
    assert.equal(body.error.code, 'rate_limited')
    assert.ok(body.error.details.retryAfterSec >= 1)
  } finally {
    await fx.close()
  }
})
