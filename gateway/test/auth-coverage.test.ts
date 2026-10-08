// 认证覆盖面回归：全部业务 /api/* 在无 cookie 时必须 401（防 Fastify 钩子注册顺序回退）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

process.env.AUTH_LOGIN_PASSWORD = 'test-pass-123';
process.env.OPENCODE_BASE_URL = 'http://127.0.0.1:1'; // 故意不可达，只测 401 前置

const { buildApp } = await import('../src/app.js');
const { loginCookie } = await import('./helper.js');

const dbPath = join(tmpdir(), `wb-authcov-${Date.now()}.db`);
const { app } = await buildApp({ dbPath, startSampler: false, startSched: false });

const PROTECTED_URLS: Array<[string, string]> = [
  ['GET', '/api/ai/health'],
  ['GET', '/api/ai/sessions'],
  ['POST', '/api/ai/sessions'],
  ['GET', '/api/ai/sessions/ses_x/messages'],
  ['POST', '/api/ai/sessions/ses_x/prompt'],
  ['GET', '/api/sys/overview'],
  ['GET', '/api/sys/metrics'],
  ['GET', '/api/sys/services'],
  ['POST', '/api/sys/services/opencode.service/restart'],
  ['GET', '/api/sys/logs'],
  ['GET', '/api/sys/apt'],
  ['GET', '/api/sys/disk'],
  ['GET', '/api/todos'],
  ['POST', '/api/todos'],
  ['GET', '/api/notes'],
  ['GET', '/api/bookmarks'],
  ['GET', '/api/files'],
  ['GET', '/api/jobs'],
  ['POST', '/api/jobs'],
  ['GET', '/api/portal/services'],
  ['GET', '/api/auth/sessions'],
];

void describe('auth coverage', () => {
  void it('开放面无需 cookie', async () => {
    for (const [method, url] of [['GET', '/api/auth/status'], ['GET', '/health']] as Array<[string, string]>) {
      const res = await app.inject({ method: method as 'GET', url });
      assert.notEqual(res.statusCode, 401, `${method} ${url} 不应 401`);
    }
    // 登录端点可达：空体应报口令错/锁定，而不是被认证钩子拦成 login required
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });
    assert.ok([401, 429].includes(login.statusCode), `login 可达，实际 ${login.statusCode}`);
    assert.notEqual(String(login.body).includes('login required'), true, 'login 不应被认证钩子拦截');
  });

  void it('全部业务 API 无 cookie 一律 401（含 /api/ai/*）', async () => {
    for (const [method, url] of PROTECTED_URLS) {
      const res = await app.inject({
        method: method as 'GET',
        url,
        ...(method === 'POST' ? { payload: {}, headers: { 'content-type': 'application/json' } } : {}),
      });
      assert.equal(res.statusCode, 401, `${method} ${url} 应 401，实际 ${res.statusCode}`);
    }
  });

  void it('登录后 /api/ai/health 不再 401（可 502 表示上游不可达）', async () => {
    const cookie = await loginCookie(app);
    const res = await app.inject({ method: 'GET', url: '/api/ai/health', headers: { cookie } });
    assert.ok(res.statusCode === 200 || res.statusCode === 502, `期望 200/502，实际 ${res.statusCode}`);
    assert.notEqual(res.statusCode, 401);
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
