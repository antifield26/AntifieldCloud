/** 二期模块测试夹具：完整 Config、临时目录/DB、带 Cookie/CSRF/错误处理的迷你 Fastify 应用。 */
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../src/config.ts'
import type { AuthContext, SessionRow } from '../src/types.ts'
import { registerErrorHandler } from '../src/http/errors.ts'
import { FileService } from '../src/files/service.ts'
import { sha256Hex } from '../src/util/ids.ts'
import { cleanupDir, tempDataDir, testConfig, testDb } from './helpers.ts'

export const SESSION_COOKIE = 'af_session'
export const TEST_SESSION_TOKEN = 'phase2-session-token'
export const TEST_CSRF_TOKEN = 'phase2-csrf-token'

const TEST_SESSION: SessionRow = {
  id: 'phase2-session',
  user_id: 'phase2-user',
  token_hash: sha256Hex(TEST_SESSION_TOKEN),
  csrf_hash: sha256Hex(TEST_CSRF_TOKEN),
  created_at: '2026-01-01T00:00:00.000Z',
  expires_at: '2999-01-01T00:00:00.000Z',
  last_seen_at: '2026-01-01T00:00:00.000Z',
  ip: '127.0.0.1',
  user_agent: 'test',
}

export interface Phase2Fixture {
  dir: string
  config: Config
  db: DatabaseSync
  files: FileService
  close: () => void
}

export function phase2Fixture(overrides: Partial<Config> = {}): Phase2Fixture {
  const dir = tempDataDir()
  const config = testConfig(dir, overrides)
  const db = testDb(dir)
  const files = new FileService(db, config)
  return {
    dir,
    config,
    db,
    files,
    close: () => {
      db.close()
      cleanupDir(dir)
    },
  }
}

/** 带登录态注入的迷你应用：仅测试本模块路由，不依赖 app.ts 的集成进度。 */
export async function createAuthedApp(
  db: DatabaseSync,
  register: (app: FastifyInstance) => void,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, exposeHeadRoutes: true })
  await app.register(cookie)
  app.addHook('onRequest', async (request) => {
    if (request.cookies?.[SESSION_COOKIE] === TEST_SESSION_TOKEN) {
      const context: AuthContext = { user: { id: 'phase2-user', username: 'admin' }, session: TEST_SESSION }
      request.auth = context
    }
  })
  register(app)
  registerErrorHandler(app)
  return app
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${TEST_SESSION_TOKEN}`, 'x-csrf-token': TEST_CSRF_TOKEN, ...extra }
}

export function csrfHeadersOnly(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${TEST_SESSION_TOKEN}`, ...extra }
}

export async function uploadFile(
  files: FileService,
  name: string,
  content: Buffer | string,
  actor: { username: string; ip: string | null } = { username: 'admin', ip: '127.0.0.1' },
) {
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  const tempPath = files.storage.tempPath()
  writeFileSync(tempPath, buffer)
  return files.registerUpload(actor, {
    parentId: null,
    rawName: name,
    tempPath,
    size: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  })
}

export function parseSetCookies(header: string | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header]
  for (const raw of lines) {
    const first = raw.split(';')[0] ?? ''
    const eq = first.indexOf('=')
    if (eq > 0) out[first.slice(0, eq)] = first.slice(eq + 1)
  }
  return out
}

export function fullSetCookie(header: string | string[] | undefined): string {
  return header === undefined ? '' : Array.isArray(header) ? header.join('\n') : header
}

export function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ')
}
