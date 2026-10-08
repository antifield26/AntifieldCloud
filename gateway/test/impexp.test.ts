// 导入导出测试：导出形状、合并/替换 round-trip、非法拒绝。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';

process.env.WB_FILES_DIR = join(tmpdir(), `wb-files-ix-${Date.now()}`);
mkdirSync(process.env.WB_FILES_DIR, { recursive: true });
process.env.AUTH_LOGIN_PASSWORD = 'test-pass-123';

const { buildApp } = await import('../src/app.js');
const { loginCookie } = await import('./helper.js');
const dbPath = join(tmpdir(), `wb-ix-${Date.now()}.db`);
const { app } = await buildApp({ dbPath, startSampler: false, startSched: false });
const COOKIE = await loginCookie(app);

async function call(method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; json: unknown; headers: Record<string, unknown> }> {
  const res = await app.inject({
    method,
    url,
    payload: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie: COOKIE },
  });
  return { status: res.statusCode, json: res.json(), headers: res.headers as Record<string, unknown> };
}

void describe('impexp', () => {
  void it('导出 JSON 四类 + 文件名含日期', async () => {
    await call('POST', '/api/todos', { title: 'exp-todo' });
    const r = await call('GET', '/api/export?format=json');
    assert.equal(r.status, 200);
    const j = r.json as { version: number; todos: unknown[]; notes: unknown[]; bookmarks: unknown[]; files_meta: unknown[] };
    assert.equal(j.version, 1);
    assert.ok(j.todos.length >= 1);
    const disp = String(r.headers['content-disposition'] ?? '');
    assert.ok(/workbench-\d{8}\.json/.test(disp));
  });

  void it('导出 CSV todos', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/export?format=csv&kind=todos', headers: { cookie: COOKIE } });
    assert.equal(res.statusCode, 200);
    assert.ok(String(res.headers['content-type']).includes('text/csv'));
    assert.ok(res.body.split('\n')[0].startsWith('id,title,'));
  });

  void it('导入合并/替换 round-trip + 非法拒绝', async () => {
    const exp = (await call('GET', '/api/export?format=json')).json as { todos: Array<{ id: string; title: string }> };
    const n0 = exp.todos.length;
    // 非法：缺 title
    const bad = await call('POST', '/api/import?mode=merge', { version: 1, todos: [{ id: 'x' }], notes: [], bookmarks: [], files_meta: [] });
    assert.equal(bad.status, 400);
    // 非法：坏 url
    const bad2 = await call('POST', '/api/import?mode=merge', {
      version: 1, todos: [], notes: [],
      bookmarks: [{ id: 'b1', title: 't', url: 'ftp://x', created_at: '', tags: '' }], files_meta: [],
    });
    assert.equal(bad2.status, 400);
    // 合并：同 id 不翻倍
    const m = await call('POST', '/api/import?mode=merge', exp);
    assert.equal((m.json as { ok: boolean }).ok, true);
    const exp2 = (await call('GET', '/api/export?format=json')).json as { todos: unknown[] };
    assert.equal(exp2.todos.length, n0);
    // 替换：只剩导入内容
    const only = { version: 1, todos: [{ id: 'k1', title: 'kept', done: 0, due_at: null, created_at: '', updated_at: '' }], notes: [], bookmarks: [], files_meta: [] };
    await call('POST', '/api/import?mode=replace', only);
    const exp3 = (await call('GET', '/api/export?format=json')).json as { todos: Array<{ title: string }> };
    assert.deepEqual(exp3.todos.map((t) => t.title), ['kept']);
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
  try {
    rmSync(process.env.WB_FILES_DIR as string, { recursive: true });
  } catch {
    // 忽略
  }
});
