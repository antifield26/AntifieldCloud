// 内置认证测试：401 守卫、登录、改密、旧会话失效。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { sealedPw } from './helper.js';

process.env.WB_INITIAL_PW_FILE = join(tmpdir(), `wb-sealed-${Date.now()}`);

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
  void it('未登录 401，health 放行', async () => {
    assert.equal((await call('GET', '/api/sys/overview')).status, 401);
    assert.equal((await call('GET', '/api/auth/status')).status, 200);
    const h = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(h.statusCode, 200);
  });

  void it('错口令 401，对口令 200 置 cookie', async () => {
    assert.equal((await call('POST', '/api/auth/login', { password: 'nope' })).status, 401);
    const ok = await call('POST', '/api/auth/login', { password: sealedPw() });
    assert.equal(ok.status, 200);
    const set = ok.headers['set-cookie'];
    assert.ok(String(Array.isArray(set) ? set[0] : set).includes('wb_session='));
    assert.ok(String(Array.isArray(set) ? set[0] : set).includes('HttpOnly'));
  });

  void it('登录后通行，改密后旧会话失效、密封文件删除', async () => {
    const login = await call('POST', '/api/auth/login', { password: sealedPw() });
    const set = login.headers['set-cookie'];
    const cookie = String(Array.isArray(set) ? set[0] : set).split(';')[0];
    assert.equal((await call('GET', '/api/sys/overview', undefined, cookie)).status, 200);
    const ch = await call('POST', '/api/auth/password', { old: sealedPw(), next: 'newpass-123' }, cookie);
    assert.equal(ch.status, 200);
    assert.equal(existsSync(process.env.WB_INITIAL_PW_FILE as string), false);
    assert.equal((await call('GET', '/api/sys/overview', undefined, cookie)).status, 401);
    const re = await call('POST', '/api/auth/login', { password: 'newpass-123' });
    assert.equal(re.status, 200);
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

  void it('会话列表可见当前会话，吊销后 401', async () => {
    const login = await call('POST', '/api/auth/login', { password: sealedPw() });
    const set = login.headers['set-cookie'];
    const cookie = String(Array.isArray(set) ? set[0] : set).split(';')[0];
    const list = (await call('GET', '/api/auth/sessions', undefined, cookie)).json as {
      sessions: Array<{ id: string; current: boolean }>;
    };
    const cur = list.sessions.find((x) => x.current);
    assert.ok(cur);
    const target = cur.id.replace('…', '');
    const del = await app.inject({ method: 'DELETE', url: '/api/auth/sessions/' + target, headers: { cookie } });
    assert.equal(del.statusCode, 200);
    assert.equal((await call('GET', '/api/sys/overview', undefined, cookie)).status, 401);
  });
});
