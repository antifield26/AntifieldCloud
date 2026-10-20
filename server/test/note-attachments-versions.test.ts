/** 笔记附件与版本历史：服务层规则 + HTTP multipart/路由契约。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import type { FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import type { AuthContext } from '../src/types.ts'
import type { Config } from '../src/config.ts'
import { BookmarkService, NoteService, sameTags } from '../src/notes/service.ts'
import { registerNoteRoutes } from '../src/http/routes/notes.ts'
import { registerErrorHandler } from '../src/http/errors.ts'
import { AppError } from '../src/util/errors.ts'
import { sha256Hex } from '../src/util/ids.ts'
import {
  SESSION_COOKIE,
  TEST_CSRF_TOKEN,
  TEST_SESSION_TOKEN,
  authHeaders,
  csrfHeadersOnly,
  phase2Fixture,
  uploadFile,
  type Phase2Fixture,
} from './phase2-fixtures.ts'

const ACTOR = { username: 'admin', ip: '127.0.0.1' }

interface NoteFixture extends Phase2Fixture {
  notes: NoteService
}

function noteFixture(overrides: Partial<Config> = {}): NoteFixture {
  const fx = phase2Fixture(overrides)
  const notes = new NoteService(fx.db, {
    files: fx.files,
    config: fx.config,
    log: { warn: () => {} },
  })
  return { ...fx, notes }
}

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

/** 写临时文件并返回服务层需要的上传描述。 */
function stagedUpload(files: NoteFixture['files'], name: string, content: string) {
  const buffer = Buffer.from(content, 'utf8')
  const tempPath = files.storage.tempPath()
  writeFileSync(tempPath, buffer)
  return { rawName: name, tempPath, size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') }
}

/** 注意：服务层成功登记后临时文件已被移走；失败时由调用方清理。 */
async function addAttachments(fx: NoteFixture, noteId: string, files: { name: string; content: string }[]) {
  const uploads = files.map((file) => stagedUpload(fx.files, file.name, file.content))
  try {
    return await fx.notes.addAttachments(ACTOR, noteId, uploads)
  } catch (error) {
    for (const upload of uploads) fx.files.storage.removeTemp(upload.tempPath)
    throw error
  }
}

test('附件：上传、GET 返回、列表隔离、名称按 origin 去重、URL 契约', async () => {
  const fx = noteFixture()
  try {
    const note = fx.notes.create(ACTOR, { title: '带附件', bodyMd: '# hi' })
    const sameNameUserFile = await uploadFile(fx.files, 'pic.png', 'user-png')
    const result = await addAttachments(fx, note.id, [
      { name: 'pic.png', content: 'png' },
      { name: 'doc.pdf', content: 'pdf' },
    ])
    assert.equal(result.items.length, 2)
    assert.equal(result.items[0]?.name, 'pic.png', '笔记附件与用户同名不冲突')
    assert.equal(result.items[0]?.url, `/api/files/${result.items[0]?.fileId}/content?inline=1`)
    assert.equal(result.items[1]?.mime, 'application/pdf')

    const detail = fx.notes.get(note.id)
    assert.equal(detail.attachments.length, 2)
    assert.equal(detail.attachments[0]?.fileId, result.items[0]?.fileId)
    const listed = fx.notes.list()
    assert.equal(listed.items[0]?.attachments.length, 2, '列表也带附件元数据')
    assert.deepEqual(fx.notes.listAttachments(note.id).items.map((item) => item.name), ['pic.png', 'doc.pdf'])

    // 附件不出现在普通文件列表/搜索，但内容元数据按 id 可读取（鉴权内容路由依赖）。
    const fileIds = result.items.map((item) => item.fileId)
    const rootList = fx.files.list({ parentId: null, page: 1, pageSize: 200, sort: 'name', dir: 'asc' })
    assert.equal(rootList.total, 1)
    assert.equal(rootList.items[0]?.id, sameNameUserFile.id)
    assert.equal(fx.files.contentInfo(fileIds[0]!).mime, 'image/png')
    assert.equal(fx.files.contentInfo(fileIds[1]!).mime, 'application/pdf')
    assert.equal(fx.files.usage().usedBytes, 'user-png'.length + 3 + 3)
  } finally {
    fx.close()
  }
})

test('附件：单文件大小、每笔记数量与配额限制', async () => {
  const small = noteFixture({ noteAttachmentMaxBytes: 8, noteMaxAttachments: 2, quotaBytes: 1024 * 1024 })
  try {
    const note = small.notes.create(ACTOR, { title: '限制' })
    await assert.rejects(
      addAttachments(small, note.id, [{ name: 'big.txt', content: '123456789' }]),
      (error: unknown) => error instanceof AppError && error.statusCode === 413,
    )
    const first = await addAttachments(small, note.id, [{ name: 'a.txt', content: '123' }])
    assert.equal(first.items.length, 1)
    await addAttachments(small, note.id, [{ name: 'b.txt', content: '456' }])
    await assert.rejects(
      addAttachments(small, note.id, [{ name: 'c.txt', content: '789' }]),
      (error: unknown) => error instanceof AppError && error.code === 'too_many_attachments',
    )
    // 单次请求最多 5 个文件。
    await assert.rejects(
      small.notes.addAttachments(
        ACTOR,
        note.id,
        Array.from({ length: 6 }, (_, index) => ({
          rawName: `x-${index}.txt`,
          tempPath: small.files.storage.tempPath(),
          size: 1,
          sha256: '0'.repeat(64),
        })),
      ),
      (error: unknown) => error instanceof AppError && error.code === 'invalid_request',
    )
  } finally {
    small.close()
  }

  const quota = noteFixture({ quotaBytes: 8, maxUploadBytes: 8 })
  try {
    const note = quota.notes.create(ACTOR, { title: '配额' })
    await uploadFile(quota.files, 'base.txt', '12345')
    await assert.rejects(
      addAttachments(quota, note.id, [{ name: 'a.txt', content: '1234' }]),
      (error: unknown) => error instanceof AppError && error.code === 'quota_exceeded',
    )
    // 失败后不残留附件行与临时文件。
    assert.equal(quota.notes.get(note.id).attachments.length, 0)
  } finally {
    quota.close()
  }
})

test('删除附件硬删除并释放配额；删除笔记级联删除附件与物理文件', async () => {
  const fx = noteFixture()
  try {
    const note = fx.notes.create(ACTOR, { title: '删除' })
    const added = await addAttachments(fx, note.id, [
      { name: 'a.txt', content: 'aaa' },
      { name: 'b.txt', content: 'bb' },
    ])
    const filePath = fx.files.storage.finalPath(added.items[0]!.fileId)
    assert.equal(existsSync(filePath), true)
    const removed = fx.notes.removeAttachment(ACTOR, note.id, added.items[0]!.fileId)
    assert.deepEqual(removed, { ok: true })
    assert.equal(existsSync(filePath), false)
    assert.equal(fx.files.usage().usedBytes, 2)
    expectAppError(
      () => fx.notes.removeAttachment(ACTOR, note.id, added.items[0]!.fileId),
      404,
      'not_found',
    )
    expectAppError(() => fx.notes.removeAttachment(ACTOR, 'no-note', added.items[1]!.fileId), 404, 'not_found')

    // 再挂一个附件后删除笔记：级联删除笔记、附件行与物理文件。
    const second = await addAttachments(fx, note.id, [{ name: 'c.txt', content: 'cc' }])
    const secondPath = fx.files.storage.finalPath(second.items[0]!.fileId)
    fx.notes.remove(ACTOR, note.id)
    assert.equal(existsSync(secondPath), false)
    assert.equal(
      (fx.db.prepare('SELECT COUNT(*) AS c FROM note_attachments').get() as { c: number }).c,
      0,
    )
    assert.equal(fx.files.usage().usedBytes, 0)
  } finally {
    fx.close()
  }
})

test('版本：变更快照、仅置顶不快照、保留上限、恢复与跨笔记 404', async () => {
  const fx = noteFixture({ noteVersionsKeep: 3 })
  try {
    const note = fx.notes.create(ACTOR, { title: 'v1', bodyMd: 'body1', tags: ['a'] })
    assert.equal(fx.notes.listVersions(note.id).total, 0, '创建时不写版本')

    fx.notes.update(ACTOR, note.id, { pinned: true })
    assert.equal(fx.notes.listVersions(note.id).total, 0, '仅置顶变化不产生版本')

    fx.notes.update(ACTOR, note.id, { title: 'v2', bodyMd: 'body2', tags: ['b'] })
    const versions = fx.notes.listVersions(note.id)
    assert.equal(versions.total, 1)
    const versionId = versions.items[0]!.id
    const version = fx.notes.getVersion(note.id, versionId).version
    assert.equal(version.title, 'v1')
    assert.equal(version.bodyMd, 'body1')
    assert.deepEqual(version.tags, ['a'])
    assert.equal(version.noteId, note.id)

    // 保留上限：连续更新后仅保留最近 noteVersionsKeep 条。
    for (let index = 0; index < 5; index += 1) {
      fx.notes.update(ACTOR, note.id, { bodyMd: `body-${index}` })
    }
    const kept = fx.notes.listVersions(note.id)
    assert.equal(kept.total, 3)
    assert.equal(kept.items.length, 3)
    // 分页。
    assert.equal(fx.notes.listVersions(note.id, { limit: 1, offset: 1 }).items.length, 1)

    // 恢复：写回标题/正文/标签，且恢复前当前内容进入版本表。
    const target = fx.notes.listVersions(note.id).items.at(-1)!
    const targetVersion = fx.notes.getVersion(note.id, target.id).version
    const restored = fx.notes.restoreVersion(ACTOR, note.id, target.id)
    assert.equal(restored.title, targetVersion.title)
    assert.equal(restored.bodyMd, targetVersion.bodyMd)
    assert.deepEqual(restored.tags, targetVersion.tags)
    assert.equal(restored.pinned, true, '恢复版本不改变置顶')
    assert.ok(fx.notes.listVersions(note.id).total >= 1)

    // 跨笔记 versionId 404。
    const other = fx.notes.create(ACTOR, { title: 'other' })
    expectAppError(() => fx.notes.getVersion(other.id, versionId), 404, 'not_found')
    expectAppError(() => fx.notes.restoreVersion(ACTOR, other.id, versionId), 404, 'not_found')
    expectAppError(() => fx.notes.getVersion('no-note', versionId), 404, 'not_found')

    assert.equal(sameTags(['A', 'b'], ['b', 'a']), true)
    assert.equal(sameTags(['a'], ['a', 'b']), false)
  } finally {
    fx.close()
  }
})

test('维护对账：清理无 note_attachments 关联的笔记附件孤儿文件', async () => {
  const fx = noteFixture()
  try {
    const note = fx.notes.create(ACTOR, { title: '对账' })
    const kept = await addAttachments(fx, note.id, [{ name: 'kept.txt', content: 'keep' }])
    const orphanNote = fx.notes.create(ACTOR, { title: '孤儿' })
    const orphan = await addAttachments(fx, orphanNote.id, [{ name: 'orphan.txt', content: 'orphan-data' }])
    const orphanPath = fx.files.storage.finalPath(orphan.items[0]!.fileId)

    // 模拟崩溃：只删笔记行（级联删 note_attachments），未执行附件文件清理。
    fx.db.prepare('DELETE FROM notes WHERE id = ?').run(orphanNote.id)
    assert.equal(existsSync(orphanPath), true, '此时物理文件仍存在')
    assert.ok(fx.files.usage().usedBytes > 4)

    assert.equal(fx.notes.cleanupOrphanAttachments(), 1)
    assert.equal(existsSync(orphanPath), false)
    assert.equal(
      (fx.db.prepare('SELECT COUNT(*) AS c FROM files WHERE id = ?').get(orphan.items[0]!.fileId) as { c: number }).c,
      0,
    )
    // 正常附件与普通文件不受影响；再次对账为 0。
    assert.equal(fx.notes.get(note.id).attachments.length, 1)
    assert.equal(fx.notes.get(note.id).attachments[0]?.fileId, kept.items[0]?.fileId)
    assert.equal(fx.notes.cleanupOrphanAttachments(), 0)
  } finally {
    fx.close()
  }
})

// ---------- HTTP 路由 ----------

async function createNotesApp(fx: NoteFixture): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, exposeHeadRoutes: true })
  await app.register(cookie)
  await app.register(multipart, {
    limits: { fileSize: fx.config.maxUploadBytes, files: 20, fields: 16, parts: 36 },
  })
  app.addHook('onRequest', async (request) => {
    if (request.cookies?.[SESSION_COOKIE] === TEST_SESSION_TOKEN) {
      const context: AuthContext = {
        user: { id: 'phase2-user', username: 'admin' },
        session: {
          id: 'phase2-session',
          user_id: 'phase2-user',
          token_hash: sha256Hex(TEST_SESSION_TOKEN),
          csrf_hash: sha256Hex(TEST_CSRF_TOKEN),
          created_at: '2026-01-01T00:00:00.000Z',
          expires_at: '2999-01-01T00:00:00.000Z',
          last_seen_at: '2026-01-01T00:00:00.000Z',
          ip: '127.0.0.1',
          user_agent: 'test',
        },
      }
      request.auth = context
    }
  })
  registerNoteRoutes(app, fx.config, fx.notes, new BookmarkService(fx.db), fx.files)
  registerErrorHandler(app)
  return app
}

