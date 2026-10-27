import test from 'node:test'
import assert from 'node:assert/strict'
import { isLoopbackAddress, normalizeIpAddress, resolveRequestMeta } from '../src/http/request-meta.ts'

test('requestMeta：非 loopback 对端忽略一切转发头', () => {
  const meta = resolveRequestMeta({
    peerAddress: '203.0.113.7',
    encrypted: false,
    headers: {
      host: 'app.test',
      'cf-connecting-ip': '1.1.1.1',
      'x-forwarded-for': '8.8.8.8',
      'x-forwarded-proto': 'https',
    },
  })
  assert.equal(meta.trustedPeer, false)
  assert.equal(meta.ip, '203.0.113.7')
  assert.equal(meta.protocol, 'http')
})

test('requestMeta：loopback 对端优先采信 CF-Connecting-IP', () => {
  const meta = resolveRequestMeta({
    peerAddress: '127.0.0.1',
    encrypted: false,
    headers: { host: 'app.test', 'cf-connecting-ip': '198.51.100.9', 'x-forwarded-for': '1.2.3.4, 198.51.100.9' },
  })
  assert.equal(meta.trustedPeer, true)
  assert.equal(meta.ip, '198.51.100.9')
})

test('requestMeta：非法 CF-Connecting-IP 回退 XFF 最后一个合法值', () => {
  const invalid = resolveRequestMeta({
    peerAddress: '127.0.0.1',
    encrypted: false,
    headers: { host: 'app.test', 'cf-connecting-ip': 'not-an-ip', 'x-forwarded-for': '1.2.3.4, 203.0.113.5' },
  })
  assert.equal(invalid.ip, '203.0.113.5')
  const noValid = resolveRequestMeta({
    peerAddress: '127.0.0.1',
    encrypted: false,
    headers: { host: 'app.test', 'cf-connecting-ip': 'still-not-ip', 'x-forwarded-for': 'garbage' },
  })
  assert.equal(noValid.ip, '127.0.0.1')
})

test('requestMeta：X-Forwarded-Host 不参与 hostname 判断', () => {
  const meta = resolveRequestMeta({
    peerAddress: '127.0.0.1',
    encrypted: true,
    headers: { host: 'app.test', 'x-forwarded-host': '127.0.0.1', 'x-forwarded-proto': 'https' },
  })
  assert.equal(meta.hostname, 'app.test')
  assert.equal(meta.loopback, false)
  assert.equal(meta.protocol, 'https')
})

test('requestMeta：协议只采信合法 X-Forwarded-Proto，垃圾值回退 socket', () => {
  const meta = resolveRequestMeta({
    peerAddress: '127.0.0.1',
    encrypted: false,
    headers: { host: 'app.test', 'x-forwarded-proto': 'ftp' },
  })
  assert.equal(meta.protocol, 'http')
})

test('requestMeta：IPv4-mapped IPv6 loopback 视为可信对端', () => {
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('10.0.0.1'), false)
  assert.equal(normalizeIpAddress('::ffff:192.0.2.1'), '192.0.2.1')
  const meta = resolveRequestMeta({
    peerAddress: '::ffff:127.0.0.1',
    encrypted: false,
    headers: { host: 'app.test', 'cf-connecting-ip': '203.0.113.9' },
  })
  assert.equal(meta.trustedPeer, true)
  assert.equal(meta.ip, '203.0.113.9')
})

test('requestMeta：loopback Host 判定（HTTP 本机例外）', () => {
  const meta = resolveRequestMeta({ peerAddress: '127.0.0.1', encrypted: false, headers: { host: '127.0.0.1:3000' } })
  assert.equal(meta.hostname, '127.0.0.1')
  assert.equal(meta.loopback, true)
})
