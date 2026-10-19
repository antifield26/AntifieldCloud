import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import type { FileService } from '../src/files/service.ts'
import { FileService as Service } from '../src/files/service.ts'
import { previewKindFor, sanitizeName } from '../src/files/mime.ts'
import { cleanupDir, tempDataDir, testConfig, testDb } from './helpers.ts'

interface Fixture {
  dir: string
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
