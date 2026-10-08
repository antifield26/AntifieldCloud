// 全局搜索测试：命中、转义、空查询。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

process.env.WB_INITIAL_PW_FILE = join(tmpdir(), `wb-sealed-search-${Date.now()}`);

const { buildApp } = await import('../src/app.js');
const { loginCookie } = await import('./helper.js');
const dbPath = join(tmpdir(), `wb-search-${Date.now()}.db`);
const { app } = await buildApp({ dbPath, startSampler: false, startSched: false });
const COOKIE = await loginCookie(app);

async function get(url: string): Promise<{ status: number; json: unknown }> {
  const res = await app.inject({ method: 'GET', url, headers: { cookie: COOKIE } });
  return { status: res.statusCode, json: res.json() };
}

async function post(url: string, body: unknown): Promise<unknown> {
  const res = await app.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie: COOKIE } });
  return res.json();
}

void describe('search', () => {
  void it('跨类命中 + 空查询 400', async () => {
    await post('/api/todos', { title: '买牛奶周三' });
    await post('/api/notes', { title: '购物单', body: '牛奶面包' });
    await post('/api/bookmarks', { title: '奶站', url: 'https://milk.example.com' });
    const r = await get('/api/search?q=' + encodeURIComponent('牛奶'));
    assert.equal(r.status, 200);
    const j = r.json as { q: string; ms: number; hits: Array<{ kind: string; title: string }> };
    const kinds = new Set(j.hits.map((h) => h.kind));
    assert.ok(kinds.has('todo') && kinds.has('note'));
    assert.ok(j.ms < 200);
    assert.equal((await get('/api/search?q=')).status, 400);
    assert.equal((await get('/api/search?q=%25')).status, 200);
  });

  void it('% 与 _ 不做通配', async () => {
    await post('/api/todos', { title: '100%纯牛奶_鲜' });
    const r = await get('/api/search?q=' + encodeURIComponent('%'));
    const j = r.json as { hits: Array<{ title: string }> };
    assert.ok(j.hits.every((h) => h.title.includes('%')));
    const r2 = await get('/api/search?q=' + encodeURIComponent('_鲜'));
    const j2 = r2.json as { hits: Array<{ title: string }> };
    assert.ok(j2.hits.every((h) => h.title.includes('_鲜')));
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
