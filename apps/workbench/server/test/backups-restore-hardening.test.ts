/** 备份恢复加固：origin 过滤、skippedMissing 跳过、链来源隔离、磁盘预检与 prepare 超时/陈旧锁。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '../src/util/errors.ts'
import { sha256 } from './helpers.ts'
import {
  backupsFixture,
  buildArchive,
  type ArchiveFixtureOptions,
  type BackupsFixture,
} from './backups-fixtures.ts'

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

/** 把构造的归档落盘并登记为 Pi 归档（已校验），用于链/恢复测试。 */
function addPiArchive(fx: BackupsFixture, options: Omit<ArchiveFixtureOptions, 'workDir'>) {
  const archive = buildArchive({ ...options, workDir: fx.dir })
  const path = join(fx.dir, 'backups', archive.name)
  mkdirSync(join(fx.dir, 'backups'), { recursive: true })
  writeFileSync(path, archive.buffer)
  const digest = sha256(archive.buffer)
  fx.db
    .prepare(
      `INSERT INTO backup_archives (name, mode, created_at, sha256, size, file_count, pulled_at, acked_at, deleted_at, verified_at, origin, manifest_json, last_error)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 'pi', ?, NULL)`,
    )
    .run(
      archive.name,
      options.mode,
      options.createdAt,
      digest,
      archive.buffer.length,
      options.contents.length,
      options.createdAt,
      JSON.stringify({ schema: 1, createdAt: options.createdAt, mode: options.mode, ...(options.manifestPatch ?? {}) }),
    )
  return archive.name
}

test('恢复 origin 过滤：note/system 行不进入普通文件树，也不参与恢复计划', async () => {
  const fx = backupsFixture()
  try {
    const name = addPiArchive(fx, {
      createdAt: T0,
      mode: 'full',
      snapshotRows: [
        { id: 'dir-docs', name: 'docs', kind: 'dir' },
        { id: 'file-user', parentId: 'dir-docs', name: 'user.txt', kind: 'file', size: 3 },
        { id: 'file-note', parentId: 'dir-docs', name: 'secret-note.txt', kind: 'file', size: 3, origin: 'note' },
        { id: 'file-system', name: 'system.bin', kind: 'file', size: 3, origin: 'system' },
      ],
      contents: [
        { id: 'file-user', data: Buffer.from('abc') },
        { id: 'file-note', data: Buffer.from('xyz') },
      ],
    })
    const root = await fx.service.listArchiveEntries(name, '/')
    assert.deepEqual(root.items.map((item) => item.name), ['docs'], '隐藏 origin 行不显示在普通树')
    const docs = await fx.service.listArchiveEntries(name, '/docs')
    assert.deepEqual(docs.items.map((item) => item.name), ['user.txt'])

    const plan = await fx.service.createRestorePlan(fx.actor, { archive: name, paths: ['/'] })
    assert.equal(plan.fileCount, 1, '恢复计划只包含普通文件')
    const executed = await fx.service.executeRestore(fx.actor, plan.id)
    assert.equal(executed.result.filesRestored, 1)
    const target = fx.db
      .prepare("SELECT id FROM files WHERE name = ? AND parent_id IS NULL AND origin = 'user'")
      .get(executed.result.targetName) as { id: string }
    const children = fx.files.list({ parentId: target.id, page: 1, pageSize: 50, sort: 'name', dir: 'asc' })
    assert.deepEqual(children.items.map((item) => item.name).sort(), ['docs'])
    const docsRestored = fx.files.list({ parentId: children.items[0]!.id, page: 1, pageSize: 50, sort: 'name', dir: 'asc' })
    assert.deepEqual(docsRestored.items.map((item) => item.name), ['user.txt'])
  } finally {
    fx.close()
  }
})

