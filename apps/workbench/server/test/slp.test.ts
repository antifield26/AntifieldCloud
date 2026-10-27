import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { flattenMotd, pingStatus, stripColors } from '../src/mc/slp.ts'

function varInt(value: number): Buffer {
  const bytes: number[] = []
  let current = value >>> 0
  do {
    let byte = current & 0x7f
    current >>>= 7
    if (current !== 0) byte |= 0x80
    bytes.push(byte)
  } while (current !== 0)
  return Buffer.from(bytes)
}

function statusResponse(json: string): Buffer {
  const jsonBuffer = Buffer.from(json, 'utf8')
  const body = Buffer.concat([varInt(0), varInt(jsonBuffer.length), jsonBuffer])
  return Buffer.concat([varInt(body.length), body])
}

function startFakeServer(response: Buffer | null): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((socket: Socket) => {
      socket.once('data', () => {
        if (response) setTimeout(() => socket.write(response), 10)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address) resolve({ server, port: address.port })
    })
  })
}

test('SLP 解析版本、玩家与富文本 MOTD', async () => {
  const json = JSON.stringify({
    version: { name: 'Paper 26.1.2', protocol: 775 },
    players: { online: 2, max: 5, sample: [{ name: 'Steve' }, { name: 'Alex' }] },
    description: { text: '§aRaspberry Pi 5', extra: [{ text: ' | ' }, { text: 'LAN', color: 'yellow' }] },
  })
  const { server, port } = await startFakeServer(statusResponse(json))
  try {
    const status = await pingStatus('127.0.0.1', port, 1500)
    assert.equal(status.version, 'Paper 26.1.2')
    assert.equal(status.protocol, 775)
    assert.equal(status.playersOnline, 2)
    assert.equal(status.playersMax, 5)
    assert.deepEqual(status.samplePlayers, ['Steve', 'Alex'])
    assert.equal(status.motd, 'Raspberry Pi 5 | LAN')
  } finally {
    server.close()
  }
})

test('SLP 服务器不响应时超时', async () => {
  const { server, port } = await startFakeServer(null)
  try {
    await assert.rejects(() => pingStatus('127.0.0.1', port, 250), /超时|关闭|ECONN/)
  } finally {
    server.close()
  }
})

test('MOTD 扁平化与颜色剥离', () => {
  assert.equal(flattenMotd('§aHello §rWorld'), 'Hello World')
  assert.equal(flattenMotd({ text: 'A', extra: [{ text: 'B' }, { text: 'C' }] }), 'ABC')
  assert.equal(stripColors('§6TPS from last 1m'), 'TPS from last 1m')
})
