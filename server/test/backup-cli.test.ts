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

    const acked = runBackup(dir, ['--ack', String(entry.name), '--sha256', String(entry.sha256)])
    assert.equal(acked.status, 0)
    assert.equal(acked.json.ok, true)
    assert.equal(acked.json.alreadyAcked, false)
    assert.equal(countPending(dir), 0)
    assert.equal(readBackupState(dir)?.last_backup_at, String(prepared.json.createdAt))

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
    // 先初始化 DB（不生成归档），再插入一个超大文件元数据行触发空间预算失败（不实际写大文件）。
    const init = runBackup(dir, ['--pending'])
    assert.equal(init.status, 0)
    const dbPath = join(dir, 'db.sqlite')
    const rw = new DatabaseSync(dbPath)
    const now = new Date().toISOString()
    try {
      rw.prepare(
        `INSERT INTO files (id, parent_id, name, kind, size, mime, sha256, storage_key, created_at, updated_at, deleted_at, deleted_parent_id)
         VALUES (?, NULL, ?, 'file', ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      ).run('space-test-file', 'huge.bin', 1_000_000_000_000_000, 'application/octet-stream', '0'.repeat(64), 'space-test-file', now, now)
    } finally {
      rw.close()
    }

    const failed = runBackup(dir, ['--prepare', '--full'])
    assert.notEqual(failed.status, 0)
    assert.equal(failed.json.ok, false)
    assert.match(String(failed.json.error), /磁盘空间不足/)
    assert.equal(countPending(dir), 0)
    const archiveCount = existsSync(join(dir, 'backups'))
      ? readdirSync(join(dir, 'backups')).filter((name) => name.endsWith('.tar.gz')).length
      : 0
    assert.equal(archiveCount, 0)
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
