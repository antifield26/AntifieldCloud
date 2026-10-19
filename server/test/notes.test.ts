/** 笔记/书签模块测试：CRUD、标签、置顶、FTS5 搜索、输入约束、XSS 输入与 HTTP 路由。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { AppError } from '../src/util/errors.ts'
import { BookmarkService, NoteService, ftsExpression, normalizeTags, validateBookmarkUrl } from '../src/notes/service.ts'
import { registerNoteRoutes } from '../src/http/routes/notes.ts'
import { authHeaders, createAuthedApp, csrfHeadersOnly, phase2Fixture } from './phase2-fixtures.ts'

const ACTOR = { username: 'admin', ip: '127.0.0.1' }

function expectAppError(fn: () => unknown, status: number, code: string): void {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof AppError, `应抛出 AppError，实际为 ${String(error)}`)
    assert.equal(error.statusCode, status)
    assert.equal(error.code, code)
    return
  }
  assert.fail('预期抛出 AppError，但没有抛错')
}

test('笔记 CRUD、标签、置顶排序与分页', () => {
  const fx = phase2Fixture()
  try {
    const notes = new NoteService(fx.db)
    const first = notes.create(ACTOR, {
      title: '第一条笔记',
      bodyMd: '# 你好',
      tags: ['工作', '阅读', ' 工作 '],
      pinned: true,
    })
    assert.equal(first.title, '第一条笔记')
    assert.deepEqual(first.tags.sort(), ['工作', '阅读'].sort())
    assert.equal(first.pinned, true)

    const second = notes.create(ACTOR, { title: '第二条', bodyMd: '正文', tags: ['阅读'] })
    assert.equal(second.pinned, false)

    const list = notes.list({ page: 1, pageSize: 10 })
    assert.equal(list.total, 2)
    assert.equal(list.items[0]?.id, first.id, '置顶笔记应排在最前')
    assert.equal(list.pageSize, 10)

    const paged = notes.list({ page: 2, pageSize: 1 })
    assert.equal(paged.items.length, 1)
    assert.equal(paged.total, 2)

    const updated = notes.update(ACTOR, second.id, { title: '第二条（改）', bodyMd: '新正文', tags: ['生活'] })
    assert.equal(updated.title, '第二条（改）')
    assert.equal(updated.bodyMd, '新正文')
    assert.deepEqual(updated.tags, ['生活'])

    const byTag = notes.list({ tag: '阅读' })
    assert.equal(byTag.total, 1)
    assert.equal(byTag.items[0]?.id, first.id)
    assert.equal(notes.list({ pinned: true }).total, 1)
    assert.equal(notes.list({ tag: '不存在' }).total, 0)

    const tags = notes.listTags()
    assert.deepEqual(
      tags.items.map((item) => item.name).sort(),
      ['工作', '生活', '阅读'].sort(),
    )
    assert.ok(tags.items.every((item) => item.count === 1))

    notes.remove(ACTOR, first.id)
    expectAppError(() => notes.get(first.id), 404, 'not_found')
    assert.equal(notes.list().total, 1)

    const actions = fx.db
      .prepare('SELECT action FROM audit_log ORDER BY id ASC')
      .all() as unknown as { action: string }[]
    assert.deepEqual(
      actions.map((row) => row.action),
      ['note_create', 'note_create', 'note_update', 'note_delete'],
    )
  } finally {
    fx.close()
  }
})

test('FTS5 英文搜索、特殊字符回退与中文 LIKE 搜索', () => {
  const fx = phase2Fixture()
  try {
    const notes = new NoteService(fx.db)
    const alpha = notes.create(ACTOR, { title: 'Alpha Project', bodyMd: 'notes about deployment pipeline' })
    notes.create(ACTOR, { title: 'Beta', bodyMd: 'nothing related here' })
    const chinese = notes.create(ACTOR, { title: '中文笔记', bodyMd: '今天天气很好，适合散步' })

    assert.equal(notes.list({ q: 'alpha' }).total, 1)
    assert.equal(notes.list({ q: 'alpha' }).items[0]?.id, alpha.id)
    assert.equal(notes.list({ q: 'deploy' }).total, 1, 'FTS 前缀匹配应命中 deployment')
    assert.equal(notes.list({ q: '项目' }).total, 0)

    // FTS 语法字符不会被拼进 MATCH 语句（提取词元后按短语查询）。
    assert.equal(notes.list({ q: 'alpha"*' }).total, 1)
    assert.equal(notes.list({ q: '@@%%__' }).total, 0)

    // 更新正文后 FTS 索引同步（migration 2 的触发器）。
    notes.update(ACTOR, alpha.id, { bodyMd: 'completely different words' })
    assert.equal(notes.list({ q: 'deployment' }).total, 0)
    assert.equal(notes.list({ q: 'different' }).total, 1)

    // 中文按 LIKE 回退搜索（unicode61 分词不适合中文子串）。
    assert.equal(notes.list({ q: '天气' }).total, 1)
    assert.equal(notes.list({ q: '天气' }).items[0]?.id, chinese.id)

    // 搜索 + 标签组合。
    notes.update(ACTOR, chinese.id, { tags: ['中文'] })
    assert.equal(notes.list({ q: '天气', tag: '中文' }).total, 1)
    assert.equal(notes.list({ q: '天气', tag: '其它' }).total, 0)

    assert.equal(ftsExpression('alpha beta'), '"alpha"* "beta"*')
    assert.equal(ftsExpression('「」@@'), null)
  } finally {
    fx.close()
  }
})

test('笔记输入约束与 XSS 输入原样存储', () => {
  const fx = phase2Fixture()
  try {
    const notes = new NoteService(fx.db)
    expectAppError(() => notes.create(ACTOR, { title: 'x'.repeat(201) }), 400, 'invalid_request')
    expectAppError(() => notes.create(ACTOR, { title: 't', bodyMd: 'x'.repeat(200 * 1024 + 1) }), 400, 'note_too_large')
    expectAppError(() => notes.create(ACTOR, { title: 't', tags: 'not-array' }), 400, 'invalid_tags')
    expectAppError(() => notes.create(ACTOR, { title: 't', tags: ['x'.repeat(33)] }), 400, 'invalid_tags')
    expectAppError(
      () => notes.create(ACTOR, { title: 't', tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`) }),
      400,
      'invalid_tags',
    )
    expectAppError(() => notes.create(ACTOR, { title: 't', pinned: 'maybe' }), 400, 'invalid_request')

    // 标题为空时使用默认标题；正文允许 200KB 边界。
    const untitled = notes.create(ACTOR, { title: '   ' })
    assert.equal(untitled.title, '无标题')
    const maxBody = notes.create(ACTOR, { title: '边界', bodyMd: 'a'.repeat(200 * 1024) })
    assert.equal(Buffer.byteLength(maxBody.bodyMd, 'utf8'), 200 * 1024)

    // XSS 输入原样存储为字符串（转义由前端负责），API 不返回 HTML。
    const xssTitle = '<script>alert("x")</script>'
    const xssBody = '<img src=x onerror=alert(1)>'
    const xss = notes.create(ACTOR, { title: xssTitle, bodyMd: xssBody })
    assert.equal(xss.title, xssTitle)
    assert.equal(xss.bodyMd, xssBody)

    // 标签 NFC 与大小写去重。
    assert.deepEqual(normalizeTags([' Work ', 'work', 'WORK', '']), ['Work'])
  } finally {
    fx.close()
  }
})

test('书签 CRUD、URL 协议限制、搜索与标签过滤', () => {
  const fx = phase2Fixture()
  try {
    const bookmarks = new BookmarkService(fx.db)
    const first = bookmarks.create(ACTOR, {
      url: 'https://example.com/docs/alpha',
      title: 'Alpha 文档',
      description: '部署说明与运维手册',
      tags: ['docs'],
      pinned: true,
    })
    assert.equal(first.url, 'https://example.com/docs/alpha')
    assert.deepEqual(first.tags, ['docs'])

    const fallback = bookmarks.create(ACTOR, { url: 'http://example.org/path' })
    assert.equal(fallback.title, 'example.org')

    assert.equal(bookmarks.list({ q: 'alpha' }).total, 1)
    assert.equal(bookmarks.list({ q: '运维' }).total, 1)
    assert.equal(bookmarks.list({ tag: 'docs' }).total, 1)
    assert.equal(bookmarks.list({ pinned: true }).total, 1)
    assert.equal(bookmarks.list().items[0]?.id, first.id, '置顶书签应排在最前')

    const updated = bookmarks.update(ACTOR, fallback.id, {
      url: 'https://example.net/next',
      description: '更新后的描述',
    })
    assert.equal(updated.url, 'https://example.net/next')
    assert.equal(updated.description, '更新后的描述')
    assert.equal(bookmarks.list({ q: 'description' }).total, 0)
    assert.equal(bookmarks.list({ q: '更新后' }).total, 1)

    assert.deepEqual(bookmarks.listTags().items, [{ name: 'docs', count: 1 }])
    bookmarks.remove(ACTOR, first.id)
    expectAppError(() => bookmarks.get(first.id), 404, 'not_found')

    // 协议白名单：拒绝可执行/数据/非 HTTP 协议。
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'ftp://example.com/a', 'not-a-url']) {
      expectAppError(() => validateBookmarkUrl(url), 400, 'invalid_url')
    }
    expectAppError(() => bookmarks.create(ACTOR, { url: 'javascript:alert(1)' }), 400, 'invalid_url')
  } finally {
    fx.close()
  }
})

test('笔记/书签 HTTP 路由：认证、CSRF、状态码与响应形状', async () => {
  const fx = phase2Fixture()
  const notes = new NoteService(fx.db)
  const bookmarks = new BookmarkService(fx.db)
  const app = await createAuthedApp(fx.db, (instance) => {
    registerNoteRoutes(instance, fx.config, notes, bookmarks)
  })
  try {
    const anonymous = await app.inject({ method: 'GET', url: '/api/notes' })
    assert.equal(anonymous.statusCode, 401)
    assert.equal(anonymous.json().error.code, 'unauthenticated')

    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/notes',
      headers: csrfHeadersOnly(),
      payload: { title: '无 CSRF' },
    })
    assert.equal(noCsrf.statusCode, 403)
    assert.equal(noCsrf.json().error.code, 'csrf_failed')

    const created = await app.inject({
      method: 'POST',
      url: '/api/notes',
      headers: authHeaders(),
      payload: { title: 'HTTP 笔记', bodyMd: '# hi', tags: ['a'], pinned: true },
    })
    assert.equal(created.statusCode, 201)
    const note = created.json() as { id: string; title: string; tags: string[]; pinned: boolean; createdAt: string }
    assert.equal(note.title, 'HTTP 笔记')
    assert.deepEqual(note.tags, ['a'])
    assert.equal(note.pinned, true)
    assert.ok(note.createdAt)

    const list = await app.inject({ method: 'GET', url: '/api/notes?pageSize=5', headers: authHeaders() })
    assert.equal(list.statusCode, 200)
    assert.deepEqual(Object.keys(list.json()).sort(), ['items', 'page', 'pageSize', 'total'])
    assert.equal(list.json().total, 1)

    const detail = await app.inject({ method: 'GET', url: `/api/notes/${note.id}`, headers: authHeaders() })
    assert.equal(detail.statusCode, 200)
    assert.equal(detail.json().bodyMd, '# hi')

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/notes/${note.id}`,
      headers: authHeaders(),
      payload: { pinned: false },
    })
    assert.equal(patched.statusCode, 200)
    assert.equal(patched.json().pinned, false)

    const tags = await app.inject({ method: 'GET', url: '/api/notes/tags', headers: authHeaders() })
    assert.equal(tags.statusCode, 200)
    assert.deepEqual(tags.json().items, [{ name: 'a', count: 1 }])

    const tooLong = await app.inject({
      method: 'POST',
      url: '/api/notes',
      headers: authHeaders(),
      payload: { title: 'x'.repeat(201) },
    })
    assert.equal(tooLong.statusCode, 400)
    assert.equal(tooLong.json().error.code, 'invalid_request')

    const missing = await app.inject({ method: 'GET', url: '/api/notes/not-exist', headers: authHeaders() })
    assert.equal(missing.statusCode, 404)

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/notes/${note.id}`,
      headers: authHeaders(),
    })
    assert.equal(deleted.statusCode, 200)
    assert.deepEqual(deleted.json(), { ok: true, id: note.id })

    // 书签路由同样需要认证/CSRF，并拒绝非法 URL。
    const bookmarkNoAuth = await app.inject({ method: 'GET', url: '/api/bookmarks' })
    assert.equal(bookmarkNoAuth.statusCode, 401)
    const badBookmark = await app.inject({
      method: 'POST',
      url: '/api/bookmarks',
      headers: authHeaders(),
      payload: { url: 'javascript:alert(1)' },
    })
    assert.equal(badBookmark.statusCode, 400)
    assert.equal(badBookmark.json().error.code, 'invalid_url')
    const bookmark = await app.inject({
      method: 'POST',
      url: '/api/bookmarks',
      headers: authHeaders(),
      payload: { url: 'https://example.com/', title: '示例', tags: ['site'] },
    })
    assert.equal(bookmark.statusCode, 201)
    assert.equal(bookmark.json().title, '示例')
    const bookmarkTags = await app.inject({ method: 'GET', url: '/api/bookmarks/tags', headers: authHeaders() })
    assert.deepEqual(bookmarkTags.json().items, [{ name: 'site', count: 1 }])
  } finally {
    await app.close()
    fx.close()
  }
})
