import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import type { FileService } from '../src/files/service.ts'
import { FileService as Service } from '../src/files/service.ts'
import type { DatabaseSync } from 'node:sqlite'
import { previewKindFor, sanitizeName } from '../src/files/mime.ts'
import { cleanupDir, tempDataDir, testConfig, testDb } from './helpers.ts'

interface Fixture {
  dir: string
  db: DatabaseSync
  files: FileService
  actor: { username: string; ip: string | null }
  close: () => void
}

async function fixture(overrides = {}): Promise<Fixture> {
  const dir = tempDataDir()
  const config = testConfig(dir, overrides)
  const db = testDb(dir)
  const files = new Service(db, config)
  return {
    dir,
    db,
    files,
    actor: { username: 'tester', ip: '127.0.0.1' },
    close: () => {
      db.close()
      cleanupDir(dir)
    },
  }
}

async function upload(
  files: FileService,
  actor: { username: string; ip: string | null },
  parentId: string | null,
  name: string,
  content: Buffer,
) {
  const tempPath = files.storage.tempPath()
  writeFileSync(tempPath, content)
  return files.registerUpload(actor, {
    parentId,
    rawName: name,
    tempPath,
    size: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  })
}

test('目录、上传、列表、面包屑与搜索', async () => {
  const fx = await fixture()
  const { dir, files, actor } = fx
  try {
    const folder = files.createFolder(actor, null, '文档')
    const a = await upload(files, actor, folder.id, '报告.txt', Buffer.from('hello'))
    const b = await upload(files, actor, folder.id, 'notes.md', Buffer.from('# notes'))
    const list = files.list({ parentId: folder.id, page: 1, pageSize: 200, sort: 'name', dir: 'asc' })
    assert.equal(list.total, 2)
    assert.equal(list.breadcrumb.at(-1)?.name, '文档')
    assert.deepEqual(list.items.map((item) => item.name).sort(), ['notes.md', '报告.txt'])
    assert.equal(list.items.find((item) => item.id === a.id)?.size, 5)
    assert.equal(files.search('报告').items.length, 1)
    assert.equal(files.search('notes').items[0]?.id, b.id)
    assert.equal(files.get(a.id).path.at(-1)?.name, '文档')
    assert.equal(files.usage().usedBytes, 12)
    void dir
  } finally {
    fx.close()
  }
})

test('同名自动后缀、清洗非法字符', async () => {
  const fx = await fixture()
  try {
    const first = await upload(fx.files, fx.actor, null, 'a.txt', Buffer.from('1'))
    const second = await upload(fx.files, fx.actor, null, 'a.txt', Buffer.from('2'))
    const third = await upload(fx.files, fx.actor, null, 'A.TXT', Buffer.from('3'))
    assert.equal(first.name, 'a.txt')
    assert.equal(second.name, 'a (2).txt')
    assert.equal(third.name, 'A (3).TXT')
    assert.equal(sanitizeName(' ..\\evil:/name?.txt '), '_evil__name_.txt')
    assert.equal(sanitizeName('...'), '未命名')
  } finally {
    fx.close()
  }
})

test('重命名、移动与循环检测', async () => {
  const fx = await fixture()
  try {
    const a = fx.files.createFolder(fx.actor, null, 'A')
    const b = fx.files.createFolder(fx.actor, a.id, 'B')
    assert.throws(() => fx.files.move(fx.actor, a.id, b.id), /不能移动到自己的子目录/)
    const file = await upload(fx.files, fx.actor, null, 'x.txt', Buffer.from('x'))
    const moved = fx.files.move(fx.actor, file.id, b.id)
    assert.equal(moved.parentId, b.id)
    const renamed = fx.files.rename(fx.actor, file.id, 'y.txt')
    assert.equal(renamed.name, 'y.txt')
  } finally {
    fx.close()
  }
})

