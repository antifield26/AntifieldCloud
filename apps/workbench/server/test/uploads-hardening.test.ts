/**
 * A5-SEC-02 回归：octet-stream raw body 上限按 scope 隔离。
 *
 * - 全局 octet-stream 解析器保持实例默认 1 MiB：任何非分片路由（含公开分享解锁）在
 *   鉴权/Origin/限流之前最多只缓冲 1 MiB；8 MiB 直接 413，不进入业务 handler。
 * - 分片上传 scope 内覆盖为 CHUNK_SIZE + 64 KiB：8 MiB 块仍可正常写入与拼接。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { buildApp } from '../src/app.ts'
import { createSession } from '../src/auth/sessions.ts'
import { cleanupDir, seedAdmin, tempDataDir, testConfig, testDb } from './helpers.ts'

const CHUNK = 8 * 1024 * 1024
const OVER_GLOBAL = CHUNK // 8 MiB：超过全局 1 MiB 上限

interface Fixture {
  context: Awaited<ReturnType<typeof buildApp>>
  dir: string
  headers: Record<string, string>
  close: () => Promise<void>
}

async function fixture(): Promise<Fixture> {
  const dir = tempDataDir()
  const config = testConfig(dir, {
    chunkSizeBytes: CHUNK,
    chunkMaxFileBytes: 16 * 1024 * 1024,
    quotaBytes: 32 * 1024 * 1024,
  })
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const context = await buildApp(config, db)
  const session = createSession(db, seeded.userId, 'scope-csrf', 7, '127.0.0.1', 'test')
  return {
    context,
    dir,
    headers: {
      host: 'app.test',
      cookie: `af_session=${session.token}`,
      'x-csrf-token': 'scope-csrf',
    },
    async close() {
      await context.app.close()
      db.close()
      cleanupDir(dir)
    },
  }
}

test('非分片路由：octet-stream 8 MiB 在解析阶段 413（公开 unlock 与登录写路由一致）', async () => {
  const fx = await fixture()
  try {
    // 公开分享解锁：无会话、Access bypass 路径；8 MiB 必须在 handler 之前被拒。
    const unlock = await fx.context.app.inject({
      method: 'POST',
      url: '/api/public/shares/sometoken1234567890abcdef/unlock',
      headers: {
        host: 'app.test',
        'x-forwarded-proto': 'https',
        origin: 'https://app.test',
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.alloc(OVER_GLOBAL, 0x41),
    })
    assert.equal(unlock.statusCode, 413, unlock.body)
    assert.equal(unlock.json().error.code, 'file_too_large')
    assert.doesNotMatch(unlock.body, /ECONNREFUSED|server\/src|DATA_DIR/i)

    // 登录后的普通写路由同样受全局 1 MiB 约束。
    const folder = await fx.context.app.inject({
      method: 'POST',
      url: '/api/files/folder',
      headers: {
        ...fx.headers,
        origin: 'https://app.test',
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.alloc(2 * 1024 * 1024, 0x42),
    })
    assert.equal(folder.statusCode, 413, folder.body)

    // 对照：<= 1 MiB 的 octet-stream 仍会被全局解析器接收（进入 handler 后按业务报错）。
    const small = await fx.context.app.inject({
      method: 'POST',
      url: '/api/public/shares/sometoken1234567890abcdef/unlock',
      headers: {
        host: 'app.test',
        'x-forwarded-proto': 'https',
        origin: 'https://app.test',
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.alloc(512 * 1024, 0x43),
    })
    assert.equal(small.statusCode, 404, small.body)
    assert.equal(small.json().error.code, 'not_found')

    // JSON 解析器的 1 MiB 上限保持不变。
    const json = await fx.context.app.inject({
      method: 'POST',
      url: '/api/public/shares/sometoken1234567890abcdef/unlock',
      headers: {
        host: 'app.test',
        'x-forwarded-proto': 'https',
        origin: 'https://app.test',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ password: 'x'.repeat(2 * 1024 * 1024) }),
    })
    assert.equal(json.statusCode, 413, json.body)
  } finally {
    await fx.close()
  }
})

test('分片上传 scope：8 MiB 块仍可写入、拼接，超限块 413', async () => {
  const fx = await fixture()
  try {
    const content = Buffer.alloc(CHUNK, 0x5a)
    const sha = createHash('sha256').update(content).digest('hex')

    const init = await fx.context.app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: fx.headers,
      payload: { name: 'chunk-8mib.bin', size: CHUNK },
    })
    assert.equal(init.statusCode, 201, init.body)
    const body = init.json() as { uploadId: string; chunkSize: number; totalChunks: number }
    assert.equal(body.chunkSize, CHUNK)
    assert.equal(body.totalChunks, 1)

    // 超过 CHUNK_SIZE + 64 KiB 的块被解析阶段拒绝（未进入 putChunk）。
    const tooBig = await fx.context.app.inject({
      method: 'PUT',
      url: `/api/uploads/${body.uploadId}/chunks/0`,
      headers: { ...fx.headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(CHUNK + 128 * 1024, 0x61),
    })
    assert.equal(tooBig.statusCode, 413, tooBig.body)

    // 恰好 8 MiB 的块正常写入（scope 内的 raw body 上限覆盖生效）。
    const chunk = await fx.context.app.inject({
      method: 'PUT',
      url: `/api/uploads/${body.uploadId}/chunks/0`,
      headers: { ...fx.headers, 'content-type': 'application/octet-stream' },
      payload: content,
    })
    assert.equal(chunk.statusCode, 200, chunk.body)
    assert.equal(chunk.json().index, 0)

    const complete = await fx.context.app.inject({
      method: 'POST',
      url: `/api/uploads/${body.uploadId}/complete`,
      headers: fx.headers,
      payload: { sha256: sha },
    })
    assert.equal(complete.statusCode, 200, complete.body)
    assert.equal(complete.json().file.size, CHUNK)
    assert.equal(complete.json().file.sha256, sha)
  } finally {
    await fx.close()
  }
})
