import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { request } from 'node:http'
import { buildApp } from '../src/app.ts'
import { createSession } from '../src/auth/sessions.ts'
import { cleanupDir, seedAdmin, tempDataDir, testConfig, testDb } from './helpers.ts'

interface UpstreamRecord {
  authorization: string | undefined
  cookie: string | undefined
  url: string | undefined
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address) resolve(address.port)
    })
  })
}

function get(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('opencode 反代：会话校验、注入 Basic、剥离 Cookie', async () => {
  const upstreamRecords: UpstreamRecord[] = []
  const upstream = createServer((req, res) => {
    upstreamRecords.push({
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
      url: req.url,
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [] }))
  })
  const upstreamPort = await listen(upstream)
  const dir = tempDataDir()
  const config = testConfig(dir, {
    opencodeUrl: `http://127.0.0.1:${upstreamPort}`,
    opencodePassword: 'super-secret',
    opencodeUsername: 'opencode',
  })
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const session = createSession(db, seeded.userId, 'csrf-token', 7, '127.0.0.1', 'test')
  const context = await buildApp(config, db)
  const app = context.app
  await app.listen({ host: '127.0.0.1', port: 0 })
  const appAddress = app.server.address()
  assert.ok(appAddress && typeof appAddress === 'object')
  try {
    const authed = await get(appAddress.port, '/api/session', {
      host: 'ai.test',
      cookie: `af_session=${session.token}`,
    })
    assert.equal(authed.status, 200)
    assert.equal(authed.body, '{"data":[]}')
    assert.equal(upstreamRecords.length, 1)
    const expected = `Basic ${Buffer.from('opencode:super-secret', 'utf8').toString('base64')}`
    assert.equal(upstreamRecords[0]?.authorization, expected)
    assert.equal(upstreamRecords[0]?.cookie, undefined)
    assert.equal(upstreamRecords[0]?.url, '/api/session')

    const unauthApi = await get(appAddress.port, '/api/session', { host: 'ai.test', accept: 'application/json' })
    assert.equal(unauthApi.status, 401)

    const unauthHtml = await get(appAddress.port, '/', { host: 'ai.test', accept: 'text/html' })
    assert.equal(unauthHtml.status, 302)
  } finally {
    await app.close()
    upstream.close()
    db.close()
    cleanupDir(dir)
  }
})

test('AI 主机 HTTP Origin 校验：app/ai 允许，兄弟子域/null/错误协议 403 并审计', async () => {
  const upstreamRecords: UpstreamRecord[] = []
  const upstream = createServer((req, res) => {
    upstreamRecords.push({ authorization: req.headers.authorization, cookie: req.headers.cookie, url: req.url })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"data":[]}')
  })
  const upstreamPort = await listen(upstream)
  const dir = tempDataDir()
  const config = testConfig(dir, {
    opencodeUrl: `http://127.0.0.1:${upstreamPort}`,
    opencodePassword: 'super-secret',
  })
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const session = createSession(db, seeded.userId, 'csrf-token', 7, '127.0.0.1', 'test')
  const context = await buildApp(config, db)
  const app = context.app
  await app.listen({ host: '127.0.0.1', port: 0 })
  const appAddress = app.server.address()
  assert.ok(appAddress && typeof appAddress === 'object')
  try {
    const headers = { host: 'ai.test', cookie: `af_session=${session.token}` }
    for (const origin of ['https://ai.test', 'https://app.test']) {
      const allowed = await get(appAddress.port, '/api/session', { ...headers, origin })
      assert.equal(allowed.status, 200, `Origin=${origin} 应放行`)
    }
    assert.equal(upstreamRecords.length, 2)

    for (const origin of ['https://evil.test', 'https://app.test.evil.test', 'null', 'http://ai.test', 'https://ai.test:8443']) {
      const rejected = await get(appAddress.port, '/api/session', { ...headers, origin })
      assert.equal(rejected.status, 403, `Origin=${origin} 应被拒绝`)
      assert.match(rejected.body, /origin_rejected/)
    }
    assert.equal(upstreamRecords.length, 2, '被拒绝请求不得触达上游')
    const auditRows = db
      .prepare("SELECT action, target, detail_json FROM audit_log WHERE action = 'opencode_origin_rejected'")
      .all() as unknown as { action: string; target: string; detail_json: string }[]
    assert.equal(auditRows.length, 5)
    assert.ok(auditRows.every((row) => row.target.length <= 256))

    // 未登录行为保持 302/401（Origin 校验在认证之后）。
    const unauthHtml = await get(appAddress.port, '/', {
      host: 'ai.test',
      accept: 'text/html',
      origin: 'https://evil.test',
    })
    assert.equal(unauthHtml.status, 302)
    const unauthApi = await get(appAddress.port, '/api/session', {
      host: 'ai.test',
      accept: 'application/json',
      origin: 'https://evil.test',
    })
    assert.equal(unauthApi.status, 401)
  } finally {
    await app.close()
    upstream.close()
    db.close()
    cleanupDir(dir)
  }
})

