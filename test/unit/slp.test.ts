import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import {
  buildHandshakePacket,
  buildStatusRequest,
  decodeVarInt,
  encodeVarInt,
  parseStatusJson,
  pingServer
} from '../../src/presence/slp.ts'

test('VarInt roundtrips', () => {
  for (const value of [0, 1, 127, 128, 255, 775, 2097151, 2147483647]) {
    const buffer = encodeVarInt(value)
    const decoded = decodeVarInt(buffer)
    assert.ok(decoded)
    assert.equal(decoded.value, value)
    assert.equal(decoded.size, buffer.length)
  }
  assert.equal(decodeVarInt(Buffer.from([0x80])), null)
})

test('parses status JSON and flattens MOTD', () => {
  const status = parseStatusJson(JSON.stringify({
    version: { name: 'Paper 26.1.2', protocol: 775 },
    players: { online: 2, max: 6, sample: [{ name: 'Antifield' }, { name: 'SmokeTester' }] },
    description: { text: 'Hello ', extra: [{ text: 'Pi' }] }
  }))
  assert.equal(status.versionName, 'Paper 26.1.2')
  assert.equal(status.protocol, 775)
  assert.equal(status.online, 2)
  assert.equal(status.max, 6)
  assert.deepEqual(status.sampleNames, ['Antifield', 'SmokeTester'])
  assert.equal(status.motd, 'Hello Pi')
})

test('handshake and status request are well formed', () => {
  const handshake = buildHandshakePacket('127.0.0.1', 25565, 775)
  const length = decodeVarInt(handshake)
  assert.ok(length)
  assert.equal(length.value, handshake.length - length.size)
  assert.deepEqual(buildStatusRequest(), Buffer.from([0x01, 0x00]))
})

test('pings a fake SLP server', async () => {
  const server = net.createServer(socket => {
    socket.once('data', () => {
      const json = JSON.stringify({
        version: { name: 'Paper 26.1.2', protocol: 775 },
        players: { online: 1, max: 6, sample: [{ name: 'Antifield' }] },
        description: { text: 'Test server' }
      })
      const payload = Buffer.concat([
        Buffer.from([0x00]),
        encodeVarInt(Buffer.byteLength(json)),
        Buffer.from(json, 'utf8')
      ])
      socket.write(Buffer.concat([encodeVarInt(payload.length), payload]))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const result = await pingServer({ host: '127.0.0.1', port: address.port, timeoutMs: 2000 })
    assert.equal(result.online, 1)
    assert.equal(result.max, 6)
    assert.deepEqual(result.sampleNames, ['Antifield'])
    assert.equal(result.motd, 'Test server')
    assert.ok(result.latencyMs >= 0)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
