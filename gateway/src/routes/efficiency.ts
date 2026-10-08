// 个人效率面板：todos / notes / bookmarks / files。
// 二进制文件落盘（WB_FILES_DIR），库中只存元数据。
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { registerImportExport } from './impexp.js';

const FILES_DIR = process.env.WB_FILES_DIR ?? '/var/lib/workbench/files';
const MAX_FILE_BYTES = 50 * 1024 * 1024;

const now = (): string => new Date().toISOString();

function fail(msg: string, code = 400): never {
  throw Object.assign(new Error(msg), { statusCode: code });
}

/** node:sqlite run() 参数收敛（unknown 不可直传） */
function v(x: unknown): string | number | null {
  if (x === undefined || x === null) return null;
  if (typeof x === 'string' || typeof x === 'number') return x;
  return String(x);
}

function needStr(v: unknown, name: string, max: number): string {
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) fail(`invalid ${name}`);
  return (v as string).trim();
}

function optStr(v: unknown, max: number): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > max) fail('invalid field');
  return v;
}

function safeName(name: string): string {
  const b = basename(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  if (b === '' || b === '.' || b === '..') fail('invalid name');
  return b;
}

function normTags(v: unknown): string {
  if (v === undefined || v === null) return '';
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const out = arr
    .map((t) => String(t).trim().slice(0, 32))
    .filter((t) => t !== '' && /^[\w\u4e00-\u9fa5-]+$/.test(t))
    .slice(0, 10);
  return [...new Set(out)].join(',');
}

async function readRaw(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

export function registerEfficiencyRoutes(app: FastifyInstance, db: DatabaseSync): void {
  registerImportExport(app, db);
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });
  app.setErrorHandler((err: Error, _req, reply) => {
    const sc = (err as Error & { statusCode?: unknown }).statusCode;
    reply.code(typeof sc === 'number' ? sc : 500).send({ error: err.message ?? String(err) });
  });
  void mkdir(FILES_DIR, { recursive: true }).catch(() => undefined);

  // ---- todos ----
  app.get('/api/todos', async () => db.prepare('SELECT * FROM todos ORDER BY updated_at DESC').all());
  app.post<{ Body: { title?: unknown; due_at?: unknown } }>('/api/todos', async (req, reply) => {
    const title = needStr(req.body?.title, 'title', 500);
    const due = optStr(req.body?.due_at, 64);
    const id = randomUUID();
    const t = now();
    db.prepare('INSERT INTO todos(id,title,done,due_at,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(
      id, title, 0, due ?? null, t, t,
    );
    return reply.code(201).send({ id, title, done: 0, due_at: due ?? null, created_at: t, updated_at: t });
  });
  app.patch<{ Params: { id: string }; Body: { title?: unknown; done?: unknown; due_at?: unknown } }>(
    '/api/todos/:id',
    async (req, reply) => {
      const cur = db.prepare('SELECT * FROM todos WHERE id=?').get(req.params.id) as Record<string, unknown> | undefined;
      if (cur === undefined) return reply.code(404).send({ error: 'not found' });
      const title = req.body?.title === undefined ? cur.title : needStr(req.body.title, 'title', 500);
      const done = req.body?.done === undefined ? cur.done : req.body.done ? 1 : 0;
      const due = req.body?.due_at === undefined ? cur.due_at : (optStr(req.body.due_at, 64) ?? null);
      const t = now();
      db.prepare('UPDATE todos SET title=?,done=?,due_at=?,updated_at=? WHERE id=?').run(
        v(title), v(done), v(due), t, req.params.id,
      );
      return { id: req.params.id, title, done, due_at: due, updated_at: t };
    },
  );
  app.delete<{ Params: { id: string } }>('/api/todos/:id', async (req, reply) => {
    const r = db.prepare('DELETE FROM todos WHERE id=?').run(req.params.id) as unknown as { changes: number };
    if (Number(r.changes) === 0) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  // ---- notes ----
  app.get('/api/notes', async () => db.prepare('SELECT * FROM notes ORDER BY updated_at DESC').all());
  app.post<{ Body: { title?: unknown; body?: unknown } }>('/api/notes', async (req, reply) => {
    const title = needStr(req.body?.title, 'title', 200);
    const body = optStr(req.body?.body, 100000) ?? '';
    const id = randomUUID();
    const t = now();
    db.prepare('INSERT INTO notes(id,title,body,updated_at) VALUES (?,?,?,?)').run(id, title, body, t);
    return reply.code(201).send({ id, title, body, updated_at: t });
  });
  app.patch<{ Params: { id: string }; Body: { title?: unknown; body?: unknown } }>('/api/notes/:id', async (req, reply) => {
    const cur = db.prepare('SELECT * FROM notes WHERE id=?').get(req.params.id) as Record<string, unknown> | undefined;
    if (cur === undefined) return reply.code(404).send({ error: 'not found' });
    const title = req.body?.title === undefined ? cur.title : needStr(req.body.title, 'title', 200);
    const body = req.body?.body === undefined ? cur.body : (optStr(req.body.body, 100000) ?? '');
    const t = now();
    db.prepare('UPDATE notes SET title=?,body=?,updated_at=? WHERE id=?').run(v(title), v(body), t, req.params.id);
    return { id: req.params.id, title, body, updated_at: t };
  });
  app.delete<{ Params: { id: string } }>('/api/notes/:id', async (req, reply) => {
    const r = db.prepare('DELETE FROM notes WHERE id=?').run(req.params.id) as unknown as { changes: number };
    if (Number(r.changes) === 0) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  // ---- bookmarks ----
  app.get<{ Querystring: { tag?: string } }>('/api/bookmarks', async (req) => {
    const all = db.prepare('SELECT * FROM bookmarks ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
    const tag = typeof req.query.tag === 'string' && req.query.tag !== '' ? req.query.tag : null;
    const rows = tag === null ? all : all.filter((r) => String(r.tags ?? '').split(',').includes(tag));
    return rows.map((r) => ({ ...r, tags: String(r.tags ?? '').split(',').filter(Boolean) }));
  });
  app.post<{ Body: { title?: unknown; url?: unknown; tags?: unknown } }>('/api/bookmarks', async (req, reply) => {
    const title = needStr(req.body?.title, 'title', 200);
    const url = needStr(req.body?.url, 'url', 2000);
    if (!/^https?:\/\//.test(url)) return reply.code(400).send({ error: 'url must be http(s)' });
    const tags = normTags(req.body?.tags);
    const id = randomUUID();
    const t = now();
    db.prepare('INSERT INTO bookmarks(id,title,url,created_at,tags) VALUES (?,?,?,?,?)').run(id, title, url, t, tags);
    return reply.code(201).send({ id, title, url, created_at: t, tags: tags.split(',').filter(Boolean) });
  });
  app.patch<{ Params: { id: string }; Body: { title?: unknown; tags?: unknown } }>('/api/bookmarks/:id', async (req, reply) => {
    const cur = db.prepare('SELECT * FROM bookmarks WHERE id=?').get(req.params.id) as Record<string, unknown> | undefined;
    if (cur === undefined) return reply.code(404).send({ error: 'not found' });
    const title = req.body?.title === undefined ? String(cur.title) : needStr(req.body.title, 'title', 200);
    const tags = req.body?.tags === undefined ? String(cur.tags ?? '') : normTags(req.body.tags);
    db.prepare('UPDATE bookmarks SET title=?,tags=? WHERE id=?').run(title, tags, req.params.id);
    return { id: req.params.id, title, tags: tags.split(',').filter(Boolean) };
  });
  app.delete<{ Params: { id: string } }>('/api/bookmarks/:id', async (req, reply) => {
    const r = db.prepare('DELETE FROM bookmarks WHERE id=?').run(req.params.id) as unknown as { changes: number };
    if (Number(r.changes) === 0) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  // ---- files (binary on disk, meta in db) ----
  app.get('/api/files', async () => db.prepare('SELECT * FROM files_meta ORDER BY updated_at DESC').all());
  app.post<{ Querystring: { name?: string }; Body: unknown }>('/api/files', async (req, reply) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (buf.length === 0) return reply.code(400).send({ error: 'empty body' });
    if (buf.length > MAX_FILE_BYTES) return reply.code(413).send({ error: 'too large' });
    const name = safeName(typeof req.query.name === 'string' ? req.query.name : 'upload.bin');
    const id = randomUUID();
    const t = now();
    const diskName = `${id}-${name}`;
    await mkdir(FILES_DIR, { recursive: true });
    await writeFile(join(FILES_DIR, diskName), buf);
    db.prepare('INSERT INTO files_meta(id,name,path,size,updated_at) VALUES (?,?,?,?,?)').run(id, name, diskName, buf.length, t);
    return reply.code(201).send({ id, name, size: buf.length, updated_at: t });
  });
  app.get<{ Params: { id: string } }>('/api/files/:id', async (req, reply) => {
    const row = db.prepare('SELECT * FROM files_meta WHERE id=?').get(req.params.id) as
      | { path: string; name: string }
      | undefined;
    if (row === undefined) return reply.code(404).send({ error: 'not found' });
    const data = await readFile(join(FILES_DIR, basename(row.path))).catch(() => null);
    if (data === null) return reply.code(410).send({ error: 'blob missing' });
    return reply.header('content-disposition', `attachment; filename="${row.name}"`).send(data);
  });
  const TEXT_EXT = new Set(['txt', 'md', 'json', 'log', 'csv', 'ts', 'js', 'tsx', 'py', 'sh', 'yaml', 'yml', 'toml', 'ini', 'conf']);
  app.get<{ Params: { id: string } }>('/api/files/:id/preview', async (req, reply) => {
    const row = db.prepare('SELECT * FROM files_meta WHERE id=?').get(req.params.id) as
      | { path: string; name: string; size: number }
      | undefined;
    if (row === undefined) return reply.code(404).send({ error: 'not found' });
    const ext = row.name.split('.').pop()?.toLowerCase() ?? '';
    const data = await readFile(join(FILES_DIR, basename(row.path))).catch(() => null);
    if (data === null) return reply.code(410).send({ error: 'blob missing' });
    const head = data.subarray(0, 512);
    if (!TEXT_EXT.has(ext) && head.includes(0)) {
      return reply.code(415).send({ error: 'not previewable' });
    }
    const text = data.subarray(0, 8192).toString('utf8');
    return { name: row.name, size: row.size, truncated: data.length > 8192, text };
  });
  app.delete<{ Params: { id: string } }>('/api/files/:id', async (req, reply) => {
    const row = db.prepare('SELECT * FROM files_meta WHERE id=?').get(req.params.id) as { path: string } | undefined;
    if (row === undefined) return reply.code(404).send({ error: 'not found' });
    await rm(join(FILES_DIR, basename(row.path)), { force: true });
    db.prepare('DELETE FROM files_meta WHERE id=?').run(req.params.id);
    return { ok: true };
  });
}
