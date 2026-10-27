/** 文件服务守卫测试：目录深度上限、唯一名重试、物理孤儿回收、硬删除前分享吊销兜底。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FileService, MAX_TREE_DEPTH, type FileServiceOptions } from '../src/files/service.ts'
import { cleanupDir, tempDataDir, testConfig, testDb } from './helpers.ts'

const ACTOR = { username: 'admin', ip: '127.0.0.1' }

interface Fixture {
  dir: string
  db: ReturnType<typeof testDb>
  files: FileService
  close: () => void
}

function fixture(options: FileServiceOptions = {}): Fixture {
  const dir = tempDataDir()
  const config = testConfig(dir)
  const db = testDb(dir)
  const files = new FileService(db, config, undefined, options)
  return {
    dir,
    db,
    files,
    close: () => {
      db.close()
      cleanupDir(dir)
    },
  }
}

async function upload(
  fx: Fixture,
  name: string,
  content: string,
  parentId: string | null = null,
  origin: 'user' | 'note' = 'user',
) {
  const tempPath = fx.files.storage.tempPath()
  const buffer = Buffer.from(content, 'utf8')
  writeFileSync(tempPath, buffer)
  return fx.files.registerUpload(ACTOR, {
    parentId,
    rawName: name,
    tempPath,
    size: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    origin,
  })
}

function isCode(code: string) {
  return (error: unknown): boolean => (error as { code?: string }).code === code
}

test('目录深度上限：createFolder/registerUpload/move 拒绝超过 MAX_TREE_DEPTH（DATA-08）', async () => {
  const fx = fixture()
  try {
    assert.ok(MAX_TREE_DEPTH >= 16 && MAX_TREE_DEPTH <= 256)
    let parent: string | null = null
    for (let depth = 1; depth <= MAX_TREE_DEPTH; depth += 1) {
      parent = fx.files.createFolder(ACTOR, parent, `d${depth}`).id
    }
    assert.ok(parent)
    assert.throws(() => fx.files.createFolder(ACTOR, parent, 'too-deep'), isCode('path_too_deep'))

    const tempPath = fx.files.storage.tempPath()
    writeFileSync(tempPath, 'x')
    await assert.rejects(
      fx.files.registerUpload(ACTOR, {
        parentId: parent,
        rawName: 'deep.txt',
        tempPath,
        size: 1,
        sha256: 'a'.repeat(64),
      }),
      isCode('path_too_deep'),
    )
    fx.files.storage.removeTemp(tempPath)

    // 移动整棵子树到最大深度目录：目标深度 + 子树高度超过上限。
    const source = fx.files.createFolder(ACTOR, null, 'src')
    fx.files.createFolder(ACTOR, source.id, 'child')
    assert.throws(() => fx.files.move(ACTOR, source.id, parent), isCode('path_too_deep'))
  } finally {
    fx.close()
  }
})

test('唯一名冲突重试：createFolder/rename 首次 UNIQUE 后重算并成功（DATA-09）', async () => {
  const fx = fixture()
  try {
    fx.files.createFolder(ACTOR, null, 'existing')
    const internal = fx.files as unknown as { uniqueName: (...args: unknown[]) => string }
    const original = internal.uniqueName.bind(fx.files)
    let calls = 0
    internal.uniqueName = (...args: unknown[]) => {
      calls += 1
      return calls === 1 ? 'existing' : original(...args)
    }
    const created = fx.files.createFolder(ACTOR, null, 'fresh')
    assert.equal(created.name, 'fresh')
    assert.ok(calls >= 2, '首次 UNIQUE 冲突后应重算名称重试')
    assert.equal(
      (fx.db.prepare("SELECT COUNT(*) AS c FROM files WHERE name = 'fresh'").get() as { c: number }).c,
      1,
    )

    const file = await upload(fx, 'a.txt', 'a')
    calls = 0
    internal.uniqueName = (...args: unknown[]) => {
      calls += 1
      return calls === 1 ? 'existing' : original(...args)
    }
    const renamed = fx.files.rename(ACTOR, file.id, 'b.txt')
    assert.equal(renamed.name, 'b.txt')
    assert.ok(calls >= 2, 'rename 首次 UNIQUE 冲突后应重算名称重试')
  } finally {
    fx.close()
  }
})

test('物理孤儿文件回收：只删超期且 DB 无行的 id 形状文件（DATA-10）', async () => {
  const fx = fixture()
  try {
    const active = await upload(fx, 'active.txt', 'ok')
    const shardDir = join(fx.files.storage.filesDir, 'or')
    mkdirSync(shardDir, { recursive: true })
    const oldOrphan = join(shardDir, 'orphan-old-0001')
    const freshOrphan = join(shardDir, 'orphan-new-0001')
    const foreign = join(shardDir, 'not-an-id.txt')
    const subdir = join(shardDir, 'subdir-00000001')
    for (const target of [oldOrphan, freshOrphan, foreign]) writeFileSync(target, 'x')
    mkdirSync(subdir, { recursive: true })
    const old = (Date.now() - 48 * 3_600_000) / 1000
    utimesSync(oldOrphan, old, old)
    utimesSync(foreign, old, old)

    assert.equal(fx.files.cleanupOrphanFiles(), 1)
    assert.equal(existsSync(oldOrphan), false, '超期且 DB 无行的孤儿应删除')
    assert.equal(existsSync(freshOrphan), true, '未超期的孤儿保留（可能是在途上传）')
    assert.equal(existsSync(foreign), true, '非 id 形状文件不删除')
    assert.equal(existsSync(subdir), true, '目录不删除')
    assert.equal(existsSync(fx.files.storage.finalPath(active.id)), true, 'DB 有行的文件保留')
  } finally {
    fx.close()
  }
})

test('硬删除前调用分享吊销兜底：purge 与 deleteFiles 都命中（DATA-12）', async () => {
  const calls: string[][] = []
  const fx = fixture({ revokeSharesForFiles: (fileIds) => calls.push(fileIds) })
  try {
    const trashed = await upload(fx, 'trashed.txt', 'x')
    fx.files.trash(ACTOR, trashed.id)
    const purged = fx.files.purge(ACTOR, trashed.id)
    assert.equal(purged.count, 1)
    assert.equal(calls.length, 1)
    assert.ok(calls[0]?.includes(trashed.id))

    const attachment = await upload(fx, 'attachment.txt', 'y', null, 'note')
    const deleted = fx.files.deleteFiles(ACTOR, [attachment.id], { auditAction: 'note_attachment_delete' })
    assert.equal(deleted.count, 1)
    assert.equal(calls.length, 2)
    assert.ok(calls[1]?.includes(attachment.id))
  } finally {
    fx.close()
  }
})

test('分享吊销兜底失败时中止硬删除：文件与行保留（DATA-12 失败路径）', async () => {
  const fx = fixture({
    revokeSharesForFiles: () => {
      throw new Error('revoke-failed')
    },
  })
  try {
    const file = await upload(fx, 'abort.txt', 'retain')
    fx.files.trash(ACTOR, file.id)
    assert.throws(() => fx.files.purge(ACTOR, file.id), /revoke-failed/)
    const row = fx.db.prepare('SELECT COUNT(*) AS c FROM files WHERE id = ?').get(file.id) as { c: number }
    assert.equal(row.c, 1, '吊销失败时不得删除 DB 行')
    assert.equal(existsSync(fx.files.storage.finalPath(file.id)), true, '吊销失败时不得删除物理文件')

    const attachment = await upload(fx, 'abort-attach.txt', 'z', null, 'note')
    assert.throws(() => fx.files.deleteFiles(ACTOR, [attachment.id]), /revoke-failed/)
    assert.equal(
      (fx.db.prepare('SELECT COUNT(*) AS c FROM files WHERE id = ?').get(attachment.id) as { c: number }).c,
      1,
    )
  } finally {
    fx.close()
  }
})
