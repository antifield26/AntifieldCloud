import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { loadWhitelist, isAllowed, serviceState, controlService, audit } from '../sys/services.js';

const WL_PATH = process.env.WB_WHITELIST_PATH ?? '/opt/workbench/config/systemd-whitelist.json';

export function registerServiceRoutes(app: FastifyInstance, db: DatabaseSync): void {
  app.get('/api/sys/services', async () => {
    const wl = await loadWhitelist(WL_PATH);
    const units = await Promise.all(
      wl.allowed.map(async (e) => ({ unit: e.unit, actions: e.actions, state: await serviceState(e.unit) })),
    );
    return { units };
  });

  app.post<{ Params: { unit: string; action: string } }>('/api/sys/services/:unit/:action', async (req, reply) => {
    const { unit, action } = req.params;
    const actor = 'local';
    let wl;
    try {
      wl = await loadWhitelist(WL_PATH);
    } catch (err) {
      return reply.code(500).send({ error: 'whitelist unreadable' });
    }
    if (!isAllowed(wl, unit, action)) {
      audit(db, { actor, unit, action, allowed: 0, reason: 'not in whitelist' });
      return reply.code(403).send({ error: 'forbidden: not in whitelist' });
    }
    if (action === 'status') {
      audit(db, { actor, unit, action, allowed: 1, reason: 'read-only' });
      return { unit, state: await serviceState(unit) };
    }
    if (action === 'restart') {
      const { code, out } = await controlService(unit, 'restart');
      audit(db, { actor, unit, action, allowed: 1, reason: code === 0 ? 'ok' : 'systemctl failed' });
      if (code !== 0) return reply.code(502).send({ error: 'systemctl restart failed' });
      // 自重启时本响应可能发不出；客户端应重连 /health 确认
      return { unit, action, ok: true, detail: out.slice(0, 500) };
    }
    audit(db, { actor, unit, action, allowed: 0, reason: 'unknown action' });
    return reply.code(403).send({ error: 'forbidden: unknown action' });
  });
}
