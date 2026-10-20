/** 备份管理加固：快照行数上限、staging 空间预检/清理与 entries 限流。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '../src/util/errors.ts'
import { BACKUP_SESSION, backupsFixture, buildAndImport, createBackupApp } from './backups-fixtures.ts'

const T0 = '2026-06-01T00:00:00.000Z'

async function expectAppRejects(promise: Promise<unknown>, status: number, code: string): Promise<AppError> {
  let captured: AppError | null = null
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, `应抛出 AppError，实际为 ${String(error)}`)
    assert.equal(error.statusCode, status)
    assert.equal(error.code, code)
    captured = error
    return true
  })
  return captured as unknown as AppError
}

test('归档内 DB 快照行数超限：422 invalid_archive，不加载全部行', async () => {
  const fx = backupsFixture({ serviceConfig: { backupSnapshotMaxRows: 2 } })
  try {
    const rows = [1, 2, 3].map((index) => ({ id: `file-${index}`, name: `f${index}.txt`, kind: 'file' as const, size: 1 }))
    const imported = await buildAndImport(fx, {
      createdAt: T0,
      mode: 'full',
      snapshotRows: rows,
      contents: [],
    })
    const error = await expectAppRejects(fx.service.listArchiveEntries(imported.archive.name, '/'), 422, 'invalid_archive')
    assert.match(error.message, /行数超出上限/)
    assert.deepEqual(error.details, { rows: 3, maxRows: 2 })
  } finally {
    fx.close()
  }
})

test('entries：可用空间为 0 时 507，不进入解包流程', async () => {
  const fx = backupsFixture({ freeBytes: () => 0 })
  try {
    const imported = await buildAndImport(fx, {
      createdAt: T0,
      mode: 'full',
      snapshotRows: [{ id: 'file-1', name: 'a.txt', kind: 'file', size: 1 }],
      contents: [],
    })
    await expectAppRejects(fx.service.listArchiveEntries(imported.archive.name, '/'), 507, 'insufficient_storage')
  } finally {
    fx.close()
  }
})

test('staging：超期异常目录在下次解包前被清理', async () => {
  const fx = backupsFixture()
  try {
    const imported = await buildAndImport(fx, {
      createdAt: T0,
      mode: 'full',
      snapshotRows: [{ id: 'file-1', name: 'a.txt', kind: 'file', size: 0 }],
      contents: [{ id: 'file-1', data: Buffer.alloc(0) }],
    })
    const staleDir = join(fx.dir, 'tmp', 'restore', 'stale-abnormal')
    mkdirSync(staleDir, { recursive: true })
    // 时钟固定在 T0：把目录 mtime 设为 T0 之前，模拟崩溃遗留。
    const old = new Date(new Date(T0).getTime() - 48 * 3_600_000)
    utimesSync(staleDir, old, old)
    assert.equal(existsSync(staleDir), true)

    const entries = await fx.service.listArchiveEntries(imported.archive.name, '/')
    assert.ok(entries.items.length >= 1)
    assert.equal(existsSync(staleDir), false, '超期 staging 目录应被清理')
  } finally {
    fx.close()
  }
})

test('GET /api/backups/archives/:name/entries 限流 30 次/分钟/IP', async () => {
  const fx = backupsFixture()
  const app = await createBackupApp(fx)
  try {
    for (let index = 0; index < 30; index += 1) {
      const response = await app.app.inject({
        method: 'GET',
        url: '/api/backups/archives/snapshot-missing-full.tar.gz/entries',
        headers: { cookie: `af_session=${BACKUP_SESSION}` },
      })
      assert.notEqual(response.statusCode, 429, `第 ${index + 1} 次不应限流`)
    }
    const limited = await app.app.inject({
      method: 'GET',
      url: '/api/backups/archives/snapshot-missing-full.tar.gz/entries',
      headers: { cookie: `af_session=${BACKUP_SESSION}` },
    })
    assert.equal(limited.statusCode, 429)
    assert.equal(limited.json().error.code, 'rate_limited')
    assert.ok(limited.headers['retry-after'])
  } finally {
    await app.close()
    fx.close()
  }
})

test('快照行数在默认上限内可正常浏览（含目录层级）', async () => {
  const fx = backupsFixture()
  try {
    const imported = await buildAndImport(fx, {
      createdAt: T0,
      mode: 'full',
      snapshotRows: [
        { id: 'dir-1', name: 'docs', kind: 'dir' },
        { id: 'file-1', parentId: 'dir-1', name: 'a.txt', kind: 'file', size: 3 },
      ],
      contents: [{ id: 'file-1', data: Buffer.from('abc') }],
    })
    const root = await fx.service.listArchiveEntries(imported.archive.name, '/')
    assert.deepEqual(root.items.map((item) => `${item.kind}:${item.name}`), ['dir:docs'])
    const nested = await fx.service.listArchiveEntries(imported.archive.name, '/docs')
    assert.deepEqual(nested.items.map((item) => `${item.kind}:${item.name}`), ['file:a.txt'])
  } finally {
    fx.close()
  }
})
