// API 审计测试：脱敏收敛 + 落盘 + 30 天裁剪。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { normalizePath, AuditBuffer } from '../src/sys/apiaudit.js';

process.env.AUTH_LOGIN_PASSWORD = 'test-pass-123';

process.env.AUTH_LOGIN_PASSWORD = 'test-pass-123';

void describe('apiaudit', () => {
  void it('normalizePath 收敛 id、丢 query', () => {
    assert.equal(normalizePath('/api/todos'), '/api/todos');
    assert.equal(normalizePath('/api/todos/1a125f61-03ed-4118-8d3b-2aabddecb258'), '/api/todos/:id');
    assert.equal(normalizePath('/api/files/dcea0f28aeeb40ad539f1cc8a64c'), '/api/files/:id');
    assert.equal(normalizePath('/api/sys/services/cloudflared.service/restart'), '/api/sys/services/cloudflared.service/restart');
    assert.equal(normalizePath('/api/sys/logs?unit=ssh.service&since=-1h'), '/api/sys/logs');
  });

  void it('buffer 落盘 + 30 天裁剪', () => {
    const p = join(tmpdir(), `wb-audit-${Date.now()}.db`);
    const d = openDb(p);
    const buf = new AuditBuffer(d, 60000);
    const now = Date.now();
    buf.push({ ts: now, actor: 'ses:abcd', method: 'POST', path: '/api/todos', status: 201, ms: 5 });
    buf.push({ ts: now - 31 * 24 * 3600 * 1000, actor: 'x', method: 'GET', path: '/old', status: 200, ms: 1 });
    assert.equal(buf.flush(), 2);
    const rows = d.prepare('SELECT path FROM api_audit').all() as Array<{ path: string }>;
    assert.deepEqual(rows.map((r) => r.path), ['/api/todos']);
    d.close();
    for (const suf of ['', '-wal', '-shm', '-journal']) {
      try {
        rmSync(p + suf);
      } catch {
        // 忽略
      }
    }
  });

  void it('端到端：登录后写入含 actor、无 body；未登录记 anon', async () => {
    process.env.WB_AUDIT_FLUSH_MS = '50';
    const { buildApp } = await import('../src/app.js');
    const { loginCookie } = await import('./helper.js');
    const dbPath = join(tmpdir(), `wb-audit-e2e-${Date.now()}.db`);
    const { app } = await buildApp({ dbPath, startSampler: false, startSched: false });
    const cookie = await loginCookie(app);
    const sidPrefix = cookie.split('=')[1].slice(0, 8);
    assert.equal((await app.inject({ method: 'GET', url: '/api/todos', headers: { cookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/todos' })).statusCode, 401);
    await new Promise((r) => setTimeout(r, 400));
    const d = openDb(dbPath);
    const rows = d.prepare('SELECT actor,method,path,status FROM api_audit ORDER BY id').all() as Array<{
      actor: string; method: string; path: string; status: number;
    }>;
    const authed = rows.find((r) => r.status === 200 && r.path === '/api/todos');
    assert.ok(authed);
    assert.equal(authed.actor, `ses:${sidPrefix}`);
    const anon = rows.find((r) => r.status === 401);
    assert.ok(anon);
    assert.equal(anon.actor, 'anon');
    // 全行无 body/query 痕迹：转储文本不含测试标题
    const dump = JSON.stringify(rows);
    assert.ok(!dump.includes('buy milk'));
    delete process.env.WB_AUDIT_FLUSH_MS;
    d.close();
    for (const suf of ['', '-wal', '-shm', '-journal']) {
      try {
        rmSync(dbPath + suf);
      } catch {
        // 忽略
      }
    }
  });
});
