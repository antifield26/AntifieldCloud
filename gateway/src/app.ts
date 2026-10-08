import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { registerAiRoutes } from './routes/ai.js';
import { registerAuthRoutes, isOpen, cookieId } from './routes/auth.js';
import { validSession } from './auth/password.js';
import { AuditBuffer, normalizePath } from './sys/apiaudit.js';
import { registerSysRoutes } from './routes/sys.js';
import { registerServiceRoutes } from './routes/services.js';
import { registerEfficiencyRoutes } from './routes/efficiency.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerPortalRoutes } from './routes/portal.js';
import { startScheduler } from './jobs/scheduler.js';
import { startWatchdog } from './sys/watchdog.js';
import { createAdapter } from './opencode/adapter.js';
import { openDb } from './db.js';
import { Sampler } from './sys/metrics.js';
import fastifyCookie from '@fastify/cookie';

export interface AppContext {
  app: FastifyInstance;
  sampler: Sampler;
  dbPath: string;
}

export async function buildApp(opts?: { dbPath?: string; startSampler?: boolean; startSched?: boolean }): Promise<AppContext> {
  const dbPath = opts?.dbPath ?? process.env.WB_DB_PATH ?? '/var/lib/workbench/wb.db';
  const app = Fastify({ logger: false });
  app.get('/health', async () => ({ ok: true, service: 'workbench-gateway', version: '0.1.0' }));
  const SPA_DIR = process.env.WB_SPA_DIR ?? '/opt/workbench/web/dist';
  const hasSpa = existsSync(join(SPA_DIR, 'index.html'));
  if (!hasSpa) {
    app.get('/', async (_req, reply) => {
      return reply
        .type('text/html')
        .send(`<html><head><title>AntifieldCloud</title></head><body><h1>AntifieldCloud P0</h1><p>Gateway OK. SPA in P1.</p><p><a href="/health">/health</a></p></body></html>`);
    });
  }
  // 认证钩子只作用于其后注册的路由；AI/系统等业务路由必须挂在钩子之后。
  const db = openDb(dbPath);
  await app.register(fastifyCookie);
  registerAuthRoutes(app, db);
  const auditBuf = new AuditBuffer(db, Number(process.env.WB_AUDIT_FLUSH_MS ?? 60000));
  auditBuf.start();
  app.addHook('onRequest', async (req, reply) => {
    (req as unknown as { startTime: number }).startTime = Date.now();
    if (!isOpen(req.url) && !validSession(db, cookieId(req.headers.cookie))) {
      return reply.code(401).send({ error: 'login required' });
    }
    return undefined;
  });
  // 审计记在 onResponse（onRequest 拒掉的 401 也会走到这里，actor=anon，不重复）。
  app.addHook('onResponse', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const start = (req as unknown as { startTime?: number }).startTime ?? Date.now();
    const sid = cookieId(req.headers.cookie);
    auditBuf.push({
      ts: Date.now(),
      actor: validSession(db, sid) ? `ses:${(sid ?? '').slice(0, 8)}` : 'anon',
      method: req.method,
      path: normalizePath(req.url),
      status: reply.statusCode,
      ms: Date.now() - start,
    });
  });
  registerAiRoutes(app);
  const sampler = new Sampler(db);
  if (opts?.startSampler !== false) sampler.start();
  registerSysRoutes(app, db, sampler);
  registerServiceRoutes(app, db);
  registerEfficiencyRoutes(app, db);
  registerJobRoutes(app, db);
  registerPortalRoutes(app);
  if (hasSpa) {
    await app.register(fastifyStatic, { root: SPA_DIR });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url === '/health') {
        reply.code(404).send({ error: 'not found' });
        return;
      }
      reply.sendFile('index.html');
    });
  }
  if (opts?.startSched !== false) {
    const adapter = () =>
      createAdapter({
        baseUrl: process.env.OPENCODE_BASE_URL ?? 'http://127.0.0.1:4096',
        username: process.env.OPENCODE_SERVER_USERNAME ?? 'opencode',
        password: process.env.OPENCODE_SERVER_PASSWORD ?? '',
      });
    startScheduler(db, adapter);
    startWatchdog(db, () => sampler.latest());
  }
  return { app, sampler, dbPath };
}
