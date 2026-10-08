// 内置认证测试（口令来源：环境变量 AUTH_LOGIN_PASSWORD）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';

process.env.AUTH_LOGIN_PASSWORD = 'test-pass-123';

const wlPath = join(tmpdir(), `wb-wl-${Date.now()}.json`);
writeFileSync(wlPath, JSON.stringify({ allowed: [{ unit: 'opencode.service', actions: ['restart', 'status'] }] }));
process.env.WB_WHITELIST_PATH = wlPath;

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

  void it('登录审计 + 会话列表/吊销 + 操作归因', async () => {
    const login = await call('POST', '/api/auth/login', { password: 'test-pass-123' });
    const set = login.headers['set-cookie'];
    const cookie = String(Array.isArray(set) ? set[0] : set).split(';')[0];
    const sidPrefix = cookie.split('=')[1].slice(0, 8);
    // 白名单外操作被拒，且审计行归因到会话
    const denied = await call('POST', '/api/sys/services/minecraft.service/stop', undefined, cookie);
    assert.equal(denied.status, 403);
    // 会话列表可见当前会话
    const list = (await call('GET', '/api/auth/sessions', undefined, cookie)).json as {
      sessions: Array<{ id: string; current: boolean }>;
    };
    assert.ok(list.sessions.some((s) => s.current));
    // 吊销当前会话后即 401
    const target = list.sessions.find((s) => s.current)?.id.replace('…', '') ?? '';
    const del = await app.inject({ method: 'DELETE', url: `/api/auth/sessions/${target}`, headers: { cookie } });
    assert.equal(del.statusCode, 200);
    assert.equal((await call('GET', '/api/sys/overview', undefined, cookie)).status, 401);
    // 审计行检查（需重新登录）
    const login2 = await call('POST', '/api/auth/login', { password: 'test-pass-123' });
    const set2 = login2.headers['set-cookie'];
    const cookie2 = String(Array.isArray(set2) ? set2[0] : set2).split(';')[0];
    const rows = (
      await app.inject({ method: 'GET', url: '/api/auth/sessions', headers: { cookie: cookie2 } })
    ).json() as unknown;
    assert.ok(rows !== null);
    const { openDb } = await import('../src/db.js');
    const d = openDb(dbPath);
    const audits = d.prepare("SELECT result FROM auth_audit ORDER BY id DESC LIMIT 5").all() as Array<{ result: string }>;
    assert.ok(audits.some((a) => a.result === 'ok'));
    assert.ok(audits.some((a) => a.result === 'fail'));
    const svc = d.prepare("SELECT actor FROM service_audit ORDER BY id DESC LIMIT 1").get() as { actor: string };
    assert.equal(svc.actor, `ses:${sidPrefix}`);
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
