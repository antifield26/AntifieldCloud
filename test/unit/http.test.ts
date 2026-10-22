import assert from 'node:assert/strict'
import test from 'node:test'
import { HttpApi } from '../../src/http/server.ts'
import type { ChatSender } from '../../src/minecraft/chat.ts'
import { createLogger } from '../../src/logger.ts'
import { makeConfig, makeState } from '../helpers.ts'

const token = '0123456789abcdef0123456789abcdef'

test('HTTP API enforces auth and /say rules', async () => {
  let connected = false
  const sent: string[] = []
  const chatSender = {
    isConnected: () => connected,
    say: async (text: string) => {
      sent.push(text)
      return [text]
    }
  } as unknown as ChatSender
  const config = makeConfig({ httpPort: 0, httpHost: '127.0.0.1' })
  const state = makeState(config)
  const api = new HttpApi({ config, logger: createLogger('error'), state, chatSender })
  const port = await api.start()
  const base = `http://127.0.0.1:${port}`
  const headers = { Authorization: `Bearer ${token}` }
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200)
    assert.equal((await fetch(`${base}/status`)).status, 401)
    assert.equal((await fetch(`${base}/status`, { headers })).status, 200)
    assert.equal((await fetch(`${base}/say`, { method: 'POST', headers, body: JSON.stringify({ message: 'hi' }) })).status, 409)

    connected = true
    const ok = await fetch(`${base}/say`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' })
    })
    assert.equal(ok.status, 200)
    assert.deepEqual(await ok.json(), { ok: true, lines: 1 })
    assert.deepEqual(sent, ['hello'])

    const slash = await fetch(`${base}/say`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '/op Antifield' })
    })
    assert.equal(slash.status, 400)

    const empty = await fetch(`${base}/say`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '' })
    })
    assert.equal(empty.status, 400)

    const long = await fetch(`${base}/say`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'x'.repeat(9000) })
    })
    assert.equal(long.status, 413)

    assert.equal((await fetch(`${base}/say`, { headers })).status, 405)
    assert.equal((await fetch(`${base}/nope`)).status, 404)
  } finally {
    await api.stop()
  }
})