function multipartFiles(files: { name: string; content: string }[]): { body: Buffer; boundary: string } {
  const boundary = `----afc-notes-${Math.random().toString(16).slice(2)}`
  const chunks: Buffer[] = []
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n',
        'utf8',
      ),
      Buffer.from(file.content, 'utf8'),
      Buffer.from('\r\n', 'utf8'),
    )
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  return { body: Buffer.concat(chunks), boundary }
}

test('笔记附件/版本 HTTP：认证、CSRF、multipart、契约形状', async () => {
  const fx = noteFixture()
  const app = await createNotesApp(fx)
  try {
    const note = fx.notes.create(ACTOR, { title: 'HTTP 笔记' })
    const anonymous = await app.inject({ method: 'POST', url: `/api/notes/${note.id}/attachments` })
    assert.equal(anonymous.statusCode, 401)

    const { body, boundary } = multipartFiles([
      { name: 'a.png', content: 'png-bytes' },
      { name: 'a.png', content: 'png-2' },
    ])
    const headers = { ...authHeaders(), 'content-type': `multipart/form-data; boundary=${boundary}` }
    const noCsrf = await app.inject({
      method: 'POST',
      url: `/api/notes/${note.id}/attachments`,
      headers: { ...csrfHeadersOnly(), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    })
    assert.equal(noCsrf.statusCode, 403)

    const uploaded = await app.inject({ method: 'POST', url: `/api/notes/${note.id}/attachments`, headers, payload: body })
    assert.equal(uploaded.statusCode, 200, uploaded.body)
    const items = uploaded.json().items as { fileId: string; name: string; size: number; mime: string; url: string }[]
    assert.equal(items.length, 2)
    assert.equal(items[0]?.name, 'a.png')
    assert.equal(items[1]?.name, 'a (2).png', '同名附件自动去重')
    assert.equal(items[0]?.url, `/api/files/${items[0]?.fileId}/content?inline=1`)

    const detail = await app.inject({ method: 'GET', url: `/api/notes/${note.id}`, headers: authHeaders() })
    assert.equal(detail.statusCode, 200)
    assert.equal(detail.json().attachments.length, 2)
    const attachmentList = await app.inject({ method: 'GET', url: `/api/notes/${note.id}/attachments`, headers: authHeaders() })
    assert.deepEqual(attachmentList.json().items.map((item: { name: string }) => item.name), ['a.png', 'a (2).png'])

    // 版本路由：更新后列表/详情/恢复。
    await app.inject({ method: 'PATCH', url: `/api/notes/${note.id}`, headers: authHeaders(), payload: { bodyMd: 'changed' } })
    const versions = await app.inject({ method: 'GET', url: `/api/notes/${note.id}/versions`, headers: authHeaders() })
    assert.equal(versions.statusCode, 200)
    const versionBody = versions.json() as { items: { id: string }[]; total: number }
    assert.equal(versionBody.total, 1)
    const versionId = versionBody.items[0]!.id
    const versionDetail = await app.inject({
      method: 'GET',
      url: `/api/notes/${note.id}/versions/${versionId}`,
      headers: authHeaders(),
    })
    assert.equal(versionDetail.statusCode, 200)
    assert.equal(versionDetail.json().version.bodyMd, '')
    const restored = await app.inject({
      method: 'POST',
      url: `/api/notes/${note.id}/versions/${versionId}/restore`,
      headers: authHeaders(),
    })
    assert.equal(restored.statusCode, 200)
    assert.equal(restored.json().bodyMd, '')

    // 删除附件。
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/notes/${note.id}/attachments/${items[0]!.fileId}`,
      headers: authHeaders(),
    })
    assert.equal(removed.statusCode, 200)
    assert.deepEqual(removed.json(), { ok: true })
    const afterDelete = await app.inject({ method: 'GET', url: `/api/notes/${note.id}/attachments`, headers: authHeaders() })
    assert.equal(afterDelete.json().items.length, 1)

    // 跨笔记版本 404。
    const other = fx.notes.create(ACTOR, { title: '其它' })
    const cross = await app.inject({
      method: 'GET',
      url: `/api/notes/${other.id}/versions/${versionId}`,
      headers: authHeaders(),
    })
    assert.equal(cross.statusCode, 404)
  } finally {
    await app.close()
    fx.close()
  }
})
