import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.ts'
import { hotp, currentStep } from '../src/auth/totp.ts'
import { createSession } from '../src/auth/sessions.ts'
import { cleanupDir, cookieHeader, parseSetCookies, seedAdmin, tempDataDir, testConfig, testDb } from './helpers.ts'

interface AppFixture {
  context: Awaited<ReturnType<typeof buildApp>>
  dir: string
  seeded: Awaited<ReturnType<typeof seedAdmin>>
  close: () => Promise<void>
}

async function fixture(): Promise<AppFixture> {
  const dir = tempDataDir()
  const config = testConfig(dir)
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const context = await buildApp(config, db)
  return {
    context,
    dir,
    seeded,
    close: async () => {
      await context.app.close()
      db.close()
      cleanupDir(dir)
    },
  }
}

function nextCode(secret: string, offset = 0): string {
  return hotp(secret, currentStep() + offset)
}

/** 完整登录，返回 cookie/CSRF 与可用于再认证的当前 TOTP。 */
async function login(fx: AppFixture, password?: string, offset = 0): Promise<{ cookie: string; csrf: string; code: string }> {
  const passwordRes = await fx.context.app.inject({
    method: 'POST',
    url: '/api/auth/password',
    headers: { host: 'app.test' },
    payload: { username: fx.seeded.username, password: password ?? fx.seeded.password },
  })
  assert.equal(passwordRes.statusCode, 200)
  const code = nextCode(fx.seeded.secret, offset)
  const totpRes = await fx.context.app.inject({
    method: 'POST',
    url: '/api/auth/totp',
    headers: { host: 'app.test' },
    payload: { challenge: passwordRes.json().challenge, code },
  })
  assert.equal(totpRes.statusCode, 200)
  const cookies = parseSetCookies(totpRes.headers['set-cookie'] as string[] | undefined)
  return { cookie: cookieHeader(cookies), csrf: cookies.af_csrf!, code }
}

async function reauthRequest(
  fx: AppFixture,
  session: { cookie: string; csrf: string },
  url: string,
  payload: Record<string, unknown>,
): Promise<Awaited<ReturnType<AppFixture['context']['app']['inject']>>> {
  return fx.context.app.inject({
    method: 'POST',
    url,
    headers: { host: 'app.test', cookie: session.cookie, 'x-csrf-token': session.csrf },
    payload,
  })
}

function auditCount(fx: AppFixture, action: string): number {
  const row = fx.context.db.prepare('SELECT COUNT(*) AS c FROM audit_log WHERE action = ?').get(action) as { c: number }
  return row.c
}

test('H1：改密接口要求 TOTP，且当前时间步可复用（登录后立即再认证）', async () => {
  const fx = await fixture()
  try {
    const session = await login(fx)
    // 缺少 totpCode
    const missing = await reauthRequest(fx, session, '/api/account/password', {
      currentPassword: fx.seeded.password,
      newPassword: 'another-password-123',
    })
    assert.equal(missing.statusCode, 400)

    // 登录刚用过的当前时间步验证码允许用于再认证
    const ok = await reauthRequest(fx, session, '/api/account/password', {
      currentPassword: fx.seeded.password,
      newPassword: 'another-password-123',
      totpCode: session.code,
    })
    assert.equal(ok.statusCode, 200, ok.body)
    assert.equal(auditCount(fx, 'password_change'), 1)
  } finally {
    await fx.close()
  }
})

test('H1：改密失败（密码错/TOTP 错）401、恒定延迟路径、写失败审计且不消耗成功计数', async () => {
  const fx = await fixture()
  try {
    const session = await login(fx)
    const wrongPassword = await reauthRequest(fx, session, '/api/account/password', {
      currentPassword: 'wrong-password-123',
      newPassword: 'another-password-123',
      totpCode: nextCode(fx.seeded.secret),
    })
    assert.equal(wrongPassword.statusCode, 401)
    assert.equal(wrongPassword.json().error.code, 'invalid_credentials')

    const wrongTotp = await reauthRequest(fx, session, '/api/account/password', {
      currentPassword: fx.seeded.password,
      newPassword: 'another-password-123',
      totpCode: '000000' === nextCode(fx.seeded.secret) ? '111111' : '000000',
    })
    assert.equal(wrongTotp.statusCode, 401)
    assert.equal(wrongTotp.json().error.code, 'invalid_code')

    assert.equal(auditCount(fx, 'password_change_failed'), 2)
    assert.equal(auditCount(fx, 'password_change'), 0)
    const reasons = fx.context.db
      .prepare("SELECT detail_json FROM audit_log WHERE action = 'password_change_failed' ORDER BY id")
      .all() as { detail_json: string }[]
    assert.deepEqual(reasons.map((row) => JSON.parse(row.detail_json).reason), ['bad_password', 'bad_totp'])
  } finally {
    await fx.close()
  }
})

