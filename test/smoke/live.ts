import mineflayer from 'mineflayer'

const host = process.env.MC_HOST ?? '169.254.77.10'
const port = Number(process.env.MC_PORT ?? 25565)
const username = process.env.SMOKE_USERNAME ?? 'SmokeTester'
const version = process.env.MC_VERSION ?? '26.1'
const skipAi = process.env.SMOKE_SKIP_AI === '1'

console.log(`[smoke] connecting ${username}@${host}:${port}`)
const bot = mineflayer.createBot({
  host,
  port,
  username,
  auth: 'offline',
  version,
  viewDistance: 'short',
  chatLengthLimit: 256,
  physicsEnabled: true,
  checkTimeoutInterval: 60000,
  hideErrors: false
})

const pending: Array<{ predicate: (message: string) => boolean, resolve: (message: string) => void, timer: NodeJS.Timeout }> = []

bot.on('chat', (user: string, message: string) => {
  if (user !== 'lofii') return
  for (const waiter of [...pending]) {
    if (waiter.predicate(message)) {
      clearTimeout(waiter.timer)
      pending.splice(pending.indexOf(waiter), 1)
      waiter.resolve(message)
    }
  }
})

function waitForLofii (predicate: (message: string) => boolean, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = pending.findIndex(waiter => waiter.timer === timer)
      if (index >= 0) pending.splice(index, 1)
      reject(new Error(`timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.push({ predicate, resolve, timer })
  })
}

function fail (message: string): never {
  console.error(`[smoke] FAIL: ${message}`)
  try { bot.quit('smoke failed') } catch { /* ignore */ }
  process.exit(1)
}

function sleep (ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForLofiiJoin (timeoutMs: number): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (bot.players.lofii) return
    await sleep(500)
  }
  throw new Error(`Lofii did not join within ${timeoutMs}ms (dynamic presence)`)
}

bot.once('spawn', async () => {
  try {
    console.log('[smoke] spawned at', bot.entity?.position)
    console.log('[smoke] waiting for Lofii to join (dynamic presence)')
    await waitForLofiiJoin(Number(process.env.SMOKE_WAIT_JOIN_MS ?? 45000))
    console.log('[smoke] Lofii is online')
    await sleep(500)

    console.log('[smoke] step: status')
    bot.chat('Lofii 状态')
    const statusReply = await waitForLofii(message => message.includes('位置') || message.includes('血量'), 15000)
    console.log('[smoke] status reply:', statusReply)

    console.log('[smoke] step: wave')
    bot.chat('Lofii 挥手')
    const waveReply = await waitForLofii(message => message.includes('嗨') || message.includes('挥手'), 15000)
    console.log('[smoke] wave reply:', waveReply)

    if (!skipAi) {
      console.log('[smoke] step: ai chat (waiting out per-player AI cooldown)')
      await sleep(11000)
      bot.chat('Lofii 你好，用一句话介绍你自己')
      const aiReply = await waitForLofii(message => message.trim().length > 0, 45000)
      console.log('[smoke] ai reply:', aiReply)
    }

    console.log('[smoke] PASS')
    bot.quit('smoke done')
    setTimeout(() => process.exit(0), 1000)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
})

bot.on('kicked', reason => fail(`kicked: ${JSON.stringify(reason)}`))
bot.on('error', error => fail(`error: ${error.message}`))
bot.on('end', reason => {
  if (pending.length > 0) fail(`disconnected before replies: ${reason}`)
})

setTimeout(() => fail('overall timeout'), 180000)
