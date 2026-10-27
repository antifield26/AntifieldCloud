import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { cleanupDir, tempDataDir } from './helpers.ts'

/** 有效的 age 公钥形状（仅用于解析/正则夹具，非真实密钥）。 */
const FAKE_AGE_RECIPIENT = `age1${'q'.repeat(58)}`

interface RunResult {
  status: number | null
  json: Record<string, unknown>
  stderr: string
}

function runBackup(dir: string, args: string[], env: Record<string, string> = {}): RunResult {
  const result = spawnSync(process.execPath, [join('scripts', 'backup.mjs'), ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATA_DIR: dir,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      APP_VERSION: '0.7.0-test',
      BACKUP_ARCHIVE_ENCRYPTION: 'true',
      BACKUP_AGE_RECIPIENT_FILE: join(dir, 'backup-age.pub'),
      BACKUP_AGE_FAKE: '1',
      BACKUP_SKIP_KEY_OWNER_CHECK: '1',
      ...env,
    },
    encoding: 'utf8',
    timeout: 120_000,
  })
  const line = (result.stdout ?? '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => value.startsWith('{'))
    .at(-1)
  assert.ok(line, `备份没有输出 JSON（status=${result.status}）：${result.stderr}`)
  return { status: result.status, json: JSON.parse(line) as Record<string, unknown>, stderr: result.stderr ?? '' }
}

function writeRecipient(dir: string, content = FAKE_AGE_RECIPIENT): string {
  const path = join(dir, 'backup-age.pub')
  writeFileSync(path, `${content}\n`, { mode: 0o600 })
  return path
}

function backupsDir(dir: string): string {
  return join(dir, 'backups')
}

function backupFiles(dir: string): string[] {
  try {
    return readdirSync(backupsDir(dir))
  } catch {
    return []
  }
}

test('加密 prepare：生成 .tar.gz.age + sidecar，明文哈希在归档外且临时明文被清理', () => {
  const dir = tempDataDir()
  try {
    writeRecipient(dir)
    const result = runBackup(dir, ['--prepare', '--full'])
    assert.equal(result.status, 0, String(result.json.error ?? result.stderr))
    assert.equal(result.json.ok, true)
    assert.equal(result.json.encrypted, true)
    assert.equal(result.json.archiveFormat, 'tar.gz.age')
    const archiveName = String(result.json.archiveName)
    assert.match(archiveName, /^snapshot-.+-(full|inc)\.tar\.gz\.age$/)
    assert.equal(result.json.metaName, `${archiveName}.meta.json`)

    const archivePath = join(backupsDir(dir), archiveName)
    const metaPath = join(backupsDir(dir), `${archiveName}.meta.json`)
    assert.equal(existsSync(archivePath), true)
    assert.equal(existsSync(metaPath), true)
    // 归档临时明文不得残留。
    assert.equal(backupFiles(dir).some((name) => name.endsWith('.plain.tmp')), false)

    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
    assert.equal(meta.schema, 2)
    assert.equal(meta.encrypted, true)
    assert.equal(meta.name, archiveName)
    assert.equal(meta.plainSha256, result.json.plainSha256)
    assert.equal(meta.cipherSha256, result.json.sha256)
    assert.equal(meta.plainSize, result.json.plainSize)
    // 外部元数据必须区分明文与密文（旧设计把 plainSha 放进归档内会自引用）。
    assert.match(String(meta.plainSha256), /^[0-9a-f]{64}$/)
    assert.match(String(meta.cipherSha256), /^[0-9a-f]{64}$/)
    assert.notEqual(meta.plainSha256, meta.cipherSha256)
    // 密文大小 = 明文 + 测试前缀，sidecar 记录的不是明文大小。
    assert.equal(Number(meta.cipherSize), statSync(archivePath).size)
    assert.ok(Number(meta.plainSize) < Number(meta.cipherSize))

    // 归档内 manifest 不允许出现 plainSha256（扫描解压后的明文 tar 不可行；直接检查 DB 外部元数据）。
    const db = new DatabaseSync(join(dir, 'db.sqlite'), { readOnly: true })
    try {
      const row = db
        .prepare('SELECT name, size, manifest_json FROM backup_archives WHERE name = ?')
        .get(archiveName) as { name: string; size: number; manifest_json: string }
      assert.equal(Number(row.size), statSync(archivePath).size)
      const manifest = JSON.parse(row.manifest_json) as Record<string, unknown>
      assert.equal(manifest.plainSha256, result.json.plainSha256)
      assert.equal(manifest.plainSize, result.json.plainSize)
      assert.equal(manifest.encrypted, true)
      assert.equal(manifest.schema, 2)
    } finally {
      db.close()
    }

    const pending = runBackup(dir, ['--pending'])
    assert.equal(pending.status, 0)
    const entry = (pending.json.pending as Array<Record<string, unknown>>)[0]!
    assert.equal(entry.encrypted, true)
    assert.equal(entry.metaName, `${archiveName}.meta.json`)
    assert.equal(entry.metaExists, true)
  } finally {
    cleanupDir(dir)
  }
})

test('加密失败关闭：age 失败时不生成 pending/明文/密文，且没有半成品残留', () => {
  const dir = tempDataDir()
  try {
    writeRecipient(dir)
    const result = runBackup(dir, ['--prepare', '--full'], { BACKUP_AGE_FAKE_FAIL: '1' })
    assert.notEqual(result.status, 0)
    assert.equal(result.json.ok, false)
    assert.match(String(result.json.error), /加密失败/)
    assert.equal(backupFiles(dir).some((name) => name.endsWith('.tar.gz.age')), false)
    assert.equal(backupFiles(dir).some((name) => name.endsWith('.plain.tmp')), false)
    assert.equal(backupFiles(dir).some((name) => name.endsWith('.part')), false)
    const pending = runBackup(dir, ['--pending'])
    assert.equal(pending.json.count, 0)
    const db = new DatabaseSync(join(dir, 'db.sqlite'), { readOnly: true })
    try {
      const count = db.prepare('SELECT COUNT(*) AS c FROM backup_archives').get() as { c: number }
      assert.equal(Number(count.c), 0)
    } finally {
      db.close()
    }
  } finally {
    cleanupDir(dir)
  }
})

test('非法 age 公钥：在打包前失败关闭，不产生归档', () => {
  const dir = tempDataDir()
  try {
    writeRecipient(dir, 'not-an-age-recipient')
    const result = runBackup(dir, ['--prepare', '--full'])
    assert.notEqual(result.status, 0)
    assert.match(String(result.json.error), /age 公钥格式无效/)
    assert.equal(backupFiles(dir).some((name) => name.endsWith('.tar.gz.age')), false)
  } finally {
    cleanupDir(dir)
  }
})

test('缺少 age 公钥：失败关闭且提示路径', () => {
  const dir = tempDataDir()
  try {
    const result = runBackup(dir, ['--prepare', '--full'])
    assert.notEqual(result.status, 0)
    assert.match(String(result.json.error), /缺少 age 公钥文件/)
    assert.equal(backupFiles(dir).length, 0)
  } finally {
    cleanupDir(dir)
  }
})
