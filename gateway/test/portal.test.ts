// 门户测试：parse 校验 + inject 端点（WB_PORTAL_PATH 指向临时文件）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';
import { parsePortal } from '../src/routes/portal.js';

void describe('portal', () => {
  void it('parsePortal 校验', () => {
    const ok = parsePortal(JSON.stringify({ services: [{ id: 'a', title: 'A', href: '/api/files', note: 'n' }] }));
    assert.equal(ok.length, 1);
    assert.throws(() => parsePortal('{}'), /services/);
    assert.throws(() => parsePortal(JSON.stringify({ services: [{ id: 'a' }] })), /bad service/);
    assert.throws(
      () => parsePortal(JSON.stringify({ services: [{ id: 'a', title: 'A', href: 'https://evil.com' }] })),
      /same-origin/,
    );
  });

  void it('端点读配置', async () => {
    const p = join(tmpdir(), `portal-${Date.now()}.json`);
    writeFileSync(p, JSON.stringify({ services: [{ id: 'x', title: 'X', href: '/health' }] }));
    process.env.WB_PORTAL_PATH = p;
    process.env.WB_INITIAL_PW_FILE = join(tmpdir(), `wb-sealed-portal-${Date.now()}`);
    const { buildApp } = await import('../src/app.js');
    const { loginCookie } = await import('./helper.js');
    const { app } = await buildApp({ dbPath: join(tmpdir(), `wb-portal-${Date.now()}.db`), startSampler: false, startSched: false });
    const cookie = await loginCookie(app);
    const res = await app.inject({ method: 'GET', url: '/api/portal/services', headers: { cookie } });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { services: Array<{ id: string }> }).services[0].id, 'x');
    delete process.env.WB_PORTAL_PATH;
    rmSync(p);
  });
});
