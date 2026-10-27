/** 分片上传服务：成功、幂等、哈希、配额、过期与并发上限。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('并发同索引同内容：两次都成功、只保留一份块、received 只加一次（DATA-02）', async () => {
  const ctx = setup()
  try {
    const init = ctx.uploads.init(ctx.actor, { name: 'concurrent-same.bin', parentId: null, size: 4 })
    const body = Buffer.from('abcd')
    const results = await Promise.all([
      ctx.uploads.putChunk(ctx.actor, init.uploadId, 0, body),
      ctx.uploads.putChunk(ctx.actor, init.uploadId, 0, body),
    ])
    assert.deepEqual(results.map((item) => item.index), [0, 0])
    const chunkPath = join(ctx.dir, 'tmp', 'chunks', init.uploadId, '0.part')
    assert.equal(existsSync(chunkPath), true, '共享分块不得被并发的另一个请求删除')
    assert.equal(readFileSync(chunkPath, 'utf8'), 'abcd')
    const chunkCount = (
      ctx.db.prepare('SELECT COUNT(*) AS c FROM upload_chunks WHERE session_id = ? AND idx = 0').get(init.uploadId) as {
        c: number
      }
    ).c
    assert.equal(chunkCount, 1)
    const session = ctx.db.prepare('SELECT received FROM upload_sessions WHERE id = ?').get(init.uploadId) as {
      received: number
    }
    assert.equal(session.received, 1, 'received 只应计一次')
    const result = await ctx.uploads.complete(ctx.actor, init.uploadId)
    assert.equal(result.file.size, 4)
    assert.equal(result.file.sha256, createHash('sha256').update(body).digest('hex'))
  } finally {
    close(ctx)
  }
})

test('并发同索引不同内容：一个成功一个 409，已落盘块保留可完成（DATA-02）', async () => {
  const ctx = setup()
  try {
    const init = ctx.uploads.init(ctx.actor, { name: 'concurrent-diff.bin', parentId: null, size: 4 })
    const results = await Promise.allSettled([
      ctx.uploads.putChunk(ctx.actor, init.uploadId, 0, Buffer.from('abcd')),
      ctx.uploads.putChunk(ctx.actor, init.uploadId, 0, Buffer.from('abce')),
    ])
    const fulfilled = results.filter((item) => item.status === 'fulfilled')
    const rejected = results.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.equal((rejected[0]!.reason as { code?: string }).code, 'chunk_conflict')
    const chunkPath = join(ctx.dir, 'tmp', 'chunks', init.uploadId, '0.part')
    assert.equal(existsSync(chunkPath), true, '冲突请求不得删除已成功写入的块')
    const row = ctx.db
      .prepare('SELECT sha256 FROM upload_chunks WHERE session_id = ? AND idx = 0')
      .get(init.uploadId) as { sha256: string }
    assert.equal(row.sha256, createHash('sha256').update(readFileSync(chunkPath)).digest('hex'))
    await ctx.uploads.complete(ctx.actor, init.uploadId)
  } finally {
    close(ctx)
  }
})

test('parentId 目录：分片上传可落到目录，completed 状态返回 fileId', async () => {
  const ctx = setup()
  try {
    const folder = ctx.files.createFolder(ctx.actor, null, '大文件')
    const init = ctx.uploads.init(ctx.actor, { name: 'nested.bin', parentId: folder.id, size: 8 })
    await ctx.uploads.putChunk(ctx.actor, init.uploadId, 0, Buffer.from('abcd'))
    await ctx.uploads.putChunk(ctx.actor, init.uploadId, 1, Buffer.from('efgh'))
    const result = await ctx.uploads.complete(ctx.actor, init.uploadId)
    assert.equal(result.file.parentId, folder.id)
    const status = ctx.uploads.status(ctx.actor, init.uploadId)
    assert.equal(status.status, 'completed')
    assert.equal(status.fileId, result.file.id, 'completed 会话返回已登记 fileId')
    const again = await ctx.uploads.complete(ctx.actor, init.uploadId)
    assert.equal(again.file.id, result.file.id)
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

test('过期会话懒失效：访问返回 410 并释放预留；assembling 期间清理不删块', async () => {
  const ctx = setup({ chunkSessionTtlHours: 1 })
  try {
    const init = ctx.uploads.init(ctx.actor, { name: 'ttl.bin', parentId: null, size: 4 })
    // 直接把 expires_at 拨到过去，模拟 TTL 到期但清理任务未运行。
    ctx.db.prepare('UPDATE upload_sessions SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', init.uploadId)
    assert.throws(
      () => ctx.uploads.status(ctx.actor, init.uploadId),
      (error: unknown) => (error as { code?: string }).code === 'upload_expired',
    )
    await assert.rejects(
      ctx.uploads.putChunk(ctx.actor, init.uploadId, 0, Buffer.from('abcd')),
      (error: unknown) =>
        (error as { code?: string }).code === 'upload_expired' || (error as { code?: string }).code === 'upload_not_found',
    )

    // assembling 状态：cleanup/abort 都不得破坏拼接。
    const second = ctx.uploads.init(ctx.actor, { name: 'assembling.bin', parentId: null, size: 4 })
    ctx.db.prepare("UPDATE upload_sessions SET status = 'assembling' WHERE id = ?").run(second.uploadId)
    assert.equal(ctx.uploads.cleanupExpired(new Date()), 0)
    assert.throws(
      () => ctx.uploads.abort(ctx.actor, second.uploadId),
      (error: unknown) => (error as { code?: string }).code === 'upload_assembling',
    )
    assert.equal(existsSync(join(ctx.dir, 'tmp', 'chunks', second.uploadId)), true, 'assembling 会话目录保留')
  } finally {
    close(ctx)
  }
})

test('断电截断分片：complete 拒绝并要求重传，重传后可完成（DR2-02）', async () => {
  const ctx = setup()
  try {
    const init = ctx.uploads.init(ctx.actor, { name: 'truncated.bin', parentId: null, size: 4 })
    await ctx.uploads.putChunk(ctx.actor, init.uploadId, 0, Buffer.from('abcd'))
    // 模拟断电导致物理块被截断但 DB 行仍在。
    writeFileSync(join(ctx.dir, 'tmp', 'chunks', init.uploadId, '0.part'), Buffer.from('ab'))
    await assert.rejects(
      ctx.uploads.complete(ctx.actor, init.uploadId),
      (error: unknown) => (error as { code?: string }).code === 'chunks_missing',
    )
    assert.equal(
      (ctx.db.prepare('SELECT COUNT(*) AS c FROM upload_chunks WHERE session_id = ?').get(init.uploadId) as { c: number }).c,
      0,
    )
    await ctx.uploads.putChunk(ctx.actor, init.uploadId, 0, Buffer.from('abcd'))
    const result = await ctx.uploads.complete(ctx.actor, init.uploadId)
    assert.equal(result.file.size, 4)
  } finally {
    close(ctx)
  }
})

test('assembling 崩溃超过 2 小时：释放配额并标记过期（DR2-03）', () => {
  const ctx = setup()
  try {
    const init = ctx.uploads.init(ctx.actor, { name: 'stale-assembling.bin', parentId: null, size: 4 })
    ctx.db
      .prepare("UPDATE upload_sessions SET status = 'assembling', updated_at = ? WHERE id = ?")
      .run('2000-01-01T00:00:00.000Z', init.uploadId)
    assert.equal(ctx.uploads.cleanupExpired(new Date()), 1)
    const row = ctx.db.prepare('SELECT status FROM upload_sessions WHERE id = ?').get(init.uploadId) as { status: string }
    assert.equal(row.status, 'expired')
  } finally {
    close(ctx)
  }
})

test('缺块自愈：物理分块丢失后允许重传并正确计数', async () => {
  const ctx = setup()
  try {
    const init = ctx.uploads.init(ctx.actor, { name: 'heal.bin', parentId: null, size: 8 })
    await ctx.uploads.putChunk(ctx.actor, init.uploadId, 0, Buffer.from('abcd'))
    await ctx.uploads.putChunk(ctx.actor, init.uploadId, 1, Buffer.from('efgh'))
    rmSync(join(ctx.dir, 'tmp', 'chunks', init.uploadId, '0.part'), { force: true })
    const statusBefore = ctx.uploads.status(ctx.actor, init.uploadId)
    assert.deepEqual(statusBefore.missing, [0])
    const reupload = await ctx.uploads.putChunk(ctx.actor, init.uploadId, 0, Buffer.from('abcd'))
    assert.equal(reupload.received, 2)
    const result = await ctx.uploads.complete(ctx.actor, init.uploadId)
    assert.equal(result.file.sha256, '9c56cc51b374c3ba189210d5b6d4bf57790d351c96c47c02190ecf1e430635ab')
  } finally {
    close(ctx)
  }
})

test('孤儿分片目录/assembling 残片：维护清理只删除无活动会话的条目', () => {
  const ctx = setup()
  try {
    const init = ctx.uploads.init(ctx.actor, { name: 'keep.bin', parentId: null, size: 4 })
    const expired = ctx.uploads.init(ctx.actor, { name: 'expired.bin', parentId: null, size: 4 })
    ctx.db.prepare("UPDATE upload_sessions SET status = 'expired' WHERE id = ?").run(expired.uploadId)
    const root = join(ctx.dir, 'tmp', 'chunks')
    mkdirSync(join(root, 'orphan-session-dir'), { recursive: true })
    writeFileSync(join(root, 'orphan-session-dir', '0.part'), 'x')
    writeFileSync(join(root, 'dead-session.assembling'), 'x')
    writeFileSync(join(root, 'keep.bin.assembling'), 'x') // 无对应会话 → 应清理
    mkdirSync(join(root, expired.uploadId), { recursive: true })
    // 终态会话的残留目录也应回收（known 只保护 active 会话）。
    assert.equal(ctx.uploads.cleanupOrphanSessions(), 4)
    assert.equal(existsSync(join(root, 'orphan-session-dir')), false)
    assert.equal(existsSync(join(root, 'dead-session.assembling')), false)
    assert.equal(existsSync(join(root, expired.uploadId)), false, '终态会话残留目录应回收')
    assert.equal(existsSync(join(root, init.uploadId)), true, '仍活动的会话目录保留')
  } finally {
    close(ctx)
  }
})

test('终态上传会话 retention：回收超期 completed/aborted/expired 行与块（DATA-10）', () => {
  const ctx = setup()
  try {
    const old = ctx.uploads.init(ctx.actor, { name: 'old-completed.bin', parentId: null, size: 4 })
    ctx.db
      .prepare("UPDATE upload_sessions SET status = 'completed', updated_at = ? WHERE id = ?")
      .run('2000-01-01T00:00:00.000Z', old.uploadId)
    ctx.db
      .prepare("INSERT INTO upload_chunks (session_id, idx, size, sha256, created_at) VALUES (?, 0, 4, ?, ?)")
      .run(old.uploadId, 'a'.repeat(64), '2000-01-01T00:00:00.000Z')
    mkdirSync(join(ctx.dir, 'tmp', 'chunks', old.uploadId), { recursive: true })

    const recent = ctx.uploads.init(ctx.actor, { name: 'recent-completed.bin', parentId: null, size: 4 })
    ctx.db
      .prepare("UPDATE upload_sessions SET status = 'completed', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), recent.uploadId)
    const active = ctx.uploads.init(ctx.actor, { name: 'active.bin', parentId: null, size: 4 })

    assert.equal(ctx.uploads.cleanupTerminalSessions(30), 1)
    const oldRow = ctx.db.prepare('SELECT COUNT(*) AS c FROM upload_sessions WHERE id = ?').get(old.uploadId) as { c: number }
    const oldChunks = ctx.db.prepare('SELECT COUNT(*) AS c FROM upload_chunks WHERE session_id = ?').get(old.uploadId) as {
      c: number
    }
    assert.equal(oldRow.c, 0, '超期终态会话行应删除')
    assert.equal(oldChunks.c, 0, '关联块索引应删除')
    assert.equal(existsSync(join(ctx.dir, 'tmp', 'chunks', old.uploadId)), false)
    assert.equal(
      (ctx.db.prepare('SELECT COUNT(*) AS c FROM upload_sessions WHERE id = ?').get(recent.uploadId) as { c: number }).c,
      1,
      '未超期终态会话保留',
    )
    assert.equal(
      (ctx.db.prepare('SELECT COUNT(*) AS c FROM upload_sessions WHERE id = ?').get(active.uploadId) as { c: number }).c,
      1,
      '活动会话保留',
    )
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
