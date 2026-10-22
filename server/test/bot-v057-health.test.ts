/**
 * v0.5.7 平台适配器契约测试（三）：连接自检 check()。
 * 覆盖四平台成功、401/鉴权失败与网络错误的脱敏结果；不访问真实平台，不打印任何 Token/URL。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { TelegramAdapter } from '../src/bot/adapters/telegram.ts'
import { DiscordAdapter } from '../src/bot/adapters/discord.ts'
import { SlackAdapter } from '../src/bot/adapters/slack.ts'
import { QqAdapter } from '../src/bot/adapters/qq.ts'
import type { BotHealthCheck, BotSecret } from '../src/bot/types.ts'

interface Captured {
  url: string
  init?: RequestInit
}

type FetchHandler = (url: string, init?: RequestInit) => Response

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function makeFetch(handler: FetchHandler) {
  const captured: Captured[] = []
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    captured.push({ url, init })
    return handler(url, init)
  }
  return { fetchImpl: fetchImpl as typeof fetch, captured }
}

function assertSanitized(result: BotHealthCheck, secrets: string[]): void {
  const text = JSON.stringify(result)
  for (const secret of secrets) assert.ok(!text.includes(secret), `自检结果不应包含：${secret}`)
  for (const item of result.items) {
    assert.equal(typeof item.name, 'string')
    assert.equal(typeof item.ok, 'boolean')
    assert.equal(typeof item.detail, 'string')
    assert.ok(item.detail.length > 0)
    assert.ok(!/https?:\/\//i.test(item.detail), '自检 detail 不得包含 URL')
  }
}

/* ------------------------------- Telegram ------------------------------- */

const TG_TOKEN = `123456789:${'A'.repeat(35)}`
const TG_WEBHOOK_SECRET = 'telegram-webhook-secret-1234'

function tgAdapter(fetchImpl: typeof fetch): TelegramAdapter {
  return new TelegramAdapter(
    { token: TG_TOKEN, webhookSecret: TG_WEBHOOK_SECRET } as BotSecret,
    { fetch: fetchImpl },
  )
}

test('Telegram check：getMe 与 Webhook URL 匹配时整体通过，detail 脱敏', async () => {
  const { fetchImpl } = makeFetch((url) => {
    if (url.endsWith('/getMe')) return jsonResponse({ ok: true, result: { username: 'HealthBot' } })
    if (url.endsWith('/getWebhookInfo')) {
      return jsonResponse({
        ok: true,
        result: { url: 'https://app.example.com/api/bot/webhook/bot-1', pending_update_count: 3 },
      })
    }
    return jsonResponse({ ok: false, description: 'unexpected' }, 404)
  })
  const result = await tgAdapter(fetchImpl).check({ botId: 'bot-1', appOrigin: 'https://app.example.com/' })
  assert.equal(result.ok, true)
  assert.equal(result.items.length, 2)
  assert.equal(result.items[0]?.name, 'Bot 账号')
  assert.equal(result.items[0]?.detail, '@HealthBot')
  assert.equal(result.items[1]?.ok, true)
  assert.match(result.items[1]!.detail, /待处理 3 条/)
  assertSanitized(result, [TG_TOKEN, TG_WEBHOOK_SECRET, 'https://app.example.com'])
})

test('Telegram check：Webhook 不匹配给失败项，401 与网络错误返回固定错误码', async () => {
  const mismatch = makeFetch((url) => {
    if (url.endsWith('/getMe')) return jsonResponse({ ok: true, result: { username: 'HealthBot' } })
    return jsonResponse({ ok: true, result: { url: 'https://other.example.com/hook', pending_update_count: 0 } })
  })
  const mismatchResult = await tgAdapter(mismatch.fetchImpl).check({
    botId: 'bot-1',
    appOrigin: 'https://app.example.com',
  })
  assert.equal(mismatchResult.ok, false)
  assert.equal(mismatchResult.items[1]?.ok, false)
  assert.equal(mismatchResult.items[1]?.detail, 'webhook_url_mismatch')
  assertSanitized(mismatchResult, [TG_TOKEN, TG_WEBHOOK_SECRET, 'other.example.com'])

  const unauthorized = makeFetch(() => jsonResponse({ ok: false, description: 'Unauthorized' }, 401))
  const unauthorizedResult = await tgAdapter(unauthorized.fetchImpl).check({
    botId: 'bot-1',
    appOrigin: 'https://app.example.com',
  })
  assert.equal(unauthorizedResult.ok, false)
  assert.equal(unauthorizedResult.items[0]?.detail, 'telegram_unauthorized')
  assertSanitized(unauthorizedResult, [TG_TOKEN])

  const offline = makeFetch(() => {
    throw new Error(`connect failed to https://api.telegram.org/bot${TG_TOKEN}/getMe`)
  })
  const offlineResult = await tgAdapter(offline.fetchImpl).check({
    botId: 'bot-1',
    appOrigin: 'https://app.example.com',
  })
  assert.equal(offlineResult.ok, false)
  assert.equal(offlineResult.items[0]?.detail, 'network_error')
  assertSanitized(offlineResult, [TG_TOKEN])
})

/* -------------------------------- Discord ------------------------------- */

