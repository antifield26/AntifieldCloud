/** 分片上传服务：成功、幂等、哈希、配额、过期与并发上限。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from '../src/db.ts'
import { FileService } from '../src/files/service.ts'
import { UploadService } from '../src/uploads/service.ts'
import { testConfig, tempDataDir } from './helpers.ts'

function setup(overrides: Record<string, unknown> = {}) {
  const dir = tempDataDir()
  const db = openDatabase({ path: join(dir, 'db.sqlite') })
  const config = testConfig(dir, {
    quotaBytes: 1024 * 1024,
    chunkSizeBytes: 4,
    chunkMaxFileBytes: 1000,
    chunkMaxConcurrentSessions: 2,
    ...overrides,
  })
  const files = new FileService(db, config)
  const uploads = new UploadService(db, config, files)
  const actor = { username: 'admin', ip: '127.0.0.1' }
  return { dir, db, config, files, uploads, actor }
}

function close(ctx: ReturnType<typeof setup>): void {
  ctx.db.close()
  rmSync(ctx.dir, { recursive: true, force: true })
}

test('分片乱序上传、complete 拼接并登记文件', async () => {
  const ctx = setup()
  try {
    const init = ctx.uploads.init(ctx.actor, { name: 'hello.bin', parentId: null, size: 10 })
    assert.equal(init.totalChunks, 3)
    assert.equal(init.chunkSize, 4)
    await ctx.uploads.putChunk(ctx.actor, init.uploadId, 2, Buffer.from('ij'))
    await ctx.uploads.putChunk(ctx.actor, init.uploadId, 0, Buffer.from('abcd'))
    await ctx.uploads.putChunk(ctx.actor, init.uploadId, 1, Buffer.from('efgh'))
    const status = ctx.uploads.status(ctx.actor, init.uploadId)
    assert.deepEqual(status.received, [0, 1, 2])
    assert.deepEqual(status.missing, [])
    const result = await ctx.uploads.complete(ctx.actor, init.uploadId)
    assert.equal(result.file.size, 10)
    assert.equal(result.file.sha256, '72399361da6a7754fec986dca5b7cbaf1c810a28ded4abaf56b2106d06cb78b0')
    assert.equal((ctx.db.prepare('SELECT COUNT(*) AS c FROM upload_chunks WHERE session_id = ?').get(init.uploadId) as { c: number }).c, 0)
    const again = await ctx.uploads.complete(ctx.actor, init.uploadId)
    assert.equal(again.file.id, result.file.id)
  } finally {
    close(ctx)
  }
})

test('重复分片同内容幂等，不同内容 409', async () => {
  const ctx = setup()
  try {
    const init = ctx.uploads.init(ctx.actor, { name: 'a.bin', parentId: null, size: 8 })
    await ctx.uploads.putChunk(ctx.actor, init.uploadId, 0, Buffer.from('abcd'))
    await ctx.uploads.putChunk(ctx.actor, init.uploadId, 0, Buffer.from('abcd'))
    await assert.rejects(
      ctx.uploads.putChunk(ctx.actor, init.uploadId, 0, Buffer.from('abce')),
      (error: unknown) => (error as { code?: string }).code === 'chunk_conflict',
    )
  } finally {
    close(ctx)
  }
})

test('非法大小、缺块、SHA 不匹配与取消', async () => {
  const ctx = setup()
  try {
    assert.throws(
      () => ctx.uploads.init(ctx.actor, { name: 'x', parentId: null, size: 0 }),
      (error: unknown) => (error as { code?: string }).code === 'invalid_size',
    )
    const init = ctx.uploads.init(ctx.actor, { name: 'a.bin', parentId: null, size: 8 })
    await ctx.uploads.putChunk(ctx.actor, init.uploadId, 0, Buffer.from('abcd'))
    await assert.rejects(
      ctx.uploads.complete(ctx.actor, init.uploadId),
      (error: unknown) => (error as { code?: string }).code === 'chunks_missing',
    )
    await ctx.uploads.putChunk(ctx.actor, init.uploadId, 1, Buffer.from('efgh'))
    await assert.rejects(
      ctx.uploads.complete(ctx.actor, init.uploadId, '0'.repeat(64)),
      (error: unknown) => (error as { code?: string }).code === 'checksum_mismatch',
    )
    assert.deepEqual(ctx.uploads.abort(ctx.actor, init.uploadId), { ok: true })
    assert.throws(
      () => ctx.uploads.status(ctx.actor, init.uploadId),
      (error: unknown) => (error as { code?: string }).code === 'upload_not_found',
    )
  } finally {
    close(ctx)
  }
})

test('配额预留：不足时拒绝 init，abort 后释放', () => {
  const ctx = setup({ quotaBytes: 10 })
  try {
    assert.throws(
      () => ctx.uploads.init(ctx.actor, { name: 'big.bin', parentId: null, size: 11 }),
      (error: unknown) => (error as { code?: string }).code === 'quota_exceeded',
    )
    const init = ctx.uploads.init(ctx.actor, { name: 'ok.bin', parentId: null, size: 8 })
    assert.ok(init.uploadId)
    ctx.uploads.abort(ctx.actor, init.uploadId)
    const again = ctx.uploads.init(ctx.actor, { name: 'ok2.bin', parentId: null, size: 8 })
    assert.ok(again.uploadId)
  } finally {
    close(ctx)
  }
})

test('并发会话上限与过期清理', () => {
  const ctx = setup({ chunkMaxConcurrentSessions: 1, chunkSessionTtlHours: 1 })
  try {
    const first = ctx.uploads.init(ctx.actor, { name: 'a.bin', parentId: null, size: 4 })
    assert.throws(
      () => ctx.uploads.init(ctx.actor, { name: 'b.bin', parentId: null, size: 4 }),
      (error: unknown) => (error as { code?: string }).code === 'too_many_uploads',
    )
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000)
    assert.equal(ctx.uploads.cleanupExpired(future), 1)
    assert.throws(
      () => ctx.uploads.status(ctx.actor, first.uploadId),
      (error: unknown) => (error as { code?: string }).code === 'upload_not_found',
    )
  } finally {
    close(ctx)
  }
})

test('重启后重新预留并可继续会话', async () => {
  const ctx = setup()
  try {
    const init = ctx.uploads.init(ctx.actor, { name: 'restart.bin', parentId: null, size: 4 })
    await ctx.uploads.putChunk(ctx.actor, init.uploadId, 0, Buffer.from('abcd'))
    const second = new UploadService(ctx.db, ctx.config, ctx.files)
    const status = second.status(ctx.actor, init.uploadId)
    assert.deepEqual(status.received, [0])
    const result = await second.complete(ctx.actor, init.uploadId)
    assert.equal(result.file.size, 4)
  } finally {
    close(ctx)
  }
})

test('不允许访问他人或非法 id', () => {
  const ctx = setup()
  try {
    const init = ctx.uploads.init(ctx.actor, { name: 'secret.bin', parentId: null, size: 4 })
    assert.throws(
      () => ctx.uploads.status({ username: 'other', ip: null }, init.uploadId),
      (error: unknown) => (error as { code?: string }).code === 'upload_not_found',
    )
    assert.throws(
      () => ctx.uploads.status(ctx.actor, '../../etc/passwd'),
      (error: unknown) => (error as { code?: string }).code === 'upload_not_found',
    )
  } finally {
    close(ctx)
  }
})
