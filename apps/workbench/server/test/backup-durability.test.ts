/** 备份 CLI 可靠性：缺失文件水位、ack 事务/游标修复、tar 残片清理、full 链保护与时钟告警。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { cleanupDir, tempDataDir } from './helpers.ts'

const ENV_BASE = { NODE_ENV: 'test', LOG_LEVEL: 'silent', APP_VERSION: '0.4.0-test' }

function runBackup(dir: string, args: string[], extraEnv: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [join('scripts', 'backup.mjs'), ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...ENV_BASE, DATA_DIR: dir, ...extraEnv },
    encoding: 'utf8',
    timeout: 120_000,
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

function openDb(dir: string): DatabaseSync {
  return new DatabaseSync(join(dir, 'db.sqlite'))
}

/** 读取 meta.backup_missing_files（等待下一次增量强制重查的缺失文件 id）。 */
function readMissingMeta(dir: string): string[] {
  const db = openDb(dir)
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'backup_missing_files'").get() as
      | { value: string }
      | undefined
    return row ? (JSON.parse(row.value) as string[]) : []
  } finally {
    db.close()
  }
}

/** 写一个仅用于 ack 校验的占位归档（内容不参与 CLI 解析）。 */
function writePlaceholderArchive(dir: string, name: string, content: string): string {
  mkdirSync(join(dir, 'backups'), { recursive: true })
  writeFileSync(join(dir, 'backups', name), content)
  return createHash('sha256').update(content).digest('hex')
}

function insertFile(
  db: DatabaseSync,
  id: string,
  name: string,
  createdAt: string,
  size = 3,
  origin = 'user',
): void {
  db.prepare(
    `INSERT INTO files (id, parent_id, name, kind, size, mime, sha256, storage_key, created_at, updated_at, deleted_at, deleted_parent_id, origin)
     VALUES (?, NULL, ?, 'file', ?, 'text/plain', ?, ?, ?, ?, NULL, NULL, ?)`,
  ).run(id, name, size, 'a'.repeat(64), id, createdAt, createdAt, origin)
}

function writePhysical(dir: string, id: string, content: string): void {
  mkdirSync(join(dir, 'files', id.slice(0, 2)), { recursive: true })
  writeFileSync(join(dir, 'files', id.slice(0, 2), id), content)
}

function manifestOf(archivePath: string): { skippedMissing?: string[]; files?: { id: string }[]; warnings?: string[]; since?: string | null } {
  const listing = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8' })
  const manifestName = listing.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((line) => /^backups\/manifest-.*\.json$/.test(line))
  assert.ok(manifestName, '归档缺少 manifest')
  const text = spawnSync('tar', ['-xOzf', archivePath, manifestName], { encoding: 'utf8' }).stdout
  return JSON.parse(text) as ReturnType<typeof manifestOf>
}

test('缺失文件不越水位：ack 后恢复文件，下一次增量自动补入', () => {
  const dir = tempDataDir()
  try {
    assert.equal(runBackup(dir, ['--pending']).status, 0)
    const createdAt = new Date(Date.now() - 60_000).toISOString()
    const id = 'missing-file-1'
    const db = openDb(dir)
    try {
      insertFile(db, id, 'gone.txt', createdAt)
    } finally {
      db.close()
    }

    const first = runBackup(dir, ['--prepare', '--full'])
    assert.equal(first.status, 0, first.stderr)
    assert.deepEqual(first.json.skippedMissing, [id])
    assert.equal((first.json.warnings as unknown[]).length >= 1, true)

    const pending = runBackup(dir, ['--pending'])
    const entry = (pending.json.pending as Array<Record<string, unknown>>)[0]!
    const acked = runBackup(dir, ['--ack', String(entry.name), '--sha256', String(entry.sha256)])
    assert.equal(acked.status, 0, acked.stderr)

    // ack 后缺失集合记入 meta。
    const db2 = openDb(dir)
    try {
      const meta = db2.prepare("SELECT value FROM meta WHERE key = 'backup_missing_files'").get() as
        | { value: string }
        | undefined
      assert.deepEqual(JSON.parse(meta?.value ?? '[]'), [id])
    } finally {
      db2.close()
    }

    // 恢复物理文件：它的 created_at 已低于备份水位，正常情况下增量不会再看它。
    writePhysical(dir, id, 'abc')

    const second = runBackup(dir, ['--prepare'])
    assert.equal(second.status, 0, second.stderr)
    assert.equal(second.json.mode, 'inc')
    const archive = String(second.json.archive)
    const manifest = manifestOf(archive)
    assert.equal(manifest.skippedMissing?.length ?? 0, 0, '恢复的文件不应再记为缺失')
    assert.deepEqual(manifest.files?.map((file) => file.id), [id], '早于水位但上次缺失的文件应补入增量')
  } finally {
    cleanupDir(dir)
  }
})

