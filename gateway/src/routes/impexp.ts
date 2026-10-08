// 导入导出：JSON 四类 + CSV（todos/notes）；导入合并/替换；字段校验；大 body 限长。
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';

const DAY = (): string => new Date().toISOString().slice(0, 10).replace(/-/g, '');

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function asArr(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) throw Object.assign(new Error('expected array'), { statusCode: 400 });
  return v as Array<Record<string, unknown>>;
}

function str(r: Record<string, unknown>, k: string, max: number, required: boolean): string | null {
  const v = r[k];
  if (v === undefined || v === null) {
    if (required) throw Object.assign(new Error(`missing ${k}`), { statusCode: 400 });
    return null;
  }
  if (typeof v !== 'string' || v.length > max) throw Object.assign(new Error(`invalid ${k}`), { statusCode: 400 });
  return v;
}

export function registerImportExport(app: FastifyInstance, db: DatabaseSync): void {
  app.get<{ Querystring: { format?: string; kind?: string } }>('/api/export', async (req, reply) => {
    const format = req.query.format ?? 'json';
    const stamp = DAY();
    if (format === 'csv') {
      const kind = req.query.kind === 'notes' ? 'notes' : 'todos';
      const rows =
        kind === 'notes'
          ? (db.prepare('SELECT id,title,body,updated_at FROM notes ORDER BY updated_at').all() as Array<Record<string, unknown>>)
          : (db.prepare('SELECT id,title,done,due_at,created_at,updated_at FROM todos ORDER BY updated_at').all() as Array<Record<string, unknown>>);
      const head = kind === 'notes' ? ['id', 'title', 'body', 'updated_at'] : ['id', 'title', 'done', 'due_at', 'created_at', 'updated_at'];
      const lines = rows.map((r) => head.map((h) => csvCell(r[h])).join(','));
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${kind}-${stamp}.csv"`)
        .send([head.join(','), ...lines].join('\n'));
    }
    if (format !== 'json') return reply.code(400).send({ error: 'format must be json|csv' });
    const data = {
      version: 1,
      exported_at: new Date().toISOString(),
      todos: db.prepare('SELECT * FROM todos ORDER BY updated_at').all(),
      notes: db.prepare('SELECT * FROM notes ORDER BY updated_at').all(),
      bookmarks: db.prepare('SELECT * FROM bookmarks ORDER BY created_at').all(),
      files_meta: db.prepare('SELECT * FROM files_meta ORDER BY updated_at').all(),
    };
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="workbench-${stamp}.json"`)
      .send(data);
  });

  app.post<{ Querystring: { mode?: string }; Body: unknown }>(
    '/api/import',
    { bodyLimit: 5 * 1024 * 1024 },
    async (req, reply) => {
      const mode = req.query.mode ?? 'merge';
      if (mode !== 'merge' && mode !== 'replace') return reply.code(400).send({ error: 'mode must be merge|replace' });
      const body = req.body as Record<string, unknown>;
      if (typeof body !== 'object' || body === null || (body as { version?: unknown }).version !== 1) {
        return reply.code(400).send({ error: 'bad export version' });
      }
      const todos = asArr(body.todos ?? []);
      const notes = asArr(body.notes ?? []);
      const bookmarks = asArr(body.bookmarks ?? []);
      const files = asArr(body.files_meta ?? []);
      // 先全量校验，再写库（单批次原子视觉）
      const T = todos.map((r) => ({
        id: str(r, 'id', 64, true) as string,
        title: str(r, 'title', 500, true) as string,
        done: r.done ? 1 : 0,
        due_at: str(r, 'due_at', 64, false),
        created_at: str(r, 'created_at', 64, false) ?? new Date().toISOString(),
        updated_at: str(r, 'updated_at', 64, false) ?? new Date().toISOString(),
      }));
      const N = notes.map((r) => ({
        id: str(r, 'id', 64, true) as string,
        title: str(r, 'title', 200, true) as string,
        body: (str(r, 'body', 100000, false) ?? '') as string,
        updated_at: str(r, 'updated_at', 64, false) ?? new Date().toISOString(),
      }));
      const B = bookmarks.map((r) => {
        const url = str(r, 'url', 2000, true) as string;
        if (!/^https?:\/\//.test(url)) throw Object.assign(new Error('bad bookmark url'), { statusCode: 400 });
        return {
          id: str(r, 'id', 64, true) as string,
          title: str(r, 'title', 200, true) as string,
          url,
          created_at: str(r, 'created_at', 64, false) ?? new Date().toISOString(),
          tags: str(r, 'tags', 400, false) ?? '',
        };
      });
      const F = files.map((r) => ({
        id: str(r, 'id', 64, true) as string,
        name: str(r, 'name', 128, true) as string,
        path: str(r, 'path', 256, true) as string,
        size: typeof r.size === 'number' ? Math.floor(r.size) : 0,
        updated_at: str(r, 'updated_at', 64, false) ?? new Date().toISOString(),
      }));
      if (mode === 'replace') {
        db.prepare('DELETE FROM todos').run();
        db.prepare('DELETE FROM notes').run();
        db.prepare('DELETE FROM bookmarks').run();
        db.prepare('DELETE FROM files_meta').run();
      }
      const put = (table: string, cols: string[], rows: Array<Record<string, unknown>>): number => {
        const stmt = db.prepare(
          `INSERT OR ${mode === 'merge' ? 'IGNORE' : 'REPLACE'} INTO ${table}(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
        );
        let n = 0;
        for (const r of rows) {
          stmt.run(...cols.map((c) => (r[c] === undefined ? null : (r[c] as string | number | null))));
          n++;
        }
        return n;
      };
      const counts = {
        todos: put('todos', ['id', 'title', 'done', 'due_at', 'created_at', 'updated_at'], T),
        notes: put('notes', ['id', 'title', 'body', 'updated_at'], N),
        bookmarks: put('bookmarks', ['id', 'title', 'url', 'created_at', 'tags'], B),
        files_meta: put('files_meta', ['id', 'name', 'path', 'size', 'updated_at'], F),
      };
      return { ok: true, mode, counts };
    },
  );
}
