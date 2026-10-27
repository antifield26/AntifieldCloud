/**
 * v0.3 分享安全修复测试：软删除文件 410、吊销顺序、密码最小长度、审计节流、
 * 公开信息不含备注、列表分页与过期/吊销行 GC。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Config } from '../src/config.ts'
import { ShareService, SHARE_PASSWORD_MIN_LENGTH, SHARE_ROW_RETENTION_DAYS, DOWNLOAD_AUDIT_WINDOW_MS } from '../src/shares/service.ts'
import { hashSharePassword } from '../src/shares/password.ts'
import { AppError } from '../src/util/errors.ts'
import { newId, randomToken, sha256Hex } from '../src/util/ids.ts'
import { registerFileRoutes, trashFileWithShareRevoke } from '../src/http/routes/files.ts'
import { registerShareRoutes } from '../src/http/routes/shares.ts'
import {
  authHeaders,
  createAuthedApp,
  phase2Fixture,
  uploadFile,
  type Phase2Fixture,
} from './phase2-fixtures.ts'

const ACTOR = { username: 'admin', ip: '127.0.0.1' }
const IP = '203.0.113.9'
const T0 = '2026-06-01T00:00:00.000Z'

interface ShareFixture extends Phase2Fixture {
  shares: ShareService
  clock: { now: () => Date; advanceMs: (ms: number) => void }
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
      advanceMs: (ms: number) => {
        current = new Date(current.getTime() + ms)
      },
    },
  }
}

function tokenFromUrl(url: string): string {
  const match = /\/s\/([A-Za-z0-9_-]+)$/.exec(url)
  assert.ok(match, `URL 形状不正确：${url}`)
  return match[1]!
}

function expectAppError(fn: () => unknown, status: number, code: string): void {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof AppError, `应为 AppError，实际 ${String(error)}`)
    assert.equal(error.statusCode, status)
    assert.equal(error.code, code)
    return
  }
  assert.fail('预期抛出 AppError')
}

test('软删除文件：metadata/openContent 均返回 410，不依赖吊销钩子', async () => {
  const fx = shareFixture()
  try {
    const file = await uploadFile(fx.files, 'secret.txt', 'SECRET-CONTENT')
    const created = await fx.shares.create(ACTOR, file.id, {})
    const token = tokenFromUrl(created.url)
    assert.equal(fx.shares.metadata(token, null).state, 'active')

    // 绕过路由钩子直接软删除，模拟吊销钩子失败/漏接。
    fx.files.trash(ACTOR, file.id)
    expectAppError(() => fx.shares.metadata(token, null), 410, 'share_gone')
    expectAppError(() => fx.shares.openContent(token, null, 'GET'), 410, 'share_gone')
  } finally {
    fx.close()
  }
})

test('HTTP 公开端点：软删除文件返回 410 而不是继续下载', async () => {
  const fx = shareFixture()
  const app = await createAuthedApp(fx.db, (instance) => registerShareRoutes(instance, fx.config, fx.shares))
  try {
    const file = await uploadFile(fx.files, 'deleted.txt', 'x')
    const created = await fx.shares.create(ACTOR, file.id, {})
    const token = tokenFromUrl(created.url)
    fx.files.trash(ACTOR, file.id)

    const metadata = await app.inject({ method: 'GET', url: `/api/public/shares/${token}` })
    assert.equal(metadata.statusCode, 410)
    assert.equal(metadata.json().error.code, 'share_gone')

    const content = await app.inject({ method: 'GET', url: `/api/public/shares/${token}/content` })
    assert.equal(content.statusCode, 410)
  } finally {
    await app.close()
    fx.close()
  }
})

test('吊销顺序：先吊销再软删除；吊销失败则中止删除，文件保持可访问', async () => {
  const fx = shareFixture()
  try {
    const file = await uploadFile(fx.files, 'order.txt', 'x')
    const order: string[] = []
    const result = trashFileWithShareRevoke(
      fx.files,
      (id) => {
        order.push('revoke')
        assert.equal(fx.files.get(id).item.id, id, '吊销时文件仍应处于活动状态')
      },
      ACTOR,
      file.id,
    )
    order.push('trashed')
    assert.equal(result.count, 1)
    assert.deepEqual(order, ['revoke', 'trashed'])
    expectAppError(() => fx.files.get(file.id), 404, 'not_found')

    const second = await uploadFile(fx.files, 'order-2.txt', 'y')
    assert.throws(
      () =>
        trashFileWithShareRevoke(
          fx.files,
          () => {
            throw new Error('revoke failed')
          },
          ACTOR,
          second.id,
        ),
      /revoke failed/,
    )
    // 吊销失败 → 删除未执行，文件仍活动（不会留下“回收站里仍可下载”的分享）。
    assert.equal(fx.files.get(second.id).item.id, second.id)
  } finally {
    fx.close()
  }
})

test('HTTP DELETE：吊销钩子抛错返回 500 且文件未被软删除', async () => {
  const fx = shareFixture()
  const app = await createAuthedApp(fx.db, (instance) => {
    registerFileRoutes(instance, fx.config, fx.files, () => {
      throw new Error('share revoke unavailable')
    })
  })
  try {
    const file = await uploadFile(fx.files, 'http-delete.txt', 'x')
    const deleted = await app.inject({ method: 'DELETE', url: `/api/files/${file.id}`, headers: authHeaders() })
    assert.equal(deleted.statusCode, 500)
    const stillThere = await app.inject({ method: 'GET', url: `/api/files/${file.id}`, headers: authHeaders() })
    assert.equal(stillThere.statusCode, 200)
  } finally {
    await app.close()
    fx.close()
  }
})

test('分享密码最小 8 位；旧短密码分享仍可验证（兼容）', async () => {
  const fx = shareFixture()
  try {
    const file = await uploadFile(fx.files, 'pass.txt', 'x')
    assert.ok(SHARE_PASSWORD_MIN_LENGTH >= 8)
    await assert.rejects(
      fx.shares.create(ACTOR, file.id, { password: '1234567' }),
      (error: unknown) => error instanceof AppError && error.code === 'invalid_password',
    )
    const created = await fx.shares.create(ACTOR, file.id, { password: '12345678' })
    assert.equal((await fx.shares.unlock(tokenFromUrl(created.url), '12345678')).state, 'active')

    // 兼容：数据库里已有 3 位旧密码的分享仍可 unlock（只对新创建做最短校验）。
    const token = randomToken(32)
    const legacyPassword = await hashSharePassword('123')
    const shareId = newId()
    fx.db
      .prepare(
        `INSERT INTO shares (id, file_id, token_hash, password_hash, password_salt, expires_at,
           max_downloads, download_count, created_at, revoked_at, created_by, note)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, NULL, 'admin', NULL)`,
      )
      .run(shareId, file.id, sha256Hex(token), legacyPassword.hash, legacyPassword.salt, '2026-12-01T00:00:00.000Z', T0)
    assert.equal((await fx.shares.unlock(token, '123')).state, 'active')
  } finally {
    fx.close()
  }
})

test('下载审计：同一 share+IP 在窗口内只记一条，计数仍逐次累加', async () => {
  const fx = shareFixture()
  try {
    const file = await uploadFile(fx.files, 'audit.txt', 'x')
    const created = await fx.shares.create(ACTOR, file.id, {})
    const token = tokenFromUrl(created.url)
    const auditCount = (): number =>
      (fx.db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'share_download'").get() as { c: number }).c

    // 每次都不带 Cookie → 每次新建会话并计一次下载（模拟清 Cookie 的放大攻击）。
    for (let index = 0; index < 10; index += 1) {
      const access = fx.shares.openContent(token, null, 'GET')
      fx.shares.markDownloaded(access, IP)
    }
    assert.equal(auditCount(), 1, '同一 share+IP 窗口内只应写一条审计')
    const row = fx.db.prepare('SELECT download_count FROM shares WHERE id = ?').get(created.share.id) as {
      download_count: number
    }
    assert.equal(row.download_count, 10, '下载计数不受审计节流影响')

    // 不同 IP → 另一条审计。
    const other = fx.shares.openContent(token, null, 'GET')
    fx.shares.markDownloaded(other, '198.51.100.7')
    assert.equal(auditCount(), 2)

    // 窗口过后同 IP 再记一条。
    fx.clock.advanceMs(DOWNLOAD_AUDIT_WINDOW_MS + 1)
    const later = fx.shares.openContent(token, null, 'GET')
    fx.shares.markDownloaded(later, IP)
    assert.equal(auditCount(), 3)
  } finally {
    fx.close()
  }
})

test('公开信息不返回备注；账号列表仍保留备注', async () => {
  const fx = shareFixture()
  try {
    const file = await uploadFile(fx.files, 'note.txt', 'x')
    const created = await fx.shares.create(ACTOR, file.id, { note: '仅自己可见的备注' })
    const metadata = fx.shares.metadata(tokenFromUrl(created.url), null)
    assert.equal('note' in metadata.share, false, '公开 metadata 不应暴露 note')
    assert.equal(fx.shares.list().items[0]?.note, '仅自己可见的备注')
  } finally {
    fx.close()
  }
})

test('分享列表分页（服务 + HTTP additive 字段）', async () => {
  const fx = shareFixture()
  const app = await createAuthedApp(fx.db, (instance) => registerShareRoutes(instance, fx.config, fx.shares))
  try {
    const file = await uploadFile(fx.files, 'page.txt', 'x')
    for (let index = 0; index < 3; index += 1) await fx.shares.create(ACTOR, file.id, {})
    const first = fx.shares.list({ page: 1, pageSize: 2 })
    assert.equal(first.items.length, 2)
    assert.equal(first.total, 3)
    assert.equal(first.page, 1)
    assert.equal(first.pageSize, 2)
    assert.equal(fx.shares.list({ page: 2, pageSize: 2 }).items.length, 1)

    const response = await app.inject({ method: 'GET', url: '/api/shares?page=1&pageSize=2', headers: authHeaders() })
    assert.equal(response.statusCode, 200)
    const body = response.json() as { items: unknown[]; total: number; page: number; pageSize: number }
    assert.equal(body.items.length, 2)
    assert.equal(body.total, 3)
    assert.equal(body.page, 1)
    assert.equal(body.pageSize, 2)
  } finally {
    await app.close()
    fx.close()
  }
})

test('过期/吊销行 GC：超过保留期删除，活动分享保留', async () => {
  const fx = shareFixture()
  try {
    const file = await uploadFile(fx.files, 'gc.txt', 'x')
    const active = await fx.shares.create(ACTOR, file.id, {})
    const revoked = await fx.shares.create(ACTOR, file.id, {})
    fx.shares.revoke(ACTOR, revoked.share.id)
    const oldIso = new Date(new Date(T0).getTime() - (SHARE_ROW_RETENTION_DAYS + 1) * 86_400_000).toISOString()
    fx.db.prepare('UPDATE shares SET revoked_at = ? WHERE id = ?').run(oldIso, revoked.share.id)

    const expiredToken = randomToken(32)
    const expiredId = newId()
    fx.db
      .prepare(
        `INSERT INTO shares (id, file_id, token_hash, password_hash, password_salt, expires_at,
           max_downloads, download_count, created_at, revoked_at, created_by, note)
         VALUES (?, ?, ?, NULL, NULL, ?, 0, 0, ?, NULL, 'admin', NULL)`,
      )
      .run(expiredId, file.id, sha256Hex(expiredToken), oldIso, oldIso)

    fx.shares.cleanup()
    const remaining = fx.db.prepare('SELECT id FROM shares').all() as unknown as { id: string }[]
    assert.deepEqual(remaining.map((row) => row.id), [active.share.id])
    const sessions = fx.db.prepare('SELECT COUNT(*) AS c FROM share_sessions').get() as { c: number }
    assert.equal(sessions.c, 0)
  } finally {
    fx.close()
  }
})
