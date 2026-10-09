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

  app.post<{ Body: { title?: string; model?: { providerID: string; modelID: string }; agent?: string } }>('/api/ai/sessions', async (req, reply) => {
    try {
      return await adapter().createSession(req.body?.title, req.body?.model, req.body?.agent);
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

  app.delete<{ Params: { id: string } }>('/api/ai/sessions/:id', async (req, reply) => {
    try {
      const ok = await adapter().deleteSession(req.params.id);
      return { ok };
    } catch (err) {
      return reply.code(502).send({ error: 'opencode unreachable', detail: String(err) });
    }
  });

  app.post<{ Params: { id: string } }>('/api/ai/sessions/:id/abort', async (req, reply) => {
    try {
      const ok = await adapter().abortSession(req.params.id);
      return { ok };
    } catch (err) {
      return reply.code(502).send({ error: 'opencode unreachable', detail: String(err) });
    }
  });

  app.get('/api/ai/models', async (_req, reply) => {
    try {
      return await adapter().listModels();
    } catch (err) {
      return reply.code(502).send({ error: 'opencode unreachable', detail: String(err) });
    }
  });

  app.get('/api/ai/models/default', async (_req, reply) => {
    try {
      return await adapter().defaultModel();
    } catch (err) {
      return reply.code(502).send({ error: 'opencode unreachable', detail: String(err) });
    }
  });

  app.get('/api/ai/agents', async (_req, reply) => {
    try {
      return await adapter().listAgents();
    } catch (err) {
      return reply.code(502).send({ error: 'opencode unreachable', detail: String(err) });
    }
  });

  app.get('/api/ai/providers', async (_req, reply) => {
    try {
      return await adapter().listProviders();
    } catch (err) {
      return reply.code(502).send({ error: 'opencode unreachable', detail: String(err) });
    }
  });

  app.post<{ Params: { id: string }; Body: { providerID?: unknown; modelID?: unknown; variant?: unknown } }>(
    '/api/ai/sessions/:id/model',
    async (req, reply) => {
      if (typeof req.body?.providerID !== 'string' || typeof req.body?.modelID !== 'string') {
        return reply.code(400).send({ error: 'invalid model' });
      }
      const variant = typeof req.body?.variant === 'string' ? req.body.variant : undefined;
      try {
        return await adapter().setSessionModel(req.params.id, { providerID: req.body.providerID, modelID: req.body.modelID, variant });
      } catch (err) {
        return reply.code(502).send({ error: 'opencode unreachable', detail: String(err) });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { agent?: unknown } }>('/api/ai/sessions/:id/agent', async (req, reply) => {
    if (typeof req.body?.agent !== 'string' || req.body.agent === '') {
      return reply.code(400).send({ error: 'invalid agent' });
    }
    try {
      return await adapter().setSessionAgent(req.params.id, req.body.agent);
    } catch (err) {
      return reply.code(502).send({ error: 'opencode unreachable', detail: String(err) });
    }
  });

  app.get<{ Params: { id: string } }>('/api/ai/sessions/:id/permissions', async (req, reply) => {
    try {
      return await adapter().listPermissions(req.params.id);
    } catch (err) {
      return reply.code(502).send({ error: 'opencode unreachable', detail: String(err) });
    }
  });

  app.post<{ Params: { id: string; rid: string }; Body: { response?: unknown } }>(
    '/api/ai/sessions/:id/permissions/:rid/reply',
    async (req, reply) => {
      if (req.body?.response !== 'allow' && req.body?.response !== 'deny') {
        return reply.code(400).send({ error: 'response must be allow|deny' });
      }
      try {
        return await adapter().replyPermission(req.params.id, req.params.rid, req.body.response);
      } catch (err) {
        return reply.code(502).send({ error: 'opencode unreachable', detail: String(err) });
      }
    },
  );

  // SSE 透传：浏览器 EventSource 直连网关，网关过滤后转发本会话事件。
  app.get<{ Params: { id: string } }>('/api/ai/sessions/:id/events', async (req, reply) => {
    const sid = req.params.id;
    if (!/^ses_[A-Za-z0-9]+$/.test(sid)) {
      return reply.code(400).send({ error: 'invalid session id' });
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    let cancel: () => void = () => undefined;
    let closed = false;
    req.raw.on('close', () => {
      closed = true;
      cancel();
    });
    const hb = setInterval(() => {
      if (closed) {
        clearInterval(hb);
        return;
      }
      reply.raw.write(': heartbeat\n\n');
    }, 25000);
    if ((hb as unknown as { unref?: () => void }).unref !== undefined) {
      (hb as unknown as { unref: () => void }).unref();
    }
    try {
      cancel = await adapter().subscribe(sid, (ev) => {
        if (closed) return;
        reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
      });
    } catch (err) {
      clearInterval(hb);
      if (!closed) reply.raw.write(`data: ${JSON.stringify({ type: 'gateway.error', message: String(err) })}\n\n`);
      reply.raw.end();
    }
  });
}