test('恢复跳过 skippedMissing：计划明确报告并从选择中剔除，其余文件正常恢复', async () => {
  const fx = backupsFixture()
  try {
    const name = addPiArchive(fx, {
      createdAt: T0,
      mode: 'full',
      snapshotRows: [
        { id: 'file-ok-0001', name: 'ok.txt', kind: 'file', size: 3 },
        { id: 'file-gone-0002', name: 'gone.txt', kind: 'file', size: 5 },
      ],
      contents: [{ id: 'file-ok-0001', data: Buffer.from('abc') }],
      manifestPatch: { skippedMissing: ['file-gone-0002'], warnings: ['1 个文件缺失'] },
    })
    const plan = await fx.service.createRestorePlan(fx.actor, { archive: name, paths: ['/'] })
    assert.equal(plan.fileCount, 1)
    assert.deepEqual(plan.skippedMissing, ['file-gone-0002'])
    const executed = await fx.service.executeRestore(fx.actor, plan.id)
    assert.equal(executed.result.filesRestored, 1)
    assert.deepEqual(executed.result.skippedMissing, ['file-gone-0002'])
  } finally {
    fx.close()
  }
})

test('恢复磁盘预检：按选择字节 ×2 + 保留空间判断，不足返回 507', async () => {
  const fx = backupsFixture({ freeBytes: () => 1024 })
  try {
    const name = addPiArchive(fx, {
      createdAt: T0,
      mode: 'full',
      snapshotRows: [{ id: 'file-a', name: 'a.txt', kind: 'file', size: 3 }],
      contents: [{ id: 'file-a', data: Buffer.from('abc') }],
    })
    await expectAppRejects(fx.service.createRestorePlan(fx.actor, { archive: name, paths: ['/'] }), 507, 'insufficient_storage')
  } finally {
    fx.close()
  }
})

test('恢复链按 origin 隔离：Pi full+inc 中插入 import full 仍解析正确父链', async () => {
  const fx = backupsFixture()
  try {
    const piFull = addPiArchive(fx, {
      createdAt: '2026-06-01T00:00:00.000Z',
      mode: 'full',
      snapshotRows: [{ id: 'file-a', name: 'a.txt', kind: 'file', size: 3 }],
      contents: [{ id: 'file-a', data: Buffer.from('old') }],
    })
    const piInc = addPiArchive(fx, {
      createdAt: '2026-06-01T02:00:00.000Z',
      mode: 'inc',
      since: '2026-06-01T00:00:00.000Z',
      snapshotRows: [{ id: 'file-b', name: 'b.txt', kind: 'file', size: 3 }],
      contents: [{ id: 'file-b', data: Buffer.from('new') }],
    })
    // Web 导入的 full 时间落在两个 Pi 归档之间，不能成为 Pi inc 的父链。
    const imported = buildArchive({
      createdAt: '2026-06-01T01:00:00.000Z',
      mode: 'full',
      snapshotRows: [{ id: 'file-x', name: 'x.txt', kind: 'file', size: 1 }],
      contents: [{ id: 'file-x', data: Buffer.from('x') }],
      workDir: fx.dir,
    })
    fx.db
      .prepare(
        `INSERT INTO backup_archives (name, mode, created_at, sha256, size, file_count, pulled_at, acked_at, deleted_at, verified_at, origin, manifest_json, last_error)
         VALUES (?, 'full', '2026-06-01T01:00:00.000Z', ?, ?, 1, NULL, NULL, NULL, '2026-06-01T01:00:00.000Z', 'import', ?, NULL)`,
      )
      .run(imported.name, sha256(imported.buffer), imported.buffer.length, JSON.stringify({ schema: 1 }))
    mkdirSync(join(fx.dir, 'backups', 'imports'), { recursive: true })
    writeFileSync(join(fx.dir, 'backups', 'imports', imported.name), imported.buffer)

    const plan = await fx.service.createRestorePlan(fx.actor, { archive: piInc, paths: ['/'] })
    assert.deepEqual(plan.archives, [piFull, piInc], '链只包含 Pi 归档')
  } finally {
    fx.close()
  }
})

