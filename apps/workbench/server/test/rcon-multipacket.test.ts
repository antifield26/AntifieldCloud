import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { rconCommand, RconError } from '../src/mc/rcon.ts'

interface Parsed {
  id: number
  type: number
  body: string
}

function encodePacket(id: number, type: number, body: string): Buffer {
  const bodyBuffer = Buffer.from(body, 'utf8')
  const payload = Buffer.alloc(8 + bodyBuffer.length + 2)
  payload.writeInt32LE(id, 0)
  payload.writeInt32LE(type, 4)
  bodyBuffer.copy(payload, 8)
  const frame = Buffer.alloc(4 + payload.length)
  frame.writeInt32LE(payload.length, 0)
  payload.copy(frame, 4)
  return frame
}

interface FakeOptions {
  /** 收到命令后回发的多包响应（每项一个 RCON 包）。 */
  responses: string[]
  /** 回发后是否关闭连接。 */
  closeAfter?: boolean
  /** 认证后是否吞掉命令（用于超时测试）。 */
  silentCommand?: boolean
}

function startFakeRcon(password: string, options: FakeOptions): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((socket: Socket) => {
      // 客户端在“响应过大/超时”场景会主动断开，吞掉服务端的 ECONNRESET。
      socket.on('error', () => {})
      let buffer = Buffer.alloc(0)
      let authed = false
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        while (buffer.length >= 4) {
          const length = buffer.readInt32LE(0)
          if (buffer.length < 4 + length) return
          const payload = buffer.subarray(4, 4 + length)
          buffer = buffer.subarray(4 + length)
          const packet: Parsed = {
            id: payload.readInt32LE(0),
            type: payload.readInt32LE(4),
            body: payload.subarray(8, payload.length - 2).toString('utf8'),
          }
          if (packet.type === 3) {
            if (packet.body === password) {
              authed = true
              socket.write(encodePacket(packet.id, 2, ''))
            } else {
              socket.write(encodePacket(-1, 2, ''))
            }
          } else if (packet.type === 2 && authed && !options.silentCommand) {
            for (const response of options.responses) socket.write(encodePacket(packet.id, 0, response))
            if (options.closeAfter) socket.end()
          }
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address) resolve({ server, port: address.port })
    })
  })
}

test('RCON 多包响应拼接（>4096B 拆分）', async () => {
  const body = 'x'.repeat(5000)
  const { server, port } = await startFakeRcon('fixture-rcon-secret', {
    responses: [body.slice(0, 4096), body.slice(4096)],
  })
  try {
    const result = await rconCommand({ host: '127.0.0.1', port, password: 'fixture-rcon-secret', timeoutMs: 3000 }, 'list')
    assert.equal(result.length, 5000)
    assert.equal(result, body)
  } finally {
    server.close()
  }
})

test('RCON 服务器发送后关闭连接：已收包正常返回', async () => {
  const { server, port } = await startFakeRcon('fixture-rcon-secret', {
    responses: ['There are 0 of a max of 5 players online:', ''],
    closeAfter: true,
  })
  try {
    const result = await rconCommand({ host: '127.0.0.1', port, password: 'fixture-rcon-secret', timeoutMs: 3000 }, 'list')
    assert.match(result, /max of 5/)
  } finally {
    server.close()
  }
})

test('RCON 命令无响应时按超时拒绝，不挂起', async () => {
  const { server, port } = await startFakeRcon('fixture-rcon-secret', { responses: [], silentCommand: true })
  const started = Date.now()
  try {
    await assert.rejects(
      () => rconCommand({ host: '127.0.0.1', port, password: 'fixture-rcon-secret', timeoutMs: 400 }, 'list'),
      /超时/,
    )
    assert.ok(Date.now() - started < 3000)
  } finally {
    server.close()
  }
})

test('RCON 累计响应超过 1MiB 拒绝', async () => {
  const chunk = 'y'.repeat(4096)
  const responses = Array.from({ length: 300 }, () => chunk)
  const { server, port } = await startFakeRcon('fixture-rcon-secret', { responses })
  try {
    await assert.rejects(
      () => rconCommand({ host: '127.0.0.1', port, password: 'fixture-rcon-secret', timeoutMs: 3000 }, 'list'),
      (error: unknown) => error instanceof RconError && /响应过大/.test(error.message),
    )
  } finally {
    server.close()
  }
})
