import assert from 'node:assert/strict'
import test from 'node:test'
import { AiError, OpenCodeClient } from '../../src/ai/opencode.ts'
import { createLogger } from '../../src/logger.ts'
import { makeConfig } from '../helpers.ts'

const logger = createLogger('error')

function jsonResponse (body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

test('OpenCode client sends the configured model and Basic auth', async () => {
  const config = makeConfig({ aiEnabled: true, opencodePassword: 'secret', aiTimeoutMs: 5000 })
  const captured: { value: { url: string, init?: RequestInit } | null } = { value: null }
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.value = { url: String(url), init }
    return jsonResponse({ data: { text: '你好' } })
  }) as unknown as typeof fetch
  const client = new OpenCodeClient(config, logger, fetchImpl)
  const result = await client.generate('prompt')
  assert.equal(result.text, '你好')
  assert.ok(captured.value)
  assert.equal(captured.value.url, 'http://127.0.0.1:4096/api/experimental/generate')
  const headers = new Headers(captured.value.init?.headers)
  assert.ok(headers.get('authorization')?.startsWith('Basic '))
  const body = JSON.parse(String(captured.value.init?.body)) as { prompt: string, model: { id: string, providerID: string } }
  assert.equal(body.prompt, 'prompt')
  assert.deepEqual(body.model, { id: 'deepseek-v4.1-flash', providerID: 'opencode-go' })
})

test('OpenCode client retries once on 5xx', async () => {
  const config = makeConfig({ aiEnabled: true, opencodePassword: 'secret', aiTimeoutMs: 5000 })
  let calls = 0
  const fetchImpl = (async () => {
    calls += 1
    return calls === 1 ? new Response('boom', { status: 500 }) : jsonResponse({ data: { text: 'ok' } })
  }) as unknown as typeof fetch
  const client = new OpenCodeClient(config, logger, fetchImpl)
  const result = await client.generate('prompt')
  assert.equal(result.text, 'ok')
  assert.equal(calls, 2)
})

test('OpenCode client rejects invalid payloads', async () => {
  const config = makeConfig({ aiEnabled: true, opencodePassword: 'secret', aiTimeoutMs: 5000 })
  const fetchImpl = (async () => jsonResponse({ data: { text: '' } })) as unknown as typeof fetch
  const client = new OpenCodeClient(config, logger, fetchImpl)
  await assert.rejects(() => client.generate('prompt'), (error: unknown) => error instanceof AiError && error.kind === 'invalid')
})

test('OpenCode client reports timeouts', async () => {
  const config = makeConfig({ aiEnabled: true, opencodePassword: 'secret', aiTimeoutMs: 50 })
  const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    })
  })) as unknown as typeof fetch
  const client = new OpenCodeClient(config, logger, fetchImpl)
  await assert.rejects(() => client.generate('prompt'), (error: unknown) => error instanceof AiError && error.kind === 'timeout')
})
