// 自托管服务门户：纯配置驱动，读 portal.json 即增卡，无需改代码。
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

export interface PortalService {
  id: string;
  title: string;
  href: string;
  note: string;
}

const portalPath = (): string => process.env.WB_PORTAL_PATH ?? '/opt/workbench/config/portal.json';

export function parsePortal(raw: string): PortalService[] {
  const json = JSON.parse(raw) as { services?: unknown };
  if (!Array.isArray(json.services)) throw new Error('portal.json: services[] missing');
  return json.services.map((s) => {
    const r = s as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.title !== 'string' || typeof r.href !== 'string') {
      throw new Error('portal.json: bad service entry');
    }
    if (!r.href.startsWith('/')) throw new Error('portal.json: href must be same-origin');
    return { id: r.id, title: r.title, href: r.href, note: typeof r.note === 'string' ? r.note : '' };
  });
}

export function registerPortalRoutes(app: FastifyInstance): void {
  app.get('/api/portal/services', async (_req, reply) => {
    try {
      return { services: parsePortal(await readFile(portalPath(), 'utf8')) };
    } catch (err) {
      return reply.code(500).send({ error: `portal config: ${(err as Error).message}` });
    }
  });
}
