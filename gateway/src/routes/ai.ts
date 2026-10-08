import type { FastifyInstance } from 'fastify';
import { createAdapter } from '../opencode/adapter.js';

const BASE_URL = process.env.OPENCODE_BASE_URL ?? 'http://127.0.0.1:4096';
const USERNAME = process.env.OPENCODE_SERVER_USERNAME ?? 'opencode';
const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD ?? '';

export function registerAiRoutes(app: FastifyInstance): void {
  const adapter = () =>
    createAdapter({ baseUrl: BASE_URL, username: USERNAME, password: PASSWORD });

  app.get('/api/ai/health', async (_req, reply) => {
    try {
      return await adapter().health();
    } catch (err) {
      return reply.code(502).send({ error: 'opencode unreachable', detail: String(err) });
    }
  });

  app.get('/api/ai/sessions', async (_req, reply) => {
    try {
      return await adapter().listSessions();
    } catch (err) {
      return reply.code(502).send({ error: 'opencode unreachable', detail: String(err) });
    }
  });

  app.post<{ Body: { title?: string } }>('/api/ai/sessions', async (req, reply) => {
    try {
      return await adapter().createSession(req.body?.title);
    } catch (err) {
      return reply.code(502).send({ error: 'opencode unreachable', detail: String(err) });
    }
  });

  app.get<{ Params: { id: string } }>('/api/ai/sessions/:id/messages', async (req, reply) => {
    try {
      return await adapter().messages(req.params.id);
    } catch (err) {
      return reply.code(502).send({ error: 'opencode unreachable', detail: String(err) });
    }
  });

  app.post<{ Params: { id: string }; Body: { text?: unknown } }>('/api/ai/sessions/:id/prompt', async (req, reply) => {
    if (typeof req.body?.text !== 'string' || req.body.text.trim() === '' || req.body.text.length > 20000) {
      return reply.code(400).send({ error: 'invalid text' });
    }
    try {
      return await adapter().promptOnly(req.params.id, req.body.text);
    } catch (err) {
      return reply.code(502).send({ error: 'opencode unreachable', detail: String(err) });
    }
  });
}
