/**
 * chatbot-tool-mcp.mjs 协议测试：用本机 HTTP 桩模拟应用工具回调。
 * 不访问真实 QQ/OpenCode；只验证 MCP 初始化、工具列表、转发 turn 凭据与错误路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'chatbot-tool-mcp.mjs')

function startToolServer() {
  const requests = []
  const server = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        body = null
      }
      requests.push({ url: request.url, body })
      if (body?.text === '失败样本') {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'send_limit' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, index: requests.length }))
    })
  })
  return { server, requests }
}

function startMcp(url) {
  const child = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, CHATBOT_TOOL_URL: url },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  const errors = []
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      const message = JSON.parse(line)
      const resolve = pending.get(message.id)
      if (resolve) {
        pending.delete(message.id)
        resolve(message)
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => errors.push(chunk))
  child.on('exit', () => {
    for (const resolve of pending.values()) resolve(null)
    pending.clear()
  })
  let nextId = 1
  const call = (method, params) => {
    const id = nextId
    nextId += 1
    const promise = new Promise((resolve) => pending.set(id, resolve))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return promise
  }
  return { child, call, errors }
}

test('chatbot-tool-mcp：初始化、列出工具并转发 turn_id/turn_token/text', async () => {
  const { server, requests } = startToolServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const { child, call } = startMcp(`http://127.0.0.1:${address.port}/api/chatbot/ai/tool/send`)
  try {
    const init = await call('initialize', {})
    assert.equal(init?.result?.serverInfo?.name, 'botmsg')
    const list = await call('tools/list', {})
    const tool = list?.result?.tools?.[0]
    assert.equal(tool?.name, 'send_message')
    assert.deepEqual(tool?.inputSchema?.required, ['turn_id', 'turn_token', 'text'])

    const sent = await call('tools/call', {
      name: 'send_message',
      arguments: { turn_id: 'turn-test', turn_token: 'token-test', text: '第一条' },
    })
    assert.equal(sent?.result?.isError, false)
    assert.equal(sent?.result?.content?.[0]?.text ?? '', 'ok:1')
    assert.deepEqual(requests[0]?.body, { turn_id: 'turn-test', turn_token: 'token-test', text: '第一条' })

    const failed = await call('tools/call', {
      name: 'send_message',
      arguments: { turn_id: 'turn-test', turn_token: 'token-test', text: '失败样本' },
    })
    assert.equal(failed?.result?.isError, true)
    assert.match(failed?.result?.content?.[0]?.text ?? '', /send failed/)
  } finally {
    child.kill()
    server.close()
  }
})
