// 全局搜索：todos/notes/bookmarks/files_meta，LIKE 实现（千条级够用，不引入 FTS）。
// 通配符转义，单类 LIMIT 20。
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';

export interface Hit {
  kind: 'todo' | 'note' | 'bookmark' | 'file';
  id: string;
  title: string;
  snippet: string;
  jump: string;
}

const escLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function snippetOf(text: string, q: string, len = 60): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.slice(0, len);
  const a = Math.max(0, i - 20);
  return (a > 0 ? '…' : '') + text.slice(a, a + len);
}

export function registerSearchRoutes(app: FastifyInstance, db: DatabaseSync): void {
  app.get<{ Querystring: { q?: string } }>('/api/search', async (req, reply) => {
    const q = (req.query.q ?? '').trim().slice(0, 100);
    if (q === '') return reply.code(400).send({ error: 'empty q' });
    const like = `%${escLike(q)}%`;
    const hits: Hit[] = [];
    const t0 = Date.now();
    for (const r of db
      .prepare("SELECT id,title FROM todos WHERE title LIKE ? ESCAPE '\\' LIMIT 20")
      .all(like) as Array<{ id: string; title: string }>) {
      hits.push({ kind: 'todo', id: r.id, title: r.title, snippet: snippetOf(r.title, q), jump: '#eff' });
    }
    for (const r of db
      .prepare("SELECT id,title,body FROM notes WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' LIMIT 20")
      .all(like, like) as Array<{ id: string; title: string; body: string }>) {
      hits.push({ kind: 'note', id: r.id, title: r.title, snippet: snippetOf(`${r.title} ${r.body}`, q), jump: '#eff' });
    }
    for (const r of db
      .prepare("SELECT id,title,url FROM bookmarks WHERE title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' LIMIT 20")
      .all(like, like) as Array<{ id: string; title: string; url: string }>) {
      hits.push({ kind: 'bookmark', id: r.id, title: r.title, snippet: r.url.slice(0, 80), jump: '#eff' });
    }
    for (const r of db
      .prepare("SELECT id,name FROM files_meta WHERE name LIKE ? ESCAPE '\\' LIMIT 20")
      .all(like) as Array<{ id: string; name: string }>) {
      hits.push({ kind: 'file', id: r.id, title: r.name, snippet: r.name, jump: '#eff' });
    }
    return { q, ms: Date.now() - t0, hits };
  });
}