test('ack 幂等补游标：已 ack 行 + 旧游标重试后 backup_state 恢复', () => {
  const dir = tempDataDir()
  try {
    const prepared = runBackup(dir, ['--prepare', '--full'])
    assert.equal(prepared.status, 0)
    const pending = runBackup(dir, ['--pending'])
    const entry = (pending.json.pending as Array<Record<string, unknown>>)[0]!
    const acked = runBackup(dir, ['--ack', String(entry.name), '--sha256', String(entry.sha256)])
    assert.equal(acked.status, 0)

    const db = openDb(dir)
    try {
      db.prepare('UPDATE backup_state SET last_backup_at = NULL, last_archive = NULL WHERE id = 1').run()
    } finally {
      db.close()
    }
    const retry = runBackup(dir, ['--ack', String(entry.name), '--sha256', String(entry.sha256)])
    assert.equal(retry.status, 0, retry.stderr)
    assert.equal(retry.json.alreadyAcked, true)
    const db2 = openDb(dir)
    try {
      const state = db2.prepare('SELECT last_backup_at FROM backup_state WHERE id = 1').get() as {
        last_backup_at: string | null
      }
      assert.ok(state.last_backup_at, '重试 ack 应补齐游标')
      assert.equal(state.last_backup_at, String(prepared.json.createdAt))
    } finally {
      db2.close()
    }
  } finally {
    cleanupDir(dir)
  }
})

test('tar 失败：不留下 snapshot 残片/.part，且可立即重试成功', () => {
  const dir = tempDataDir()
  try {
    assert.equal(runBackup(dir, ['--pending']).status, 0)
    const db = openDb(dir)
    try {
      insertFile(db, 'physical-file', 'ok.txt', new Date().toISOString())
    } finally {
      db.close()
    }
    writePhysical(dir, 'physical-file', 'abc')

    const failed = runBackup(dir, ['--prepare', '--full'], { BACKUP_SIMULATE_TAR_FAILURE: '1' })
    assert.notEqual(failed.status, 0)
    assert.equal(failed.json.ok, false)
    const backups = join(dir, 'backups')
    const leftovers = existsSync(backups)
      ? readdirSync(backups).filter((name) => /snapshot-.*\.(tar\.gz|tar\.gz\.part)$/.test(name))
      : []
    assert.deepEqual(leftovers, [], '失败后不得留下 snapshot 残片或 .part')
    assert.equal(existsSync(join(backups, '.backup.lock')), false, '锁应已释放')

    const retried = runBackup(dir, ['--prepare', '--full'])
    assert.equal(retried.status, 0, retried.stderr)
    assert.equal(retried.json.ok, true)
  } finally {
    cleanupDir(dir)
  }
})

