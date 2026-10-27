import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bot } from 'mineflayer'
import type { BotController } from '../../src/minecraft/bot.ts'
import type { SlpResult } from '../../src/presence/slp.ts'
import { PresenceManager } from '../../src/presence/manager.ts'
import { EventBus } from '../../src/events/bus.ts'
import { isTransientConnectionLoss } from '../../src/tasks/manager.ts'
import { createLogger } from '../../src/logger.ts'
import { makeConfig, makeState, waitFor } from '../helpers.ts'

const logger = createLogger('error')

class FaultyController implements BotController {
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
  setDeathHandler (): void {}
  setSpawnHandler (): void {}

  setDisconnectHandler (handler: (reason: string) => void): void {
    this.disconnectHandler = handler
  }

  disconnect (reason: string): void {
    this.connected = false
    this.disconnectHandler?.(reason)
  }
}

function pingResult (online: number, sample: string[]): SlpResult {
  return {
    versionName: 'Paper 26.1.2',
    protocol: 775,
    online,
    max: 6,
    sampleNames: sample,
    motd: 'Test',
    latencyMs: 1
  }
}

test('故障注入：SLP 连续抖动后恢复并上线', async () => {
  const config = makeConfig({
    presenceEnabled: true,
    forceOnline: false,
    presencePollMs: 20,
    presenceGraceMs: 100,
    presenceQuitCooldownMs: 30,
    presenceCheckMs: 20,
    reconnectMinMs: 30,
    reconnectMaxMs: 60
  })
  const state = makeState(config)
  const controller = new FaultyController()
  let pings = 0
  let failures = 3
  const ping = async (): Promise<SlpResult> => {
    pings += 1
    if (failures > 0) {
      failures -= 1
      throw new Error('socket hang up')
    }
    return pingResult(1, ['Antifield'])
  }
  const manager = new PresenceManager({ config, logger, state, controller, ping })
  try {
    manager.start()
    await waitFor(() => state.state === 'connected', 3000)
    assert.ok(pings >= 4, '应经历抖动后成功探测')
    assert.equal(state.server.reachable, true)
    assert.equal(controller.connected, true)
  } finally {
    await manager.stop()
  }
})

test('故障注入：连续断线退避后仍能自动重连', async () => {
  const config = makeConfig({
    presenceEnabled: true,
    forceOnline: true,
    presencePollMs: 20,
    presenceGraceMs: 50,
    presenceQuitCooldownMs: 20,
    presenceCheckMs: 20,
    reconnectMinMs: 30,
    reconnectMaxMs: 60
  })
  const state = makeState(config)
  const controller = new FaultyController()
  const manager = new PresenceManager({ config, logger, state, controller, ping: async () => pingResult(0, []) })
  try {
    manager.start()
    await waitFor(() => state.state === 'connected', 2000)
    for (let round = 0; round < 3; round += 1) {
      controller.disconnect(`socket closed #${round}`)
      await waitFor(() => state.state === 'backoff' || state.state === 'idle' || state.state === 'connecting', 1000)
      await waitFor(() => state.state === 'connected', 2000)
    }
    assert.ok(controller.starts >= 4, `expected >=4 starts, got ${controller.starts}`)
    assert.ok(state.minecraft.reconnects >= 3)
    assert.equal(state.state, 'connected')
  } finally {
    await manager.stop()
  }
})

test('故障注入：断线错误被识别为可恢复，不消耗任务重试次数', () => {
  for (const message of [
    'disconnected: socket closed',
    'Connection reset by peer',
    'Timed out while connecting',
    '服务器还没连回来',
    'Server closed the connection',
    'kicked: server restart'
  ]) {
    assert.equal(isTransientConnectionLoss(message), true, message)
  }
  for (const message of ['铁镐快坏了，箱子里没有备用镐', '箱子满了，我先停下', '没有配置探索航点（EXPLORE_WAYPOINTS）']) {
    assert.equal(isTransientConnectionLoss(message), false, message)
  }
})

test('soak：事件 ring 有界且订阅清理后不再增长', () => {
  const bus = new EventBus(100)
  let subscribed = 0
  const unsubscribe = bus.subscribe(() => { subscribed += 1 })
  for (let index = 0; index < 10_000; index += 1) bus.emit('chat', { text: `m${index}` })
  assert.equal(bus.size, 100)
  assert.equal(subscribed, 10_000)
  const recent = bus.recent(100)
  assert.equal(recent.events.length, 100)
  assert.equal(recent.lastEventId, bus.lastEventId)
  const last = recent.events[recent.events.length - 1]!
  const replay = bus.replayAfter(last.id)
  assert.deepEqual(replay, { events: [], resync: false })
  unsubscribe()
  bus.emit('chat', { text: 'after-unsubscribe' })
  assert.equal(subscribed, 10_000)
  assert.equal(bus.size, 100)
})
