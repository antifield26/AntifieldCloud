/** 备份恢复测试：full+inc 链、文件级选择、不覆盖、计划过期/并发/配额与失败清理。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { AppError } from '../src/util/errors.ts'
import { backupsFixture, buildArchive, type BackupsFixture, type SnapshotFixtureRow } from './backups-fixtures.ts'

const T1 = '2026-06-01T00:00:00.000Z'
const T2 = '2026-06-02T00:00:00.000Z'
const DIR_ID = 'dddddddd-1111-4111-8111-111111111111'
const FILE_A = 'aaaa1111-1111-4111-8111-111111111111'
const FILE_B = 'bbbb2222-2222-4222-8222-222222222222'

const CONTENT_A = Buffer.from('alpha restore content')
const CONTENT_B = Buffer.from('beta restore content')
const INC_NAME = 'snapshot-20260602T000000Z-inc.tar.gz'

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function snapshotRows(includeB: boolean): SnapshotFixtureRow[] {
  const rows: SnapshotFixtureRow[] = [
    { id: DIR_ID, name: 'docs', kind: 'dir' },
    { id: FILE_A, parentId: DIR_ID, name: 'a.txt', size: CONTENT_A.length, sha256: sha256(CONTENT_A) },
  ]
  if (includeB) rows.push({ id: FILE_B, name: 'b.txt', size: CONTENT_B.length, sha256: sha256(CONTENT_B) })
  return rows
}

function fullArchive(fx: BackupsFixture, nameOverride?: string): { name: string; buffer: Buffer } {
  return buildArchive({
    createdAt: T1,
    mode: 'full',
    workDir: fx.dir,
    snapshotRows: snapshotRows(false),
    contents: [{ id: FILE_A, data: CONTENT_A }],
    ...(nameOverride ? { nameOverride } : {}),
  })
}

function incArchive(fx: BackupsFixture): { name: string; buffer: Buffer } {
  return buildArchive({
    createdAt: T2,
    mode: 'inc',
    since: T1,
    workDir: fx.dir,
    snapshotRows: snapshotRows(true),
    contents: [{ id: FILE_B, data: CONTENT_B }],
  })
}

async function importArchive(fx: BackupsFixture, archive: { name: string; buffer: Buffer }): Promise<void> {
  const result = await fx.service.importArchive(fx.actor, { filename: archive.name, stream: Readable.from(archive.buffer) })
  assert.equal(result.verify.ok, true, `导入的测试归档应能通过校验：${result.verify.error ?? ''}`)
}

async function seedChain(fx: BackupsFixture): Promise<{ full: string; inc: string }> {
  const full = fullArchive(fx)
  const inc = incArchive(fx)
  await importArchive(fx, full)
  await importArchive(fx, inc)
  return { full: full.name, inc: inc.name }
}

async function expectAppError(promise: Promise<unknown>, code: string, status: number): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, `应抛出 AppError，实际为 ${String(error)}`)
    assert.equal(error.code, code)
    assert.equal(error.statusCode, status)
    return true
  })
}

test('full+inc 链恢复全部文件到新文件夹（不覆盖、新 ID）', async () => {
  const fx = backupsFixture()
  try {
    const { full, inc } = await seedChain(fx)
    const plan = await fx.service.createRestorePlan(fx.actor, { archive: inc, paths: ['/'], targetName: '恢复-测试' })
    assert.deepEqual(plan.archives, [full, inc])
    assert.equal(plan.fileCount, 2)
    assert.equal(plan.totalBytes, CONTENT_A.length + CONTENT_B.length)
    assert.equal(plan.status, 'planned')

    const executed = await fx.service.executeRestore(fx.actor, plan.id)
    assert.equal(executed.result.filesRestored, 2)
    assert.equal(executed.result.bytesRestored, CONTENT_A.length + CONTENT_B.length)
    assert.equal(executed.plan.status, 'completed')

    const target = fx.db.prepare('SELECT * FROM files WHERE id = ?').get(executed.result.targetFolderId) as {
      id: string
      kind: string
      parent_id: string | null
      name: string
    }
    assert.equal(target.kind, 'dir')
    assert.equal(target.parent_id, null)
    assert.equal(target.name, '恢复-测试')

    const docs = fx.db.prepare("SELECT * FROM files WHERE parent_id = ? AND name = 'docs'").get(target.id) as {
      id: string
      kind: string
    }
    assert.equal(docs.kind, 'dir')
    const restoredA = fx.db.prepare('SELECT * FROM files WHERE parent_id = ? AND name = ?').get(docs.id, 'a.txt') as {
      id: string
      size: number
      sha256: string
    }
    const restoredB = fx.db.prepare('SELECT * FROM files WHERE parent_id = ? AND name = ?').get(target.id, 'b.txt') as {
      id: string
      size: number
      sha256: string
    }
    assert.notEqual(restoredA.id, FILE_A, '恢复应生成新 ID')
    assert.equal(restoredA.size, CONTENT_A.length)
    assert.equal(restoredA.sha256, sha256(CONTENT_A))
    assert.equal(restoredB.sha256, sha256(CONTENT_B))
    assert.equal(readFileSync(fx.files.storage.finalPath(restoredA.id)).toString(), CONTENT_A.toString())
    assert.equal(readFileSync(fx.files.storage.finalPath(restoredB.id)).toString(), CONTENT_B.toString())

    const actions = (fx.db.prepare('SELECT action FROM audit_log ORDER BY id').all() as unknown as { action: string }[]).map(
      (row) => row.action,
    )
    assert.ok(actions.includes('backup_restore_plan'))
    assert.ok(actions.includes('backup_restore_execute'))
    // 审计详情不包含服务器绝对路径。
    const details = (fx.db.prepare("SELECT COALESCE(detail_json, '') AS detail FROM audit_log").all() as unknown as {
      detail: string
    }[]).map((row) => row.detail)
    for (const detail of details) assert.ok(!detail.includes(fx.dir), '审计不得包含 DATA_DIR 绝对路径')
  } finally {
    fx.close()
  }
})

test('文件级选择只恢复选中路径；entries 接口可浏览快照', async () => {
  const fx = backupsFixture()
  try {
    const { inc } = await seedChain(fx)
    const rootEntries = await fx.service.listArchiveEntries(inc, '/')
    assert.deepEqual(
      rootEntries.items.map((item) => `${item.name}:${item.kind}`).sort(),
      ['b.txt:file', 'docs:dir'],
    )
    const docsEntries = await fx.service.listArchiveEntries(inc, '/docs')
    assert.deepEqual(docsEntries.items.map((item) => item.name), ['a.txt'])
    await expectAppError(fx.service.listArchiveEntries(inc, '/missing'), 'path_not_found', 404)

    const plan = await fx.service.createRestorePlan(fx.actor, { archive: inc, paths: ['/docs/a.txt'], targetName: '选择恢复' })
    assert.equal(plan.fileCount, 1)
    const executed = await fx.service.executeRestore(fx.actor, plan.id)
    const target = fx.db.prepare('SELECT id, name FROM files WHERE id = ?').get(executed.result.targetFolderId) as {
      id: string
      name: string
    }
    const docs = fx.db.prepare("SELECT id FROM files WHERE parent_id = ? AND name = 'docs'").get(target.id) as
      | { id: string }
      | undefined
    assert.ok(docs, '选中文件所在目录应被重建')
    const file = fx.db.prepare('SELECT name FROM files WHERE parent_id = ?').get(docs.id) as { name: string }
    assert.equal(file.name, 'a.txt')
    const bCount = fx.db.prepare('SELECT COUNT(*) AS c FROM files WHERE name = ? AND parent_id = ?').get('b.txt', target.id) as {
      c: number
    }
    assert.equal(bCount.c, 0)
  } finally {
    fx.close()
  }
})

test('计划校验：未校验/缺 full/配额不足/未启用恢复', async () => {
  const fx = backupsFixture()
  try {
    const { full, inc } = await seedChain(fx)
    fx.db.prepare('UPDATE backup_archives SET verified_at = NULL WHERE name = ?').run(full)
    await expectAppError(fx.service.createRestorePlan(fx.actor, { archive: inc, paths: ['/'] }), 'archive_not_verified', 409)
    fx.db.prepare('UPDATE backup_archives SET verified_at = ? WHERE name = ?').run(T1, full)
  } finally {
    fx.close()
  }

  const incOnly = backupsFixture()
  try {
    await importArchive(incOnly, incArchive(incOnly))
    await expectAppError(
      incOnly.service.createRestorePlan(incOnly.actor, { archive: INC_NAME, paths: ['/'] }),
      'archive_chain_invalid',
      409,
    )
  } finally {
    incOnly.close()
  }

  const quotaFx = backupsFixture({ config: { quotaBytes: 8 } })
  try {
    await seedChain(quotaFx)
    await expectAppError(quotaFx.service.createRestorePlan(quotaFx.actor, { archive: INC_NAME, paths: ['/'] }), 'quota_exceeded', 409)
  } finally {
    quotaFx.close()
  }

  const disabled = backupsFixture({ config: { backupRestoreEnabled: false } })
  try {
    await seedChain(disabled)
    await expectAppError(disabled.service.createRestorePlan(disabled.actor, { archive: INC_NAME, paths: ['/'] }), 'restore_disabled', 403)
  } finally {
    disabled.close()
  }
})

test('计划过期、并发执行与目标文件夹重名', async () => {
  const fx = backupsFixture()
  try {
    await seedChain(fx)
    const plan = await fx.service.createRestorePlan(fx.actor, { archive: INC_NAME, paths: ['/'] })
    fx.clock.advanceMs(31 * 60_000)
    await expectAppError(fx.service.executeRestore(fx.actor, plan.id), 'plan_expired', 410)
    assert.equal(fx.service.getRestorePlan(plan.id).status, 'expired')

    const plan2 = await fx.service.createRestorePlan(fx.actor, { archive: INC_NAME, paths: ['/'], targetName: '恢复-测试' })
    const [first, second] = await Promise.allSettled([
      fx.service.executeRestore(fx.actor, plan2.id),
      fx.service.executeRestore(fx.actor, plan2.id),
    ])
    assert.equal(first.status, 'fulfilled')
    assert.equal(second.status, 'rejected')
    if (second.status === 'rejected') {
      assert.ok(second.reason instanceof AppError)
      assert.equal(second.reason.statusCode, 409)
    }

    fx.files.createFolder({ username: 'admin', ip: null }, null, '恢复-测试')
    const plan3 = await fx.service.createRestorePlan(fx.actor, { archive: INC_NAME, paths: ['/'], targetName: '恢复-测试' })
    const executed = await fx.service.executeRestore(fx.actor, plan3.id)
    assert.match(executed.result.targetName, /^恢复-测试 \(\d+\)$/)
  } finally {
    fx.close()
  }
})

test('内容哈希与快照不一致时恢复失败并清理已创建内容', async () => {
  const fx = backupsFixture()
  try {
    const tampered = buildArchive({
      createdAt: T1,
      mode: 'full',
      workDir: fx.dir,
      snapshotRows: [{ id: FILE_A, name: 'tampered.txt', size: CONTENT_A.length, sha256: 'f'.repeat(64) }],
      contents: [{ id: FILE_A, data: CONTENT_A }],
    })
    await importArchive(fx, tampered)
    const before = (fx.db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number }).c
    const plan = await fx.service.createRestorePlan(fx.actor, { archive: tampered.name, paths: ['/'], targetName: '失败恢复' })
    await expectAppError(fx.service.executeRestore(fx.actor, plan.id), 'invalid_archive', 422)
    const failed = fx.service.getRestorePlan(plan.id)
    assert.equal(failed.status, 'failed')
    assert.ok(failed.error)
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number }).c, before, '失败后不应留下文件行')
    assert.equal(
      (fx.db.prepare("SELECT COUNT(*) AS c FROM files WHERE name = '失败恢复'").get() as { c: number }).c,
      0,
      '失败后目标文件夹应被清理',
    )
    const actions = (fx.db.prepare('SELECT action FROM audit_log ORDER BY id').all() as unknown as { action: string }[]).map(
      (row) => row.action,
    )
    assert.ok(actions.includes('backup_restore_failed'))
  } finally {
    fx.close()
  }
})
