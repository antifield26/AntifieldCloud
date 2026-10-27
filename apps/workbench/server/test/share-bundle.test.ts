/** 多文件分享：createBundle、share_items、公开 items、逐项内容、旧端点兼容与吊销。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import type { Config } from '../src/config.ts'
import { ShareService } from '../src/shares/service.ts'
import { AppError } from '../src/util/errors.ts'
import { newId, sha256Hex } from '../src/util/ids.ts'
import { registerShareRoutes } from '../src/http/routes/shares.ts'
import {
  authHeaders,
  createAuthedApp,
  csrfHeadersOnly,
  fullSetCookie,
  parseSetCookies,
  phase2Fixture,
  uploadFile,
  type Phase2Fixture,
} from './phase2-fixtures.ts'

const ACTOR = { username: 'admin', ip: '127.0.0.1' }
const IP = '203.0.113.9'
const T0 = '2026-06-01T00:00:00.000Z'

interface ShareFixture extends Phase2Fixture {
  shares: ShareService
  clock: { now: () => Date; set: (iso: string) => void }
}

function shareFixture(overrides: Partial<Config> = {}): ShareFixture {
  const fx = phase2Fixture(overrides)
  let current = new Date(T0)
  const now = () => current
  const shares = new ShareService(fx.db, fx.config, { storage: fx.files.storage, now })
  return {
    ...fx,
    shares,
    clock: {
      now,
      set: (iso: string) => {
        current = new Date(iso)
      },
    },
  }
}

function tokenFromUrl(url: string): string {
  const match = /\/s\/([A-Za-z0-9_-]+)$/.exec(url)
  assert.ok(match, `URL 形状不正确：${url}`)
  return match[1]!
}

async function expectRejects(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, `应抛出 AppError，实际为 ${String(error)}`)
    assert.equal(error.statusCode, status)
    assert.equal(error.code, code)
    return true
  })
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

async function noteAttachment(files: Phase2Fixture['files'], name: string, content: string): Promise<string> {
  const tempPath = files.storage.tempPath()
  const buffer = Buffer.from(content, 'utf8')
  writeFileSync(tempPath, buffer)
  const item = await files.registerUpload(ACTOR, {
    parentId: null,
    rawName: name,
    tempPath,
    size: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    origin: 'note',
  })
  return item.id
}

test('createBundle：固定顺序、去重、itemCount 与 share_items 落库', async () => {
  const fx = shareFixture()
  try {
    const a = await uploadFile(fx.files, 'a.txt', 'aaa')
    const b = await uploadFile(fx.files, 'b.txt', 'bb')
    const created = await fx.shares.createBundle(ACTOR, [a.id, b.id, a.id], { note: '打包' })
    assert.equal(created.share.itemCount, 2)
    assert.equal(created.share.totalSizeBytes, 5, '全部文件大小之和 3+2')
    assert.equal(created.share.fileId, a.id, 'fileId 为首个文件（兼容字段）')
    assert.equal(created.share.fileName, 'a.txt')
    assert.equal(fx.shares.list().items[0]?.itemCount, 2)
    assert.equal(fx.shares.list().items[0]?.totalSizeBytes, 5)

    const items = fx.db
      .prepare('SELECT file_id FROM share_items WHERE share_id = ? ORDER BY rowid ASC')
      .all(created.share.id) as unknown as { file_id: string }[]
    assert.deepEqual(items.map((item) => item.file_id), [a.id, b.id])

    // 单文件兼容入口等价于 fileIds:[id]。
    const single = await fx.shares.create(ACTOR, b.id, {})
    assert.equal(single.share.itemCount, 1)
    assert.equal(single.share.totalSizeBytes, 2, '单文件 totalSizeBytes 等于文件大小')
    assert.equal(
      (fx.db.prepare('SELECT COUNT(*) AS c FROM share_items WHERE share_id = ?').get(single.share.id) as { c: number }).c,
      1,
    )

    // 审计只保留元数据，不含 token（首条 share_create 属于本次多文件分享）。
    const audit = fx.db
      .prepare("SELECT detail_json FROM audit_log WHERE action = 'share_create' ORDER BY id ASC LIMIT 1")
      .get() as { detail_json: string }
    assert.ok(!audit.detail_json.includes(tokenFromUrl(created.url)))
    assert.match(audit.detail_json, /"itemCount":2/)
  } finally {
    fx.close()
  }
})

test('createBundle 校验：空/非数组/超上限/目录/回收站/笔记附件/不存在', async () => {
  const fx = shareFixture({ shareMaxItems: 2 })
  try {
    const a = await uploadFile(fx.files, 'a.txt', 'a')
    const b = await uploadFile(fx.files, 'b.txt', 'b')
    const c = await uploadFile(fx.files, 'c.txt', 'c')
    await expectRejects(fx.shares.createBundle(ACTOR, [], {}), 400, 'invalid_file_ids')
    await expectRejects(fx.shares.createBundle(ACTOR, 'not-array', {}), 400, 'invalid_file_ids')
    await expectRejects(fx.shares.createBundle(ACTOR, [123], {}), 400, 'invalid_file_ids')
    await expectRejects(fx.shares.createBundle(ACTOR, [a.id, b.id, c.id], {}), 400, 'too_many_items')

    const folder = fx.files.createFolder(ACTOR, null, 'dir')
    await expectRejects(fx.shares.createBundle(ACTOR, [folder.id], {}), 400, 'not_a_file')
    const trashed = await uploadFile(fx.files, 'trashed.txt', 'x')
    fx.files.trash(ACTOR, trashed.id)
    await expectRejects(fx.shares.createBundle(ACTOR, [trashed.id], {}), 400, 'file_unavailable')
    const attachment = await noteAttachment(fx.files, 'note.txt', 'note')
    await expectRejects(fx.shares.createBundle(ACTOR, [attachment], {}), 400, 'not_a_file')
    await expectRejects(fx.shares.createBundle(ACTOR, ['missing-id'], {}), 404, 'not_found')

    // 目录树内的普通文件仍可分享。
    const nested = await uploadFile(fx.files, 'nested.txt', 'n')
    fx.files.move(ACTOR, nested.id, folder.id)
    const ok = await fx.shares.createBundle(ACTOR, [nested.id], {})
    assert.equal(ok.share.itemCount, 1)
  } finally {
    fx.close()
  }
})

test('公开 metadata：无密码返回 items，密码未解锁省略 items，解锁后返回', async () => {
  const fx = shareFixture()
  try {
    const a = await uploadFile(fx.files, '公开.txt', 'aaa')
    const b = await uploadFile(fx.files, 'b.txt', 'bb')
    const open = await fx.shares.createBundle(ACTOR, [a.id, b.id], { note: '仅自己可见的备注' })
    const openToken = tokenFromUrl(open.url)
    const metadata = fx.shares.metadata(openToken, null)
    assert.equal(metadata.requiresPassword, false)
    assert.equal(metadata.share.itemCount, 2)
    assert.equal(metadata.share.totalSizeBytes, 5)
    assert.equal(metadata.share.fileName, '公开.txt')
    assert.equal(metadata.share.size, 3)
    assert.deepEqual(metadata.share.items, [
      { id: a.id, name: '公开.txt', size: 3, mime: 'text/plain' },
      { id: b.id, name: 'b.txt', size: 2, mime: 'text/plain' },
    ])
    assert.equal('note' in metadata.share, false, '公开信息不含备注')

    const locked = await fx.shares.createBundle(ACTOR, [a.id, b.id], { password: 'share-pass-123' })
    const lockedToken = tokenFromUrl(locked.url)
    const lockedMeta = fx.shares.metadata(lockedToken, null)
    assert.equal(lockedMeta.requiresPassword, true)
    assert.equal('items' in lockedMeta.share, false, '未解锁不泄露文件清单')
    assert.equal(lockedMeta.share.itemCount, 2)
    assert.equal(lockedMeta.share.totalSizeBytes, 5, '未解锁也可返回总大小')

    const unlocked = await fx.shares.unlock(lockedToken, 'share-pass-123')
    assert.equal(unlocked.share.items?.length, 2)
    assert.equal(unlocked.share.totalSizeBytes, 5)
    const sessionMeta = fx.shares.metadata(lockedToken, unlocked.sessionToken)
    assert.equal(sessionMeta.requiresPassword, false)
    assert.equal(sessionMeta.share.items?.length, 2)

    // 历史分享行没有 share_items 时回退到 shares.file_id。
    const legacyToken = 'legacy-token-0123456789abcdef'
    fx.db
      .prepare(
        `INSERT INTO shares (id, file_id, token_hash, password_hash, password_salt, expires_at,
           max_downloads, download_count, created_at, revoked_at, created_by, note)
         VALUES (?, ?, ?, NULL, NULL, '2026-12-01T00:00:00.000Z', 0, 0, ?, NULL, 'admin', NULL)`,
      )
      .run(newId(), a.id, sha256Hex(legacyToken), T0)
    const legacy = fx.shares.metadata(legacyToken, null)
    assert.equal(legacy.share.itemCount, 1)
    assert.deepEqual(legacy.share.items?.map((item) => item.id), [a.id])
  } finally {
    fx.close()
  }
})

test('旧 /content 仅单文件；逐项 content 校验归属、删除与下载计数', async () => {
  const fx = shareFixture()
  try {
    const a = await uploadFile(fx.files, 'a.txt', '0123456789')
    const b = await uploadFile(fx.files, 'b.txt', 'abcdefghij')
    const created = await fx.shares.createBundle(ACTOR, [a.id, b.id], {})
    const token = tokenFromUrl(created.url)

    expectAppError(() => fx.shares.openContent(token, null, 'GET'), 409, 'share_bundle')

    const first = fx.shares.openItemContent(token, null, a.id, 'GET')
    assert.equal(first.file.id, a.id)
    assert.equal(first.mustCount, true)
    fx.shares.markDownloaded(first, IP)
    // 同会话取第二个文件不重复计数。
    const second = fx.shares.openItemContent(token, first.newSessionToken, b.id, 'GET')
    assert.equal(second.mustCount, false)
    assert.equal(
      (fx.db.prepare('SELECT download_count FROM shares WHERE id = ?').get(created.share.id) as { download_count: number })
        .download_count,
      1,
      '多文件按会话只计一次下载',
    )
    const downloadAudit = fx.db
      .prepare("SELECT target, detail_json FROM audit_log WHERE action = 'share_download'")
      .get() as { target: string; detail_json: string }
    assert.equal(downloadAudit.target, 'a.txt', '审计 target 用首个文件名')
    assert.match(downloadAudit.detail_json, /"itemCount":2/)

    // 越权 itemId 404；其它分享的文件也 404。
    expectAppError(() => fx.shares.openItemContent(token, null, newId(), 'GET'), 404, 'share_item_not_found')
    const other = await uploadFile(fx.files, 'other.txt', 'x')
    expectAppError(() => fx.shares.openItemContent(token, null, other.id, 'GET'), 404, 'share_item_not_found')

    // 密码分享未解锁 401，解锁后可按项下载。
    const locked = await fx.shares.createBundle(ACTOR, [a.id], { password: 'share-pass-123' })
    const lockedToken = tokenFromUrl(locked.url)
    expectAppError(() => fx.shares.openItemContent(lockedToken, null, a.id, 'GET'), 401, 'share_locked')
    const unlocked = await fx.shares.unlock(lockedToken, 'share-pass-123')
    assert.equal(fx.shares.openItemContent(lockedToken, unlocked.sessionToken, a.id, 'HEAD').mustCount, false)

    // 文件被删除/移入回收站后公开访问 410 share_gone。
    fx.files.trash(ACTOR, b.id)
    expectAppError(() => fx.shares.openItemContent(token, first.newSessionToken, b.id, 'GET'), 410, 'share_gone')
    expectAppError(() => fx.shares.metadata(token, first.newSessionToken), 410, 'share_gone')
  } finally {
    fx.close()
  }
})

test('多文件分享：过期/次数用尽/吊销与递归吊销（含 share_items 匹配）', async () => {
  const fx = shareFixture()
  try {
    const a = await uploadFile(fx.files, 'a.txt', 'a')
    const b = await uploadFile(fx.files, 'b.txt', 'b')
    const expired = await fx.shares.createBundle(ACTOR, [a.id, b.id], { expiresInHours: 1 })
    fx.clock.set('2026-06-01T02:00:00.000Z')
    expectAppError(() => fx.shares.metadata(tokenFromUrl(expired.url), null), 410, 'share_expired')
    fx.clock.set(T0)

    const limited = await fx.shares.createBundle(ACTOR, [a.id, b.id], { maxDownloads: 1 })
    const limitedToken = tokenFromUrl(limited.url)
    const access = fx.shares.openItemContent(limitedToken, null, a.id, 'GET')
    fx.shares.markDownloaded(access, IP)
    // 新会话（无 Cookie）尝试第二个文件：次数已用尽。
    expectAppError(() => fx.shares.openItemContent(limitedToken, null, b.id, 'GET'), 410, 'share_exhausted')

    const revoked = await fx.shares.createBundle(ACTOR, [a.id, b.id], {})
    const revokedToken = tokenFromUrl(revoked.url)
    const session = fx.shares.openItemContent(revokedToken, null, a.id, 'GET')
    // 三个未吊销分享都包含 b：只吊销 b 所在文件树也应命中全部多文件分享。
    assert.equal(fx.shares.revokeForFileTree(b.id), 3)
    expectAppError(() => fx.shares.metadata(revokedToken, session.newSessionToken), 410, 'share_revoked')
    const sessions = fx.db
      .prepare('SELECT COUNT(*) AS c FROM share_sessions WHERE share_id = ?')
      .get(revoked.share.id) as { c: number }
    assert.equal(sessions.c, 0, '吊销时清理 share_sessions')
  } finally {
    fx.close()
  }
})

test('删除单个文件：列表 status 仍为 active、被删条目 410 share_gone；吊销后其它条目 410 share_revoked', async () => {
  const fx = shareFixture()
  try {
    const a = await uploadFile(fx.files, 'a.txt', 'aaa')
    const b = await uploadFile(fx.files, 'b.txt', 'bbb')
    const created = await fx.shares.createBundle(ACTOR, [a.id, b.id], {})
    const token = tokenFromUrl(created.url)

    // 绕过吊销钩子直接软删除（模拟钩子失败），列表状态沿用 shares 行 → 仍 active。
    fx.db
      .prepare('UPDATE files SET deleted_at = ?, deleted_parent_id = ? WHERE id = ?')
      .run(T0, '', a.id)
    assert.equal(fx.shares.list().items[0]?.status, 'active', 'status 不受条目删除影响')
    expectAppError(() => fx.shares.openItemContent(token, null, a.id, 'GET'), 410, 'share_gone')
    expectAppError(() => fx.shares.metadata(token, null), 410, 'share_gone')

    // 删除路由会先吊销整条分享：其它条目也立即 410 share_revoked。
    const sessionsBefore = fx.db
      .prepare('SELECT COUNT(*) AS c FROM share_sessions WHERE share_id = ?')
      .get(created.share.id) as { c: number }
    assert.equal(sessionsBefore.c, 0)
    assert.equal(fx.shares.revokeForFileTree(a.id), 1)
    expectAppError(() => fx.shares.openItemContent(token, null, b.id, 'GET'), 410, 'share_revoked')

    // 全部条目被删后公开 metadata 统一 410 share_gone。
    const second = await fx.shares.createBundle(ACTOR, [b.id], {})
    const secondToken = tokenFromUrl(second.url)
    fx.db.prepare('UPDATE files SET deleted_at = ?, deleted_parent_id = ? WHERE id = ?').run(T0, '', b.id)
    expectAppError(() => fx.shares.metadata(secondToken, null), 410, 'share_gone')
  } finally {
    fx.close()
  }
})

test('多文件分享 HTTP：创建、公开 metadata/items、逐项下载、旧 content 409', async () => {
  const fx = shareFixture()
  const app = await createAuthedApp(fx.db, (instance) => {
    registerShareRoutes(instance, fx.config, fx.shares)
  })
  try {
    const a = await uploadFile(fx.files, 'a.txt', '0123456789')
    const b = await uploadFile(fx.files, 'b.txt', 'abcdefghij')

    const anonymous = await app.inject({ method: 'POST', url: '/api/shares', payload: { fileIds: [a.id, b.id] } })
    assert.equal(anonymous.statusCode, 401)
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/shares',
      headers: csrfHeadersOnly(),
      payload: { fileIds: [a.id, b.id] },
    })
    assert.equal(noCsrf.statusCode, 403)
    const invalid = await app.inject({ method: 'POST', url: '/api/shares', headers: authHeaders(), payload: { fileIds: [] } })
    assert.equal(invalid.statusCode, 400)
    assert.equal(invalid.json().error.code, 'invalid_file_ids')

    const created = await app.inject({
      method: 'POST',
      url: '/api/shares',
      headers: authHeaders(),
      payload: { fileIds: [a.id, b.id], note: 'HTTP' },
    })
    assert.equal(created.statusCode, 201, created.body)
    const createdBody = created.json() as {
      share: { id: string; itemCount: number; totalSizeBytes: number; fileName: string }
      url: string
    }
    assert.equal(createdBody.share.itemCount, 2)
    assert.equal(createdBody.share.totalSizeBytes, 20, '10+10')
    assert.equal(createdBody.share.fileName, 'a.txt')
    const token = tokenFromUrl(createdBody.url)

    const metadata = await app.inject({ method: 'GET', url: `/api/public/shares/${token}` })
    assert.equal(metadata.statusCode, 200)
    assert.equal(metadata.json().share.itemCount, 2)
    assert.equal(metadata.json().share.items.length, 2)
    assert.match(String(metadata.headers['x-robots-tag']), /noindex/)

    // 旧 /content 端点返回 409，客户端改用逐项下载。
    const oldContent = await app.inject({ method: 'GET', url: `/api/public/shares/${token}/content` })
    assert.equal(oldContent.statusCode, 409)
    assert.equal(oldContent.json().error.code, 'share_bundle')

    // HEAD 不计数也不建会话；首个 GET（带 Range）建会话、计一次下载并下发 af_share。
    const head = await app.inject({ method: 'HEAD', url: `/api/public/shares/${token}/items/${a.id}/content` })
    assert.equal(head.statusCode, 200)
    assert.equal(head.headers['content-length'], '10')
    assert.equal(head.headers['set-cookie'], undefined)
    const range = await app.inject({
      method: 'GET',
      url: `/api/public/shares/${token}/items/${a.id}/content`,
      headers: { range: 'bytes=2-5' },
    })
    assert.equal(range.statusCode, 206)
    assert.equal(range.body, '2345')
    const setCookies = parseSetCookies(range.headers['set-cookie'] as string | string[] | undefined)
    assert.ok(setCookies.af_share)
    assert.match(fullSetCookie(range.headers['set-cookie'] as string | string[] | undefined), /HttpOnly/i)
    const cookie = `af_share=${setCookies.af_share}`
    const headB = await app.inject({
      method: 'HEAD',
      url: `/api/public/shares/${token}/items/${b.id}/content`,
      headers: { cookie },
    })
    assert.equal(headB.statusCode, 200)
    const notModified = await app.inject({
      method: 'GET',
      url: `/api/public/shares/${token}/items/${b.id}/content`,
      headers: { cookie, 'if-none-match': String(headB.headers.etag) },
    })
    assert.equal(notModified.statusCode, 304)
    const wrongItem = await app.inject({
      method: 'GET',
      url: `/api/public/shares/${token}/items/${newId()}/content`,
      headers: { cookie },
    })
    assert.equal(wrongItem.statusCode, 404)
    assert.equal(wrongItem.json().error.code, 'share_item_not_found')

    // 注释：HEAD 不计数，首个 GET Range 也已在同一会话内计一次。
    const count = fx.db
      .prepare('SELECT download_count FROM shares WHERE id = ?')
      .get(createdBody.share.id) as { download_count: number }
    assert.equal(Number(count.download_count), 1)

    // 列表含 itemCount 且不含 token。
    const list = await app.inject({ method: 'GET', url: '/api/shares', headers: authHeaders() })
    assert.equal(list.statusCode, 200)
    assert.ok(!JSON.stringify(list.json()).includes(token))
    assert.equal(list.json().items[0].itemCount, 2)
  } finally {
    await app.close()
    fx.close()
  }
})

test('单文件分享旧端点保持兼容（/content 可下载、itemCount=1）', async () => {
  const fx = shareFixture()
  const app = await createAuthedApp(fx.db, (instance) => {
    registerShareRoutes(instance, fx.config, fx.shares)
  })
  try {
    const file = await uploadFile(fx.files, 'single.txt', 'hello')
    const created = await app.inject({
      method: 'POST',
      url: `/api/files/${file.id}/shares`,
      headers: authHeaders(),
      payload: {},
    })
    assert.equal(created.statusCode, 201)
    const body = created.json() as { share: { itemCount: number }; url: string }
    assert.equal(body.share.itemCount, 1)
    const token = tokenFromUrl(body.url)
    const content = await app.inject({ method: 'GET', url: `/api/public/shares/${token}/content` })
    assert.equal(content.statusCode, 200)
    assert.equal(content.body, 'hello')
  } finally {
    await app.close()
    fx.close()
  }
})

test('分享下载计数后置：内容流失败（物理缺失）不计次', async () => {
  const fx = shareFixture()
  const app = await createAuthedApp(fx.db, (instance) => {
    registerShareRoutes(instance, fx.config, fx.shares)
  })
  try {
    const file = await uploadFile(fx.files, 'broken.txt', 'payload')
    const created = await fx.shares.create(ACTOR, file.id, {})
    const token = tokenFromUrl(created.url)
    // 物理文件在访问前被删除：流读取失败，不应计下载次数。
    fx.files.storage.remove(file.id)
    let status = 0
    try {
      const response = await app.inject({ method: 'GET', url: `/api/public/shares/${token}/content` })
      status = response.statusCode
    } catch {
      status = 500
    }
    assert.notEqual(status, 200)
    const row = fx.db.prepare('SELECT download_count FROM shares WHERE id = ?').get(created.share.id) as {
      download_count: number
    }
    assert.equal(Number(row.download_count), 0)
  } finally {
    await app.close()
    fx.close()
  }
})

test('删除文件时吊销包含它的多文件分享（files 路由钩子语义）', async () => {
  const fx = shareFixture()
  try {
    const a = await uploadFile(fx.files, 'a.txt', 'a')
    const b = await uploadFile(fx.files, 'b.txt', 'b')
    const created = await fx.shares.createBundle(ACTOR, [a.id, b.id], {})
    // 路由在软删除前调用 revokeForFileTree（与 registerFileRoutes 的 onTrashed 一致）。
    assert.equal(fx.shares.revokeForFileTree(a.id), 1)
    fx.files.trash(ACTOR, a.id)
    expectAppError(() => fx.shares.metadata(tokenFromUrl(created.url), null), 410, 'share_revoked')
  } finally {
    fx.close()
  }
})

test('revokeSharesForFiles：硬删除前按文件 id 批量吊销（DATA-12）', async () => {
  const fx = shareFixture()
  try {
    const a = await uploadFile(fx.files, 'hard-a.txt', 'aaa')
    const b = await uploadFile(fx.files, 'hard-b.txt', 'bbb')
    const bundle = await fx.shares.createBundle(ACTOR, [a.id, b.id], {})
    const single = await fx.shares.create(ACTOR, b.id, {})
    // 先建立分享会话（懒创建），验证吊销时一并删除。
    const unlocked = await fx.shares.metadata(tokenFromUrl(bundle.url), null)
    assert.equal(unlocked.state, 'active')
    const access = fx.shares.openItemContent(tokenFromUrl(bundle.url), null, a.id, 'GET')
    assert.ok(access.newSessionToken)
    assert.equal(
      (fx.db.prepare('SELECT COUNT(*) AS c FROM share_sessions WHERE share_id = ?').get(bundle.share.id) as { c: number })
        .c,
      1,
    )
    const revoked = fx.shares.revokeSharesForFiles([a.id, b.id])
    assert.equal(revoked, 2, 'bundle 与单文件分享都应命中')
    for (const id of [bundle.share.id, single.share.id]) {
      const row = fx.db.prepare('SELECT revoked_at FROM shares WHERE id = ?').get(id) as { revoked_at: string | null }
      assert.ok(row.revoked_at)
    }
    assert.equal(
      (fx.db.prepare('SELECT COUNT(*) AS c FROM share_sessions WHERE share_id = ?').get(bundle.share.id) as { c: number })
        .c,
      0,
      '吊销时删除分享会话',
    )
    // 已吊销的分享不重复计数。
    assert.equal(fx.shares.revokeSharesForFiles([a.id]), 0)
    expectAppError(() => fx.shares.metadata(tokenFromUrl(bundle.url), null), 410, 'share_revoked')
    // 未命中任何分享时返回 0。
    const unrelated = await uploadFile(fx.files, 'unrelated.txt', 'x')
    assert.equal(fx.shares.revokeSharesForFiles([unrelated.id]), 0)
  } finally {
    fx.close()
  }
})
