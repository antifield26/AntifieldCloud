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
