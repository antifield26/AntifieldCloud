import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import {
  SESSION_COOKIE, SESSION_TTL_MS, verifyPassword, isConfigured,
  newSession, validSession, destroySession, authDelayMs, authFailed, authOk,
} from '../auth/password.js';

const cookieOpts = (secure: boolean): Record<string, unknown> => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: Math.floor(SESSION_TTL_MS / 1000),
  ...(secure ? { secure: true } : {}),
});

export function registerAuthRoutes(app: FastifyInstance, db: DatabaseSync): void {
  app.get('/api/auth/status', async (req) => {
    const sid = cookieId(req.headers.cookie);
    return { configured: isConfigured(), authenticated: validSession(db, sid) };
  });

  app.post<{ Body: { password?: unknown } }>('/api/auth/login', async (req, reply) => {
    const wait = authDelayMs();
    if (wait < 0) return reply.code(429).send({ error: 'locked, try later' });
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const ok = isConfigured() && verifyPassword(req.body?.password);
    if (!ok) {
      authFailed();
      return reply.code(401).send({ error: 'bad password' });
    }
    authOk();
    const s = newSession(db);
    const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol;
    return reply
      .setCookie(SESSION_COOKIE, s.id, cookieOpts(proto === 'https'))
      .send({ ok: true });
  });

  app.post('/api/auth/logout', async (req, reply) => {
    destroySession(db, cookieId(req.headers.cookie) ?? '');
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ ok: true });
  });
}

export function cookieId(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE) return rest.join('=');
  }
  return undefined;
}

/** 登录守卫：白名单直行，其余 /api/* 必须有效会话。 */
export function isOpen(url: string): boolean {
  if (!url.startsWith('/api/')) return true;
  const open = new Set(['/api/auth/status', '/api/auth/login']);
  return open.has(url.split('?')[0]);
}
