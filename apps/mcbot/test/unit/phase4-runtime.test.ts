import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'
import { loadConfig } from '../../src/config.ts'
import { MemoryGuard, toRssMb } from '../../src/runtime/memory-guard.ts'
import { SdNotify, formatNotifyMessage, normalizeNotifySocket } from '../../src/runtime/sdnotify.ts'
import { itemStorageCategory } from '../../src/tasks/inventory.ts'
import { miningBands } from '../../src/tasks/resources.ts'

function baseEnv (overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    HTTP_TOKEN: 'x'.repeat(24),
    AI_ENABLED: 'false',
    DATA_DIR: join(tmpdir(), 'mcbot-phase4'),
    ...overrides
  }
}

function fakeBot (foods: string[] = []): Bot {
  const registry = { foodsByName: Object.fromEntries(foods.map(name => [name, {}])) }
  return { registry } as unknown as Bot
}

test('sd_notify：文本格式/换行拒绝/未设置 socket 时 no-op', () => {
  assert.equal(formatNotifyMessage({ READY: 1, STATUS: 'ok' }), 'READY=1\nSTATUS=ok')
  assert.throws(() => formatNotifyMessage({ STATUS: 'a\nb' }))
  assert.equal(normalizeNotifySocket(undefined), null)
  assert.equal(normalizeNotifySocket('  '), null)
  assert.equal(normalizeNotifySocket('/run/systemd/notify'), '/run/systemd/notify')
  assert.equal(normalizeNotifySocket('@abstract'), '\0abstract')
  const notify = new SdNotify({ env: {} })
  assert.equal(notify.enabled, false)
  assert.equal(notify.ready(), false)
  assert.equal(notify.watchdog(), false)
})

test('sd_notify：通过 systemd-notify 发送 READY/WATCHDOG/STOPPING/STATUS', () => {
  const calls: Array<{ file: string, args: readonly string[] }> = []
  const notify = new SdNotify({
    env: { NOTIFY_SOCKET: '/run/systemd/notify' },
    execFileImpl: (file, args, _options, callback) => {
      calls.push({ file, args })
      callback(null, '', '')
    }
  })
  assert.equal(notify.enabled, true)
  assert.equal(notify.ready(), true)
  assert.equal(notify.watchdog(), true)
  assert.equal(notify.stopping(), true)
  assert.equal(notify.status('busy\nstate'), true)
  assert.deepEqual(calls.map(call => call.args), [
    ['--ready'],
    ['WATCHDOG=1'],
    ['--stopping'],
    ['--status=busy state']
  ])
  assert.ok(calls.every(call => call.file === '/usr/bin/systemd-notify'))

  const errors: string[] = []
  const failing = new SdNotify({
    env: { NOTIFY_SOCKET: '/run/systemd/notify' },
    logger: { debug: (_message, details) => { errors.push(String(details?.error ?? '')) } },
    execFileImpl: (_file, _args, _options, callback) => callback(new Error('ENOENT'), '', '')
  })
  assert.equal(failing.ready(), true)
  assert.match(errors.join(','), /ENOENT/)
})

test('内存治理：阈值/冷却/未启用时不告警', () => {
  let now = 1000
  const alerts: number[] = []
  let usage = { rss: 300 * 1024 * 1024 } as NodeJS.MemoryUsage
  const guard = new MemoryGuard({
    limitMb: 256,
    checkMs: 60_000,
    logger: { warn: () => {} },
    cooldownMs: 5000,
    now: () => now,
    memoryUsage: () => usage,
    onHigh: rssMb => alerts.push(rssMb)
  })
  guard.start()
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0], 300)
  now += 1000
  guard.check()
  assert.equal(alerts.length, 1, '冷却窗口内不重复告警')
  now += 5000
  guard.check()
  assert.equal(alerts.length, 2)
  usage = { rss: 128 * 1024 * 1024 } as NodeJS.MemoryUsage
  assert.equal(guard.check(), false)
  guard.stop()
  assert.equal(guard.check(), false)
  assert.equal(toRssMb({ rss: 1024 * 1024 * 1.25 }), 1.3)
  const disabled = new MemoryGuard({
    limitMb: 0,
    checkMs: 1000,
    logger: { warn: () => {} },
    memoryUsage: () => ({ rss: 999 * 1024 * 1024 } as NodeJS.MemoryUsage),
    onHigh: () => { throw new Error('must not alert') }
  })
  disabled.start()
  assert.equal(disabled.check(), false)
})

