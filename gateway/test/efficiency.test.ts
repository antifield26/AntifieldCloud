// 效率面板 API 测试（inject，不起端口）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';

process.env.WB_FILES_DIR = join(tmpdir(), `wb-files-${Date.now()}`);
mkdirSync(process.env.WB_FILES_DIR, { recursive: true });
process.env.WB_INITIAL_PW_FILE = join(tmpdir(), `wb-sealed-eff-${Date.now()}`);

const { buildApp } = await import('../src/app.js');
const { loginCookie } = await import('./helper.js');
const dbPath = join(tmpdir(), `wb-eff-${Date.now()}.db`);
const { app } = await buildApp({ dbPath, startSampler: false });
const COOKIE = await loginCookie(app);

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function req(method: Method, url: string, body?: unknown, raw?: Buffer): Promise<{ status: number; json: unknown }> {
  const hasBody = raw !== undefined || body !== undefined;
  const res = await app.inject({
    method,
    url,
    payload: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    headers: {
      ...(raw !== undefined
        ? { 'content-type': 'application/octet-stream' }
        : hasBody
          ? { 'content-type': 'application/json' }
          : {}),
      cookie: COOKIE,
    },
  });
  return { status: res.statusCode, json: res.json() };
}

void describe('efficiency', () => {
  void it('todos 全周期', async () => {
    const created = await req('POST', '/api/todos', { title: 'buy milk' });
    assert.equal(created.status, 201);
    const id = (created.json as { id: string }).id;
    const bad = await req('POST', '/api/todos', { title: '' });
    assert.equal(bad.status, 400);
    const patched = await req('PATCH', `/api/todos/${id}`, { done: true });
    assert.equal((patched.json as { done: number }).done, 1);
    const listed = await req('GET', '/api/todos');
    assert.equal((listed.json as unknown[]).length, 1);
    const del = await req('DELETE', `/api/todos/${id}`);
    assert.equal((del.json as { ok: boolean }).ok, true);
    const del2 = await req('DELETE', `/api/todos/${id}`);
    assert.equal(del2.status, 404);
  });

  void it('notes 全周期', async () => {
    const created = await req('POST', '/api/notes', { title: 'n', body: 'b' });
    assert.equal(created.status, 201);
    const id = (created.json as { id: string }).id;
    const patched = await req('PATCH', `/api/notes/${id}`, { body: 'b2' });
    assert.equal((patched.json as { body: string }).body, 'b2');
    assert.equal((await req('DELETE', `/api/notes/${id}`)).status, 200);
  });

  void it('bookmarks 校验 url', async () => {
    const bad = await req('POST', '/api/bookmarks', { title: 'x', url: 'ftp://a' });
    assert.equal(bad.status, 400);
    const created = await req('POST', '/api/bookmarks', { title: 'x', url: 'https://example.com', tags: ['work', ' rss '] });
    assert.equal(created.status, 201);
    assert.deepEqual((created.json as { tags: string[] }).tags, ['work', 'rss']);
    const id = (created.json as { id: string }).id;
    const filtered = (await req('GET', '/api/bookmarks?tag=work')).json as Array<{ id: string }>;
    assert.ok(filtered.some((b) => b.id === id));
    const missed = (await req('GET', '/api/bookmarks?tag=play')).json as unknown[];
    assert.equal(missed.length, 0);
    const patched = await req('PATCH', `/api/bookmarks/${id}`, { tags: ['play'] });
    assert.equal(patched.status, 200);
    assert.equal((await req('DELETE', `/api/bookmarks/${id}`)).status, 200);
  });

  void it('files 上传下载删除', async () => {
    const up = await req('POST', '/api/files?name=a.txt', undefined, Buffer.from('hello'));
    assert.equal(up.status, 201);
    const id = (up.json as { id: string }).id;
    const meta = (await req('GET', '/api/files')).json as Array<{ id: string; size: number }>;
    assert.equal(meta.length, 1);
    assert.equal(meta[0].size, 5);
    const dl = await app.inject({ method: 'GET', url: `/api/files/${id}`, headers: { cookie: COOKIE } });
    assert.equal(dl.statusCode, 200);
    assert.equal(dl.body, 'hello');
    assert.equal((await req('DELETE', `/api/files/${id}`)).status, 200);
    assert.equal((await req('GET', `/api/files/${id}`)).status, 404);
  });

  void it('files 拒绝空体与路径穿越', async () => {
    assert.equal((await req('POST', '/api/files?name=x', undefined, Buffer.alloc(0))).status, 400);
    const up = await req('POST', '/api/files?name=../../evil', undefined, Buffer.from('x'));
    assert.equal(up.status, 201);
    assert.equal((up.json as { name: string }).name, 'evil');
  });

  void it('files 文本预览与二进制拒绝', async () => {
    const up = await req('POST', '/api/files?name=note.md', undefined, Buffer.from('# hi\ntext'));
    const id = (up.json as { id: string }).id;
    const pv = await app.inject({ method: 'GET', url: `/api/files/${id}/preview`, headers: { cookie: COOKIE } });
    assert.equal(pv.statusCode, 200);
    assert.ok((pv.json() as { text: string }).text.includes('# hi'));
    const bin = await req('POST', '/api/files?name=a.bin', undefined, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    const bid = (bin.json as { id: string }).id;
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/files/${bid}/preview`, headers: { cookie: COOKIE } })).statusCode,
      415,
    );
    assert.equal((await req('DELETE', `/api/files/${id}`)).status, 200);
    assert.equal((await req('DELETE', `/api/files/${bid}`)).status, 200);
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
