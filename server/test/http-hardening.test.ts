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

test('Cookie host-only：登录响应无 Domain，并在同一响应清理旧父域 Cookie', async () => {
  const fx = await fixture()
  try {
    const session = await login(fx, {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': '127.0.0.1',
      'cf-connecting-ip': '203.0.113.9',
    })
    const lines = session.setCookie.split('\n').filter(Boolean)
    // XFP=true（来自 loopback 对端）→ Secure；新 Cookie 一律 host-only（无 Domain）。
    assert.match(session.setCookie, /Secure/i)
    const fresh = lines.filter((line) => /\baf_(session|csrf)=/.test(line) && !/Max-Age=0/i.test(line))
    assert.equal(fresh.length, 2, session.setCookie)
    for (const line of fresh) assert.doesNotMatch(line, /Domain=/i, line)
    // 过渡期：额外删除旧父域 af_session/af_csrf（testConfig legacyCookieDomain='.test'）。
    const legacy = lines.filter((line) => /Domain=\.test/i.test(line))
    assert.equal(legacy.length, 2, session.setCookie)
    for (const name of ['af_session', 'af_csrf']) {
      const line = legacy.find((entry) => entry.startsWith(`${name}=`))
      assert.ok(line, `缺少旧父域 ${name} 清理：${session.setCookie}`)
      assert.match(line, /Max-Age=0/i)
      assert.match(line, /Path=\//i)
      assert.match(line, /Secure/i)
      assert.match(line, /SameSite=Lax/i)
    }
    // 新 Cookie 仍可用：/api/auth/me 正常，X-Forwarded-Host 不参与判断。
    const me = await fx.context.app.inject({ method: 'GET', url: '/api/auth/me', headers: { host: 'app.test', cookie: session.cookie } })
    assert.equal(me.statusCode, 200)
    assert.equal(me.json().session.ip, '203.0.113.9')
  } finally {
    await fx.close()
  }
})

test('AI SSO：/api/auth/ai-ticket 鉴权、next 同源校验、302 与一次性 ticket', async () => {
  const fx = await fixture()
  try {
    const unauth = await fx.context.app.inject({
      method: 'GET',
      url: `/api/auth/ai-ticket?next=${encodeURIComponent('https://ai.test/')}`,
      headers: { host: 'app.test' },
    })
    assert.equal(unauth.statusCode, 401)

    const session = await login(fx)
    const headers = { host: 'app.test', cookie: session.cookie }
    for (const next of ['', 'https://evil.test/', 'https://ai.test.evil.test/', 'https://ai.test@evil.test/', 'http://ai.test/']) {
      const bad = await fx.context.app.inject({
        method: 'GET',
        url: `/api/auth/ai-ticket?next=${encodeURIComponent(next)}`,
        headers,
      })
      assert.equal(bad.statusCode, 400, `next=${next}: ${bad.body}`)
      assert.equal(bad.json().error.code, 'invalid_next')
    }
    const missing = await fx.context.app.inject({ method: 'GET', url: '/api/auth/ai-ticket', headers })
    assert.equal(missing.statusCode, 400)

    const ok = await fx.context.app.inject({
      method: 'GET',
      url: `/api/auth/ai-ticket?next=${encodeURIComponent('https://ai.test/session/abc?x=1#fragment')}`,
      headers,
    })
    assert.equal(ok.statusCode, 302, ok.body)
    assert.equal(ok.headers['cache-control'], 'no-store')
    const location = String(ok.headers.location)
    assert.match(location, /^https:\/\/ai\.test\/__af\/sso\/[A-Za-z0-9_-]{20,128}\?next=%2Fsession%2Fabc%3Fx%3D1$/)
    const ticket = /\/__af\/sso\/([A-Za-z0-9_-]+)/.exec(location)?.[1]
    assert.ok(ticket)
    // ticket 一次性：服务层直接消费一次成功，再次失败。
    assert.ok(fx.context.auth.consumeAiSsoTicket(ticket, 'https://ai.test'))
    assert.equal(fx.context.auth.consumeAiSsoTicket(ticket, 'https://ai.test'), null)
  } finally {
    await fx.close()
  }
})

test('Origin 收口：aiOrigin 不再被 app 写请求与公开分享 unlock 接受', async () => {
  const fx = await fixture()
  try {
    const session = await login(fx)
    const write = await fx.context.app.inject({
      method: 'POST',
      url: '/api/files/folder',
      headers: {
        host: 'app.test',
        cookie: session.cookie,
        'x-csrf-token': session.csrf,
        origin: 'https://ai.test',
      },
      payload: { name: 'from-ai' },
    })
    assert.equal(write.statusCode, 403)
    assert.equal(write.json().error.code, 'csrf_failed')
    const writeOk = await fx.context.app.inject({
      method: 'POST',
      url: '/api/files/folder',
      headers: {
        host: 'app.test',
        cookie: session.cookie,
        'x-csrf-token': session.csrf,
        origin: 'https://app.test',
      },
      payload: { name: 'from-app' },
    })
    assert.equal(writeOk.statusCode, 201)

    const { body, boundary } = multipartBody('share.txt', Buffer.from('hello'))
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
    const fileId = upload.json().items[0].id as string
    const share = await fx.context.app.inject({
      method: 'POST',
      url: `/api/files/${fileId}/shares`,
      headers: { host: 'app.test', cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: { password: 'share-pass-123' },
    })
    assert.equal(share.statusCode, 201, share.body)
    const token = (share.json().url as string).split('/s/')[1]!
    const unlock = await fx.context.app.inject({
      method: 'POST',
      url: `/api/public/shares/${token}/unlock`,
      headers: {
        host: 'app.test',
        'x-forwarded-proto': 'https',
        origin: 'https://ai.test',
        'content-type': 'application/json',
      },
      payload: { password: 'share-pass-123' },
    })
    assert.equal(unlock.statusCode, 403)
    assert.equal(unlock.json().error.code, 'origin_rejected')
    const unlockOk = await fx.context.app.inject({
      method: 'POST',
      url: `/api/public/shares/${token}/unlock`,
      headers: {
        host: 'app.test',
        'x-forwarded-proto': 'https',
        origin: 'https://app.test',
        'content-type': 'application/json',
      },
      payload: { password: 'share-pass-123' },
    })
    assert.equal(unlockOk.statusCode, 200, unlockOk.body)
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
