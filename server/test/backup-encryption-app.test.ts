/** v0.7.0 加密归档在应用侧的边界：可展示、不可校验/浏览/恢复（Pi 无私钥）。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { AppError } from '../src/util/errors.ts'
import { backupsFixture } from './backups-fixtures.ts'

const T0 = '2026-06-01T00:00:00.000Z'
const ARCHIVE = 'snapshot-20260601T000000Z-full.tar.gz.age'

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

async function expectCode(promise: Promise<unknown>, code: string, status?: number): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, `应抛出 AppError，实际为 ${String(error)}`)
    assert.equal(error.code, code)
    if (status !== undefined) assert.equal(error.statusCode, status)
    return true
  })
}

/** 写入一个加密归档行 + 密文 + sidecar（验证“应用只碰密文，不碰私钥/明文”）。 */
function seedEncryptedArchive(fx: ReturnType<typeof backupsFixture>): { cipher: Buffer; plainSha: string } {
  const backupsDir = join(fx.dir, 'backups')
  mkdirSync(backupsDir, { recursive: true })
  const plain = Buffer.from('fake-plain-tar-bytes')
  const cipher = Buffer.concat([Buffer.from('age-encryption.org/v1\nfake-age\n'), plain])
  writeFileSync(join(backupsDir, ARCHIVE), cipher, { mode: 0o640 })
  const plainSha = sha256(plain)
  const cipherSha = sha256(cipher)
  const manifest = {
    schema: 2,
    createdAt: T0,
    mode: 'full',
    since: null,
    database: 'backups/db-20260601T000000Z.sqlite',
    files: [],
    fileCount: 0,
    totalBytes: 0,
    skippedMissing: [],
    warnings: [],
    encrypted: true,
    archiveFormat: 'tar.gz.age',
    plainSha256: plainSha,
    plainSize: plain.length,
    cipherSha256: cipherSha,
    cipherSize: cipher.length,
    encryptedWith: 'age',
    recipient: `age1${'q'.repeat(58)}`,
  }
  writeFileSync(
    join(backupsDir, `${ARCHIVE}.meta.json`),
    JSON.stringify({
      schema: 2,
      name: ARCHIVE,
      mode: 'full',
      createdAt: T0,
      archiveFormat: 'tar.gz.age',
      encrypted: true,
      encryptedWith: 'age',
      recipient: manifest.recipient,
      plainSha256: plainSha,
      plainSize: plain.length,
      cipherSha256: cipherSha,
      cipherSize: cipher.length,
    }),
    { mode: 0o640 },
  )
  fx.db
    .prepare(
      `INSERT INTO backup_archives (name, mode, created_at, sha256, size, file_count, pulled_at, acked_at, deleted_at, manifest_json)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    )
    .run(ARCHIVE, 'full', T0, cipherSha, cipher.length, 0, JSON.stringify(manifest))
  return { cipher, plainSha }
}

test('加密归档：列表展示 encrypted 计数，verify/浏览/恢复/导入均返回 archive_encrypted', async () => {
  const fx = backupsFixture()
  try {
    seedEncryptedArchive(fx)
    const list = fx.service.list()
    const item = list.items.find((entry) => entry.name === ARCHIVE)
    assert.ok(item)
    assert.equal(item.encrypted, true)
    assert.equal(item.manifest?.schema, 2)
    assert.equal(list.state.encryptedPendingCount, 1)
    assert.equal(list.state.encryptedAckedCount, 0)

    await expectCode(fx.service.verify(fx.actor, ARCHIVE), 'archive_encrypted', 409)
    // 拒绝不得把归档行标记为校验失败（这是预期状态，不是损坏）。
    const row = fx.db.prepare('SELECT verified_at, last_error FROM backup_archives WHERE name = ?').get(ARCHIVE) as {
      verified_at: string | null
      last_error: string | null
    }
    assert.equal(row.verified_at, null)
    assert.equal(row.last_error, null)

    await expectCode(fx.service.listArchiveEntries(ARCHIVE, '/'), 'archive_encrypted', 409)
    await expectCode(
      fx.service.createRestorePlan(fx.actor, { archive: ARCHIVE, paths: ['/'] }),
      'archive_encrypted',
      409,
    )
    await expectCode(
      fx.service.importArchive(fx.actor, { filename: ARCHIVE, stream: Readable.from(Buffer.from('x')) }),
      'archive_encrypted',
      409,
    )
  } finally {
    fx.close()
  }
})

test('加密归档：自动恢复目标选择跳过加密归档（不会误选到不可解密归档）', async () => {
  const fx = backupsFixture()
  try {
    seedEncryptedArchive(fx)
    // 没有任何明文归档可选时，自动选择应返回 archive_not_found，而不是选中加密归档后失败在解密。
    await expectCode(fx.service.createRestorePlan(fx.actor, { paths: ['/'] }), 'archive_not_found', 409)
  } finally {
    fx.close()
  }
})