test('SEC-10：AI SSO 入口未认证限流 + 审计窗口去重（公网写放大防护）', async () => {
  const dir = tempDataDir()
  const config = testConfig(dir, { opencodePassword: 'super-secret' })
  const db = testDb(dir)
  await seedAdmin(db)
  const context = await buildApp(config, db)
  const app = context.app
  await app.listen({ host: '127.0.0.1', port: 0 })
  const appAddress = app.server.address()
  assert.ok(appAddress && typeof appAddress === 'object')
  try {
    const statuses: number[] = []
    for (let index = 0; index < 70; index += 1) {
      const response = await get(appAddress.port, `/__af/sso/not-a-ticket-${index}`, { host: 'ai.test' })
      statuses.push(response.status)
    }
    // 前 60 次进入业务校验（400），之后同一 IP 被限流（429）。
    assert.equal(statuses.filter((status) => status === 400).length, 60)
    assert.equal(statuses.filter((status) => status === 429).length, 10)
    // 审计去重：同 IP/result 窗口内只写一条，攻击请求不会线性放大审计表。
    const rows = db
      .prepare("SELECT detail_json FROM audit_log WHERE action = 'auth.sso_ai'")
      .all() as unknown as Array<{ detail_json: string }>
    assert.equal(rows.length, 1)
    assert.match(rows[0]!.detail_json, /invalid_path/)
  } finally {
    await app.close()
    cleanupDir(dir)
  }
})

