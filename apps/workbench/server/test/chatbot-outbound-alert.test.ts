/**
 * chatbot_outbound_down 告警：近期失败 firing，新的成功发送后 resolved。
 *
 * 使用进程内 QQ 服务夹具与假告警依赖；不访问真实 QQ/网络。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { AlertService, type AlertDeps } from '../src/alerts/service.ts'
import { createQqServiceFixture } from './chatbot-qq-fixtures.ts'

const NOW = new Date('2026-10-30T00:00:00.000Z')

function alertServiceFor(fixture: ReturnType<typeof createQqServiceFixture>, overrides: Partial<AlertDeps> = {}): AlertService {
  const files = new Map<string, string>([
    [fixture.config.piHealthFile, JSON.stringify({ tempC: 45, underVoltage: false })],
    [
      fixture.config.backupPullFile,
      JSON.stringify({ lastPullAt: NOW.toISOString(), secretsAttempted: true, secretsOk: true }),
    ],
  ])
  const deps: AlertDeps = {
    now: () => NOW,
    log: () => {},
    sleep: async () => {},
    statfs: () => ({ availableBytes: 90, totalBytes: 100 }),
    memory: () => ({ totalBytes: 100, usedBytes: 10 }),
    serviceStates: async () => ({ minecraft: 'active' }),
    minecraftStatus: async () => ({ online: true }),
    readFile: (path) => {
      const value = files.get(path)
      if (value === undefined) throw new Error(`ENOENT: ${path}`)
      return value
    },
    ...overrides,
  }
  return new AlertService(fixture.db, fixture.config, deps)
}

function insertDelivery(
  fixture: ReturnType<typeof createQqServiceFixture>,
  input: { id: string; status: 'failed' | 'dead' | 'sent'; updatedAt: string; sentAt?: string | null; lastError?: string | null },
): void {
  fixture.db
    .prepare(
      `INSERT INTO chatbot_deliveries
       (id, chatbot_id, target_id, kind, payload_json, status, attempts, last_error, created_at, updated_at, sent_at)
       VALUES (?, ?, NULL, 'notification', ?, ?, 2, ?, ?, ?, ?)`,
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

test('chatbot_outbound_down：近期失败 firing，新成功发送后 resolved', async () => {
  const fixture = createQqServiceFixture({
    configOverrides: { alertsEnabled: true, alertWebhookUrl: '', chatbotOutboundFailureWindowMinutes: 60 },
  })
  try {
    const alerts = alertServiceFor(fixture)
    insertDelivery(fixture, {
      id: 'dead-outbound',
      status: 'dead',
      updatedAt: '2026-10-29T23:50:00.000Z',
      lastError: 'qq_access_token_failed',
    })

    await alerts.evaluateOnce()
    const firing = fixture.db
      .prepare("SELECT event, status, severity, message FROM alert_events WHERE event = 'chatbot_outbound_down' ORDER BY id ASC")
      .all() as unknown as Array<{ event: string; status: string; severity: string; message: string }>
    assert.equal(firing.length, 1)
    assert.equal(firing[0]?.status, 'firing')
    assert.equal(firing[0]?.severity, 'critical')
    assert.match(String(firing[0]?.message), /失败\/死信/)

    insertDelivery(fixture, {
      id: 'sent-recovered',
      status: 'sent',
      updatedAt: '2026-10-29T23:59:00.000Z',
      sentAt: '2026-10-29T23:59:00.000Z',
    })
    await alerts.evaluateOnce()
    const events = fixture.db
      .prepare("SELECT status FROM alert_events WHERE event = 'chatbot_outbound_down' ORDER BY id ASC")
      .all() as unknown as Array<{ status: string }>
    assert.deepEqual(events.map((event) => event.status), ['firing', 'resolved'])
    const state = fixture.db.prepare("SELECT status FROM alert_state WHERE event = 'chatbot_outbound_down'").get() as unknown as {
      status: string
    }
    assert.equal(state.status, 'ok')
  } finally {
    fixture.cleanup()
  }
})

test('chatbot_outbound_down：关闭开关时不注册条件', async () => {
  const fixture = createQqServiceFixture({
    configOverrides: {
      alertsEnabled: true,
      alertWebhookUrl: '',
      chatbotOutboundAlertEnabled: false,
    },
  })
  try {
    const alerts = alertServiceFor(fixture)
    insertDelivery(fixture, {
      id: 'dead-disabled',
      status: 'dead',
      updatedAt: '2026-10-29T23:50:00.000Z',
      lastError: 'qq_access_token_failed',
    })
    await alerts.evaluateOnce()
    const events = fixture.db
      .prepare("SELECT COUNT(*) AS c FROM alert_events WHERE event = 'chatbot_outbound_down'")
      .get() as unknown as { c: number }
    assert.equal(events.c, 0)
  } finally {
    fixture.cleanup()
  }
})
