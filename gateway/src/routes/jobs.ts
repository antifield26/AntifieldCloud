import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { matchCron, validateJob, triggerRun, type JobRow } from '../jobs/scheduler.js';
import { createAdapter } from '../opencode/adapter.js';

const BASE_URL = process.env.OPENCODE_BASE_URL ?? 'http://127.0.0.1:4096';
const USERNAME = process.env.OPENCODE_SERVER_USERNAME ?? 'opencode';
const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD ?? '';

const now = (): string => new Date().toISOString();

export function registerJobRoutes(app: FastifyInstance, db: DatabaseSync): void {
  const adapter = () => createAdapter({ baseUrl: BASE_URL, username: USERNAME, password: PASSWORD });

  app.get('/api/jobs', async () => db.prepare('SELECT * FROM jobs ORDER BY name').all());

  app.post<{ Body: { name?: unknown; cron?: unknown; kind?: unknown; payload?: unknown; enabled?: unknown } }>(
    '/api/jobs',
    async (req, reply) => {
      const name = typeof req.body?.name === 'string' && req.body.name.trim() !== '' ? req.body.name.trim() : null;
      if (name === null) return reply.code(400).send({ error: 'invalid name' });
      const cron = typeof req.body?.cron === 'string' ? req.body.cron.trim() : '';
      if (cron !== '' && !/^[*\d/, -]+$/.test(cron)) return reply.code(400).send({ error: 'invalid cron' });
      const kind = typeof req.body?.kind === 'string' ? req.body.kind : '';
      let payload: string;
      try {
        payload = validateJob(kind, req.body?.payload);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      const id = randomUUID();
      db.prepare('INSERT INTO jobs(id,name,cron,kind,payload,enabled,last_run,last_status) VALUES (?,?,?,?,?,?,?,?)').run(
        id, name, cron, kind, payload, req.body?.enabled === false ? 0 : 1, null, null,
      );
      return reply.code(201).send({ id, name, cron, kind });
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: unknown; cron?: unknown; enabled?: unknown } }>(
    '/api/jobs/:id',
    async (req, reply) => {
      const cur = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id) as JobRow | undefined;
      if (cur === undefined) return reply.code(404).send({ error: 'not found' });
      const name = req.body?.name === undefined ? cur.name : String(req.body.name);
      const cron = req.body?.cron === undefined ? cur.cron : String(req.body.cron);
      const enabled = req.body?.enabled === undefined ? cur.enabled : req.body.enabled ? 1 : 0;
      db.prepare('UPDATE jobs SET name=?,cron=?,enabled=? WHERE id=?').run(name, cron, enabled, req.params.id);
      return { id: req.params.id, name, cron, enabled };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    db.prepare('DELETE FROM job_runs WHERE job_id=?').run(req.params.id);
    const r = db.prepare('DELETE FROM jobs WHERE id=?').run(req.params.id) as unknown as { changes: number };
    if (Number(r.changes) === 0) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/run', async (req, reply) => {
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id) as JobRow | undefined;
    if (job === undefined) return reply.code(404).send({ error: 'not found' });
    return { runId: triggerRun(db, adapter, job) };
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id/runs', async (req) => {
    return db.prepare('SELECT * FROM job_runs WHERE job_id=? ORDER BY started_at DESC LIMIT 20').all(req.params.id);
  });

  app.get('/api/jobs-due', async () => {
    const d = new Date();
    const rows = db.prepare("SELECT id,name,cron FROM jobs WHERE enabled=1 AND cron<>''").all() as Array<Record<string, unknown>>;
    const jobs: JobRow[] = rows.map((r) => ({
      id: String(r.id), name: String(r.name), cron: String(r.cron), kind: '', payload: '{}', enabled: 1,
    }));
    return { now: now(), due: jobs.filter((j) => matchCron(j.cron, d)).map((j) => j.id) };
  });
}
