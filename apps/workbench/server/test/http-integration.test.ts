import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.ts'
import { cleanupDir, currentCode, parseSetCookies, seedAdmin, tempDataDir, testConfig, testDb } from './helpers.ts'

test('HTTP 端到端：登录、multipart 上传、Range 下载、文本预览、回收站', async () => {
  const dir = tempDataDir()
  const config = testConfig(dir)
  const db = testDb(dir)
  const seeded = await seedAdmin(db)
  const context = await buildApp(config, db)
  const app = context.app
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const passwordRes = await fetch(`${base}/api/auth/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: seeded.username, password: seeded.password }),
    })
    assert.equal(passwordRes.status, 200)
    const { challenge } = (await passwordRes.json()) as { challenge: string }
    const totpRes = await fetch(`${base}/api/auth/totp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challenge, code: currentCode(seeded.secret) }),
    })
    assert.equal(totpRes.status, 200)
    const cookies = parseSetCookies(totpRes.headers.getSetCookie())
    const cookie = Object.entries(cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ')
    const csrf = cookies.af_csrf!

    const form = new FormData()
    form.append('parentId', '')
    form.append('files', new Blob([Buffer.from('hello 世界')], { type: 'text/plain' }), '你好.txt')
    const upload = await fetch(`${base}/api/files/upload`, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': csrf },
      body: form,
    })
    assert.equal(upload.status, 200)
    const uploaded = (await upload.json()) as { items: { id: string; name: string; size: number }[]; errors: unknown[] }
    assert.equal(uploaded.items.length, 1)
    assert.equal(uploaded.errors.length, 0)
    assert.equal(uploaded.items[0]?.name, '你好.txt')
    assert.equal(uploaded.items[0]?.size, 12)
    const id = uploaded.items[0]!.id

    const list = await fetch(`${base}/api/files`, { headers: { cookie } })
    const listed = (await list.json()) as { total: number }
    assert.equal(listed.total, 1)

    const range = await fetch(`${base}/api/files/${id}/content`, {
      headers: { cookie, range: 'bytes=0-4' },
    })
    assert.equal(range.status, 206)
    assert.equal(range.headers.get('content-range'), 'bytes 0-4/12')
    assert.equal(await range.text(), 'hello')

    const text = await fetch(`${base}/api/files/${id}/text`, { headers: { cookie } })
    assert.equal(text.status, 200)
    assert.equal(((await text.json()) as { content: string }).content, 'hello 世界')

    const noAuth = await fetch(`${base}/api/files/${id}/text`)
    assert.equal(noAuth.status, 401)

    const trashed = await fetch(`${base}/api/files/${id}`, {
      method: 'DELETE',
      headers: { cookie, 'x-csrf-token': csrf },
    })
    assert.equal(trashed.status, 200)
    const trash = await fetch(`${base}/api/trash`, { headers: { cookie } })
    assert.equal(((await trash.json()) as { total: number }).total, 1)
  } finally {
    await app.close()
    db.close()
    cleanupDir(dir)
  }
})
