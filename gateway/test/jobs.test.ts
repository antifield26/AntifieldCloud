// 流水线测试：cron 匹配 + CRUD + shell 任务真实执行（inject）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { matchCron } from '../src/jobs/scheduler.js';

process.env.WB_INITIAL_PW_FILE = join(tmpdir(), `wb-sealed-jobs-${Date.now()}`);

const { buildApp } = await import('../src/app.js');
const { loginCookie } = await import('./helper.js');
const dbPath = join(tmpdir(), `wb-jobs-${Date.now()}.db`);
const { app } = await buildApp({ dbPath, startSampler: false, startSched: false });
const COOKIE = await loginCookie(app);

async function req(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await app.inject({
    method,
    url,
    payload: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie: COOKIE },
  });
  return { status: res.statusCode, json: res.json() };
}

void describe('jobs', () => {
  void it('matchCron 矩阵', () => {
    const d = new Date(2026, 9, 8, 2, 30, 0); // Thu
    assert.equal(matchCron('* * * * *', d), true);
    assert.equal(matchCron('30 2 * * *', d), true);
    assert.equal(matchCron('31 2 * * *', d), false);
    assert.equal(matchCron('*/15 * * * *', new Date(2026, 9, 8, 1, 45)), true);
    assert.equal(matchCron('*/15 * * * *', new Date(2026, 9, 8, 1, 46)), false);
    assert.equal(matchCron('0 0 1 * *', new Date(2026, 9, 1, 0, 0)), true);
    assert.equal(matchCron('30 2 * * 4', d), true); // Thursday
    assert.equal(matchCron('30 2 * * 5', d), false);
    assert.equal(matchCron('not a cron', d), false);
  });

  void it('jobs CRUD + 校验', async () => {
    const bad = await req('POST', '/api/jobs', { name: 'x', kind: 'shell', payload: {} });
    assert.equal(bad.status, 400);
    const created = await req('POST', '/api/jobs', {
      name: 'echo-test', cron: '', kind: 'shell', payload: { argv: ['/bin/echo', 'hi'] },
    });
    assert.equal(created.status, 201);
    const id = (created.json as { id: string }).id;
    const list = (await req('GET', '/api/jobs')).json as Array<{ id: string }>;
    assert.ok(list.some((j) => j.id === id));
    const patched = await req('PATCH', `/api/jobs/${id}`, { cron: '*/5 * * * *' });
    assert.equal((patched.json as { cron: string }).cron, '*/5 * * * *');
    const due = (await req('GET', '/api/jobs-due')).json as { due: string[] };
    assert.ok(Array.isArray(due.due));
    const del = await req('DELETE', `/api/jobs/${id}`);
    assert.equal((del.json as { ok: boolean }).ok, true);
  });

  void it('shell 任务执行落 job_runs', async () => {
    const created = await req('POST', '/api/jobs', {
      name: 'run-me', cron: '', kind: 'shell', payload: { argv: [process.execPath, '-e', 'console.log("hello-jobs")'] },
    });
    const id = (created.json as { id: string }).id;
    const run = await req('POST', `/api/jobs/${id}/run`);
    const runId = (run.json as { runId: string }).runId;
    assert.ok(typeof runId === 'string');
    let status = '';
    let log = '';
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const runs = (await req('GET', `/api/jobs/${id}/runs`)).json as Array<{
        id: string; status: string; log: string;
      }>;
      const row = runs.find((r) => r.id === runId);
      if (row !== undefined && row.status !== 'running') {
        status = row.status;
        log = row.log;
        break;
      }
    }
    assert.equal(status, 'done');
    assert.ok(log.includes('hello-jobs'));
    await req('DELETE', `/api/jobs/${id}`);
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
