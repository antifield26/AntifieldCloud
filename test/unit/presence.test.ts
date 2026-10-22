import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bot } from 'mineflayer'
import type { BotController } from '../../src/minecraft/bot.ts'
import type { SlpResult } from '../../src/presence/slp.ts'
import { PresenceManager } from '../../src/presence/manager.ts'
import { createLogger } from '../../src/logger.ts'
import { makeConfig, makeState, waitFor } from '../helpers.ts'

const logger = createLogger('error')

class FakeController implements BotController {
  connected = false
  starts = 0
  stops = 0
  others: string[] = []
  failNext = false
  disconnectHandler: ((reason: string) => void) | null = null

  async start (): Promise<void> {
    this.starts += 1
    if (this.failNext) {
      this.failNext = false
      throw new Error('Connection throttled! Please wait before reconnecting.')
    }
    this.connected = true
  }

  async stop (): Promise<void> {
    this.stops += 1
    this.connected = false
  }

  isConnected (): boolean {
    return this.connected
  }

  getBot (): Bot | null {
    return null
  }

  getOtherPlayers (): string[] {
    return this.others
  }

  setChatHandler (): void {}

  setDisconnectHandler (handler: (reason: string) => void): void {
    this.disconnectHandler = handler
  }
}

function makePing (state: { online: number, sample: string[] }): () => Promise<SlpResult> {
  return async () => ({
    versionName: 'Paper 26.1.2',
    protocol: 775,
    online: state.online,
    max: 6,
    sampleNames: state.sample,
    motd: 'Test',
    latencyMs: 1
  })
}

test('presence connects when a player is online and leaves after the grace period', async () => {
  const config = makeConfig({
    presenceEnabled: true,
    forceOnline: false,
    presencePollMs: 30,
    presenceGraceMs: 120,
    presenceQuitCooldownMs: 40,
    presenceCheckMs: 30,
    reconnectMinMs: 30,
    reconnectMaxMs: 60
  })
  const state = makeState(config)
  const controller = new FakeController()
  const sample = { online: 1, sample: ['Antifield'] }
  const manager = new PresenceManager({ config, logger, state, controller, ping: makePing(sample) })
  try {
    manager.start()
    await waitFor(() => state.state === 'connected', 1000)
    controller.others = ['Antifield']
    await waitFor(() => state.presence.otherPlayers === 1, 1000)
    controller.others = []
    sample.online = 0
    sample.sample = []
    await waitFor(() => state.state === 'idle', 2000)
    assert.ok(controller.starts >= 1)
    assert.ok(controller.stops >= 1)
  } finally {
    await manager.stop()
  }
})

test('presence backs off and retries after a failed login', async () => {
  const config = makeConfig({
    presenceEnabled: true,
    forceOnline: false,
    presencePollMs: 30,
    presenceGraceMs: 120,
    presenceQuitCooldownMs: 40,
    presenceCheckMs: 30,
    reconnectMinMs: 30,
    reconnectMaxMs: 60
  })
  const state = makeState(config)
  const controller = new FakeController()
  controller.failNext = true
  const sample = { online: 1, sample: ['Antifield'] }
  const manager = new PresenceManager({ config, logger, state, controller, ping: makePing(sample) })
  try {
    manager.start()
    await waitFor(() => state.state === 'connected', 2000)
    assert.ok(controller.starts >= 2)
  } finally {
    await manager.stop()
  }
})

test('forceOnline connects even with no players and never auto-leaves', async () => {
  const config = makeConfig({
    presenceEnabled: true,
    forceOnline: true,
    presencePollMs: 30,
    presenceGraceMs: 50,
    presenceQuitCooldownMs: 30,
    presenceCheckMs: 30,
    reconnectMinMs: 30,
    reconnectMaxMs: 60
  })
  const state = makeState(config)
  const controller = new FakeController()
  const sample = { online: 0, sample: [] }
  const manager = new PresenceManager({ config, logger, state, controller, ping: makePing(sample) })
  try {
    manager.start()
    await waitFor(() => state.state === 'connected', 1000)
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(state.state, 'connected')
    assert.equal(controller.stops, 0)
  } finally {
    await manager.stop()
  }
})
