/** 分片上传路由：认证/CSRF、raw body、完整流程与错误码。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { buildApp } from '../src/app.ts'
import { createSession } from '../src/auth/sessions.ts'
import { cleanupDir, seedAdmin, tempDataDir, testConfig, testDb } from './helpers.ts'

interface Fixture {
  context: Awaited<ReturnType<typeof buildApp>>
  dir: string
  token: string
  csrf: string
  headers: Record<string, string>
  close: () => Promise<void>
}

async function fixture(): Promise<Fixture> {
  const dir = tempDataDir()
  const config = testConfig(dir, { chunkSizeBytes: 4, chunkMaxFileBytes: 1000, quotaBytes: 1024 * 1024 })
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const context = await buildApp(config, db)
  const session = createSession(db, seeded.userId, 'chunk-csrf', 7, '127.0.0.1', 'test')
  return {
    context,
    dir,
    token: session.token,
    csrf: 'chunk-csrf',
    headers: {
      host: 'app.test',
      cookie: `af_session=${session.token}`,
      'x-csrf-token': 'chunk-csrf',
    },
    async close() {
      await context.app.close()
      db.close()
      cleanupDir(dir)
    },
  }
}

test('未登录 401；CSRF 缺失 403', async () => {
  const fx = await fixture()
  try {
    const anonymous = await fx.context.app.inject({ method: 'POST', url: '/api/uploads', payload: { name: 'a', size: 4 } })
    assert.equal(anonymous.statusCode, 401)
    const noCsrf = await fx.context.app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { host: 'app.test', cookie: `af_session=${fx.token}` },
      payload: { name: 'a.bin', size: 4 },
    })
    assert.equal(noCsrf.statusCode, 403)
  } finally {
    await fx.close()
  }
})

test('init -> raw chunk -> status -> complete', async () => {
  const fx = await fixture()
  try {
    const init = await fx.context.app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: fx.headers,
      payload: { name: 'route.bin', size: 8 },
    })
    assert.equal(init.statusCode, 201, init.body)
    const body = init.json() as { uploadId: string; totalChunks: number; chunkSize: number }
    assert.equal(body.totalChunks, 2)
    assert.equal(body.chunkSize, 4)

    const chunk0 = await fx.context.app.inject({
      method: 'PUT',
      url: `/api/uploads/${body.uploadId}/chunks/0`,
      headers: { ...fx.headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('abcd'),
    })
    assert.equal(chunk0.statusCode, 200, chunk0.body)
    const chunk1 = await fx.context.app.inject({
      method: 'PUT',
      url: `/api/uploads/${body.uploadId}/chunks/1`,
      headers: { ...fx.headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('efgh'),
    })
    assert.equal(chunk1.statusCode, 200, chunk1.body)

    const status = await fx.context.app.inject({ method: 'GET', url: `/api/uploads/${body.uploadId}`, headers: fx.headers })
    assert.equal(status.statusCode, 200)
    assert.deepEqual(status.json().received, [0, 1])
    const sha = createHash('sha256').update('abcdefgh').digest('hex')
    const complete = await fx.context.app.inject({
      method: 'POST',
      url: `/api/uploads/${body.uploadId}/complete`,
      headers: fx.headers,
      payload: { sha256: sha },
    })
    assert.equal(complete.statusCode, 200, complete.body)
    assert.equal(complete.json().file.size, 8)
    assert.equal(complete.json().file.sha256, sha)
  } finally {
    await fx.close()
  }
})

test('错误 content-type、越界序号与超限 body', async () => {
  const fx = await fixture()
  try {
    const init = await fx.context.app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: fx.headers,
      payload: { name: 'errors.bin', size: 8 },
    })
    const id = init.json().uploadId as string
    const wrongType = await fx.context.app.inject({
      method: 'PUT',
      url: `/api/uploads/${id}/chunks/0`,
      headers: { ...fx.headers, 'content-type': 'application/json' },
      payload: JSON.stringify({ bad: true }),
    })
    assert.equal(wrongType.statusCode, 400)
    const outOfRange = await fx.context.app.inject({
      method: 'PUT',
      url: `/api/uploads/${id}/chunks/9`,
      headers: { ...fx.headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('abcd'),
    })
    assert.equal(outOfRange.statusCode, 400)
    const tooBig = await fx.context.app.inject({
      method: 'PUT',
      url: `/api/uploads/${id}/chunks/0`,
      headers: { ...fx.headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(5, 0x61),
    })
    assert.equal(tooBig.statusCode, 400)
  } finally {
    await fx.close()
  }
})
