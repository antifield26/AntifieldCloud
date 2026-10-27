/** v0.7.0 备份服务加固：校验失败清状态、快照深度、恢复锁清理、interrupted 计划。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { AppError } from '../src/util/errors.ts'
import { buildArchive, buildAndImport, backupsFixture } from './backups-fixtures.ts'

const T0 = '2026-06-01T00:00:00.000Z'

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, `应抛出 AppError，实际为 ${String(error)}`)
    assert.equal(error.code, code)
    return true
  })
}

test('DATA-11：校验失败清除 verified_at/manifest_json，恢复计划不再可用', async () => {
  const fx = backupsFixture()
  try {
    const { archive } = await buildAndImport(fx, {
      createdAt: T0,
      mode: 'full',
      snapshotRows: [],
      contents: [],
    })
    const imported = fx.service.list().items.find((item) => item.name === archive.name)
    assert.ok(imported?.verifiedAt)
    assert.ok(imported.manifest)

    // 篡改归档（追加字节）后再次校验：SHA 不一致。
    appendFileSync(join(fx.importsDir, archive.name), Buffer.from('tamper'))
    await expectCode(fx.service.verify(fx.actor, archive.name), 'checksum_mismatch')

    const row = fx.db
      .prepare('SELECT verified_at, manifest_json, last_error FROM backup_archives WHERE name = ?')
      .get(archive.name) as { verified_at: string | null; manifest_json: string | null; last_error: string | null }
    assert.equal(row.verified_at, null)
    assert.equal(row.manifest_json, null)
    assert.ok(row.last_error)
    const listed = fx.service.list().items.find((item) => item.name === archive.name)
    assert.equal(listed?.verifiedAt, null)
    assert.equal(listed?.manifest, null)

    await expectCode(
      fx.service.createRestorePlan(fx.actor, { archive: archive.name, paths: ['/'] }),
      'archive_not_verified',
    )
  } finally {
    fx.close()
  }
})

test('DATA-08：归档目录层级超过上限时明确失败而不是静默丢子树', async () => {
  const fx = backupsFixture()
  try {
    const depth = 70
    const rows = []
    let parentId: string | null = null
    for (let index = 0; index < depth; index += 1) {
      const id = `d${String(index).padStart(7, '0')}`
      rows.push({ id, parentId, name: `dir-${index}`, kind: 'dir' as const })
      parentId = id
    }
    const archive = buildArchive({
      createdAt: T0,
      mode: 'full',
      workDir: fx.dir,
      snapshotRows: rows,
      contents: [],
    })
    const imported = await fx.service.importArchive(fx.actor, {
      filename: archive.name,
      stream: Readable.from(archive.buffer),
    })
    // 导入时的自动校验只做 tar/清单校验，不加载目录树；浏览/恢复加载快照时必须明确失败。
    assert.equal(imported.verify.ok, true)
    await expectCode(fx.service.listArchiveEntries(archive.name, '/'), 'invalid_archive')
  } finally {
    fx.close()
  }
})

test('DATA-03：cleanup 清理过期恢复锁，保留新鲜锁', () => {
  const fx = backupsFixture()
  try {
    const tmpDir = join(fx.dir, 'tmp')
    mkdirSync(tmpDir, { recursive: true })
    const lockPath = join(tmpDir, 'restore.lock')
    writeFileSync(lockPath, 'stale', { mode: 0o600 })
    const old = new Date(Date.now() - 3 * 60 * 60_000)
    utimesSync(lockPath, old, old)
    fx.service.cleanup()
    assert.equal(existsSync(lockPath), false)

    writeFileSync(lockPath, 'fresh', { mode: 0o600 })
    fx.service.cleanup()
    assert.equal(existsSync(lockPath), true)

    // 加密 prepare 崩溃遗留的明文临时文件在 TTL 后清理。
    const backupsDir = join(fx.dir, 'backups')
    mkdirSync(backupsDir, { recursive: true })
    const plainTemp = join(backupsDir, 'snapshot-old-full.tar.gz.plain.tmp')
    writeFileSync(plainTemp, 'plaintext-temp', { mode: 0o600 })
    // 清理使用 service 注入时钟（T0），mtime 也按 T0 前 25h 设置。
    const staleTime = new Date(Date.parse(T0) - 25 * 60 * 60_000)
    utimesSync(plainTemp, staleTime, staleTime)
    fx.service.cleanup()
    assert.equal(existsSync(plainTemp), false)
  } finally {
    fx.close()
  }
})

test('DATA-06：进程重启后 cleanup 将 executing 计划标记失败（无恢复在跑）', () => {
  const fx = backupsFixture()
  try {
    fx.db
      .prepare(
        `INSERT INTO restore_plans (id, archives_json, selection_json, target_name, status, created_by, created_at, expires_at)
         VALUES ('plan-interrupted', '[]', '[]', 'x', 'executing', 'admin', ?, ?)`,
      )
      .run(T0, '2026-06-01T00:30:00.000Z')
    const result = fx.service.cleanup()
    assert.equal(result.interruptedPlans, 1)
    const row = fx.db.prepare("SELECT status FROM restore_plans WHERE id = 'plan-interrupted'").get() as {
      status: string
    }
    assert.equal(row.status, 'failed')
  } finally {
    fx.close()
  }
})