test('H1：改密成功使其它会话失效、当前会话保留，且旧密码不可再登录', async () => {
  const fx = await fixture()
  try {
    const session = await login(fx)
    const other = createSession(fx.context.db, fx.seeded.userId, 'other-csrf', 7, '127.0.0.1', 'other')
    const otherMe = await fx.context.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { host: 'app.test', cookie: `af_session=${other.token}` },
    })
    assert.equal(otherMe.statusCode, 200)

    const changed = await reauthRequest(fx, session, '/api/account/password', {
      currentPassword: fx.seeded.password,
      newPassword: 'brand-new-password-456',
      totpCode: nextCode(fx.seeded.secret),
    })
    assert.equal(changed.statusCode, 200, changed.body)

    const otherAfter = await fx.context.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { host: 'app.test', cookie: `af_session=${other.token}` },
    })
    assert.equal(otherAfter.statusCode, 401)

    const current = await fx.context.app.inject({ method: 'GET', url: '/api/auth/me', headers: { host: 'app.test', cookie: session.cookie } })
    assert.equal(current.statusCode, 200)

    const oldLogin = await fx.context.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { host: 'app.test' },
      payload: { username: fx.seeded.username, password: fx.seeded.password },
    })
    assert.equal(oldLogin.statusCode, 401)

    const newPasswordLogin = await fx.context.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { host: 'app.test' },
      payload: { username: fx.seeded.username, password: 'brand-new-password-456' },
    })
    assert.equal(newPasswordLogin.statusCode, 200)
    const newTotp = await fx.context.app.inject({
      method: 'POST',
      url: '/api/auth/totp',
      headers: { host: 'app.test' },
      payload: { challenge: newPasswordLogin.json().challenge, code: nextCode(fx.seeded.secret, 1) },
    })
    assert.equal(newTotp.statusCode, 200)
  } finally {
    await fx.close()
  }
})

test('H1：恢复码重生成需要密码+TOTP，成功返回 10 个一次性码并审计', async () => {
  const fx = await fixture()
  try {
    const session = await login(fx)
    const failed = await reauthRequest(fx, session, '/api/account/recovery-codes', {
      password: 'wrong-password-123',
      totpCode: nextCode(fx.seeded.secret),
    })
    assert.equal(failed.statusCode, 401)
    assert.equal(auditCount(fx, 'recovery_regenerate_failed'), 1)

    const ok = await reauthRequest(fx, session, '/api/account/recovery-codes', {
      password: fx.seeded.password,
      totpCode: nextCode(fx.seeded.secret),
    })
    assert.equal(ok.statusCode, 200, ok.body)
    const codes = ok.json().codes as string[]
    assert.equal(codes.length, 10)
    assert.equal(new Set(codes).size, 10)
    assert.equal(auditCount(fx, 'recovery_regenerate'), 1)
    const row = fx.context.db.prepare('SELECT recovery_codes_json FROM users').get() as { recovery_codes_json: string }
    assert.equal((JSON.parse(row.recovery_codes_json) as string[]).length, 10)
  } finally {
    await fx.close()
  }
})

test('TOTP 全局限流：跨来源累计 40 次失败后 429（防分布式爆破）', async () => {
  const fx = await fixture()
  try {
    const password = await fx.context.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { host: 'app.test', 'cf-connecting-ip': '198.51.100.1' },
      payload: { username: fx.seeded.username, password: fx.seeded.password },
    })
    assert.equal(password.statusCode, 200)
    const challenge = password.json().challenge as string
    for (let index = 0; index < 40; index += 1) {
      const response = await fx.context.app.inject({
        method: 'POST',
        url: '/api/auth/totp',
        headers: { host: 'app.test', 'cf-connecting-ip': `198.51.100.${index + 2}` },
        payload: { challenge, code: '000000' },
      })
      assert.equal(response.statusCode, 401, `第 ${index + 1} 次应 401`)
    }
    const limited = await fx.context.app.inject({
      method: 'POST',
      url: '/api/auth/totp',
      headers: { host: 'app.test', 'cf-connecting-ip': '203.0.113.250' },
      payload: { challenge, code: '000000' },
    })
    assert.equal(limited.statusCode, 429)
    assert.ok(Number(limited.headers['retry-after']) >= 1)
  } finally {
    await fx.close()
  }
})

test('H1：再认证失败按 IP 限流（5 次/15 分钟，第 6 次 429 + Retry-After）', async () => {
  const fx = await fixture()
  try {
    const session = await login(fx)
    for (let index = 0; index < 5; index += 1) {
      const response = await reauthRequest(fx, session, '/api/account/password', {
        currentPassword: 'wrong-password-123',
        newPassword: 'another-password-123',
        totpCode: '000000',
      })
      assert.equal(response.statusCode, 401, `第 ${index + 1} 次应 401`)
    }
    const limited = await reauthRequest(fx, session, '/api/account/password', {
      currentPassword: 'wrong-password-123',
      newPassword: 'another-password-123',
      totpCode: '000000',
    })
    assert.equal(limited.statusCode, 429)
    assert.ok(Number(limited.headers['retry-after']) >= 1)
    assert.ok((limited.json().error.details.retryAfterSec as number) >= 1)
  } finally {
    await fx.close()
  }
})
