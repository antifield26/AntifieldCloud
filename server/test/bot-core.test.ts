/**
 * Bot 核心回归：凭据加密、三平台验签/命令、队列/去重/发布。
 * 测试不访问真实平台网络，全部使用注入的 fetch 夹具。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tempDataDir, testConfig, testDb } from './helpers.ts'
import { BotService } from '../src/bot/service.ts'
import { decryptBotSecret, encryptBotSecret } from '../src/bot/crypto.ts'
import { TelegramAdapter } from '../src/bot/adapters/telegram.ts'
import { DiscordAdapter } from '../src/bot/adapters/discord.ts'
import { SlackAdapter } from '../src/bot/adapters/slack.ts'

interface Captured {
  url: string
  init?: RequestInit
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function makeFetch(responses: Array<Record<string, unknown>> = [{ ok: true, result: { message_id: 1 } }]) {
  const captured: Captured[] = []
  let index = 0
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    captured.push({ url, init })
    const body = responses[Math.min(index, responses.length - 1)] ?? {}
    index += 1
    return jsonResponse(body)
  }
  return { fetchImpl: fetchImpl as typeof fetch, captured }
}

function telegramSetup() {
  const dir = tempDataDir()
  const key = randomBytes(32).toString('base64')
  const config = testConfig(dir, { botEnabled: true, botSecretKey: key })
  const db = testDb(dir)
  const { fetchImpl, captured } = makeFetch()
  const service = new BotService({
    db,
    config,
    log: () => undefined,
    audit: () => undefined,
    fetch: fetchImpl,
    media: {
      stat: () => ({ filename: 'a.png', mime: 'image/png', size: 3 }),
      load: async () => ({ filename: 'a.png', mime: 'image/png', data: Buffer.from('png') }),
    },
    providers: {
      status: async () => ({ ok: true }),
      backup: async () => ({ ok: true }),
      world: async () => ({ ok: true }),
      minecraft: async () => ({ online: true }),
      files: async () => [{ name: 'a.txt', sizeLabel: '1 KB' }],
    },
  })
  const created = service.createBot({
    platform: 'telegram',
    name: 'test',
    token: 'x'.repeat(40),
    webhookSecret: 'secret-'.repeat(4),
  })
  service.updateBot(created.id, { enabled: true })
  const target = service.createTarget(created.id, {
    externalId: '123',
    label: 'chat',
    kind: 'group',
    allowCommands: true,
    allowNotifications: true,
  })
  const userTarget = service.createTarget(created.id, {
    externalId: '456',
    label: 'admin-user',
    kind: 'user',
    allowCommands: true,
    allowNotifications: false,
  })
  return { dir, db, service, created, target, userTarget, captured, config }
}

test('Bot 凭据加密可往返且篡改失败', () => {
  const key = randomBytes(32)
  const encrypted = encryptBotSecret(key, { token: 'x'.repeat(20), webhookSecret: 'secret' })
  const decoded = decryptBotSecret(key, encrypted)
  assert.equal(decoded.token, 'x'.repeat(20))
  assert.equal(decoded.webhookSecret, 'secret')
  assert.throws(() => decryptBotSecret(randomBytes(32), encrypted))
  assert.throws(() => decryptBotSecret(key, { ...encrypted, ciphertext: 'AAAA' }))
})

test('Telegram：secret 校验、命令回复、事件去重与通知/发布队列', async () => {
  const { dir, db, service, created, target, captured } = telegramSetup()
  try {
    const headers = { 'x-telegram-bot-api-secret-token': 'secret-'.repeat(4), 'content-type': 'application/json' }
    const body = Buffer.from(
      JSON.stringify({
        update_id: 1,
        message: { text: '/status', chat: { id: 123, type: 'private' }, from: { id: 456, username: 'u' } },
      }),
    )
    const result = await service.handleWebhook(created.id, headers, body)
    assert.equal(result.status, 200)
    await service.waitForIdle()
    assert.equal(captured.length, 1)
    assert.match(captured[0]!.url, /sendMessage/)
    assert.match(String(captured[0]!.init?.body), /应用状态/)

    const duplicate = await service.handleWebhook(created.id, headers, body)
    assert.deepEqual(duplicate.body, { ok: true, duplicate: true })

    const rejected = await service.handleWebhook(created.id, { ...headers, 'x-telegram-bot-api-secret-token': 'bad' }, body)
    assert.equal(rejected.status, 401)

    service.notifyAlert({
      id: 10,
      event: 'disk_low',
      severity: 'warning',
      status: 'firing',
      title: '磁盘不足',
      message: '失败路径 /home/antifield/secret.txt ssh://internal',
      createdAt: new Date().toISOString(),
    })
    await service.processDeliveries()
    assert.ok(captured.some((item) => /sendMessage/.test(item.url) && String(item.init?.body).includes('磁盘不足')))
    assert.ok(captured.some((item) => !String(item.init?.body).includes('/home/antifield/secret.txt')))

    assert.throws(() => service.createPublish(created.id, { targetId: target.id, text: '无确认' }), /二次确认/)
    const job = service.createPublish(created.id, { targetId: target.id, text: '发布测试', confirmText: 'PUBLISH' })
    await service.processPublishJobs()
    const sent = service.listPublishJobs(created.id).find((item) => item.id === job.id)
    assert.equal(sent?.status, 'sent')
    assert.ok(captured.some((item) => String(item.init?.body).includes('发布测试')))
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Telegram：未授权目标不执行命令', async () => {
  const { dir, db, service, created, userTarget, captured } = telegramSetup()
  try {
    service.updateTarget(created.id, userTarget.id, { allowCommands: false })
    const headers = { 'x-telegram-bot-api-secret-token': 'secret-'.repeat(4) }
    const body = Buffer.from(
      JSON.stringify({
        update_id: 2,
        message: { text: '/status', chat: { id: 123, type: 'private' }, from: { id: 456 } },
      }),
    )
    const result = await service.handleWebhook(created.id, headers, body)
    assert.equal(result.status, 200)
    await service.waitForIdle()
    assert.equal(captured.length, 0)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Discord：Ed25519 PING/命令验签，deferred 响应', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
  const { fetchImpl, captured } = makeFetch([{ id: 'm1' }])
  const adapter = new DiscordAdapter(
    { applicationId: '123456789012345678', publicKey: rawPublic },
    { token: 'x'.repeat(40) },
    { fetch: fetchImpl },
  )
  const timestamp = String(Math.floor(Date.now() / 1000))
  const ping = Buffer.from(JSON.stringify({ type: 1 }))
  const signature = sign(null, Buffer.concat([Buffer.from(timestamp), ping]), privateKey).toString('hex')
  const pong = await adapter.verifyInbound({
    botId: 'b1',
    headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp },
    body: ping,
  })
  assert.deepEqual(pong, { kind: 'challenge', body: { type: 1 } })

  const command = Buffer.from(
    JSON.stringify({
      type: 2,
      id: 'i1',
      token: 'interaction-token',
      channel_id: 'channel1',
      member: { user: { id: 'u1', username: 'user' } },
      data: { name: 'status', options: [] },
    }),
  )
  const commandSignature = sign(null, Buffer.concat([Buffer.from(timestamp), command]), privateKey).toString('hex')
  const verified = await adapter.verifyInbound({
    botId: 'b1',
    headers: { 'x-signature-ed25519': commandSignature, 'x-signature-timestamp': timestamp },
    body: command,
  })
  assert.equal(verified.kind, 'command')
  if (verified.kind !== 'command') throw new Error('expected command')
  assert.deepEqual(verified.immediateResponse, { type: 5 })
  await verified.reply('pong')
  assert.equal(captured.length, 1)
  assert.match(captured[0]!.url, /webhooks\/123456789012345678\/interaction-token/)

  const bad = await adapter.verifyInbound({
    botId: 'b1',
    headers: { 'x-signature-ed25519': '00'.repeat(64), 'x-signature-timestamp': timestamp },
    body: command,
  })
  assert.equal(bad.kind, 'rejected')
})

test('Slack：签名 challenge 与命令回复', async () => {
  const signingSecret = 'slack-signing-secret-123'
  const { fetchImpl, captured } = makeFetch([{ ok: true }])
  const adapter = new SlackAdapter({ token: 'x'.repeat(40), signingSecret }, { fetch: fetchImpl })
  const timestamp = String(Math.floor(Date.now() / 1000))
  const body = Buffer.from(JSON.stringify({ type: 'url_verification', challenge: 'abc' }))
  const signature = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body.toString()}`).digest('hex')}`
  const challenge = await adapter.verifyInbound({
    botId: 'b1',
    headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature, 'content-type': 'application/json' },
    body,
  })
  assert.deepEqual(challenge, { kind: 'challenge', body: { challenge: 'abc' } })

  const form = Buffer.from(
    'command=%2Fstatus&text=&channel_id=C1&user_id=U1&trigger_id=T1&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2F1',
  )
  const formSignature = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${form.toString()}`).digest('hex')}`
  const command = await adapter.verifyInbound({
    botId: 'b1',
    headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': formSignature, 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  })
  assert.equal(command.kind, 'command')
  if (command.kind !== 'command') throw new Error('expected command')
  await command.reply('ok')
  assert.equal(captured.length, 1)
  assert.match(captured[0]!.url, /hooks\.slack\.com/)
})

test('Telegram 适配器 token/secret 校验', () => {
  const adapter = new TelegramAdapter({ token: 'short', webhookSecret: '' })
  const errors = adapter.validate({}, { token: 'short', webhookSecret: '' })
  assert.ok(errors.includes('telegram_token_invalid'))
  assert.ok(errors.includes('telegram_webhook_secret_required'))
})