test('Discord check：/users/@me 成功、401 与网络错误', async () => {
  const okFetch = makeFetch(() => jsonResponse({ id: 'bot-user-1', username: 'health-bot' }))
  const okResult = await new DiscordAdapter(
    { applicationId: '123456789012345678' },
    { token: 'x'.repeat(40) },
    { fetch: okFetch.fetchImpl },
  ).check({ botId: 'bot-1', appOrigin: 'https://app.example.com' })
  assert.equal(okResult.ok, true)
  assert.equal(okResult.items[0]?.detail, '@health-bot（bot-user-1）')
  assert.equal(okFetch.captured[0]?.url, 'https://discord.com/api/v10/users/@me')
  assertSanitized(okResult, ['x'.repeat(40)])

  const unauthorizedFetch = makeFetch(() => jsonResponse({ message: '401: Unauthorized', code: 0 }, 401))
  const unauthorized = await new DiscordAdapter(
    { applicationId: '123456789012345678' },
    { token: 'y'.repeat(40) },
    { fetch: unauthorizedFetch.fetchImpl },
  ).check({ botId: 'bot-1', appOrigin: 'https://app.example.com' })
  assert.equal(unauthorized.ok, false)
  assert.equal(unauthorized.items[0]?.detail, 'discord_unauthorized')

  const offlineFetch = makeFetch(() => {
    throw new Error('network down')
  })
  const offline = await new DiscordAdapter(
    { applicationId: '123456789012345678' },
    { token: 'z'.repeat(40) },
    { fetch: offlineFetch.fetchImpl },
  ).check({ botId: 'bot-1', appOrigin: 'https://app.example.com' })
  assert.equal(offline.ok, false)
  assert.equal(offline.items[0]?.detail, 'network_error')
})

/* --------------------------------- Slack -------------------------------- */

const SLACK_SIGNING_SECRET = 'slack-signing-secret-123456'

function slackSecret(): BotSecret {
  return { token: 'xoxb-health-token-123456', signingSecret: SLACK_SIGNING_SECRET }
}

test('Slack check：auth.test 成功、invalid_auth 与网络错误', async () => {
  const okFetch = makeFetch(() => jsonResponse({ ok: true, team: 'Acme', user: 'healthbot' }))
  const okResult = await new SlackAdapter(slackSecret(), { fetch: okFetch.fetchImpl }).check({
    botId: 'bot-1',
    appOrigin: 'https://app.example.com',
  })
  assert.equal(okResult.ok, true)
  assert.equal(okResult.items[0]?.detail, 'Acme/healthbot')
  assert.equal(okFetch.captured[0]?.url, 'https://slack.com/api/auth.test')
  assertSanitized(okResult, [slackSecret().token, SLACK_SIGNING_SECRET])

  const invalidFetch = makeFetch(() => jsonResponse({ ok: false, error: 'invalid_auth' }))
  const invalid = await new SlackAdapter(slackSecret(), { fetch: invalidFetch.fetchImpl }).check({
    botId: 'bot-1',
    appOrigin: 'https://app.example.com',
  })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.items[0]?.detail, 'slack_invalid_auth')
  assertSanitized(invalid, [slackSecret().token])

  const offlineFetch = makeFetch(() => {
    throw new Error('socket hang up')
  })
  const offline = await new SlackAdapter(slackSecret(), { fetch: offlineFetch.fetchImpl }).check({
    botId: 'bot-1',
    appOrigin: 'https://app.example.com',
  })
  assert.equal(offline.ok, false)
  assert.equal(offline.items[0]?.detail, 'network_error')
})

/* ---------------------------------- QQ ---------------------------------- */

const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'

test('QQ check：获取 access_token 成功只返回固定文案，失败返回固定错误码', async () => {
  const okFetch = makeFetch(() => jsonResponse({ access_token: 'qq-health-token-secret', expires_in: 7200 }))
  const okResult = await new QqAdapter(
    { appId: '102345701' },
    { token: 'qq-health-app-secret-fixed-0001' },
    { fetch: okFetch.fetchImpl },
  ).check({ botId: 'bot-1', appOrigin: 'https://app.example.com' })
  assert.equal(okResult.ok, true)
  assert.equal(okResult.items[0]?.detail, 'access_token 已获取')
  assert.equal(okFetch.captured[0]?.url, QQ_TOKEN_URL)
  assertSanitized(okResult, ['qq-health-token-secret', 'qq-health-app-secret-fixed-0001'])

  const unauthorizedFetch = makeFetch(() => jsonResponse({ message: 'invalid secret' }, 401))
  const unauthorized = await new QqAdapter(
    { appId: '102345702' },
    { token: 'qq-health-app-secret-fixed-0002' },
    { fetch: unauthorizedFetch.fetchImpl },
  ).check({ botId: 'bot-1', appOrigin: 'https://app.example.com' })
  assert.equal(unauthorized.ok, false)
  assert.equal(unauthorized.items[0]?.detail, 'qq_access_token_failed')

  const offlineFetch = makeFetch(() => {
    throw new Error('connect ETIMEDOUT')
  })
  const offline = await new QqAdapter(
    { appId: '102345703' },
    { token: 'qq-health-app-secret-fixed-0003' },
    { fetch: offlineFetch.fetchImpl },
  ).check({ botId: 'bot-1', appOrigin: 'https://app.example.com' })
  assert.equal(offline.ok, false)
  assert.equal(offline.items[0]?.detail, 'network_error')
})
