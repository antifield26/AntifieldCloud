/** files.origin 行为测试：可见性隔离、按 origin 去重、配额语义与硬删除释放。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { AppError } from '../src/util/errors.ts'
import type { Actor, FileService } from '../src/files/service.ts'
import { ShareService } from '../src/shares/service.ts'
import { phase2Fixture, uploadFile } from './phase2-fixtures.ts'

const ACTOR: Actor = { username: 'admin', ip: '127.0.0.1' }

function expectAppError(fn: () => unknown, status: number, code: string): void {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof AppError, `应抛出 AppError，实际为 ${String(error)}`)
    assert.equal(error.statusCode, status)
    assert.equal(error.code, code)
    return
  }
  assert.fail('预期抛出 AppError，但没有抛错')
}

async function registerAs(
  files: FileService,
  rawName: string,
  content: Buffer,
  origin: 'user' | 'note' | 'system',
): Promise<Awaited<ReturnType<FileService['registerUpload']>>> {
  const tempPath = files.storage.tempPath()
  writeFileSync(tempPath, content)
  return files.registerUpload(ACTOR, {
    parentId: null,
    rawName,
    tempPath,
    size: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    origin,
  })
}

test('usage：fileCount 只算普通文件，usedBytes/trashBytes 含附件与回收站', async () => {
  const fx = phase2Fixture()
  try {
    await uploadFile(fx.files, 'a.txt', 'aaa')
    await uploadFile(fx.files, 'b.txt', 'bb')
    const c = await uploadFile(fx.files, 'c.txt', 'c')
    await registerAs(fx.files, 'n1.txt', Buffer.from('1111'), 'note')
    await registerAs(fx.files, 'n2.txt', Buffer.from('22'), 'note')
    assert.equal(fx.files.usage().fileCount, 3, '两个附件不计入 fileCount')
    assert.equal(fx.files.usage().usedBytes, 3 + 2 + 1 + 4 + 2)

    // 回收站中的普通文件不计入 fileCount，但仍占 usedBytes/trashBytes。
    fx.files.trash(ACTOR, c.id)
    const usage = fx.files.usage()
    assert.equal(usage.fileCount, 2)
    assert.equal(usage.usedBytes, 12)
    assert.equal(usage.trashBytes, 1)
  } finally {
    fx.close()
  }
})

test('普通列表/搜索/回收站看不到笔记附件，内容信息仍可读取', async () => {
  const fx = phase2Fixture()
  try {
    const userFile = await uploadFile(fx.files, 'visible.txt', 'user')
    const attachment = await registerAs(fx.files, 'visible.txt', Buffer.from('note'), 'note')
    const systemFile = await registerAs(fx.files, 'system.bin', Buffer.from('sys'), 'system')

    const list = fx.files.list({ parentId: null, page: 1, pageSize: 200, sort: 'name', dir: 'asc' })
    assert.equal(list.total, 1)
    assert.deepEqual(list.items.map((item) => item.id), [userFile.id])
    assert.equal(fx.files.search('visible').items.length, 1)
    assert.equal(fx.files.search('visible').items[0]?.id, userFile.id)
    assert.equal(fx.files.search('system').total, 0)
    assert.equal(fx.files.listTrash({ page: 1, pageSize: 50 }).total, 0)

    // 附件（origin=note）不可通过文件元数据接口访问，但内容预览按 id 可用。
    expectAppError(() => fx.files.get(attachment.id), 404, 'not_found')
    assert.equal(fx.files.contentInfo(attachment.id).name, 'visible.txt')
    expectAppError(() => fx.files.get(systemFile.id), 404, 'not_found')
  } finally {
    fx.close()
  }
})

test('唯一名称按 origin 维度去重', async () => {
  const fx = phase2Fixture()
  try {
    const user1 = await registerAs(fx.files, 'same.txt', Buffer.from('1'), 'user')
    const user2 = await registerAs(fx.files, 'same.txt', Buffer.from('2'), 'user')
    const note1 = await registerAs(fx.files, 'same.txt', Buffer.from('3'), 'note')
    const note2 = await registerAs(fx.files, 'same.txt', Buffer.from('4'), 'note')
    assert.equal(user1.name, 'same.txt')
    assert.equal(user2.name, 'same (2).txt')
    assert.equal(note1.name, 'same.txt', '不同 origin 可同名')
    assert.equal(note2.name, 'same (2).txt')
  } finally {
    fx.close()
  }
})

test('配额统计包含附件；硬删除附件释放配额与物理文件', async () => {
  const fx = phase2Fixture({ quotaBytes: 12, maxUploadBytes: 12 })
  try {
    const userFile = await uploadFile(fx.files, 'u.txt', '1234')
    const attachment = await registerAs(fx.files, 'n.txt', Buffer.from('5678'), 'note')
    assert.equal(fx.files.usage().usedBytes, 8, '附件计入总配额')
    assert.equal(fx.files.usage().fileCount, 1, 'fileCount 只统计用户云盘可见文件')
    assert.equal(fx.files.usage().trashBytes, 0)

    // 配额不足时上传附件被拒绝。
    const temp = fx.files.storage.tempPath()
    writeFileSync(temp, Buffer.from('123456789'))
    await assert.rejects(
      fx.files.registerUpload(ACTOR, {
        parentId: null,
        rawName: 'big.bin',
        tempPath: temp,
        size: 9,
        sha256: createHash('sha256').update('x').digest('hex'),
        origin: 'note',
      }),
      /存储空间不足/,
    )
    fx.files.storage.removeTemp(temp)

    // 硬删除：DB 行、物理文件与配额一起释放，并写审计。
    const path = fx.files.storage.finalPath(attachment.id)
    assert.equal(existsSync(path), true)
    const removed = fx.files.deleteFiles(ACTOR, [attachment.id], { auditAction: 'note_attachment_delete' })
    assert.deepEqual(removed, { count: 1, freedBytes: 4 })
    assert.equal(existsSync(path), false)
    assert.equal(fx.files.usage().usedBytes, 4)
    const auditRow = fx.db
      .prepare("SELECT action, target FROM audit_log WHERE action = 'note_attachment_delete'")
      .get() as { action: string; target: string } | undefined
    assert.equal(auditRow?.target, 'n.txt')

    // 再删一次返回 0（幂等，不抛错）。
    assert.deepEqual(fx.files.deleteFiles(ACTOR, [attachment.id]), { count: 0, freedBytes: 0 })
    assert.ok(userFile.id)
  } finally {
    fx.close()
  }
})

test('笔记附件不可重命名/移动/移入回收站，也不能被分享', async () => {
  const fx = phase2Fixture()
  try {
    const attachment = await registerAs(fx.files, 'attach.txt', Buffer.from('x'), 'note')
    expectAppError(() => fx.files.rename(ACTOR, attachment.id, 'new.txt'), 404, 'not_found')
    expectAppError(() => fx.files.move(ACTOR, attachment.id, null), 404, 'not_found')
    expectAppError(() => fx.files.trash(ACTOR, attachment.id), 404, 'not_found')
    expectAppError(() => fx.files.purge(ACTOR, attachment.id), 404, 'not_found')
    const shares = new ShareService(fx.db, fx.config, { storage: fx.files.storage })
    await assert.rejects(
      shares.create(ACTOR, attachment.id, {}),
      (error: unknown) => error instanceof AppError && error.code === 'not_a_file',
    )
  } finally {
    fx.close()
  }
})

test('非用户 origin 的父目录不受支持：附件必须位于根、系统行不可见', async () => {
  const fx = phase2Fixture()
  try {
    const folder = fx.files.createFolder(ACTOR, null, 'docs')
    const tempPath = fx.files.storage.tempPath()
    writeFileSync(tempPath, Buffer.from('x'))
    await assert.rejects(
      fx.files.registerUpload(ACTOR, {
        parentId: folder.id,
        rawName: 'nested.txt',
        tempPath,
        size: 1,
        sha256: createHash('sha256').update('x').digest('hex'),
        origin: 'note',
      }),
      /非用户文件必须位于根目录/,
    )
    fx.files.storage.removeTemp(tempPath)
    // 目录列表/面包屑不受影响。
    assert.equal(fx.files.list({ parentId: folder.id, page: 1, pageSize: 50, sort: 'name', dir: 'asc' }).total, 0)
  } finally {
    fx.close()
  }
})