test('AI SSO：ticket 换 ai 主机 host-only 会话 Cookie，一次性/过期/错误 origin/next 校验', async () => {
  const upstreamRecords: UpstreamRecord[] = []
  const upstream = createServer((req, res) => {
    upstreamRecords.push({ authorization: req.headers.authorization, cookie: req.headers.cookie, url: req.url })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"data":[]}')
  })
  const upstreamPort = await listen(upstream)
  const dir = tempDataDir()
  const config = testConfig(dir, {
    opencodeUrl: `http://127.0.0.1:${upstreamPort}`,
    opencodePassword: 'super-secret',
  })
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const session = createSession(db, seeded.userId, 'csrf-token', 7, '127.0.0.1', 'test')
  const context = await buildApp(config, db)
  const app = context.app
  await app.listen({ host: '127.0.0.1', port: 0 })
  const appAddress = app.server.address()
  assert.ok(appAddress && typeof appAddress === 'object')
  const baseHeaders = { host: 'ai.test', accept: 'text/html', 'x-forwarded-proto': 'https' }
  try {
    const ticket = context.auth.createAiSsoTicket(session.token, 'https://ai.test')
    const consume = await get(appAddress.port, `/__af/sso/${ticket}?next=${encodeURIComponent('/session/abc?x=1')}`, baseHeaders)
    assert.equal(consume.status, 302)
    assert.equal(consume.headers.location, '/session/abc?x=1')
    assert.equal(consume.headers['referrer-policy'], 'no-referrer')
    assert.equal(consume.headers['cache-control'], 'no-store')
    const setCookie = ([] as string[]).concat(consume.headers['set-cookie'] ?? [])
    assert.equal(setCookie.length, 1, setCookie.join('\n'))
    const cookie = setCookie[0]!
    assert.match(cookie, /^af_session=/)
    assert.match(cookie, /HttpOnly/i)
    assert.match(cookie, /SameSite=Lax/i)
    assert.match(cookie, /Path=\//i)
    assert.match(cookie, /Secure/i)
    assert.doesNotMatch(cookie, /Domain=/i, 'ai 会话 Cookie 必须 host-only')
    assert.doesNotMatch(cookie, /af_csrf/i, 'ai 主机不需要 CSRF Cookie')

    // 新 Cookie 可直接访问 ai API（上游获得 Basic 且不转发浏览器 Cookie）。
    const cookieValue = cookie.split(';')[0]!.slice('af_session='.length)
    const authed = await get(appAddress.port, '/api/session', {
      host: 'ai.test',
      cookie: `af_session=${cookieValue}`,
      accept: 'application/json',
    })
    assert.equal(authed.status, 200)
    assert.equal(upstreamRecords.length, 1)
    assert.equal(upstreamRecords[0]?.cookie, undefined)

    // 一次性：重复使用同一 ticket 401。
    const reused = await get(appAddress.port, `/__af/sso/${ticket}?next=%2F`, baseHeaders)
    assert.equal(reused.status, 401)
    // 过期 ticket 401。
    const expired = context.auth.createAiSsoTicket(session.token, 'https://ai.test', Date.now() - 120_000)
    assert.equal((await get(appAddress.port, `/__af/sso/${expired}?next=%2F`, baseHeaders)).status, 401)
    // 绑定 origin 不符 401。
    const wrongOrigin = context.auth.createAiSsoTicket(session.token, 'https://other.test')
    assert.equal((await get(appAddress.port, `/__af/sso/${wrongOrigin}?next=%2F`, baseHeaders)).status, 401)
    // next 开放重定向/协议地址/反斜杠 400。
    for (const badNext of ['//evil.test/', 'https://evil.test/', '/\\evil.test']) {
      const code = context.auth.createAiSsoTicket(session.token, 'https://ai.test')
      const response = await get(appAddress.port, `/__af/sso/${code}?next=${encodeURIComponent(badNext)}`, baseHeaders)
      assert.equal(response.status, 400, `next=${badNext}: ${response.body}`)
    }
    // 非法 ticket 形状 400；非 GET 不处理（回落未认证 401）。
    assert.equal((await get(appAddress.port, '/__af/sso/short', baseHeaders)).status, 400)
    // 未认证 HTML 仍 302 到 app 登录（既有行为不变）。
    const unauthHtml = await get(appAddress.port, '/', { host: 'ai.test', accept: 'text/html' })
    assert.equal(unauthHtml.status, 302)
    assert.match(String(unauthHtml.headers.location), /app\.test\/login/)

    // 审计：成功/失败均有 auth.sso_ai，且 detail 不含 ticket。
    const auditRows = db
      .prepare("SELECT target, detail_json FROM audit_log WHERE action = 'auth.sso_ai'")
      .all() as unknown as { target: string | null; detail_json: string | null }[]
    assert.ok(auditRows.length >= 3)
    assert.ok(auditRows.some((row) => row.detail_json?.includes('"ok":true')))
    assert.ok(auditRows.some((row) => row.detail_json?.includes('"ok":false')))
    assert.ok(auditRows.every((row) => !String(row.detail_json ?? '').includes(ticket)))
  } finally {
    await app.close()
    upstream.close()
    db.close()
    cleanupDir(dir)
  }
})
