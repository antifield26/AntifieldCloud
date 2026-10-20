/** tar.gz 安全读取测试：合法归档、路径穿越、链接/设备条目、损坏/截断与重复 manifest。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectTarGz, normalizeArchivePath, scanTarGz } from '../src/backups/tar.ts'
import { AppError } from '../src/util/errors.ts'
import { buildArchive, tarGz, type TarFixtureEntry } from './backups-fixtures.ts'

const DB_ENTRY = 'backups/db-20260101T000000Z.sqlite'
const MANIFEST_ENTRY = 'backups/manifest-20260101T000000Z.json'

function withArchive<T>(buffer: Buffer, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'afc-tar-'))
  const path = join(dir, 'archive.tar.gz')
  writeFileSync(path, buffer)
  return fn(path).finally(() => rmSync(dir, { recursive: true, force: true }))
}

async function expectArchiveError(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, `应抛出 AppError，实际为 ${String(error)}`)
    assert.equal(error.code, code)
    return true
  })
}

test('合法归档：统计文件条目、识别数据库与 manifest', async () => {
  const archive = buildArchive({
    createdAt: '2026-01-01T00:00:00.000Z',
    mode: 'full',
    workDir: tmpdir(),
    snapshotRows: [],
    contents: [{ id: 'aaaa1111-1111-4111-8111-111111111111', data: Buffer.from('hello') }],
  })
  await withArchive(archive.buffer, async (path) => {
    const inspection = await inspectTarGz(path)
    assert.equal(inspection.fileEntries, 1, 'fileEntries 只统计 files/ 内容文件')
    assert.equal(inspection.hasDatabase, true)
    assert.equal(inspection.hasManifest, true)
    assert.deepEqual(inspection.databasePaths, [DB_ENTRY])
    const manifest = JSON.parse(inspection.manifestRaw ?? '{}') as { mode: string; fileCount: number }
    assert.equal(manifest.mode, 'full')
    assert.equal(manifest.fileCount, 1)
  })
})

test('目录条目（含结尾斜杠）允许并跳过内容', async () => {
  const entries: TarFixtureEntry[] = [
    { path: 'files/ab', type: 'dir' },
    { path: DB_ENTRY, data: Buffer.from('db') },
    { path: MANIFEST_ENTRY, data: Buffer.from('{}') },
  ]
  await withArchive(tarGz(entries), async (path) => {
    const inspection = await inspectTarGz(path)
    // fileEntries 只统计 files/ 下的内容文件；backups/ 只用于识别 db/manifest。
    assert.equal(inspection.fileEntries, 0)
    assert.equal(inspection.entries, 3)
    assert.equal(normalizeArchivePath('files/ab/'), 'files/ab')
  })
})

test('路径穿越/绝对路径/反斜杠被拒绝', async () => {
  for (const bad of ['../evil.txt', 'files/../../evil', '/etc/passwd', 'files\\ab\\evil']) {
    await withArchive(tarGz([{ path: bad, data: Buffer.from('x') }]), async (path) => {
      await expectArchiveError(inspectTarGz(path), 'unsafe_archive')
    })
  }
  assert.throws(() => normalizeArchivePath('../x'), (error: unknown) => error instanceof AppError && error.code === 'unsafe_archive')
})

test('符号链接/硬链接/设备类条目被拒绝', async () => {
  await withArchive(tarGz([{ path: 'files/ab/link', type: 'symlink', linkname: '/etc/passwd' }]), async (path) => {
    await expectArchiveError(inspectTarGz(path), 'unsafe_archive')
  })
  await withArchive(tarGz([{ path: 'files/ab/link', type: 'hardlink', linkname: 'files/ab/target' }]), async (path) => {
    await expectArchiveError(inspectTarGz(path), 'unsafe_archive')
  })
})

test('备份目录之外的文件与重复 manifest 被拒绝', async () => {
  await withArchive(tarGz([{ path: 'secret.txt', data: Buffer.from('x') }]), async (path) => {
    await expectArchiveError(inspectTarGz(path), 'unsafe_archive')
  })
  await withArchive(
    tarGz([
      { path: MANIFEST_ENTRY, data: Buffer.from('{}') },
      { path: 'backups/manifest-20260102T000000Z.json', data: Buffer.from('{}') },
    ]),
    async (path) => {
      await expectArchiveError(inspectTarGz(path), 'unsafe_archive')
    },
  )
})

test('损坏/截断的 gzip 返回 invalid_archive', async () => {
  await withArchive(Buffer.from('this is not gzip'), async (path) => {
    await expectArchiveError(inspectTarGz(path), 'invalid_archive')
  })
  const archive = buildArchive({
    createdAt: '2026-01-01T00:00:00.000Z',
    mode: 'full',
    workDir: tmpdir(),
    snapshotRows: [],
    contents: [],
  })
  await withArchive(archive.buffer.subarray(0, 80), async (path) => {
    await expectArchiveError(inspectTarGz(path), 'invalid_archive')
  })
})

test('extract 决策写入文件且不覆盖已有文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afc-tar-extract-'))
  try {
    const dest = join(dir, 'out.bin')
    writeFileSync(dest, 'existing')
    const buffer = tarGz([{ path: 'files/ab/x', data: Buffer.from('payload') }])
    const archivePath = join(dir, 'a.tar.gz')
    writeFileSync(archivePath, buffer)
    await assert.rejects(
      scanTarGz(archivePath, () => ({ kind: 'extract', dest })),
      (error: unknown) => error instanceof AppError,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