test('Web prepare：超时清理本次锁与 .part；陈旧锁（>1h）可继续', async () => {
  let capturedDir: string | null = null
  const fx = backupsFixture({
    serviceConfig: { backupPrepareTimeoutMs: 50 },
    runner: async () => {
      assert.ok(capturedDir, 'runner 执行前必须已设置数据目录')
      mkdirSync(join(capturedDir, 'backups'), { recursive: true })
      writeFileSync(join(capturedDir, 'backups', '.backup.lock'), '1234')
      writeFileSync(join(capturedDir, 'backups', 'snapshot-20000101T000000Z-full.tar.gz.part'), 'partial')
      return { code: 1, stdout: '', stderr: 'killed', timedOut: true }
    },
  })
  capturedDir = fx.dir
  try {
    const error = await expectAppRejects(fx.service.prepare(fx.actor), 500, 'backup_prepare_timeout')
    assert.match(error.message, /超时/)
    assert.equal(existsSync(join(fx.dir, 'backups', '.backup.lock')), false, '超时后应清理本次锁')
    assert.equal(existsSync(join(fx.dir, 'backups', 'snapshot-20000101T000000Z-full.tar.gz.part')), false)
  } finally {
    fx.close()
  }

  // 陈旧锁：模拟进程崩溃遗留，Web prepare 应允许继续（CLI 会按同样规则接管）。
  const staleFx = backupsFixture({
    runner: async () => ({
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        status: 'pending',
        mode: 'full',
        archiveName: 'snapshot-20260601T000000Z-full.tar.gz',
        sizeBytes: 1,
        sha256: 'a'.repeat(64),
        fileCount: 0,
        warnings: [],
        skippedMissing: [],
      }),
      stderr: '',
    }),
  })
  try {
    mkdirSync(join(staleFx.dir, 'backups'), { recursive: true })
    const lockPath = join(staleFx.dir, 'backups', '.backup.lock')
    writeFileSync(lockPath, '9999')
    const old = new Date(Date.now() - 2 * 3_600_000)
    utimesSync(lockPath, old, old)
    const result = await staleFx.service.prepare(staleFx.actor, { full: true })
    assert.equal(result.ok, true)
    assert.deepEqual(result.warnings, [])
  } finally {
    staleFx.close()
  }
})

test('恢复解包前按 tar 实际字节预检：快照声明 1 字节、实际 20 MiB，空间不足返回 507 且不建目标', async () => {
  let free = 4 * 1024 * 1024 * 1024
  const fx = backupsFixture({ freeBytes: () => free })
  try {
    const content = Buffer.alloc(20 * 1024 * 1024, 0x41)
    const name = addPiArchive(fx, {
      createdAt: T0,
      mode: 'full',
      snapshotRows: [{ id: 'file-bomb-0001', name: 'bomb.bin', kind: 'file', size: 1 }],
      contents: [{ id: 'file-bomb-0001', data: content }],
    })
    const plan = await fx.service.createRestorePlan(fx.actor, { archive: name, paths: ['/'] })
    assert.equal(plan.totalBytes, 1, '计划展示仍使用快照声明尺寸（API 兼容）')

    // 解包真实内容需要 20 MiB + 保留空间；注入可用空间 64 MiB 时必须在写内容前失败。
    free = 64 * 1024 * 1024
    const error = await expectAppRejects(fx.service.executeRestore(fx.actor, plan.id), 507, 'insufficient_storage')
    assert.match(error.message, /空间|存储/)
    const root = fx.db.prepare('SELECT COUNT(*) AS c FROM files WHERE parent_id IS NULL').get() as { c: number }
    assert.equal(root.c, 0, '预算不足时不得创建恢复目标文件夹或文件')
  } finally {
    fx.close()
  }
})

test('恢复解包前遵守 staging 上限：按实际字节判定（测试注入 2 MiB 上限）', async () => {
  const fx = backupsFixture({
    freeBytes: () => 4 * 1024 * 1024 * 1024,
    serviceConfig: { backupStagingMaxBytes: 2 * 1024 * 1024 },
  })
  try {
    const content = Buffer.alloc(4 * 1024 * 1024, 0x42)
    const name = addPiArchive(fx, {
      createdAt: T0,
      mode: 'full',
      snapshotRows: [{ id: 'file-cap-0001', name: 'cap.bin', kind: 'file', size: content.length }],
      contents: [{ id: 'file-cap-0001', data: content }],
    })
    const plan = await fx.service.createRestorePlan(fx.actor, { archive: name, paths: ['/'] })
    const error = await expectAppRejects(fx.service.executeRestore(fx.actor, plan.id), 507, 'insufficient_storage')
    assert.match(error.message, /临时空间|空间/)
    const root = fx.db.prepare('SELECT COUNT(*) AS c FROM files WHERE parent_id IS NULL').get() as { c: number }
    assert.equal(root.c, 0, 'staging 超限时不得创建恢复目标')
  } finally {
    fx.close()
  }
})
