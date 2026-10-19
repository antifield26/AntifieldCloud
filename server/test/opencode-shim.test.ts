/** opencode Web 兼容垫片：HTML 注入、同源脚本、未认证不拦截。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { buildApp } from '../src/app.ts'
import { createSession } from '../src/auth/sessions.ts'
import { injectOpenCodeShim } from '../src/opencode/shim.ts'
import { cleanupDir, seedAdmin, tempDataDir, testConfig, testDb } from './helpers.ts'

function startUpstream(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'; script-src 'self' 'sha256-test'",
    })
    res.end('<!doctype html><html><body><div id="root">opencode</div></body></html>')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address) resolve({ server, port: address.port })
    })
  })
}

test('injectOpenCodeShim 在 body 前插入同源脚本且幂等', () => {
  const html = '<html><body><div>ui</div></body></html>'
  const injected = injectOpenCodeShim(html)
  assert.match(injected, /\/__af\/oc-help\.js/)
  assert.match(injected, /data-cfasync="false"/)
  assert.equal(injectOpenCodeShim(injected), injected)
  assert.match(injectOpenCodeShim('<html></html>'), /__af\/oc-help\.js/)
})

test('opencode HTML 注入垫片、脚本同源返回、未认证仍走 302', async () => {
  const upstream = await startUpstream()
  const dir = tempDataDir()
  const config = testConfig(dir, { opencodeUrl: `http://127.0.0.1:${upstream.port}`, opencodePassword: 'secret' })
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const session = createSession(db, seeded.userId, 'csrf', 7, '127.0.0.1', 'test')
  const context = await buildApp(config, db)
  try {
    const page = await context.app.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'ai.test', cookie: `af_session=${session.token}`, accept: 'text/html' },
    })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /\/__af\/oc-help\.js/)
    assert.match(page.headers['content-security-policy'] as string, /script-src 'self'/)
    assert.equal(page.headers['x-af-oc-shim'], '1')

    const script = await context.app.inject({
      method: 'GET',
      url: '/__af/oc-help.js',
      headers: { host: 'ai.test', cookie: `af_session=${session.token}` },
    })
    assert.equal(script.statusCode, 200)
    assert.match(script.headers['content-type'] as string, /javascript/)
    assert.match(script.body, /新建 opencode 会话/)

    const unauth = await context.app.inject({ method: 'GET', url: '/', headers: { host: 'ai.test', accept: 'text/html' } })
    assert.equal(unauth.statusCode, 302)
    assert.match(String(unauth.headers.location), /\/login/)
  } finally {
    await context.app.close()
    upstream.server.closeAllConnections?.()
    upstream.server.close()
    db.close()
    cleanupDir(dir)
  }
})