test('配置 v1.0.0 新字段默认值与校验', () => {
  const config = loadConfig(baseEnv(), '1.0.0')
  assert.equal(config.watchdog.enabled, true)
  assert.equal(config.rssLimitMb, 0)
  assert.equal(config.aiToolsEnabled, false)
  assert.deepEqual(config.aiToolAllowlist, ['status', 'inventory', 'task_status'])
  assert.equal(config.autoRestock, true)
  assert.equal(config.mining.deepEnabled, false)
  assert.deepEqual(config.mining.ores.length > 0, true)
  assert.equal(config.storageChests.ores, null)
  assert.deepEqual(config.exploreWaypoints, [])
  assert.equal(config.inventoryAlertFreeSlots, 2)
  assert.equal(config.foodAlertThreshold, 4)

  const custom = loadConfig(baseEnv({
    AI_TOOLS_ENABLED: 'true',
    AI_TOOL_ALLOWLIST: 'status, inventory',    MINE_DEEP_ENABLED: 'true',
    MINE_DEEP_MIN_Y: '10',
    MINE_DEEP_MAX_Y: '50',
    EXPLORE_WAYPOINTS: 'home:175:64:410;farm:180:64:435',
    CHEST_ORES_X: '184',
    CHEST_ORES_Y: '64',
    CHEST_ORES_Z: '437',
    AUTO_RESTOCK: 'true'
  }), '1.0.0')
  assert.equal(custom.aiToolsEnabled, true)
  assert.deepEqual(custom.aiToolAllowlist, ['status', 'inventory'])
  assert.deepEqual(custom.exploreWaypoints.map(point => point.name), ['home', 'farm'])
  assert.deepEqual(custom.storageChests.ores, { x: 184, y: 64, z: 437 })
  assert.equal(custom.autoRestock, true)

  assert.throws(() => loadConfig(baseEnv({ AI_TOOL_ALLOWLIST: 'rm_rf' })), /unknown tool/)
  assert.throws(() => loadConfig(baseEnv({ CHEST_ORES_X: '184' })), /set together/)
  assert.throws(() => loadConfig(baseEnv({ EXPLORE_WAYPOINTS: 'bad:1:64:1' })), /SAFE_MIN_X/)
  assert.throws(() => loadConfig(baseEnv({ MINE_DEEP_ENABLED: 'true', MINE_DEEP_MAX_Y: '70' })), /MINE_DEEP_MAX_Y/)
})

test('挖矿深层带：关闭时仅表层，开启后深层优先且不重叠', () => {
  const base = loadConfig(baseEnv(), '1.0.0')
  assert.deepEqual(miningBands(base), [[60, 120]])
  const deep = loadConfig(baseEnv({ MINE_DEEP_ENABLED: 'true' }), '1.0.0')
  assert.deepEqual(miningBands(deep), [[0, 59], [60, 120]])
})

test('分箱归类：矿石/食物/树苗/杂项', () => {
  const bot = fakeBot(['bread', 'cod'])
  const category = (name: string): string => itemStorageCategory(bot, { name } as Item)
  assert.equal(category('iron_ore'), 'ores')
  assert.equal(category('deepslate_iron_ore'), 'ores')
  assert.equal(category('raw_iron'), 'ores')
  assert.equal(category('bread'), 'food')
  assert.equal(category('cod'), 'food')
  assert.equal(category('oak_sapling'), 'saplings')
  assert.equal(category('oak_log'), 'misc')
  assert.equal(category('cobblestone'), 'misc')
})
