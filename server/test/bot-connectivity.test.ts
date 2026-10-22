/** v0.5.3 连通性探测：代理端口、外网、平台探针与恢复回调。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { BotConnectivityMonitor, type ConnectivityDeps } from '../src/bot/connectivity.ts'

function monitor(overrides: Partial<ConnectivityDeps> & { proxyUrl?: string } = {}) {
  const events: string[] = []
  const deps: ConnectivityDeps = {
    enabled: true,
    intervalSeconds: 60,
    timeoutSeconds: 2,
    proxyUrl: 'http://127.0.0.1:18090',
    getPlatforms: () => ['qq'],
    fetchImpl: async () => new Response('{}', { status: 200 }),
    probePort: async () => true,
    log: (level, message) => events.push(`${level}:${message}`),
    onRecover: () => events.push('recover'),
    onDown: () => events.push('down'),
    ...overrides,
  }
  return { monitor: new BotConnectivityMonitor(deps), events }
}

test('v0.5.3 连通性：代理端口不可达时不发起外网探测', async () => {
  let fetched = 0
  const { monitor: m } = monitor({
    probePort: async () => false,
    fetchImpl: (async () => {
      fetched += 1
      return new Response('{}')
    }) as typeof fetch,
  })
  const snapshot = await m.checkNow()
  assert.equal(snapshot.proxy.portReachable, false)
  assert.equal(snapshot.internet.reachable, false)
  assert.equal(snapshot.internet.error, 'proxy_port_unreachable')
  assert.equal(fetched, 0)
  assert.equal(snapshot.platforms.qq?.reachable, false)
})

test('v0.5.3 连通性：代理与外网可达时探测 QQ 平台，4xx 仍视为网络可达', async () => {
  const urls: string[] = []
  const { monitor: m } = monitor({
    fetchImpl: (async (input: string | URL | Request) => {
      urls.push(String(input))
      return new Response('', { status: 401 })
    }) as typeof fetch,
  })
  const snapshot = await m.checkNow()
  assert.equal(snapshot.proxy.portReachable, true)
  assert.equal(snapshot.internet.reachable, true)
  assert.equal(snapshot.internet.status, 401)
  assert.equal(snapshot.platforms.qq?.reachable, true)
  assert.equal(urls.length, 2)
  assert.ok(urls.some((url) => url.includes('bots.qq.com')))
})

test('v0.5.3 连通性：网络从不可用恢复时触发一次自动恢复回调', async () => {
  let portOk = false
  const { monitor: m, events } = monitor({
    probePort: async () => portOk,
    fetchImpl: async () => new Response('{}', { status: 200 }),
  })
  const first = await m.checkNow()
  assert.equal(first.internet.reachable, false)
  assert.equal(events.filter((event) => event === 'recover').length, 0)
  portOk = true
  const second = await m.checkNow()
  assert.equal(second.internet.reachable, true)
  assert.equal(events.filter((event) => event === 'recover').length, 1)
  await m.checkNow()
  assert.equal(events.filter((event) => event === 'recover').length, 1)
})

test('v0.5.3 连通性：网络从可用变为不可用时触发一次 down 回调', async () => {
  let portOk = true
  const { monitor: m, events } = monitor({
    probePort: async () => portOk,
    fetchImpl: async () => new Response('{}', { status: 200 }),
  })
  await m.checkNow()
  portOk = false
  const snapshot = await m.checkNow()
  assert.equal(snapshot.internet.reachable, false)
  assert.equal(events.filter((event) => event === 'down').length, 1)
})

test('v0.5.3 连通性：未配置代理时直接探测外网，代理状态为未配置', async () => {
  const { monitor: m } = monitor({ proxyUrl: '', getPlatforms: () => [] })
  const snapshot = await m.checkNow()
  assert.equal(snapshot.proxy.configured, false)
  assert.equal(snapshot.internet.reachable, true)
  assert.deepEqual(snapshot.platforms, {})
})
