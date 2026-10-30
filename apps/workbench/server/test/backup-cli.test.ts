import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { cleanupDir, tempDataDir } from './helpers.ts'

interface BackupRun {
  status: number | null
  json: Record<string, unknown>
  stderr: string
}

function runBackup(dir: string, args: string[]): BackupRun {
  const result = spawnSync(process.execPath, [join('scripts', 'backup.mjs'), ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATA_DIR: dir,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      APP_VERSION: '0.3.0-test',
    },
    encoding: 'utf8',
    timeout: 60_000,
  })
  const line = (result.stdout ?? '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => value.startsWith('{'))
    .at(-1)
  assert.ok(line, `备份没有输出 JSON：${result.stderr}`)
  return { status: result.status, json: JSON.parse(line) as Record<string, unknown>, stderr: result.stderr ?? '' }
}

function openReadOnly(dir: string): DatabaseSync {
  return new DatabaseSync(join(dir, 'db.sqlite'), { readOnly: true })
}

function readBackupState(dir: string): { last_backup_at: string | null } | undefined {
  const db = openReadOnly(dir)
  try {
    return db.prepare('SELECT last_backup_at FROM backup_state WHERE id = 1').get() as
      | { last_backup_at: string | null }
      | undefined
  } finally {
    db.close()
  }
}

function countPending(dir: string): number {
  const output = runBackup(dir, ['--pending'])
  assert.equal(output.json.ok, true)
  return Number(output.json.count)
}

test('legacy：无动作参数直接报错，不再隐式生成/ack', () => {
  const dir = tempDataDir()
  try {
    const noArgs = runBackup(dir, [])
    assert.notEqual(noArgs.status, 0)
    assert.equal(noArgs.json.ok, false)
    assert.match(String(noArgs.json.error), /--prepare/)
    assert.match(String(noArgs.json.error), /--legacy/)

    const onlyFull = runBackup(dir, ['--full'])
    assert.notEqual(onlyFull.status, 0)
    assert.equal(onlyFull.json.ok, false)

    const conflicts = runBackup(dir, ['--legacy', '--pending'])
    assert.notEqual(conflicts.status, 0)
    assert.match(String(conflicts.json.error), /互斥/)
    assert.equal(existsSync(join(dir, 'backups')), false)
  } finally {
    cleanupDir(dir)
  }
})

test('legacy：显式 --legacy 可生成并立即 ack，输出/审计标记 deprecated', () => {
  const dir = tempDataDir()
  try {
    const first = runBackup(dir, ['--legacy', '--full'])
    assert.equal(first.status, 0)
    assert.equal(first.json.ok, true)
    assert.equal(first.json.deprecated, true)
    assert.equal(first.json.legacy, true)
    assert.equal(first.json.status, 'acked')
    assert.equal(first.json.mode, 'full')
    const archive = String(first.json.archive)
    assert.equal(existsSync(archive), true)
    assert.match(String(first.json.sha256), /^[0-9a-f]{64}$/)

    const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    assert.equal(listing.status, 0)
    assert.match(listing.stdout, /manifest-.*\.json/)
    assert.match(listing.stdout, /db-.*\.sqlite/)

    const second = runBackup(dir, ['--legacy'])
    assert.equal(second.status, 0)
    assert.equal(second.json.mode, 'inc')
    assert.equal(second.json.deprecated, true)
    assert.ok(readBackupState(dir)?.last_backup_at)

    const db = openReadOnly(dir)
    try {
      const auditRow = db
        .prepare("SELECT action, detail_json FROM audit_log WHERE action = 'backup_legacy' ORDER BY id DESC LIMIT 1")
        .get() as { action: string; detail_json: string } | undefined
      assert.ok(auditRow)
      assert.match(auditRow.detail_json, /"deprecated":true/)
    } finally {
      db.close()
    }
  } finally {
    cleanupDir(dir)
  }
})

test('prepare/pending 不推进游标，ack 校验后推进并清空 pending', () => {
  const dir = tempDataDir()
  try {
    const prepared = runBackup(dir, ['--prepare', '--full'])
    assert.equal(prepared.status, 0)
    assert.equal(prepared.json.ok, true)
    assert.equal(prepared.json.mode, 'full')
    assert.equal(prepared.json.status, 'pending')
    assert.equal(readBackupState(dir)?.last_backup_at ?? null, null)
    assert.equal(countPending(dir), 1)

    const pending = runBackup(dir, ['--pending'])
    const entry = (pending.json.pending as Array<Record<string, unknown>>)[0]!
    assert.equal(entry.exists, true)

    const rw = new DatabaseSync(join(dir, 'db.sqlite'))
    try {
      rw.prepare("UPDATE backup_archives SET last_error = '旧校验错误' WHERE name = ?").run(String(entry.name))
    } finally {
      rw.close()
    }

    const acked = runBackup(dir, ['--ack', String(entry.name), '--sha256', String(entry.sha256)])
    assert.equal(acked.status, 0)
    assert.equal(acked.json.ok, true)
    assert.equal(acked.json.alreadyAcked, false)
    assert.equal(countPending(dir), 0)
    assert.equal(readBackupState(dir)?.last_backup_at, String(prepared.json.createdAt))
    const ackedDb = openReadOnly(dir)
    try {
      const row = ackedDb.prepare('SELECT last_error FROM backup_archives WHERE name = ?').get(String(entry.name)) as {
        last_error: string | null
      }
      assert.equal(row.last_error, null, 'ack 成功后必须清除历史校验错误')
    } finally {
      ackedDb.close()
    }

    // 重复 ack 幂等。
    const again = runBackup(dir, ['--ack', String(entry.name), '--sha256', String(entry.sha256)])
    assert.equal(again.status, 0)
    assert.equal(again.json.ok, true)
    assert.equal(again.json.alreadyAcked, true)
  } finally {
    cleanupDir(dir)
  }
})

test('ack：错误 SHA、大小不符、缺失文件、未知归档均失败且不推进游标', () => {
  const dir = tempDataDir()
  try {
    const prepared = runBackup(dir, ['--prepare', '--full'])
    assert.equal(prepared.status, 0)
    const name = String(prepared.json.archiveName)
    const sha = String(prepared.json.sha256)

    const wrongSha = runBackup(dir, ['--ack', name, '--sha256', '0'.repeat(64)])
    assert.notEqual(wrongSha.status, 0)
    assert.equal(wrongSha.json.ok, false)
    assert.match(String(wrongSha.json.error), /SHA-256/)

    const dbPath = join(dir, 'db.sqlite')
    const rw = new DatabaseSync(dbPath)
    try {
      rw.prepare('UPDATE backup_archives SET size = size + 1 WHERE name = ?').run(name)
    } finally {
      rw.close()
    }
    const wrongSize = runBackup(dir, ['--ack', name, '--sha256', sha])
    assert.notEqual(wrongSize.status, 0)
    assert.equal(wrongSize.json.ok, false)
    assert.match(String(wrongSize.json.error), /大小/)

    const unknown = runBackup(dir, ['--ack', 'snapshot-unknown-full.tar.gz', '--sha256', sha])
    assert.notEqual(unknown.status, 0)
    assert.match(String(unknown.json.error), /未知归档/)

    rmSync(join(dir, 'backups', name), { force: true })
    const missing = runBackup(dir, ['--ack', name, '--sha256', sha])
    assert.notEqual(missing.status, 0)
    assert.match(String(missing.json.error), /不存在/)

    assert.equal(readBackupState(dir)?.last_backup_at ?? null, null)
    assert.equal(countPending(dir), 1)
  } finally {
    cleanupDir(dir)
  }
})

test('孤儿归档：--pending/--prepare 报告但不删除，且计入 orphanBytes', () => {
  const dir = tempDataDir()
  try {
    const backups = join(dir, 'backups')
    mkdirSync(backups, { recursive: true })
    const orphanName = 'snapshot-20200101T000000000Z-full.tar.gz'
    const orphanPath = join(backups, orphanName)
    writeFileSync(orphanPath, 'orphan-data')
    const orphanSize = statSync(orphanPath).size

    const pending = runBackup(dir, ['--pending'])
    assert.equal(pending.status, 0)
    assert.equal(pending.json.orphanBytes, orphanSize)
    assert.equal((pending.json.warnings as unknown[]).length, 1)
    const orphans = pending.json.orphans as Array<Record<string, unknown>>
    assert.equal(orphans.length, 1)
    assert.equal(orphans[0]!.name, orphanName)
    assert.equal(orphans[0]!.sizeBytes, orphanSize)

    const prepared = runBackup(dir, ['--prepare', '--full'])
    assert.equal(prepared.status, 0)
    assert.equal(prepared.json.orphanBytes, orphanSize)
    assert.equal((prepared.json.orphans as unknown[]).length, 1)
    assert.equal(existsSync(orphanPath), true, '孤儿归档不得被自动删除')
    assert.equal(readdirSync(backups).filter((name) => name.endsWith('.tar.gz')).length, 2)
  } finally {
    cleanupDir(dir)
  }
})

test('空间不足：prepare 失败且不生成 pending/归档', () => {
  const dir = tempDataDir()
  try {
    // 先初始化 DB（不生成归档），再插入一个超大 pending Pi 归档行让空间预算失败
    // （pendingBytes 计入预算，无需真的写大文件）。
    const init = runBackup(dir, ['--pending'])
    assert.equal(init.status, 0)
    const dbPath = join(dir, 'db.sqlite')
    const rw = new DatabaseSync(dbPath)
    try {
      const now = new Date().toISOString()
      rw.prepare(
        `INSERT INTO backup_archives (name, mode, created_at, sha256, size, file_count, pulled_at, acked_at, deleted_at, origin)
         VALUES ('snapshot-huge-full.tar.gz', 'full', ?, ?, 1000000000000000, 1, NULL, NULL, NULL, 'pi')`,
      ).run(now, '0'.repeat(64))
    } finally {
      rw.close()
    }

    const failed = runBackup(dir, ['--prepare', '--full'])
    assert.notEqual(failed.status, 0)
    assert.equal(failed.json.ok, false)
    assert.match(String(failed.json.error), /磁盘空间不足/)
    assert.equal(countPending(dir), 1, '失败不新增 pending（仅保留测试插入的超大行）')
    const archiveCount = existsSync(join(dir, 'backups'))
      ? readdirSync(join(dir, 'backups')).filter((name) => name.endsWith('.tar.gz')).length
      : 0
    assert.equal(archiveCount, 0)
  } finally {
    cleanupDir(dir)
  }
})

test('Web 导入归档不计入 pending，也不影响增量 since', () => {
  const dir = tempDataDir()
  try {
    // 先做一次全量并 ack，建立游标。
    const full = runBackup(dir, ['--legacy', '--full'])
    assert.equal(full.status, 0)
    const lastBackupAt = readBackupState(dir)?.last_backup_at
    assert.ok(lastBackupAt)

    // 游标之后新增一个文件（含物理内容），并插入一条未来的 Web 导入归档行。
    const now = new Date(Date.now() + 1000).toISOString()
    const fileId = 'imported-after-file'
    const physical = join(dir, 'files', fileId.slice(0, 2), fileId)
    mkdirSync(join(dir, 'files', fileId.slice(0, 2)), { recursive: true })
    writeFileSync(physical, 'new-content')
    const rw = new DatabaseSync(join(dir, 'db.sqlite'))
    try {
      rw.prepare(
        `INSERT INTO files (id, parent_id, name, kind, size, mime, sha256, storage_key, created_at, updated_at, deleted_at, deleted_parent_id)
         VALUES (?, NULL, 'new.txt', 'file', 11, 'text/plain', ?, ?, ?, ?, NULL, NULL)`,
      ).run(fileId, '0'.repeat(64), fileId, now, now)
      rw.prepare(
        `INSERT INTO backup_archives (name, mode, created_at, sha256, size, file_count, pulled_at, acked_at, deleted_at, origin)
         VALUES ('snapshot-IMPORT-full.tar.gz', 'full', '2030-01-01T00:00:00.000Z', ?, 10, 1, NULL, NULL, NULL, 'import')`,
      ).run('1'.repeat(64))
    } finally {
      rw.close()
    }

    // 导入归档仍 pending=0；建议模式为 inc（已 ack 过全量）。
    const pending = runBackup(dir, ['--pending'])
    assert.equal(pending.status, 0)
    assert.equal(pending.json.count, 0, 'origin=import 不计入 pending')
    assert.equal(pending.json.recommendedMode, 'inc')

    const prepared = runBackup(dir, ['--prepare'])
    assert.equal(prepared.status, 0)
    assert.equal(prepared.json.mode, 'inc')
    const archive = String(prepared.json.archive)
    const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    const manifestName = listing.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^backups\/manifest-.*\.json$/.test(line))
    assert.ok(manifestName)
    const manifestText = spawnSync('tar', ['-xOzf', archive, manifestName], { encoding: 'utf8' }).stdout
    const manifest = JSON.parse(manifestText) as {
      since: string | null
      files: { id: string }[]
      fileCount: number
    }
    assert.equal(manifest.since, lastBackupAt, 'since 取已确认游标，不受导入归档时间影响')
    assert.equal(manifest.fileCount, 1)
    assert.equal(manifest.files[0]?.id, fileId)
  } finally {
    cleanupDir(dir)
  }
})

