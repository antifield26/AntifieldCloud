// 内置认证测试（口令来源：环境变量 AUTH_LOGIN_PASSWORD）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

process.env.AUTH_LOGIN_PASSWORD = 'test-pass-123';

const { buildApp } = await import('../src/app.js');
const dbPath = join(tmpdir(), `wb-auth-${Date.now()}.db`);
const { app } = await buildApp({ dbPath, startSampler: false, startSched: false });

async function call(method: 'GET' | 'POST', url: string, body?: unknown, cookie?: string): Promise<{ status: number; json: unknown; headers: Record<string, unknown> }> {
  const res = await app.inject({
    method,
    url,
    payload: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
  });
  return { status: res.statusCode, json: res.json(), headers: res.headers as Record<string, unknown> };
}

void describe('auth', () => {
  void it('未登录 401，health/status 放行', async () => {
    assert.equal((await call('GET', '/api/sys/overview')).status, 401);
    const st = (await call('GET', '/api/auth/status')).json as { configured: boolean; authenticated: boolean };
    assert.equal(st.configured, true);
    assert.equal(st.authenticated, false);
    const h = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(h.statusCode, 200);
  });

  void it('错口令 401，对口令 200 置 HttpOnly cookie', async () => {
    assert.equal((await call('POST', '/api/auth/login', { password: 'nope' })).status, 401);
    const ok = await call('POST', '/api/auth/login', { password: 'test-pass-123' });
    assert.equal(ok.status, 200);
    const set = ok.headers['set-cookie'];
    const first = String(Array.isArray(set) ? set[0] : set);
    assert.ok(first.includes('wb_session='));
    assert.ok(first.includes('HttpOnly'));
  });

  void it('登录后通行，登出后 401', async () => {
    const login = await call('POST', '/api/auth/login', { password: 'test-pass-123' });
    const set = login.headers['set-cookie'];
    const cookie = String(Array.isArray(set) ? set[0] : set).split(';')[0];
    assert.equal((await call('GET', '/api/sys/overview', undefined, cookie)).status, 200);
    assert.equal((await call('POST', '/api/auth/logout', undefined, cookie)).status, 200);
    assert.equal((await call('GET', '/api/sys/overview', undefined, cookie)).status, 401);
  });

  void it('未配置口令时 status.configured=false 且登录全拒', async () => {
    delete process.env.AUTH_LOGIN_PASSWORD;
    const { buildApp: b2 } = await import('../src/app.js');
    const db2 = join(tmpdir(), `wb-auth2-${Date.now()}.db`);
    const a2 = await b2({ dbPath: db2, startSampler: false, startSched: false });
    const st = await a2.app.inject({ method: 'GET', url: '/api/auth/status' });
    assert.equal((st.json() as { configured: boolean }).configured, false);
    const bad = await a2.app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: JSON.stringify({ password: 'anything' }), headers: { 'content-type': 'application/json' },
    });
    assert.equal(bad.statusCode, 401);
    process.env.AUTH_LOGIN_PASSWORD = 'test-pass-123';
    for (const suf of ['', '-wal', '-shm', '-journal']) {
      try {
        rmSync(db2 + suf);
      } catch {
        // 忽略
      }
    }
  });
});

process.on('exit', () => {
  for (const suf of ['', '-wal', '-shm', '-journal']) {
    try {
      rmSync(dbPath + suf);
    } catch {
      // 忽略
    }
  }
});