test('pruneAcked 保护最新 full 及其后所有 inc', () => {
  const dir = tempDataDir()
  try {
    const ackLatest = (): void => {
      const pending = runBackup(dir, ['--pending'])
      const list = pending.json.pending as Array<Record<string, unknown>>
      for (const entry of list) {
        const ack = runBackup(dir, ['--ack', String(entry.name), '--sha256', String(entry.sha256)])
        assert.equal(ack.status, 0, ack.stderr)
      }
    }
    assert.equal(runBackup(dir, ['--prepare', '--full']).status, 0)
    ackLatest()
    assert.equal(runBackup(dir, ['--prepare']).status, 0)
    ackLatest()
    assert.equal(runBackup(dir, ['--prepare', '--full']).status, 0)
    ackLatest()
    assert.equal(runBackup(dir, ['--prepare']).status, 0)
    ackLatest()

    const db = openDb(dir)
    try {
      const rows = db
        .prepare(
          "SELECT name, mode, deleted_at FROM backup_archives WHERE acked_at IS NOT NULL AND origin = 'pi' ORDER BY created_at ASC",
        )
        .all() as unknown as { name: string; mode: string; deleted_at: string | null }[]
      const alive = rows.filter((row) => row.deleted_at === null)
      assert.equal(alive.some((row) => row.mode === 'full'), true, '必须保留 full')
      assert.equal(alive.at(-1)?.mode, 'inc', '最新 inc 必须保留')
      assert.ok(rows.some((row) => row.deleted_at !== null), '旧归档应被清理')
    } finally {
      db.close()
    }
  } finally {
    cleanupDir(dir)
  }
})

test('时钟告警：未来 created_at 与水位晚于当前时间写入 warnings', () => {
  const dir = tempDataDir()
  try {
    assert.equal(runBackup(dir, ['--pending']).status, 0)
    const future = new Date(Date.now() + 3_600_000).toISOString()
    const db = openDb(dir)
    try {
      insertFile(db, 'future-file', 'future.txt', future)
      writePhysical(dir, 'future-file', 'abc')
      db.prepare('UPDATE backup_state SET last_backup_at = ? WHERE id = 1').run(future)
    } finally {
      db.close()
    }
    const prepared = runBackup(dir, ['--prepare', '--full'])
    assert.equal(prepared.status, 0, prepared.stderr)
    const warnings = prepared.json.warnings as string[]
    assert.ok(warnings.some((warning) => warning.includes('晚于当前时间')), warnings.join('\n'))
    assert.ok(warnings.some((warning) => warning.includes('时钟可能回拨')), warnings.join('\n'))
    assert.deepEqual(prepared.json.clockSkew, {
      detected: true,
      futureFiles: 1,
      watermarkRollback: true,
    })
  } finally {
    cleanupDir(dir)
  }
})

test('多 pending 顺序 ack 不丢 missing 重查集合：恢复后的文件由下一次增量补入', () => {
  const dir = tempDataDir()
  try {
    assert.equal(runBackup(dir, ['--pending']).status, 0)
    const createdAt = new Date(Date.now() - 60_000).toISOString()
    const id = 'missing-file-multi'
    const db = openDb(dir)
    try {
      insertFile(db, id, 'gone.txt', createdAt)
    } finally {
      db.close()
    }

    const first = runBackup(dir, ['--prepare', '--full'])
    assert.deepEqual(first.json.skippedMissing, [id])

    // 第一个 pending 尚未 ack 时再 prepare：增量不会重复选择早于水位的文件，其 manifest.skippedMissing 为空。
    const second = runBackup(dir, ['--prepare'])
    assert.equal(second.json.mode, 'inc')
    assert.deepEqual(second.json.skippedMissing, [])

    const pending = runBackup(dir, ['--pending']).json.pending as Array<Record<string, unknown>>
    assert.equal(pending.length, 2)
    for (const entry of pending) {
      const acked = runBackup(dir, ['--ack', String(entry.name), '--sha256', String(entry.sha256)])
      assert.equal(acked.status, 0, acked.stderr)
    }
    assert.deepEqual(readMissingMeta(dir), [id], '后 ack 的 inc 不能覆盖历史缺失集合')

    // 恢复物理文件后，即使 created_at 早于水位也必须由下一次增量强制补入。
    writePhysical(dir, id, 'abc')
    const third = runBackup(dir, ['--prepare'])
    assert.equal(third.json.mode, 'inc')
    const manifest = manifestOf(String(third.json.archive))
    assert.deepEqual(manifest.files?.map((file) => file.id), [id])

    const thirdEntry = (runBackup(dir, ['--pending']).json.pending as Array<Record<string, unknown>>)[0]!
    const thirdAck = runBackup(dir, ['--ack', String(thirdEntry.name), '--sha256', String(thirdEntry.sha256)])
    assert.equal(thirdAck.status, 0, thirdAck.stderr)
    assert.deepEqual(readMissingMeta(dir), [], '已覆盖的缺失 id 应从重查集合移除')
  } finally {
    cleanupDir(dir)
  }
})

