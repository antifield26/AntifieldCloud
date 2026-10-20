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

function get(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
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
