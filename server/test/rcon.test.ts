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

function startFakeRcon(password: string, response: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((socket: Socket) => {
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
          } else if (packet.type === 2 && authed) {
            socket.write(encodePacket(packet.id, 0, response))
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

test('RCON 认证并执行命令', async () => {
  const { server, port } = await startFakeRcon('fixture-rcon-secret', 'There are 0 of a max of 5 players online:')
  try {
    const result = await rconCommand({ host: '127.0.0.1', port, password: 'fixture-rcon-secret' }, 'list')
    assert.match(result, /max of 5/)
  } finally {
    server.close()
  }
})

test('RCON 密码错误抛错', async () => {
  const { server, port } = await startFakeRcon('fixture-rcon-secret', 'ok')
  try {
    await assert.rejects(
      () => rconCommand({ host: '127.0.0.1', port, password: 'wrong' }, 'list'),
      (error: unknown) => error instanceof RconError && /认证失败/.test(error.message),
    )
  } finally {
    server.close()
  }
})

test('RCON 未配置密码时直接拒绝', async () => {
  await assert.rejects(
    () => rconCommand({ host: '127.0.0.1', port: 25575, password: '' }, 'list'),
    /未配置 RCON 密码/,
  )
})
