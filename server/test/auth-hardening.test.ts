/** 认证加固：超长用户名/审计字段上限、全局限流阈值与 loopback 例外。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.ts'
import {
  AUDIT_DETAIL_MAX_BYTES,
  AUDIT_TARGET_MAX_LENGTH,
  audit,
  listAudit,
} from '../src/auth/audit.ts'
import { AuthService, MAX_LOGIN_USERNAME_LENGTH, isLoopbackAddress } from '../src/auth/service.ts'
import { AppError } from '../src/util/errors.ts'
import { cleanupDir, seedAdmin, tempDataDir, testConfig, testDb } from './helpers.ts'

function expectRejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, `应抛出 AppError，实际为 ${String(error)}`)
    assert.equal(error.code, code)
    return true
  })
}

test('超长用户名：路由 400，服务层截断后审计 actor 有长度上限', async () => {
  const dir = tempDataDir()
  const config = testConfig(dir)
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const context = await buildApp(config, db)
  try {
    const oversized = 'x'.repeat(5000)
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { username: oversized, password: 'whatever-password' },
    })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error.code, 'invalid_request')

    // 绕过路由直接调服务层：姓名被截断，审计行不会写入整串。
    await expectRejectsCode(
      context.auth.beginPasswordLogin({
        username: oversized,
        password: 'wrong-password-123',
        ip: '203.0.113.50',
        userAgent: null,
      }),
      'invalid_credentials',
    )
    const row = db
      .prepare("SELECT actor, length(actor) AS len FROM audit_log WHERE action = 'login_failed' ORDER BY id DESC LIMIT 1")
      .get() as { actor: string; len: number }
    assert.ok(row.len <= MAX_LOGIN_USERNAME_LENGTH, `actor 长度 ${row.len} 应 ≤ ${MAX_LOGIN_USERNAME_LENGTH}`)
    assert.equal(row.actor.length, MAX_LOGIN_USERNAME_LENGTH)

    // 合法用户名仍可进入挑战流程。
    const ok = await context.auth.beginPasswordLogin({
      username: seeded.username,
      password: seeded.password,
      ip: '198.51.100.20',
      userAgent: null,
    })
    assert.ok(ok.challenge)
  } finally {
    await context.app.close()
    db.close()
    cleanupDir(dir)
  }
})

test('audit 兜底截断：target ≤256、detail_json ≤4KiB 且保持合法 JSON；列表返回有界', () => {
  const dir = tempDataDir()
  const db = testDb(dir)
  try {
    const hugeDetail: Record<string, unknown> = { blob: 'y'.repeat(50_000), nested: { deep: 'z'.repeat(10_000) } }
    audit(db, 'a'.repeat(1000), 'action_'.repeat(100), 't'.repeat(5000), hugeDetail, '203.0.113.9')
    const row = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1').get() as {
      actor: string
      action: string
      target: string
      detail_json: string
    }
    assert.ok(row.actor.length <= 64)
    assert.ok(row.action.length <= 64)
    assert.equal(row.target.length, AUDIT_TARGET_MAX_LENGTH)
    assert.ok(row.detail_json.length <= AUDIT_DETAIL_MAX_BYTES, `detail_json 长度 ${row.detail_json.length}`)
    const parsed = JSON.parse(row.detail_json) as Record<string, unknown>
    assert.equal(parsed.truncated, true)

    // 模拟历史遗留的超长行：列表返回前再截断，200 条响应大小可控。
    db.prepare(
      `INSERT INTO audit_log (ts, actor, action, target, detail_json, ip)
       VALUES (?, 'legacy', 'legacy_action', ?, ?, '198.51.100.1')`,
    ).run(new Date().toISOString(), 'T'.repeat(5000), JSON.stringify({ blob: 'x'.repeat(60_000) }))
    const list = listAudit(db, { limit: 200, offset: 0 })
    assert.equal(list.total, 2)
    for (const item of list.items) {
      if (item.target) assert.ok(item.target.length <= AUDIT_TARGET_MAX_LENGTH)
    }
    const legacy = list.items.find((item) => item.action === 'legacy_action')
    assert.deepEqual(legacy?.detail, { truncated: true })
    assert.ok(JSON.stringify(list).length < 20_000, '列表 JSON 大小应可控')
  } finally {
    db.close()
    cleanupDir(dir)
  }
})

test('登录限流：全局阈值提高，loopback 不占全局桶；每 IP 限制仍生效', async () => {
  const dir = tempDataDir()
  const config = testConfig(dir)
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const auth = new AuthService(db, config)
  try {
    // 单个来源占满自己的窗口（5 次）后仍被拒绝，但不锁死其它来源。
    for (let index = 0; index < 5; index += 1) auth.passwordLimiter.hit('203.0.113.1')
    await expectRejectsCode(
      auth.beginPasswordLogin({ username: 'admin', password: 'x'.repeat(20), ip: '203.0.113.1', userAgent: null }),
      'rate_limited',
    )
    // 40 次其它来源消耗全局（旧阈值 20 会锁死；新阈值 60 仍放行）。
    for (let index = 0; index < 40; index += 1) auth.globalLimiter.hit('global')
    const allowed = await auth.beginPasswordLogin({
      username: seeded.username,
      password: seeded.password,
      ip: '198.51.100.77',
      userAgent: null,
    })
    assert.ok(allowed.challenge, '全局 40/60 时其它来源应可登录')

    // 全局桶耗尽后：非 loopback 429，loopback 仍可登录。
    while (auth.globalLimiter.hit('global') === 0) {
      // 消耗到上限。
    }
    await expectRejectsCode(
      auth.beginPasswordLogin({ username: seeded.username, password: seeded.password, ip: '192.0.2.9', userAgent: null }),
      'rate_limited',
    )
    const loopback = await auth.beginPasswordLogin({
      username: seeded.username,
      password: seeded.password,
      ip: '127.0.0.1',
      userAgent: null,
    })
    assert.ok(loopback.challenge, 'loopback 不占全局桶，管理员本机可登录')
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
    assert.equal(isLoopbackAddress('203.0.113.9'), false)
  } finally {
    db.close()
    cleanupDir(dir)
  }
})