test('回收站递归删除、恢复与彻底删除', async () => {
  const fx = await fixture()
  try {
    const folder = fx.files.createFolder(fx.actor, null, 'docs')
    const file = await upload(fx.files, fx.actor, folder.id, 'a.txt', Buffer.from('hello'))
    const trash = fx.files.trash(fx.actor, folder.id)
    assert.equal(trash.count, 2)
    assert.equal(fx.files.usage().usedBytes, 5)
    assert.equal(fx.files.usage().trashBytes, 5)
    const trashList = fx.files.listTrash({ page: 1, pageSize: 50 })
    assert.equal(trashList.total, 1)
    assert.equal(trashList.items[0]?.kind, 'dir')
    assert.equal(trashList.items[0]?.originalPath, '全部文件')
    fx.files.restore(fx.actor, folder.id)
    const restored = fx.files.list({ parentId: folder.id, page: 1, pageSize: 50, sort: 'name', dir: 'asc' })
    assert.equal(restored.total, 1)
    assert.equal(restored.items[0]?.id, file.id)
    const trashAgain = fx.files.trash(fx.actor, folder.id)
    assert.equal(trashAgain.count, 2)
    const purged = fx.files.purge(fx.actor, folder.id)
    assert.equal(purged.count, 2)
    assert.equal(fx.files.usage().usedBytes, 0)
    assert.equal(existsSync(fx.files.storage.finalPath(file.id)), false)
  } finally {
    fx.close()
  }
})

test('配额包含回收站，超限拒绝上传', async () => {
  const fx = await fixture({ quotaBytes: 100, maxUploadBytes: 100 })
  try {
    const temp = fx.files.storage.tempPath()
    writeFileSync(temp, Buffer.alloc(60, 1))
    const first = await fx.files.registerUpload(fx.actor, {
      parentId: null,
      rawName: 'first.bin',
      tempPath: temp,
      size: 60,
      sha256: createHash('sha256').update(Buffer.alloc(60, 1)).digest('hex'),
    })
    const temp2 = fx.files.storage.tempPath()
    writeFileSync(temp2, Buffer.alloc(60, 1))
    await assert.rejects(
      () =>
        fx.files.registerUpload(fx.actor, {
          parentId: null,
          rawName: 'second.bin',
          tempPath: temp2,
          size: 60,
          sha256: createHash('sha256').update(Buffer.alloc(60, 1)).digest('hex'),
        }),
      /存储空间不足/,
    )
    fx.files.storage.removeTemp(temp2)
    fx.files.trash(fx.actor, first.id)
    const temp3 = fx.files.storage.tempPath()
    writeFileSync(temp3, Buffer.alloc(50, 1))
    await assert.rejects(
      () =>
        fx.files.registerUpload(fx.actor, {
          parentId: null,
          rawName: 'third.bin',
          tempPath: temp3,
          size: 50,
          sha256: createHash('sha256').update(Buffer.alloc(50, 1)).digest('hex'),
        }),
      /存储空间不足/,
    )
    fx.files.storage.removeTemp(temp3)
  } finally {
    fx.close()
  }
})

test('并发同名上传：事务内唯一名去重，得到 a/b 两个文件', async () => {
  const fx = await fixture()
  try {
    const [first, second] = await Promise.all([
      upload(fx.files, fx.actor, null, 'race.txt', Buffer.from('1')),
      upload(fx.files, fx.actor, null, 'race.txt', Buffer.from('2')),
    ])
    const names = [first.name, second.name].sort()
    assert.deepEqual(names, ['race (2).txt', 'race.txt'])
    const list = fx.files.list({ parentId: null, page: 1, pageSize: 50, sort: 'name', dir: 'asc' })
    assert.equal(list.total, 2)
  } finally {
    fx.close()
  }
})

