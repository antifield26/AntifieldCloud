import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, utimesSync, writeFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { FileService, type FileServiceLogger } from '../src/files/service.ts'
import { cleanupDir, tempDataDir, testConfig, testDb } from './helpers.ts'

interface LogEntry {
  obj: Record<string, unknown>
  message: string
}

interface Fixture {
  dir: string
  db: DatabaseSync
  files: FileService
  logs: LogEntry[]
  close: () => void
}

function fixture(overrides: Parameters<typeof testConfig>[1] = {}): Fixture {
  const dir = tempDataDir()
  const config = testConfig(dir, overrides)
  const db = testDb(dir)
  const logs: LogEntry[] = []
  const logger: FileServiceLogger = { warn: (obj, message) => logs.push({ obj, message }) }
  const files = new FileService(db, config, logger)
  return { dir, db, files, logs, close: () => { db.close(); cleanupDir(dir) } }
}

const actor = { username: 'tester', ip: '127.0.0.1' }

async function upload(fx: Fixture, name: string, content: Buffer, reservedBytes = 0) {
  const tempPath = fx.files.storage.tempPath()
  writeFileSync(tempPath, content)
  return fx.files.registerUpload(actor, {
    parentId: null,
    rawName: name,
    tempPath,
    size: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    reservedBytes,
  })
}

test('上传预留：全局共享剩余配额，超限拒绝、释放后恢复', () => {
  const fx = fixture({ quotaBytes: 100, maxUploadBytes: 100 })
  try {
    fx.files.reserveUploadBytes(60)
    assert.throws(() => fx.files.reserveUploadBytes(50), /存储空间不足/)
    fx.files.releaseUploadBytes(60)
    fx.files.reserveUploadBytes(60)
    assert.throws(() => fx.files.reserveUploadBytes(50), /存储空间不足/)
    fx.files.releaseUploadBytes(60)
    fx.files.reserveUploadBytes(100)
    fx.files.releaseUploadBytes(100)
  } finally {
    fx.close()
  }
})

test('上传预留与事务校验配合：自己的预留不重复计入', async () => {
  const fx = fixture({ quotaBytes: 100, maxUploadBytes: 100 })
  try {
    fx.files.reserveUploadBytes(60)
    const item = await upload(fx, 'a.bin', Buffer.alloc(60, 1), 60)
    assert.equal(item.size, 60)
    fx.files.releaseUploadBytes(60)
    fx.files.reserveUploadBytes(40)
    assert.throws(() => fx.files.reserveUploadBytes(1), /存储空间不足/)
    fx.files.releaseUploadBytes(40)
    assert.equal(fx.files.usage().usedBytes, 60)
  } finally {
    fx.close()
  }
})

test('启动清理：删除 24h 前的 tmp 残留，保留新文件', () => {
  const fx = fixture()
  try {
    const oldPath = fx.files.storage.tempPath()
    const newPath = fx.files.storage.tempPath()
    writeFileSync(oldPath, 'old')
    writeFileSync(newPath, 'new')
    const past = (Date.now() - 25 * 60 * 60 * 1000) / 1000
    utimesSync(oldPath, past, past)
    const removed = fx.files.storage.cleanupTempFiles()
    assert.equal(removed, 1)
    assert.equal(existsSync(oldPath), false)
    assert.equal(existsSync(newPath), true)
  } finally {
    fx.close()
  }
})

test('purge 物理删除失败时保留 DB 结果并写日志（需人工清理）', async () => {
  const fx = fixture()
  try {
    const item = await upload(fx, 'gone.txt', Buffer.from('hello'))
    fx.files.trash(actor, item.id)
    // 模拟非法删除失败（跨平台不依赖文件权限/占用语义）。
    fx.files.storage.remove = () => new Error('EBUSY: 模拟删除失败')
    const purged = fx.files.purge(actor, item.id)
    assert.equal(purged.count, 1)
    assert.equal(purged.freedBytes, 5)
    const row = fx.db.prepare('SELECT COUNT(*) AS c FROM files WHERE id = ?').get(item.id) as { c: number }
    assert.equal(row.c, 0)
    assert.equal(fx.logs.length, 1)
    assert.match(fx.logs[0]!.message, /物理文件删除失败/)
    const failures = fx.logs[0]!.obj.failures as { id: string; error: string }[]
    assert.equal(failures.length, 1)
    assert.equal(failures[0]!.id, item.id)
    assert.equal(existsSync(fx.files.storage.finalPath(item.id)), true)
  } finally {
    fx.close()
  }
})
