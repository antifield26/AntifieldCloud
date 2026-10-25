import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  analyzeTarListing,
  parseSidecar,
  sha256File,
  verifyArchiveSha,
  verifyDb,
  verifyManifest,
  WORLD_PREFIXES,
} from '../drill-verify.mjs'

/**
 * drill-verify.mjs 测试：构造真实 tar.gz/SQLite 夹具，覆盖恢复演练的关键校验路径。
 * 不依赖 Pi、不读写生产数据；临时目录在测试结束后删除。
 */

const DRILL_VERIFY = join(import.meta.dirname, '..', 'drill-verify.mjs')

/** 生成有效 SQLite 夹具（含 meta.schema_version）。 */
function makeDb(path, schemaVersion = 5) {
  const db = new DatabaseSync(path)
  try {
    db.exec(
      'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);' +
        'CREATE TABLE files (id TEXT PRIMARY KEY, size INTEGER NOT NULL);' +
        `INSERT INTO meta (key, value) VALUES ('schema_version', '${schemaVersion}');` +
        "INSERT INTO files (id, size) VALUES ('abc', 6);",
    )
  } finally {
    db.close()
  }
}

/** 生成完整归档夹具：backups/db-*.sqlite + backups/manifest-*.json + files/ab/abc。 */
async function makeArchiveFixture(root, { schemaVersion = 5 } = {}) {
  const staging = join(root, 'staging')
  const backupsDir = join(staging, 'backups')
  const filesDir = join(staging, 'files', 'ab')
  mkdirSync(backupsDir, { recursive: true })
  mkdirSync(filesDir, { recursive: true })
  const stamp = '20261020T040000Z'
  const dbPath = join(backupsDir, `db-${stamp}.sqlite`)
  makeDb(dbPath, schemaVersion)
  writeFileSync(join(filesDir, 'abc'), 'hello!')
  const manifest = {
    schema: 1,
    createdAt: '2026-10-20T04:00:00.000Z',
    mode: 'full',
    since: null,
    database: `backups/db-${stamp}.sqlite`,
    files: [{ id: 'abc', size: 6, createdAt: '2026-10-20T03:59:00.000Z' }],
    fileCount: 1,
    totalBytes: 6,
  }
  const manifestPath = join(backupsDir, `manifest-${stamp}.json`)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  const archivePath = join(root, `snapshot-${stamp}-full.tar.gz`)
  execFileSync('tar', ['-czf', archivePath, '-C', staging, 'backups', 'files'])
  const sha256 = await sha256File(archivePath)
  const sidecarPath = `${archivePath}.sha256`
  writeFileSync(sidecarPath, `${sha256}  ${archivePath.split(/[\\/]/).pop()}\n`)
  const listingPath = join(root, `listing-${stamp}.txt`)
  writeFileSync(listingPath, execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' }))
  return { archivePath, sidecarPath, listingPath, manifestPath, dbPath, sha256, manifest }
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'afc-drill-verify-'))
}

