#!/usr/bin/env node
/* global fetch, setTimeout, clearTimeout, AbortController */
/**
 * Bot 消息发送 MCP stdio server（v0.6.4）：把模型的一次 send_message 调用转发给本机应用。
 * 安全边界：只访问 BOT_TOOL_URL（生产为 loopback）；turn_token 只在本轮有效；不在 stdout 输出日志，
 * 不记录消息正文；应用侧只把文本写入本轮缓冲，回合结束统一发送。
 *
 * 协议：MCP stdio（每行一个 JSON-RPC 消息）；无 npm 依赖。
 */
import process from 'node:process'

const TOOL_URL = process.env.BOT_TOOL_URL ?? 'http://127.0.0.1:3000/api/bot/ai/tool/send'
const TIMEOUT_MS = Math.max(1000, Math.min(30000, Number(process.env.BOT_TOOL_TIMEOUT_MS ?? 10000)))
const MAX_TEXT = 2000

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function log(...args) {
  process.stderr.write(`[bot-tool-mcp] ${args.join(' ')}\n`)
}

async function callSendTool(args) {
  const turnId = typeof args?.turn_id === 'string' ? args.turn_id.trim() : ''
  const turnToken = typeof args?.turn_token === 'string' ? args.turn_token.trim() : ''
  const rawText = typeof args?.text === 'string' ? args.text : ''
  const text = rawText.replace(/\r\n?/g, '\n').trim()
  if (!turnId || !turnToken) throw new Error('缺少本轮凭据')
  if (!text) throw new Error('消息不能为空')
  if (text.length > MAX_TEXT) throw new Error('单条消息过长')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(TOOL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ turn_id: turnId, turn_token: turnToken, text }),
      signal: controller.signal,
      redirect: 'error',
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const code = typeof payload?.error?.code === 'string' ? payload.error.code : `HTTP ${response.status}`
      throw new Error(`发送失败（${code.slice(0, 40)}）`)
    }
    const index = Number(payload?.index)
    return Number.isFinite(index) && index > 0 ? `ok:${index}` : 'ok'
  } finally {
    clearTimeout(timer)
  }
}

async function handle(message) {
  const method = message.method
  const id = message.id
  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'botmsg', version: '0.1.0' },
        },
      }
    }
    if (method === 'notifications/initialized') return null
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'send_message',
              description: 'Send one text message to the current chat. Use only when you want to speak.',
              inputSchema: {
                type: 'object',
                properties: {
                  turn_id: { type: 'string', description: 'Current turn id.' },
                  turn_token: { type: 'string', description: 'Current turn token.' },
                  text: { type: 'string', minLength: 1, maxLength: MAX_TEXT, description: 'Plain text to send.' },
                },
                required: ['turn_id', 'turn_token', 'text'],
                additionalProperties: false,
              },
            },
          ],
        },
      }
    }
    if (method === 'tools/call') {
      const params = message.params ?? {}
      if (params.name !== 'send_message') throw new Error(`未知工具：${String(params.name)}`)
      const text = await callSendTool(params.arguments ?? {})
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text }], isError: false },
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
  } catch (error) {
    log('error', error instanceof Error ? error.message : String(error))
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: 'send failed' }], isError: true },
    }
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf('\n')
    if (index < 0) break
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      log('ignore invalid JSON line')
      continue
    }
    void handle(message).then((response) => {
      if (response) send(response)
    })
  }
})
process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
