/** v0.7.0 追加：Bot 连续消息发送间隔（生产默认 1000ms，按 Bot/AppID 串行）。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { QqAdapter, DEFAULT_SEND_INTERVAL_MS } from '../src/bot/adapters/qq.ts'
import type { BotTargetRow } from '../src/bot/types.ts'
import { makeQqServiceFetch, nextAppId } from './bot-qq-fixtures.ts'

function target(): BotTargetRow {
  return {
    id: 'target-1',
    bot_id: 'bot-1',
    external_id: 'user-openid-1',
    label: '测试目标',
    kind: 'user',
    allow_commands: 1,
    allow_notifications: 1,
    allow_chat: 1,
    chat_trigger: 'mention',
    quiet_start_minute: null,
    quiet_end_minute: null,
    created_at: '2026-01-01T00:00:00.000Z',
  }
}

/** 记录每次消息发送（POST 到 api.sgroup.qq.com）的时间戳。 */
function timedFetch(base: ReturnType<typeof makeQqServiceFetch>): { fetchImpl: typeof fetch; times: number[] } {
  const times: number[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith('https://api.sgroup.qq.com') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
      times.push(Date.now())
    }
    return base.fetchImpl(input, init)
  }) as typeof fetch
  return { fetchImpl, times }
}

test('默认生产间隔为 1000ms', () => {
  assert.equal(DEFAULT_SEND_INTERVAL_MS, 1000)
})

test('同一 Bot 连续 send 至少间隔 1000ms 可配置值（测试用 80ms）', async () => {
  const base = makeQqServiceFetch()
  const timed = timedFetch(base)
  const adapter = new QqAdapter(
    { appId: nextAppId() },
    { token: 'qq-app-secret-0123456789abcdef' },
    { fetch: timed.fetchImpl, sendIntervalMs: 80 },
  )
  await adapter.send(target(), { text: '第一条' })
  await adapter.send(target(), { text: '第二条' })
  assert.equal(timed.times.length, 2)
  assert.ok(timed.times[1]! - timed.times[0]! >= 70, `间隔应 >= 约 80ms，实际 ${timed.times[1]! - timed.times[0]!}ms`)
})

test('单条长文本分段发送也遵守间隔', async () => {
  const base = makeQqServiceFetch()
  const timed = timedFetch(base)
  const adapter = new QqAdapter(
    { appId: nextAppId() },
    { token: 'qq-app-secret-0123456789abcdef' },
    { fetch: timed.fetchImpl, sendIntervalMs: 60 },
  )
  // 超过 2000 字符会拆成 2 段。
  await adapter.send(target(), { text: 'x'.repeat(2500) })
  assert.equal(timed.times.length, 2)
  assert.ok(timed.times[1]! - timed.times[0]! >= 50, `分段间隔应 >= 约 60ms，实际 ${timed.times[1]! - timed.times[0]!}ms`)
})

test('并发外发也按同一 Bot 串行并保持间隔', async () => {
  const base = makeQqServiceFetch()
  const timed = timedFetch(base)
  const adapter = new QqAdapter(
    { appId: nextAppId() },
    { token: 'qq-app-secret-0123456789abcdef' },
    { fetch: timed.fetchImpl, sendIntervalMs: 60 },
  )
  await Promise.all([adapter.send(target(), { text: '并发一' }), adapter.send(target(), { text: '并发二' })])
  assert.equal(timed.times.length, 2)
  assert.ok(timed.times[1]! - timed.times[0]! >= 50, `并发间隔应 >= 约 60ms，实际 ${timed.times[1]! - timed.times[0]!}ms`)
})