test('落盘后父目录被移入回收站：提交失败并回滚物理文件', async () => {
  const fx = await fixture()
  try {
    const folder = fx.files.createFolder(fx.actor, null, '临时目录')
    fx.files.trash(fx.actor, folder.id)
    const tempPath = fx.files.storage.tempPath()
    writeFileSync(tempPath, Buffer.from('orphan'))
    await assert.rejects(
      () =>
        fx.files.registerUpload(fx.actor, {
          parentId: folder.id,
          rawName: 'late.txt',
          tempPath,
          size: 6,
          sha256: createHash('sha256').update('orphan').digest('hex'),
        }),
      /目标文件夹不存在/,
    )
    fx.files.storage.removeTemp(tempPath)
    assert.equal(fx.files.usage().usedBytes, 0, '失败上传不占配额')
    const rows = fx.db.prepare("SELECT COUNT(*) AS c FROM files WHERE name = 'late.txt'").get() as { c: number }
    assert.equal(rows.c, 0, '失败上传不留下 DB 行')
  } finally {
    fx.close()
  }
})

test('回收站原路径批量解析：嵌套目录显示完整路径，空回收站不报错', async () => {
  const fx = await fixture()
  try {
    const a = fx.files.createFolder(fx.actor, null, 'A')
    const b = fx.files.createFolder(fx.actor, a.id, 'B')
    const nested = await upload(fx.files, fx.actor, b.id, 'inner.txt', Buffer.from('x'))
    const rootFile = await upload(fx.files, fx.actor, null, 'root.txt', Buffer.from('y'))
    fx.files.trash(fx.actor, nested.id)
    fx.files.trash(fx.actor, rootFile.id)
    const trash = fx.files.listTrash({ page: 1, pageSize: 50 })
    assert.equal(trash.total, 2)
    const paths = new Map(trash.items.map((item) => [item.name, item.originalPath]))
    assert.equal(paths.get('inner.txt'), '全部文件 / A / B')
    assert.equal(paths.get('root.txt'), '全部文件')
    assert.equal(trash.trashBytes, 2)
  } finally {
    fx.close()
  }
})

test('空回收站容错：嵌套/并发已删除的条目视为已完成，不中断其余清理', async () => {
  const fx = await fixture()
  try {
    const folder = fx.files.createFolder(fx.actor, null, 'outer')
    const child = fx.files.createFolder(fx.actor, folder.id, 'inner')
    await upload(fx.files, fx.actor, child.id, 'x.txt', Buffer.from('x'))
    fx.files.trash(fx.actor, folder.id)
    // 模拟异常数据：子目录也被标记为顶层回收站条目，清空时父条目已级联删除它。
    fx.db.prepare("UPDATE files SET deleted_parent_id = '' WHERE id = ?").run(child.id)
    const result = fx.files.emptyTrash(fx.actor)
    assert.ok(result.count >= 1)
    const remaining = fx.db.prepare('SELECT COUNT(*) AS c FROM files WHERE deleted_at IS NOT NULL').get() as { c: number }
    assert.equal(remaining.c, 0)
  } finally {
    fx.close()
  }
})

test('文本预览与截断、二进制拒绝', async () => {
  const fx = await fixture({ textPreviewBytes: 16 })
  try {
    const text = Buffer.from('abcdefghijklmnopqrstuvwxyz')
    const file = await upload(fx.files, fx.actor, null, 'a.txt', text)
    const preview = fx.files.readText(file.id, 16)
    assert.equal(preview.truncated, true)
    assert.equal(preview.content.length, 16)
    const binary = await upload(fx.files, fx.actor, null, 'a.bin', Buffer.from([0, 1, 2, 3]))
    assert.throws(() => fx.files.readText(binary.id, 16), /不支持文本预览/)
  } finally {
    fx.close()
  }
})

test('MIME/预览分类：SVG/HTML 强制下载', () => {
  assert.equal(previewKindFor('a.png', 'image/png'), 'image')
  assert.equal(previewKindFor('a.pdf', 'application/pdf'), 'pdf')
  assert.equal(previewKindFor('a.md', 'text/markdown'), 'markdown')
  assert.equal(previewKindFor('a.ts', 'text/plain'), 'text')
  assert.equal(previewKindFor('a.svg', 'image/svg+xml'), 'none')
  assert.equal(previewKindFor('a.html', 'text/html'), 'none')
})
