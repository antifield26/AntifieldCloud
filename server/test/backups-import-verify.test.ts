/** 备份导入/校验/清单测试：SHA、manifest、tar 安全、重复/超大/孤儿与清理。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '../src/util/errors.ts'
import { backupsFixture, buildArchive, importBuffer } from './backups-fixtures.ts'

const T0 = '2026-06-01T00:00:00.000Z'

async function expectCode(promise: Promise<unknown>, code: string, status?: number): Promise<AppError> {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, `应抛出 AppError，实际为 ${String(error)}`)
    assert.equal(error.code, code)
    if (status !== undefined) assert.equal(error.statusCode, status)
    return true
  }) as unknown as Promise<AppError>
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

test('导入 + 自动校验 + 清单/审计', async () => {
  const fx = backupsFixture()
  try {
    const archive = buildArchive({ createdAt: T0, mode: 'full', workDir: fx.dir, snapshotRows: [], contents: [] })
    const imported = await importBuffer(fx, archive.name, archive.buffer)
    assert.equal(imported.verify.ok, true)
    assert.equal(imported.archive.origin, 'import')
    assert.equal(imported.archive.status, 'imported')
    assert.ok(imported.archive.verifiedAt)
    assert.equal(imported.archive.manifest?.mode, 'full')
    assert.equal(imported.archive.sizeBytes, archive.buffer.length)

    const row = fx.db.prepare('SELECT * FROM backup_archives WHERE name = ?').get(archive.name) as {
      origin: string
      sha256: string
      verified_at: string | null
      manifest_json: string | null
    }
    assert.equal(row.origin, 'import')
    assert.equal(row.sha256, sha256(archive.buffer))
    assert.ok(row.verified_at)
    assert.ok(row.manifest_json)
    assert.ok(existsSync(join(fx.importsDir, archive.name)))

    // 显式再校验一次（导入时的自动校验不写审计，避免重复记录）。
    await fx.service.verify(fx.actor, archive.name)

    const list = fx.service.list()
    assert.equal(list.items.length, 1)
    assert.equal(list.state.importCount, 1)
    assert.equal(list.inbox.length, 1)
    assert.equal(list.orphans.length, 0)
    assert.ok(list.state.dataDirFreeBytes >= 0)
    const auditActions = (fx.db.prepare('SELECT action FROM audit_log ORDER BY id').all() as unknown as { action: string }[]).map(
      (item) => item.action,
    )
    assert.ok(auditActions.includes('backup_import'))
    assert.ok(auditActions.includes('backup_verify'))
  } finally {
    fx.close()
  }
})

test('重复名/非法名/超大/空流被拒绝且不留临时文件', async () => {
  const fx = backupsFixture()
  try {
    const archive = buildArchive({ createdAt: T0, mode: 'full', workDir: fx.dir, snapshotRows: [], contents: [] })
    const first = await importBuffer(fx, archive.name, archive.buffer)
    assert.equal(first.verify.ok, true)
    await expectCode(importBuffer(fx, archive.name, archive.buffer), 'archive_exists', 409)
    await expectCode(importBuffer(fx, 'evil.tar.gz', archive.buffer), 'invalid_archive_name', 400)
    await expectCode(importBuffer(fx, 'snapshot-20260601T020000Z-full.tar.gz', Buffer.alloc(0)), 'invalid_archive_upload', 400)
    const leftovers = readdirSync(fx.importsDir).filter((name) => name.startsWith('.part-'))
    assert.deepEqual(leftovers, [])
  } finally {
    fx.close()
  }

  // 超过导入大小上限时拒绝，且不写入最终文件。
  const small = backupsFixture({ config: { backupImportMaxBytes: 1024 } })
  try {
    const archive = buildArchive({ createdAt: T0, mode: 'full', workDir: small.dir, snapshotRows: [], contents: [] })
    assert.ok(archive.buffer.length > 1024)
    await expectCode(importBuffer(small, archive.name, archive.buffer), 'archive_too_large', 413)
    assert.deepEqual(readdirSync(small.importsDir).filter((name) => !name.startsWith('.')), [])
  } finally {
    small.close()
  }
})

test('不安全归档：导入保留但校验失败并记录 last_error', async () => {
  const fx = backupsFixture()
  try {
    const archive = buildArchive({
      createdAt: T0,
      mode: 'full',
      workDir: fx.dir,
      snapshotRows: [],
      contents: [],
      extraEntries: [{ path: '../evil.sh', data: Buffer.from('x') }],
    })
    const imported = await importBuffer(fx, archive.name, archive.buffer)
    assert.equal(imported.verify.ok, false)
    assert.match(imported.verify.error ?? '', /归档|路径/)
    assert.equal(imported.archive.verifiedAt, null)
    assert.ok(imported.archive.lastError)
    await expectCode(fx.service.verify(fx.actor, archive.name), 'unsafe_archive', 422)
    assert.ok(fx.service.list().state.lastError)
  } finally {
    fx.close()
  }
})

test('SHA 不一致与 manifest 不一致被拒绝', async () => {
  const fx = backupsFixture()
  try {
    const archive = buildArchive({ createdAt: T0, mode: 'full', workDir: fx.dir, snapshotRows: [], contents: [] })
    await importBuffer(fx, archive.name, archive.buffer)
    appendFileSync(join(fx.importsDir, archive.name), Buffer.from('tamper'))
    await expectCode(fx.service.verify(fx.actor, archive.name), 'checksum_mismatch', 409)
    const row = fx.db.prepare('SELECT last_error FROM backup_archives WHERE name = ?').get(archive.name) as {
      last_error: string | null
    }
    assert.ok(row.last_error)

    const badManifest = buildArchive({
      createdAt: '2026-06-02T00:00:00.000Z',
      mode: 'full',
      workDir: fx.dir,
      snapshotRows: [],
      contents: [],
      manifestPatch: { fileCount: 99 },
    })
    const imported = await importBuffer(fx, badManifest.name, badManifest.buffer)
    assert.equal(imported.verify.ok, false)
    await expectCode(fx.service.verify(fx.actor, badManifest.name), 'invalid_archive', 422)

    const noDb = buildArchive({
      createdAt: '2026-06-03T00:00:00.000Z',
      mode: 'full',
      workDir: fx.dir,
      snapshotRows: [],
      contents: [],
      includeDatabase: false,
    })
    const noDbImported = await importBuffer(fx, noDb.name, noDb.buffer)
    assert.equal(noDbImported.verify.ok, false)
    await expectCode(fx.service.verify(fx.actor, noDb.name), 'invalid_archive', 422)
  } finally {
    fx.close()
  }
})

test('Pi 归档清单状态：pending/acked/missing 与孤儿/inbox/清理', async () => {
  const fx = backupsFixture()
  try {
    const backupsDir = join(fx.dir, 'backups')
    mkdirSync(backupsDir, { recursive: true })
    const names = {
      pending: 'snapshot-20260601T000000Z-full.tar.gz',
      acked: 'snapshot-20260602T000000Z-inc.tar.gz',
      ackedMissing: 'snapshot-20260602T010000Z-inc.tar.gz',
      missing: 'snapshot-20260603T000000Z-full.tar.gz',
    }
    writeFileSync(join(backupsDir, names.pending), Buffer.alloc(16))
    writeFileSync(join(backupsDir, names.acked), Buffer.alloc(16))
    const insert = fx.db.prepare(
      `INSERT INTO backup_archives (name, mode, created_at, sha256, size, file_count, pulled_at, acked_at, origin)
       VALUES (?, ?, ?, ?, 16, 0, NULL, ?, 'pi')`,
    )
    insert.run(names.pending, 'full', '2026-06-01T00:00:00.000Z', 'a'.repeat(64), null)
    insert.run(names.acked, 'inc', '2026-06-02T00:00:00.000Z', 'b'.repeat(64), '2026-06-02T01:00:00.000Z')
    // PC ack 后主动删除服务端归档：仍是已确认，不应误报文件缺失。
    insert.run(names.ackedMissing, 'inc', '2026-06-02T01:00:00.000Z', 'd'.repeat(64), '2026-06-02T02:00:00.000Z')
    insert.run(names.missing, 'full', '2026-06-03T00:00:00.000Z', 'c'.repeat(64), null)

    const list = fx.service.list()
    const byName = new Map(list.items.map((item) => [item.name, item]))
    assert.equal(byName.get(names.pending)?.status, 'pending')
    assert.equal(byName.get(names.acked)?.status, 'acked')
    assert.equal(byName.get(names.ackedMissing)?.status, 'acked')
    assert.equal(byName.get(names.ackedMissing)?.available, false)
    assert.equal(byName.get(names.missing)?.status, 'missing')
    assert.equal(list.state.pendingCount, 1)
    assert.equal(list.state.ackedCount, 2)

    // 孤儿归档只报告不删除；pull 状态从 backup-pull.json 读取。
    mkdirSync(fx.importsDir, { recursive: true })
    writeFileSync(join(fx.importsDir, 'snapshot-20260604T000000Z-full.tar.gz'), Buffer.alloc(8))
    writeFileSync(fx.config.backupPullFile, JSON.stringify({ lastPullAt: '2026-06-05T00:00:00.000Z' }))
    const withOrphan = fx.service.list()
    assert.equal(withOrphan.state.orphanCount, 1)
    assert.equal(withOrphan.state.lastPullAt, '2026-06-05T00:00:00.000Z')
    assert.ok(existsSync(join(fx.importsDir, 'snapshot-20260604T000000Z-full.tar.gz')))

    // 清理：过期计划、24h 前 staging 与 .part 残留（时间基于夹具时钟，避免真实时间差）。
    const stalePart = join(fx.importsDir, '.part-stale')
    writeFileSync(stalePart, Buffer.alloc(4))
    const old = new Date(fx.clock.now().getTime() - 48 * 60 * 60_000)
    utimesSync(stalePart, old, old)
    const staleStaging = join(fx.dir, 'tmp', 'restore', 'old-dir')
    mkdirSync(staleStaging, { recursive: true })
    utimesSync(staleStaging, old, old)
    fx.db
      .prepare(
        `INSERT INTO restore_plans (id, archives_json, selection_json, target_name, status, created_by, created_at, expires_at)
         VALUES ('stale-plan', '[]', '{}', 'x', 'planned', 'admin', '2026-01-01T00:00:00.000Z', '2026-01-01T00:30:00.000Z')`,
      )
      .run()
    fx.db
      .prepare(
        `INSERT INTO restore_plans (id, archives_json, selection_json, target_name, status, created_by, created_at, expires_at)
         VALUES ('interrupted-plan', '[]', '{}', 'x', 'executing', 'admin', '2026-05-30T00:00:00.000Z', '2026-05-30T00:30:00.000Z')`,
      )
      .run()
    const cleaned = fx.service.cleanup()
    assert.equal(cleaned.expiredPlans, 1)
    assert.equal(cleaned.interruptedPlans, 1)
    assert.equal(cleaned.stagingDirs, 1)
    assert.equal(cleaned.partialImports, 1)
    assert.equal(existsSync(stalePart), false)
    const interrupted = fx.db.prepare("SELECT status FROM restore_plans WHERE id = 'interrupted-plan'").get() as {
      status: string
    }
    assert.equal(interrupted.status, 'failed')
  } finally {
    fx.close()
  }
})

test('verify 不存在归档返回 404', async () => {
  const fx = backupsFixture()
  try {
    await expectCode(fx.service.verify(fx.actor, 'snapshot-20260101T000000Z-full.tar.gz'), 'not_found', 404)
  } finally {
    fx.close()
  }
})