test('ack 合并 missing 集合：manifest 缺失时保守保留，文件行删除后丢弃', () => {
  const dir = tempDataDir()
  try {
    assert.equal(runBackup(dir, ['--pending']).status, 0)
    const now = Date.now()
    const missingId = 'missing-manifest-1'
    const seed = openDb(dir)
    try {
      insertFile(seed, missingId, 'gone.txt', new Date(now - 7_200_000).toISOString())
    } finally {
      seed.close()
    }
    const insertArchive = (name: string, mode: 'full' | 'inc', createdAt: string, sha: string, manifestJson: string | null): void => {
      const db = openDb(dir)
      try {
        db.prepare(
          `INSERT INTO backup_archives (name, mode, created_at, sha256, size, file_count, pulled_at, acked_at, deleted_at, verified_at, origin, manifest_json, last_error)
           VALUES (?, ?, ?, ?, 1, 0, NULL, NULL, NULL, NULL, 'pi', ?, NULL)`,
        ).run(name, mode, createdAt, sha, manifestJson)
      } finally {
        db.close()
      }
    }
    const ack = (name: string, sha: string): void => {
      const acked = runBackup(dir, ['--ack', name, '--sha256', sha])
      assert.equal(acked.status, 0, acked.stderr)
    }

    const fullName = 'snapshot-20261021T000000000Z-full.tar.gz'
    const fullSha = writePlaceholderArchive(dir, fullName, 'A')
    insertArchive(
      fullName,
      'full',
      new Date(now - 5_400_000).toISOString(),
      fullSha,
      JSON.stringify({ schema: 1, mode: 'full', files: [], skippedMissing: [missingId] }),
    )
    ack(fullName, fullSha)
    assert.deepEqual(readMissingMeta(dir), [missingId])

    // 第二个归档 manifest 缺失（旧版本/损坏）：没有覆盖信息时保守保留仍存在的缺失 id。
    const incName = 'snapshot-20261022T000000000Z-inc.tar.gz'
    const incSha = writePlaceholderArchive(dir, incName, 'B')
    insertArchive(incName, 'inc', new Date(now - 3_600_000).toISOString(), incSha, null)
    ack(incName, incSha)
    assert.deepEqual(readMissingMeta(dir), [missingId], 'manifest 缺失时不得清空历史缺失集合')

    // 文件行真正删除后，缺失 id 不再有意义，应被移除。
    const cleanupDb = openDb(dir)
    try {
      cleanupDb.prepare('DELETE FROM files WHERE id = ?').run(missingId)
    } finally {
      cleanupDb.close()
    }
    const inc2Name = 'snapshot-20261023T000000000Z-inc.tar.gz'
    const inc2Sha = writePlaceholderArchive(dir, inc2Name, 'C')
    insertArchive(inc2Name, 'inc', new Date(now - 1_800_000).toISOString(), inc2Sha, null)
    ack(inc2Name, inc2Sha)
    assert.deepEqual(readMissingMeta(dir), [])
  } finally {
    cleanupDir(dir)
  }
})