test('有效归档：sidecar/SHA/tar 列表/manifest/DB 全部通过', async () => {
  const root = tempRoot()
  try {
    const fixture = await makeArchiveFixture(root)
    const sidecar = parseSidecar(readFileSync(fixture.sidecarPath, 'utf8'), 'snapshot-20261020T040000Z-full.tar.gz')
    assert.equal(sidecar.ok, true)
    assert.equal(sidecar.sha256, fixture.sha256)
    assert.equal((await verifyArchiveSha(fixture.archivePath, fixture.sha256)).ok, true)

    const listing = analyzeTarListing(readFileSync(fixture.listingPath, 'utf8'))
    assert.equal(listing.ok, true, JSON.stringify(listing.errors))
    assert.equal(listing.fileEntries, 1)
    assert.equal(listing.manifests.length, 1)
    assert.equal(listing.databases.length, 1)

    const manifest = verifyManifest(fixture.manifest, { expectedMode: 'full', expectedFileCount: listing.fileEntries })
    assert.equal(manifest.ok, true, JSON.stringify(manifest.errors))

    const db = verifyDb(fixture.dbPath, { expectedSchemaVersion: 5 })
    assert.equal(db.ok, true, JSON.stringify(db.errors))
    assert.deepEqual(db.details.integrity, ['ok'])
    assert.equal(db.details.foreignKeyOk, true)
    assert.equal(db.details.schemaVersion, 5)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('缺 sidecar 与坏 SHA 都能被识别', async () => {
  assert.equal(parseSidecar('', 'a.tar.gz').errors[0].code, 'sidecar_missing')
  assert.equal(parseSidecar('not-a-hash  a.tar.gz', 'a.tar.gz').errors[0].code, 'sidecar_invalid')
  const wrongName = parseSidecar(`${'a'.repeat(64)}  other.tar.gz`, 'a.tar.gz')
  assert.equal(wrongName.errors[0].code, 'sidecar_name_mismatch')

  const root = tempRoot()
  try {
    const fixture = await makeArchiveFixture(root)
    const bad = await verifyArchiveSha(fixture.archivePath, '0'.repeat(64))
    assert.equal(bad.ok, false)
    assert.equal(bad.errors[0].code, 'sha256_mismatch')
    // 文件不存在 → 可诊断错误而不是崩溃
    const missing = await verifyArchiveSha(join(root, 'no-such.tar.gz'), fixture.sha256)
    assert.equal(missing.ok, false)
    assert.equal(missing.errors[0].code, 'archive_unreadable')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('tar 列表路径穿越/绝对路径/反斜杠/非法前缀被拒绝', () => {
  const unsafe = analyzeTarListing(
    [
      'backups/db-20261020T040000Z.sqlite',
      'backups/manifest-20261020T040000Z.json',
      'files/ab/abc',
      '../evil.txt',
      '/etc/passwd',
      'files\\..\\evil',
      'secrets/env',
      'files/ab/../../evil',
    ].join('\n'),
  )
  assert.equal(unsafe.ok, false)
  const codes = unsafe.errors.map((error) => error.code)
  assert.ok(codes.includes('tar_path_traversal'))
  assert.ok(codes.includes('tar_path_absolute'))
  assert.ok(codes.includes('tar_path_backslash'))
  assert.ok(codes.includes('tar_path_unexpected_prefix'))
  // 不安全条目不进入文件计数
  assert.equal(unsafe.fileEntries, 1)
})

test('tar 列表控制字符被拒绝', () => {
  const result = analyzeTarListing(`files/ab/${String.fromCharCode(7)}bad\n`)
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'tar_path_control_char')
})

test('世界归档列表：允许 world/ 前缀并识别 level.dat', () => {
  const listing = analyzeTarListing('world/level.dat\nworld/region/r.0.0.mca\nworld/\n', {
    allowedPrefixes: WORLD_PREFIXES,
  })
  assert.equal(listing.ok, true, JSON.stringify(listing.errors))
  assert.equal(listing.hasLevelDat, true)
  // 世界归档用应用前缀校验时应报前缀错误
  const wrongPrefix = analyzeTarListing('world/level.dat\n')
  assert.equal(wrongPrefix.ok, false)
  assert.equal(wrongPrefix.errors[0].code, 'tar_path_unexpected_prefix')
})

test('manifest：schema/mode/fileCount/fields 异常可诊断', () => {
  const valid = {
    schema: 1,
    createdAt: '2026-10-20T04:00:00.000Z',
    mode: 'inc',
    since: '2026-10-19T04:00:00.000Z',
    database: 'backups/db-20261020T040000Z.sqlite',
    files: [],
    fileCount: 0,
    totalBytes: 0,
  }
  assert.equal(verifyManifest(valid).ok, true)
  // v0.7.0：manifest schema 2 表示“已按加密特性新规则生成”，与 schema 1 同样可校验；3 才非法。
  assert.equal(verifyManifest({ ...valid, schema: 2 }).ok, true)
  assert.equal(verifyManifest({ ...valid, schema: 3 }).errors.some((error) => error.code === 'manifest_schema_invalid'), true)
  assert.equal(verifyManifest({ ...valid, mode: 'delta' }).errors.some((error) => error.code === 'manifest_mode_invalid'), true)
  assert.equal(verifyManifest(valid, { expectedMode: 'full' }).errors.some((error) => error.code === 'manifest_mode_mismatch'), true)
  assert.equal(verifyManifest({ ...valid, fileCount: 2 }).errors.some((error) => error.code === 'manifest_filecount_mismatch'), true)
  assert.equal(verifyManifest({ ...valid, since: null }).errors.some((error) => error.code === 'manifest_since_invalid'), true)
  const full = { ...valid, mode: 'full', since: null }
  assert.equal(verifyManifest(full, { expectedFileCount: 1 }).errors.some((error) => error.code === 'manifest_filecount_mismatch'), true)
  assert.equal(verifyManifest(null).errors[0].code, 'manifest_invalid')
})

test('坏 DB：损坏文件返回错误码而不是抛异常', () => {
  const root = tempRoot()
  try {
    const badDb = join(root, 'db-bad.sqlite')
    writeFileSync(badDb, 'this is not a sqlite database')
    const result = verifyDb(badDb)
    assert.equal(result.ok, false)
    assert.ok(result.errors.length > 0)
    const codes = result.errors.map((error) => error.code)
    assert.ok(codes.includes('db_integrity_failed'))
    assert.equal(result.details.integrityOk, false)
    // 不存在文件 → db_open_failed
    const missing = verifyDb(join(root, 'missing.sqlite'))
    assert.equal(missing.errors[0].code, 'db_open_failed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI：有效归档组合校验退出码 0，缺 sidecar 退出码 1', async () => {
  const root = tempRoot()
  try {
    const fixture = await makeArchiveFixture(root)
    const ok = spawnSync(
      process.execPath,
      [
        DRILL_VERIFY,
        '--archive',
        fixture.archivePath,
        '--sidecar',
        fixture.sidecarPath,
        '--tar-list',
        fixture.listingPath,
        '--manifest',
        fixture.manifestPath,
        '--db',
        fixture.dbPath,
        '--expect-mode',
        'full',
        '--schema-version',
        '5',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
    const parsed = JSON.parse(ok.stdout.trim())
    assert.equal(parsed.ok, true, JSON.stringify(parsed.errors))
    assert.equal(parsed.checks.db.details.schemaVersion, 5)

    const fail = spawnSync(
      process.execPath,
      [DRILL_VERIFY, '--archive', fixture.archivePath, '--sidecar', join(root, 'missing.sha256'), '--tar-list', fixture.listingPath],
      { encoding: 'utf8' },
    )
    assert.equal(fail.status, 1)
    const failedJson = JSON.parse(fail.stdout.trim())
    assert.equal(failedJson.ok, false)
    assert.equal(failedJson.errors[0].code, 'file_unreadable')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
