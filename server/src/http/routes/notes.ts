/**
 * 笔记与书签 HTTP 路由：CRUD、置顶、标签列表、搜索与分页。
 *
 * 安全边界：全部端点需要登录会话；写操作额外校验 CSRF。
 * 输入校验与错误码由 notes 领域服务统一负责，路由只做参数解析。
 */
import type { FastifyInstance } from 'fastify'
import type { Config } from '../../config.ts'
import {
  BookmarkService,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  NoteService,
  parseOptionalPinned,
  type ListQuery,
} from '../../notes/service.ts'
import { asRecord, actorFrom, parsePositiveInt } from '../util.ts'
import { csrfGuard, requireAuth } from '../guards.ts'

function listQuery(query: Record<string, unknown>): ListQuery {
  return {
    q: typeof query.q === 'string' ? query.q : null,
    tag: typeof query.tag === 'string' ? query.tag : null,
    pinned: parseOptionalPinned(query.pinned),
    page: parsePositiveInt(query.page, 1, 1, 100_000),
    pageSize: parsePositiveInt(query.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
  }
}

export function registerNoteRoutes(
  app: FastifyInstance,
  config: Config,
  notes: NoteService,
  bookmarks: BookmarkService,
): void {
  const csrf = csrfGuard(config)

  // ---------- 笔记 ----------

  app.get('/api/notes', { preHandler: [requireAuth] }, async (request) => {
    return notes.list(listQuery(asRecord(request.query)))
  })

  app.get('/api/notes/tags', { preHandler: [requireAuth] }, async () => {
    return notes.listTags()
  })

  app.post('/api/notes', { preHandler: [requireAuth, csrf] }, async (request, reply) => {
    const body = asRecord(request.body)
    const item = notes.create(actorFrom(request), body)
    reply.code(201)
    return item
  })

  app.get('/api/notes/:id', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as { id: string }
    return notes.get(params.id)
  })

  app.patch('/api/notes/:id', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as { id: string }
    return notes.update(actorFrom(request), params.id, asRecord(request.body))
  })

  app.delete('/api/notes/:id', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as { id: string }
    return notes.remove(actorFrom(request), params.id)
  })

  // ---------- 书签 ----------

  app.get('/api/bookmarks', { preHandler: [requireAuth] }, async (request) => {
    return bookmarks.list(listQuery(asRecord(request.query)))
  })

  app.get('/api/bookmarks/tags', { preHandler: [requireAuth] }, async () => {
    return bookmarks.listTags()
  })

  app.post('/api/bookmarks', { preHandler: [requireAuth, csrf] }, async (request, reply) => {
    const body = asRecord(request.body)
    const item = bookmarks.create(actorFrom(request), body)
    reply.code(201)
    return item
  })

  app.get('/api/bookmarks/:id', { preHandler: [requireAuth] }, async (request) => {
    const params = request.params as { id: string }
    return bookmarks.get(params.id)
  })

  app.patch('/api/bookmarks/:id', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as { id: string }
    return bookmarks.update(actorFrom(request), params.id, asRecord(request.body))
  })

  app.delete('/api/bookmarks/:id', { preHandler: [requireAuth, csrf] }, async (request) => {
    const params = request.params as { id: string }
    return bookmarks.remove(actorFrom(request), params.id)
  })
}