test('缺失物理文件的预检：跳过并记录 skippedMissing/warnings，不整体失败', () => {
  const dir = tempDataDir()
  try {
    assert.equal(runBackup(dir, ['--pending']).status, 0)
    const now = new Date().toISOString()
    const rw = new DatabaseSync(join(dir, 'db.sqlite'))
    try {
      // 只插 DB 行、不写物理文件（模拟断电后“有行无文件”）。
      rw.prepare(
        `INSERT INTO files (id, parent_id, name, kind, size, mime, sha256, storage_key, created_at, updated_at, deleted_at, deleted_parent_id)
         VALUES ('missing-physical-file', NULL, 'gone.bin', 'file', 5, 'application/octet-stream', ?, 'missing-physical-file', ?, ?, NULL, NULL)`,
      ).run('2'.repeat(64), now, now)
    } finally {
      rw.close()
    }

    const prepared = runBackup(dir, ['--prepare', '--full'])
    assert.equal(prepared.status, 0, prepared.stderr)
    assert.equal(prepared.json.ok, true)
    assert.deepEqual(prepared.json.skippedMissing, ['missing-physical-file'])
    assert.equal((prepared.json.warnings as unknown[]).length, 1)
    assert.equal(prepared.json.fileCount, 0)

    const archive = String(prepared.json.archive)
    const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    assert.equal(listing.status, 0)
    const manifestName = listing.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^backups\/manifest-.*\.json$/.test(line))
    assert.ok(manifestName)
    const manifest = JSON.parse(
      spawnSync('tar', ['-xOzf', archive, manifestName], { encoding: 'utf8' }).stdout,
    ) as { skippedMissing: string[]; warnings: string[]; fileCount: number }
    assert.deepEqual(manifest.skippedMissing, ['missing-physical-file'])
    assert.equal(manifest.fileCount, 0)
    assert.equal(manifest.warnings.length, 1)
  } finally {
    cleanupDir(dir)
  }
})

test('snapshot-db：只读一致性快照可生成且不改备份游标', () => {
  const dir = tempDataDir()
  try {
    assert.equal(runBackup(dir, ['--prepare', '--full']).status, 0)
    const before = readBackupState(dir)?.last_backup_at ?? null
    const snapshot = runBackup(dir, ['--snapshot-db'])
    assert.equal(snapshot.status, 0)
    assert.equal(snapshot.json.ok, true)
    const snapPath = String(snapshot.json.snapshot)
    assert.equal(existsSync(snapPath), true)
    assert.match(String(snapshot.json.sha256), /^[0-9a-f]{64}$/)
    assert.equal(readBackupState(dir)?.last_backup_at ?? null, before)
  } finally {
    cleanupDir(dir)
  }
})
