import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server as HttpServer } from 'node:http'
import { createConnection } from 'node:net'
import type { Socket as NetSocket } from 'node:net'
import { buildApp } from '../src/app.ts'
import { createSession } from '../src/auth/sessions.ts'
import { cleanupDir, seedAdmin, tempDataDir, testConfig, testDb } from './helpers.ts'

interface UpgradeRecord {
  authorization: string | undefined
  cookie: string | undefined
  path: string | undefined
}

function startUpstream(): Promise<{ server: HttpServer; port: number; records: UpgradeRecord[] }> {
  const records: UpgradeRecord[] = []
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"data":[]}')
  })
  server.on('upgrade', (req, socket) => {
    records.push({
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
      path: req.url,
    })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address) resolve({ server, port: address.port, records })
    })
  })
}

function upgrade(port: number, lines: string[]): Promise<{ response: string; socket: NetSocket }> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let data = ''
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ response: data, socket })
    }
    const timer = setTimeout(finish, 1500)
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('latin1')
      if (data.includes('\r\n\r\n')) finish()
    })
    socket.on('error', () => finish())
    socket.on('close', () => finish())
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
  })
}

function upgradeHeaders(host: string, cookie?: string): string[] {
  return [
    'GET / HTTP/1.1',
    `Host: ${host}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    ...(cookie ? [`Cookie: ${cookie}`] : []),
  ]
}

test('C1 回归：未认证 WebSocket 升级携带畸形 Cookie 不崩进程、不 5xx', async () => {
  const dir = tempDataDir()
  const config = testConfig(dir)
  const db = testDb(dir)
  await seedAdmin(db)
  const context = await buildApp(config, db)
  await context.app.listen({ host: '127.0.0.1', port: 0 })
  const address = context.app.server.address()
  assert.ok(address && typeof address === 'object')
  try {
    // 多种畸形百分号编码都应被安全解码为“无效会话”，返回 401 而不是抛异常。
    for (const cookie of ['af_session=%', 'af_session=%ZZ', 'x=%E0%A4%A; af_session=%']) {
      const result = await upgrade(address.port, upgradeHeaders('ai.test', cookie))
      assert.match(result.response, /^HTTP\/1\.1 (401|400)/, `畸形 Cookie 响应异常：${result.response}`)
      assert.doesNotMatch(result.response, /^HTTP\/1\.1 5/, result.response)
      result.socket.destroy()
    }
    // 进程仍存活且可继续服务。
    const health = await context.app.inject({ method: 'GET', url: '/healthz' })
    assert.equal(health.statusCode, 200)
  } finally {
    await context.app.close()
    db.close()
    cleanupDir(dir)
  }
})

test('WebSocket 升级：未登录 401、未知 Host 断开、正常会话转发并注入认证', async () => {
  const upstream = await startUpstream()
  const dir = tempDataDir()
  const config = testConfig(dir, {
    opencodeUrl: `http://127.0.0.1:${upstream.port}`,
    opencodePassword: 'super-secret',
    opencodeUsername: 'opencode',
  })
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const session = createSession(db, seeded.userId, 'csrf-token', 7, '127.0.0.1', 'test')
  const context = await buildApp(config, db)
  await context.app.listen({ host: '127.0.0.1', port: 0 })
  const address = context.app.server.address()
  assert.ok(address && typeof address === 'object')
  try {
    const unauth = await upgrade(address.port, upgradeHeaders('ai.test'))
    assert.match(unauth.response, /^HTTP\/1\.1 401/)
    unauth.socket.destroy()

    const unknownHost = await upgrade(address.port, upgradeHeaders('evil.test', `af_session=${session.token}`))
    assert.doesNotMatch(unknownHost.response, /^HTTP\/1\.1 101/)
    unknownHost.socket.destroy()

    const authed = await upgrade(address.port, upgradeHeaders('ai.test', `af_session=${session.token}`))
    assert.match(authed.response, /^HTTP\/1\.1 101/, authed.response)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(upstream.records.length, 1)
    assert.equal(
      upstream.records[0]?.authorization,
      `Basic ${Buffer.from('opencode:super-secret', 'utf8').toString('base64')}`,
    )
    assert.equal(upstream.records[0]?.cookie, undefined)
    authed.socket.destroy()
  } finally {
    // WS 隧道需先断开，否则 Fastify server.close 会等待连接（120s 后才超时）。
    context.proxy.close()
    await context.app.close()
    upstream.server.closeAllConnections?.()
    upstream.server.close()
    db.close()
    cleanupDir(dir)
  }
})

test('AI 主机 HTTP 请求携带畸形 Cookie 返回 401 而非 500', async () => {
  const upstream = await startUpstream()
  const dir = tempDataDir()
  const config = testConfig(dir, { opencodeUrl: `http://127.0.0.1:${upstream.port}`, opencodePassword: 'x' })
  const db = testDb(dir)
  const context = await buildApp(config, db)
  try {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { host: 'ai.test', cookie: 'af_session=%', accept: 'application/json' },
    })
    assert.equal(response.statusCode, 401)
  } finally {
    await context.app.close()
    upstream.server.closeAllConnections?.()
    upstream.server.close()
    db.close()
    cleanupDir(dir)
  }
})
