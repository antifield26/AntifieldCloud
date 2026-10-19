/** 分享模块测试：token 哈希、密码解锁、过期/吊销/次数、Range/HEAD/ETag、Origin 与限流。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Config } from '../src/config.ts'
import { ShareService } from '../src/shares/service.ts'
import { AppError } from '../src/util/errors.ts'
import { sha256Hex } from '../src/util/ids.ts'
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

async function expectRejects(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, `应抛出 AppError，实际为 ${String(error)}`)
    assert.equal(error.statusCode, status)
    assert.equal(error.code, code)
    return true
  })
}

function tokenFromUrl(url: string): string {
  const match = /\/s\/([A-Za-z0-9_-]+)$/.exec(url)
  assert.ok(match, `URL 形状不正确：${url}`)
  return match[1]!
}

test('创建分享：token 仅存 SHA-256、默认过期时间、列表与吊销', async () => {
  const fx = shareFixture()
  try {
    const file = await uploadFile(fx.files, 'share.txt', 'hello share world')
    const created = await fx.shares.create(ACTOR, file.id, { note: '给朋友' })
    assert.equal(created.share.fileName, 'share.txt')
    assert.equal(created.share.hasPassword, false)
    assert.equal(created.share.maxDownloads, null, '0=不限，对外用 null 表示')
    assert.equal(created.share.downloadCount, 0)
    assert.equal(created.share.status, 'active')
    assert.equal(created.share.expiresAt, '2026-06-08T00:00:00.000Z')
    assert.equal(created.url, `https://app.test/s/${tokenFromUrl(created.url)}`)

    const token = tokenFromUrl(created.url)
    const row = fx.db.prepare('SELECT * FROM shares WHERE id = ?').get(created.share.id) as unknown as Record<string, unknown>
    assert.equal(row.token_hash, sha256Hex(token))
    assert.equal(String(row.token_hash).length, 64)
    assert.ok(!JSON.stringify(row).includes(token), '数据库中不得出现明文 token')
    assert.equal(row.password_hash, null)

    const list = fx.shares.list()
    assert.equal(list.total, 1)
    assert.equal(list.items[0]?.id, created.share.id)

    const metadata = fx.shares.metadata(token, null)
    assert.equal(metadata.state, 'active')
    assert.equal(metadata.requiresPassword, false)
    assert.equal(metadata.share.fileName, 'share.txt')
    assert.equal(metadata.share.size, 17)

    const revoked = fx.shares.revoke(ACTOR, created.share.id)
    assert.ok(revoked.revokedAt)
    assert.equal(revoked.status, 'revoked')
    expectAppError(() => fx.shares.metadata(token, null), 410, 'share_revoked')
    // 重复吊销幂等。
    assert.equal(fx.shares.revoke(ACTOR, created.share.id).status, 'revoked')

    const auditRows = fx.db.prepare("SELECT action, detail_json FROM audit_log WHERE action LIKE 'share_%'").all() as unknown as {
      action: string
      detail_json: string | null
    }[]
    assert.deepEqual(auditRows.map((item) => item.action), ['share_create', 'share_revoke'])
    for (const item of auditRows) {
      assert.ok(!String(item.detail_json).includes(token), '审计详情不得包含 token')
      assert.ok(!String(item.detail_json).toLowerCase().includes('password_hash'))
    }
  } finally {
    fx.close()
  }
})

test('密码分享：解锁、Cookie 会话、下载次数只计一次', async () => {
  const fx = shareFixture()
  try {
    const content = '0123456789'
    const file = await uploadFile(fx.files, 'secret.txt', content)
    const created = await fx.shares.create(ACTOR, file.id, {
      password: 'share-pass-123',
      maxDownloads: 2,
      expiresInHours: 1,
    })
    const token = tokenFromUrl(created.url)
    assert.equal(created.share.hasPassword, true)
    assert.equal(created.share.expiresAt, '2026-06-01T01:00:00.000Z')

    const row = fx.db.prepare('SELECT * FROM shares WHERE id = ?').get(created.share.id) as unknown as Record<string, unknown>
    assert.ok(row.password_hash, '应存密码哈希')
    assert.ok(row.password_salt, '应存盐')
    assert.ok(!JSON.stringify(row).includes('share-pass-123'))

    const locked = fx.shares.metadata(token, null)
    assert.equal(locked.state, 'active')
    assert.equal(locked.requiresPassword, true)
    expectAppError(() => fx.shares.openContent(token, null, 'GET'), 401, 'share_locked')

    await expectRejects(fx.shares.unlock(token, 'wrong-password'), 401, 'invalid_password')
    const unlocked = await fx.shares.unlock(token, 'share-pass-123')
    assert.equal(unlocked.state, 'active')
    assert.equal(unlocked.requiresPassword, false)
    assert.ok(unlocked.sessionToken.length >= 32)
    assert.equal(unlocked.expiresAt, '2026-06-01T00:05:00.000Z')

    // 会话内首次取内容计数一次；Range 后续请求（同会话）不再计数。
    const access = fx.shares.openContent(token, unlocked.sessionToken, 'GET')
    assert.equal(access.mustCount, true)
    fx.shares.markDownloaded(access, IP)
    const again = fx.shares.openContent(token, unlocked.sessionToken, 'GET')
    assert.equal(again.mustCount, false)
    const countRow = fx.db
      .prepare('SELECT download_count FROM shares WHERE id = ?')
      .get(created.share.id) as { download_count: number }
    assert.equal(Number(countRow.download_count), 1)

    // 第二个会话再计一次，达到 maxDownloads=2。
    const secondSession = await fx.shares.unlock(token, 'share-pass-123')
    fx.shares.markDownloaded(fx.shares.openContent(token, secondSession.sessionToken, 'GET'), IP)
    const exhausted = fx.db
      .prepare('SELECT download_count FROM shares WHERE id = ?')
      .get(created.share.id) as { download_count: number }
    assert.equal(Number(exhausted.download_count), 2)
    expectAppError(() => fx.shares.metadata(token, null), 410, 'share_exhausted')

    const downloadAudits = fx.db
      .prepare("SELECT actor, target, detail_json FROM audit_log WHERE action = 'share_download'")
      .all() as unknown as { actor: string; target: string; detail_json: string | null }[]
    assert.equal(downloadAudits.length, 2)
    assert.equal(downloadAudits[0]?.actor, 'anonymous')
    assert.equal(downloadAudits[0]?.target, 'secret.txt')
    assert.ok(!String(downloadAudits[0]?.detail_json).includes(token))
  } finally {
    fx.close()
  }
})

test('过期分享返回 410（含默认 168h）', async () => {
  const fx = shareFixture()
  try {
    const file = await uploadFile(fx.files, 'expire.txt', 'expire me')
    const shortLived = await fx.shares.create(ACTOR, file.id, { expiresInHours: 1 })
    const token = tokenFromUrl(shortLived.url)

    fx.clock.set('2026-06-01T00:30:00.000Z')
    assert.equal(fx.shares.metadata(token, null).state, 'active')

    fx.clock.set('2026-06-01T01:00:01.000Z')
    expectAppError(() => fx.shares.metadata(token, null), 410, 'share_expired')
    expectAppError(() => fx.shares.openContent(token, null, 'GET'), 410, 'share_expired')

    const longLived = await fx.shares.create(ACTOR, file.id, {})
    const longToken = tokenFromUrl(longLived.url)
    fx.clock.set('2026-06-08T01:00:02.000Z')
    expectAppError(() => fx.shares.metadata(longToken, null), 410, 'share_expired')

    // 分享密码哈希与时钟无关，但过期后不再允许 unlock。
    await expectRejects(fx.shares.unlock(longToken, 'whatever'), 410, 'share_expired')
  } finally {
    fx.close()
  }
})

test('无密码分享：懒建会话、HEAD 不计数、清理过期会话', async () => {
  const fx = shareFixture()
  try {
    const file = await uploadFile(fx.files, 'lazy.txt', 'lazy content')
    const created = await fx.shares.create(ACTOR, file.id, {})
    const token = tokenFromUrl(created.url)

    const head = fx.shares.openContent(token, null, 'HEAD')
    assert.equal(head.mustCount, false)
    assert.equal(head.newSessionToken, null, 'HEAD 不创建会话')
    assert.equal(Number(head.file.size), 12)

    const open = fx.shares.openContent(token, null, 'GET')
    assert.equal(open.mustCount, true)
    assert.ok(open.newSessionToken)
    fx.shares.markDownloaded(open, IP)
    assert.equal(fx.shares.openContent(token, open.newSessionToken, 'GET').mustCount, false)

    assert.equal(fx.shares.cleanup(), 0)
    fx.clock.set('2026-06-01T00:10:00.000Z')
    assert.equal(fx.shares.cleanup(), 1, '5 分钟会话过期后应被清理')
    assert.equal(fx.shares.openContent(token, open.newSessionToken, 'GET').mustCount, true)

    // 无效 token / 非法 token 形状都是 404。
    expectAppError(() => fx.shares.metadata('x'.repeat(43), null), 404, 'not_found')
    expectAppError(() => fx.shares.metadata('bad token!', null), 404, 'not_found')
  } finally {
    fx.close()
  }
})

test('文件移入回收站/删除时撤销分享（含目录递归与 revokeByFile）', async () => {
  const fx = shareFixture()
  try {
    const folder = fx.files.createFolder(ACTOR, null, 'docs')
    const file = await uploadFile(fx.files, 'in-folder.txt', 'nested')
    fx.files.move(ACTOR, file.id, folder.id)
    const created = await fx.shares.create(ACTOR, file.id, {})
    const token = tokenFromUrl(created.url)

    assert.equal(fx.shares.revokeForFileTree(folder.id), 1)
    expectAppError(() => fx.shares.metadata(token, null), 410, 'share_revoked')

    const second = await fx.shares.create(ACTOR, file.id, {})
    fx.files.trash(ACTOR, folder.id)
    assert.equal(fx.shares.revokeByFile(file.id), 1)
    expectAppError(() => fx.shares.metadata(tokenFromUrl(second.url), null), 410, 'share_revoked')
    // 已吊销的分享不重复计数。
    assert.equal(fx.shares.revokeByFile(file.id), 0)
  } finally {
    fx.close()
  }
})

test('分享输入校验与开关', async () => {
  const fx = shareFixture()
  try {
    const file = await uploadFile(fx.files, 'validate.txt', 'x')
    await expectRejects(fx.shares.create(ACTOR, file.id, { expiresInHours: 0 }), 400, 'invalid_expiry')
    await expectRejects(fx.shares.create(ACTOR, file.id, { expiresInHours: 9999 }), 400, 'invalid_expiry')
    await expectRejects(fx.shares.create(ACTOR, file.id, { maxDownloads: -1 }), 400, 'invalid_max_downloads')
    await expectRejects(fx.shares.create(ACTOR, file.id, { maxDownloads: 10001 }), 400, 'invalid_max_downloads')
    await expectRejects(
      fx.shares.create(ACTOR, file.id, { password: 'x'.repeat(257) }),
      400,
      'invalid_password',
    )
    // 分享密码不受账号 ≥12 字符策略限制（1–256 字符）。
    const shortPassword = await fx.shares.create(ACTOR, file.id, { password: '123' })
    const shortToken = tokenFromUrl(shortPassword.url)
    assert.equal((await fx.shares.unlock(shortToken, '123')).state, 'active')
    await expectRejects(fx.shares.create(ACTOR, file.id, { note: 'x'.repeat(501) }), 400, 'invalid_note')
    await expectRejects(fx.shares.create(ACTOR, 'not-a-file', {}), 404, 'not_found')
    const folder = fx.files.createFolder(ACTOR, null, 'dir')
    await expectRejects(fx.shares.create(ACTOR, folder.id, {}), 400, 'not_a_file')
    const trashed = await uploadFile(fx.files, 'trashed.txt', 'y')
    fx.files.trash(ACTOR, trashed.id)
    await expectRejects(fx.shares.create(ACTOR, trashed.id, {}), 400, 'file_unavailable')

    const disabled = shareFixture({ sharesEnabled: false })
    try {
      const disabledFile = await uploadFile(disabled.files, 'off.txt', 'z')
      await expectRejects(disabled.shares.create(ACTOR, disabledFile.id, {}), 403, 'shares_disabled')
      expectAppError(() => disabled.shares.metadata('x'.repeat(43), null), 404, 'not_found')
    } finally {
      disabled.close()
    }
  } finally {
    fx.close()
  }
})

test('公开 HTTP 路由：metadata/unlock/content、Cookie 属性、Range/HEAD/ETag 与 Origin', async () => {
  const fx = shareFixture()
  const file = await uploadFile(fx.files, 'report.txt', 'abcdefghij')
  const created = await fx.shares.create(ACTOR, file.id, { password: 'share-pass-123' })
  const token = tokenFromUrl(created.url)
  const app = await createAuthedApp(fx.db, (instance) => {
    registerShareRoutes(instance, fx.config, fx.shares)
  })
  try {
    // 登录端点的认证与 CSRF。
    const anonymousCreate = await app.inject({ method: 'POST', url: `/api/files/${file.id}/shares`, payload: {} })
    assert.equal(anonymousCreate.statusCode, 401)
    const noCsrf = await app.inject({
      method: 'POST',
      url: `/api/files/${file.id}/shares`,
      headers: csrfHeadersOnly(),
      payload: {},
    })
    assert.equal(noCsrf.statusCode, 403)
    const createdNoPassword = await app.inject({
      method: 'POST',
      url: `/api/files/${file.id}/shares`,
      headers: authHeaders(),
      payload: { maxDownloads: 3, note: 'HTTP 分享' },
    })
    assert.equal(createdNoPassword.statusCode, 201)
    const plain = createdNoPassword.json() as { share: { id: string; fileName: string }; url: string }
    assert.equal(plain.share.fileName, 'report.txt')
    assert.match(plain.url, /^https:\/\/app\.test\/s\/[A-Za-z0-9_-]+$/)
    const plainToken = tokenFromUrl(plain.url)

    const list = await app.inject({ method: 'GET', url: '/api/shares', headers: authHeaders() })
    assert.equal(list.statusCode, 200)
    assert.ok(!JSON.stringify(list.json()).includes(plainToken), '列表接口不得返回 token')
    assert.equal(list.json().total, 2)

    // metadata：无密码分享可直接访问。
    const metadata = await app.inject({ method: 'GET', url: `/api/public/shares/${plainToken}` })
    assert.equal(metadata.statusCode, 200)
    assert.equal(metadata.json().state, 'active')
    assert.equal(metadata.json().share.fileName, 'report.txt')
    assert.equal(metadata.json().share.hasPassword, false)

    // HEAD 不计数。
    const head = await app.inject({ method: 'HEAD', url: `/api/public/shares/${plainToken}/content` })
    assert.equal(head.statusCode, 200)
    assert.equal(head.headers['content-length'], '10')
    assert.equal(head.headers['accept-ranges'], 'bytes')

    // 首次 GET：内容、下载计数与 share Cookie。
    const first = await app.inject({ method: 'GET', url: `/api/public/shares/${plainToken}/content` })
    assert.equal(first.statusCode, 200)
    assert.equal(first.body, 'abcdefghij')
    assert.equal(first.headers['content-disposition']?.includes('attachment'), true)
    const setCookie = first.headers['set-cookie']
    const cookies = parseSetCookies(setCookie as string | string[] | undefined)
    assert.ok(cookies.af_share)
    const rawCookie = fullSetCookie(setCookie as string | string[] | undefined)
    assert.match(rawCookie, /HttpOnly/i)
    assert.match(rawCookie, /SameSite=Lax/i)
    assert.ok(rawCookie.includes(`Path=/api/public/shares/${plainToken}`))
    const etag = String(first.headers.etag)
    assert.match(etag, /^"[0-9a-f]+"$/)

    // 同一会话再次 GET 不重复计数。
    const second = await app.inject({
      method: 'GET',
      url: `/api/public/shares/${plainToken}/content`,
      headers: { cookie: `af_share=${cookies.af_share}` },
    })
    assert.equal(second.statusCode, 200)
    // Range 请求返回 206（同会话延续下载，不计数）。
    const range = await app.inject({
      method: 'GET',
      url: `/api/public/shares/${plainToken}/content`,
      headers: { cookie: `af_share=${cookies.af_share}`, range: 'bytes=2-5' },
    })
    assert.equal(range.statusCode, 206)
    assert.equal(range.body, 'cdef')
    assert.equal(range.headers['content-range'], 'bytes 2-5/10')
    // ETag 命中返回 304。
    const notModified = await app.inject({
      method: 'GET',
      url: `/api/public/shares/${plainToken}/content`,
      headers: { cookie: `af_share=${cookies.af_share}`, 'if-none-match': etag },
    })
    assert.equal(notModified.statusCode, 304)

    const countRow = fx.db
      .prepare('SELECT download_count FROM shares WHERE id = ?')
      .get(plain.share.id) as { download_count: number }
    assert.equal(Number(countRow.download_count), 1)

    // 密码分享：unlock 的 Origin 校验、错误密码与 Cookie。
    const lockedMetadata = await app.inject({ method: 'GET', url: `/api/public/shares/${token}` })
    assert.equal(lockedMetadata.statusCode, 200)
    assert.equal(lockedMetadata.json().state, 'active')
    assert.equal(lockedMetadata.json().requiresPassword, true)
    const lockedContent = await app.inject({ method: 'GET', url: `/api/public/shares/${token}/content` })
    assert.equal(lockedContent.statusCode, 401)
    assert.equal(lockedContent.json().error.code, 'share_locked')

    const noOrigin = await app.inject({
      method: 'POST',
      url: `/api/public/shares/${token}/unlock`,
      payload: { password: 'share-pass-123' },
    })
    assert.equal(noOrigin.statusCode, 403)
    assert.equal(noOrigin.json().error.code, 'origin_rejected')
    const evilOrigin = await app.inject({
      method: 'POST',
      url: `/api/public/shares/${token}/unlock`,
      headers: { origin: 'https://evil.test' },
      payload: { password: 'share-pass-123' },
    })
    assert.equal(evilOrigin.statusCode, 403)
    const wrongPassword = await app.inject({
      method: 'POST',
      url: `/api/public/shares/${token}/unlock`,
      headers: { origin: 'https://app.test' },
      payload: { password: 'wrong-password' },
    })
    assert.equal(wrongPassword.statusCode, 401)
    assert.equal(wrongPassword.json().error.code, 'invalid_password')
    const unlocked = await app.inject({
      method: 'POST',
      url: `/api/public/shares/${token}/unlock`,
      headers: { origin: 'https://app.test' },
      payload: { password: 'share-pass-123' },
    })
    assert.equal(unlocked.statusCode, 200)
    assert.equal(unlocked.json().state, 'active')
    const shareCookie = parseSetCookies(unlocked.headers['set-cookie'] as string | string[] | undefined).af_share
    assert.ok(shareCookie)
    const content = await app.inject({
      method: 'GET',
      url: `/api/public/shares/${token}/content`,
      headers: { cookie: `af_share=${shareCookie}` },
    })
    assert.equal(content.statusCode, 200)
    assert.equal(content.body, 'abcdefghij')

    // 吊销后公开访问 410，列表仍可见且状态为 revoked。
    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/shares/${plain.share.id}`,
      headers: authHeaders(),
    })
    assert.equal(revoked.statusCode, 200)
    assert.equal(revoked.json().share.status, 'revoked')
    const gone = await app.inject({ method: 'GET', url: `/api/public/shares/${plainToken}` })
    assert.equal(gone.statusCode, 410)
    assert.equal(gone.json().error.code, 'share_revoked')
  } finally {
    await app.close()
    fx.close()
  }
})

test('错误密码限流：8 次/15 分钟后返回 429', async () => {
  const fx = shareFixture()
  const file = await uploadFile(fx.files, 'limit.txt', 'limit')
  const created = await fx.shares.create(ACTOR, file.id, { password: 'share-pass-123' })
  const token = tokenFromUrl(created.url)
  const app = await createAuthedApp(fx.db, (instance) => {
    registerShareRoutes(instance, fx.config, fx.shares)
  })
  try {
    for (let index = 0; index < 8; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/public/shares/${token}/unlock`,
        headers: { origin: 'https://app.test' },
        payload: { password: 'wrong-password' },
      })
      assert.equal(response.statusCode, 401, `第 ${index + 1} 次错误密码应为 401`)
    }
    const limited = await app.inject({
      method: 'POST',
      url: `/api/public/shares/${token}/unlock`,
      headers: { origin: 'https://app.test' },
      payload: { password: 'wrong-password' },
    })
    assert.equal(limited.statusCode, 429)
    assert.equal(limited.json().error.code, 'rate_limited')
    assert.ok(limited.headers['retry-after'])
  } finally {
    await app.close()
    fx.close()
  }
})
