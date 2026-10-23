/** v0.3 日志脱敏测试：请求 URL 中的分享 token 不得进入日志。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import type { Config } from '../src/config.ts'
import { loggerOptions, redactSensitiveRequestUrl, serializeRequest } from '../src/logger.ts'

test('分享 token URL 脱敏：/s/ 与 /api/public/shares/', () => {
  assert.equal(redactSensitiveRequestUrl('/s/AbCdEf_123-xyz'), '/s/[REDACTED]')
  assert.equal(redactSensitiveRequestUrl('/s/AbCdEf_123-xyz?from=qr'), '/s/[REDACTED]?from=qr')
  assert.equal(
    redactSensitiveRequestUrl('/api/public/shares/AbCdEf_123-xyz/unlock'),
    '/api/public/shares/[REDACTED]/unlock',
  )
  assert.equal(
    redactSensitiveRequestUrl('/api/public/shares/AbCdEf_123-xyz/content?inline=1'),
    '/api/public/shares/[REDACTED]/content?inline=1',
  )
  // 非分享 URL 保持原样；空值与 /s 无 token 不误伤。
  assert.equal(redactSensitiveRequestUrl('/api/files/abc/content'), '/api/files/abc/content')
  assert.equal(redactSensitiveRequestUrl('/s'), '/s')
  assert.equal(redactSensitiveRequestUrl(''), '')
})

test('Bot Webhook 路径中的 botId 脱敏，不误伤 /api/bots 管理接口', () => {
  assert.equal(
    redactSensitiveRequestUrl('/api/bot/webhook/123e4567-e89b-12d3-a456-426614174000'),
    '/api/bot/webhook/[REDACTED]',
  )
  assert.equal(
    redactSensitiveRequestUrl('/api/bot/webhook/123e4567-e89b-12d3-a456-426614174000?op=13'),
    '/api/bot/webhook/[REDACTED]?op=13',
  )
  assert.equal(redactSensitiveRequestUrl('/api/bots'), '/api/bots')
  assert.equal(redactSensitiveRequestUrl('/api/bots/status'), '/api/bots/status')
})

test('req serializer 保留排障字段且脱敏分享 token', () => {
  const serialized = serializeRequest({
    method: 'GET',
    url: '/s/secret-token',
    headers: { host: 'app.test' },
    socket: { remoteAddress: '127.0.0.1', remotePort: 43110 },
  })
  assert.equal(serialized.method, 'GET')
  assert.equal(serialized.url, '/s/[REDACTED]')
  assert.equal(serialized.host, 'app.test')
  assert.equal(serialized.remoteAddress, '127.0.0.1')
  assert.equal(serialized.remotePort, 43110)
})

test('loggerOptions 接入自定义 serializers，silent 时关闭日志', () => {
  const options = loggerOptions({ logLevel: 'info' } as Config)
  assert.ok(options && typeof options === 'object')
  const serializers = (options as { serializers?: { req?: (input: unknown) => { url?: string } } }).serializers
  assert.ok(serializers?.req)
  assert.equal(serializers.req?.({ method: 'GET', url: '/api/public/shares/tok', headers: {} }).url, '/api/public/shares/[REDACTED]')

  assert.equal(loggerOptions({ logLevel: 'silent' } as Config), false)
})

test('Fastify 集成：真实请求日志中 /s/<token> 被脱敏', async () => {
  const lines: string[] = []
  const stream = {
    write(line: string) {
      lines.push(line)
    },
  }
  const base = loggerOptions({ logLevel: 'info' } as Config) as Record<string, unknown>
  const app = Fastify({ logger: { ...base, stream } })
  app.get('/s/:token', async () => ({ ok: true }))
  try {
    const token = 'SuperSecretShareToken123'
    const response = await app.inject({ method: 'GET', url: `/s/${token}` })
    assert.equal(response.statusCode, 200)
    const serialized = lines.join('\n')
    assert.match(serialized, /"url":"\/s\/\[REDACTED\]"/)
    assert.ok(!serialized.includes(token), `日志不得包含分享 token：${serialized}`)
  } finally {
    await app.close()
  }
})
