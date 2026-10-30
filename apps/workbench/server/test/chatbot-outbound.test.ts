/**
 * Chatbot 出站可用性快照：窗口内失败、历史死信、成功恢复与阈值行为。
 *
 * 全部使用进程内 SQLite 夹具；不访问 QQ、OpenCode 或真实网络。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createQqServiceFixture } from './chatbot-qq-fixtures.ts'
import { readOutboundHealth } from '../src/chatbot/outbound.ts'

const NOW = new Date('2026-10-30T00:00:00.000Z')

function insertDelivery(
  fixture: ReturnType<typeof createQqServiceFixture>,
  input: {
    id: string
    status: 'queued' | 'sending' | 'sent' | 'failed' | 'dead'
    updatedAt: string
    sentAt?: string | null
    lastError?: string | null
  },
): void {
  fixture.db
    .prepare(
      `INSERT INTO chatbot_deliveries
       (id, chatbot_id, target_id, kind, payload_json, status, attempts, last_error, created_at, updated_at, sent_at)
       VALUES (?, ?, NULL, 'notification', ?, ?, 1, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      fixture.chatbotId,
      JSON.stringify({ text: 'synthetic' }),
      input.status,
      input.lastError ?? null,
      input.updatedAt,
      input.updatedAt,
      input.sentAt ?? null,
    )
}

test('出站健康：无失败时 active 且 healthy', () => {
  const fixture = createQqServiceFixture()
  try {
    const health = readOutboundHealth(fixture.db, fixture.config, NOW)
    assert.equal(health.active, true)
    assert.equal(health.degraded, false)
    assert.equal(health.recentFailures, 0)
    assert.equal(health.lastError, null)
  } finally {
    fixture.cleanup()
  }
})

test('出站健康：窗口内失败晚于最近成功时 degraded，并带脱敏提示', () => {
  const fixture = createQqServiceFixture()
  try {
    insertDelivery(fixture, {
      id: 'sent-old',
      status: 'sent',
      updatedAt: '2026-10-29T22:00:00.000Z',
      sentAt: '2026-10-29T22:00:00.000Z',
    })
    insertDelivery(fixture, {
      id: 'dead-recent',
      status: 'dead',
      updatedAt: '2026-10-29T23:30:00.000Z',
      lastError: 'qq_access_token_failed',
    })

    const health = readOutboundHealth(fixture.db, fixture.config, NOW)
    assert.equal(health.active, true)
    assert.equal(health.degraded, true)
    assert.equal(health.recentFailures, 1)
    assert.equal(health.deadDeliveries, 1)
    assert.equal(health.lastSuccessAt, '2026-10-29T22:00:00.000Z')
    assert.match(String(health.lastErrorHint), /access_token/)
  } finally {
    fixture.cleanup()
  }
})

test('出站健康：窗口外历史死信不触发 degraded', () => {
  const fixture = createQqServiceFixture()
  try {
    insertDelivery(fixture, {
      id: 'dead-old',
      status: 'dead',
      updatedAt: '2026-10-27T00:00:00.000Z',
      lastError: 'qq_access_token_failed',
    })

    const health = readOutboundHealth(fixture.db, fixture.config, NOW)
    assert.equal(health.degraded, false)
    assert.equal(health.recentFailures, 0)
    assert.equal(health.deadDeliveries, 1)
  } finally {
    fixture.cleanup()
  }
})

test('出站健康：新成功晚于失败后恢复', () => {
  const fixture = createQqServiceFixture()
  try {
    insertDelivery(fixture, {
      id: 'failed-before-success',
      status: 'failed',
      updatedAt: '2026-10-29T23:00:00.000Z',
      lastError: 'network_timeout',
    })
    insertDelivery(fixture, {
      id: 'sent-newer',
      status: 'sent',
      updatedAt: '2026-10-29T23:30:00.000Z',
      sentAt: '2026-10-29T23:30:00.000Z',
    })

    const health = readOutboundHealth(fixture.db, fixture.config, NOW)
    assert.equal(health.recentFailures, 1)
    assert.equal(health.degraded, false)
    assert.equal(health.lastSuccessAt, '2026-10-29T23:30:00.000Z')
  } finally {
    fixture.cleanup()
  }
})

test('出站健康：阈值可配置，关闭 Chatbot 时 active=false', () => {
  const fixture = createQqServiceFixture({
    configOverrides: { chatbotOutboundFailureThreshold: 2, chatbotOutboundFailureWindowMinutes: 5 },
  })
  try {
    insertDelivery(fixture, {
      id: 'failed-1',
      status: 'failed',
      updatedAt: '2026-10-29T23:58:00.000Z',
      lastError: 'network_timeout',
    })
    const one = readOutboundHealth(fixture.db, fixture.config, NOW)
    assert.equal(one.degraded, false)
    assert.equal(one.recentFailures, 1)

    insertDelivery(fixture, {
      id: 'failed-2',
      status: 'failed',
      updatedAt: '2026-10-29T23:59:00.000Z',
      lastError: 'network_timeout',
    })
    const two = readOutboundHealth(fixture.db, fixture.config, NOW)
    assert.equal(two.degraded, true)
    assert.equal(two.recentFailures, 2)

    const disabled = readOutboundHealth(
      fixture.db,
      { ...fixture.config, chatbotEnabled: false },
      NOW,
    )
    assert.equal(disabled.active, false)
    assert.equal(disabled.degraded, null)
  } finally {
    fixture.cleanup()
  }
})

test('ChatbotStatus.lastError 不返回窗口外历史错误', () => {
  const fixture = createQqServiceFixture()
  try {
    insertDelivery(fixture, {
      id: 'stale-error',
      status: 'dead',
      updatedAt: '2026-10-20T00:00:00.000Z',
      lastError: 'qq_access_token_failed',
    })
    const status = fixture.service.status()
    assert.equal(status.outbound.degraded, false)
    assert.equal(status.lastError, null)
  } finally {
    fixture.cleanup()
  }
})

test('ChatbotStatus 暴露 outbound 快照', () => {
  const fixture = createQqServiceFixture()
  try {
    const status = fixture.service.status()
    assert.equal(status.outbound.active, true)
    assert.equal(status.outbound.windowMinutes, fixture.config.chatbotOutboundFailureWindowMinutes)
  } finally {
    fixture.cleanup()
  }
})
