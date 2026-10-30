/** v0.5.10 连通性探测（Pi 直连，无代理层）：外网、QQ 平台探针与恢复回调。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatbotConnectivityMonitor, type ConnectivityDeps } from '../src/chatbot/connectivity.ts'

function monitor(overrides: Partial<ConnectivityDeps> = {}) {
  const events: string[] = []
  const deps: ConnectivityDeps = {
    enabled: true,
    intervalSeconds: 60,
    timeoutSeconds: 2,
    getPlatforms: () => ['qq'],
    fetchImpl: async () => new Response('{}', { status: 200 }),
    log: (level, message) => events.push(`${level}:${message}`),
    onRecover: () => events.push('recover'),
    onDown: () => events.push('down'),
    ...overrides,
  }
  return { monitor: new ChatbotConnectivityMonitor(deps), events }
}

test('v0.5.10 连通性：外网不可达时平台探针同样判不可达', async () => {
  let fetched = 0
  const { monitor: m } = monitor({
    fetchImpl: (async () => {
      fetched += 1
      throw new Error('fetch failed')
    }) as typeof fetch,
  })
  const snapshot = await m.checkNow()
  assert.equal(snapshot.internet.reachable, false)
  assert.equal(snapshot.platforms.qq?.reachable, false)
  assert.equal(fetched, 2)
})

test('v0.5.10 连通性：外网与 QQ 平台可达，4xx 仍视为网络可达', async () => {
  const urls: string[] = []
  const { monitor: m } = monitor({
    fetchImpl: (async (input: string | URL | Request) => {
      urls.push(String(input))
      return new Response('', { status: 401 })
    }) as typeof fetch,
  })
  const snapshot = await m.checkNow()
  assert.equal(snapshot.internet.reachable, true)
  assert.equal(snapshot.internet.status, 401)
  assert.equal(snapshot.platforms.qq?.reachable, true)
  assert.equal(urls.length, 2)
  assert.ok(urls.some((url) => url.includes('bots.qq.com')))
  assert.ok(!urls.some((url) => url.includes('chatbots.qq.com')))
  assert.ok(urls.some((url) => url.includes('www.qq.com')))
})

test('v0.5.10 连通性：网络从不可用恢复时触发一次自动恢复回调', async () => {
  let down = true
  const { monitor: m, events } = monitor({
    fetchImpl: (async () => {
      if (down) throw new Error('fetch failed')
      return new Response('{}', { status: 200 })
    }) as typeof fetch,
  })
  const first = await m.checkNow()
  assert.equal(first.internet.reachable, false)
  assert.equal(events.filter((event) => event === 'recover').length, 0)
  down = false
  const second = await m.checkNow()
  assert.equal(second.internet.reachable, true)
  assert.equal(events.filter((event) => event === 'recover').length, 1)
  await m.checkNow()
  assert.equal(events.filter((event) => event === 'recover').length, 1)
})

test('v0.5.10 连通性：网络从可用变为不可用时触发一次 down 回调', async () => {
  let down = false
  const { monitor: m, events } = monitor({
    fetchImpl: (async () => {
      if (down) throw new Error('fetch failed')
      return new Response('{}', { status: 200 })
    }) as typeof fetch,
  })
  await m.checkNow()
  down = true
  const snapshot = await m.checkNow()
  assert.equal(snapshot.internet.reachable, false)
  assert.equal(events.filter((event) => event === 'down').length, 1)
})

test('v0.5.10 连通性：无启用平台时只探测外网', async () => {
  const { monitor: m } = monitor({ getPlatforms: () => [] })
  const snapshot = await m.checkNow()
  assert.equal(snapshot.internet.reachable, true)
  assert.deepEqual(snapshot.platforms, {})
})
