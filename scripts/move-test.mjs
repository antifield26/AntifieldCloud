import mineflayer from 'mineflayer'

const bot = mineflayer.createBot({
  host: process.env.MC_HOST ?? '169.254.77.10',
  port: Number(process.env.MC_PORT ?? 25565),
  username: process.env.SMOKE_USERNAME ?? 'SmokeTester',
  auth: 'offline',
  version: process.env.MC_VERSION ?? '26.1',
  viewDistance: 'short',
  chatLengthLimit: 256,
  physicsEnabled: true,
  checkTimeoutInterval: 60000,
  hideErrors: false
})

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function distanceToLofii () {
  const entity = bot.players.lofii?.entity
  if (!entity || !bot.entity) return null
  return bot.entity.position.distanceTo(entity.position)
}

function walk (ms) {
  bot.setControlState('forward', true)
  const jump = setInterval(() => {
    bot.setControlState('jump', true)
    setTimeout(() => bot.setControlState('jump', false), 150)
  }, 900)
  return sleep(ms).then(() => {
    clearInterval(jump)
    bot.setControlState('forward', false)
    bot.setControlState('jump', false)
  })
}

bot.on('chat', (user, message) => {
  if (user === 'lofii') console.log('[move] lofii:', message)
})
bot.on('kicked', r => console.log('[move] KICKED', JSON.stringify(r)))
bot.on('error', e => console.log('[move] ERROR', e?.message ?? e))
bot.on('end', r => { console.log('[move] END', r); process.exit(0) })

bot.once('spawn', async () => {
  console.log('[move] tester spawned at', bot.entity.position)
  for (let i = 0; i < 90; i++) {
    if (bot.players.lofii) break
    await sleep(500)
  }
  if (!bot.players.lofii) {
    console.log('[move] FAIL lofii not online')
    process.exit(1)
  }
  console.log('[move] lofii online; WAITING_TELEPORT 12s')
  await sleep(12000)
  console.log('[move] tester now at', bot.entity.position, 'distance to lofii', distanceToLofii())

  console.log('[move] follow test')
  bot.chat('Lofii 跟随我')
  await sleep(1500)
  await walk(3000)
  await sleep(2500)
  const followDistance = distanceToLofii()
  console.log('[move] after follow walk: tester', bot.entity.position, 'lofii', bot.players.lofii?.entity?.position, 'distance', followDistance)

  bot.chat('Lofii 停下')
  await sleep(1500)
  await walk(3000)
  await sleep(1000)
  console.log('[move] come test from distance', distanceToLofii())
  bot.chat('Lofii 过来')
  await sleep(12000)
  const comeDistance = distanceToLofii()
  console.log('[move] after come: tester', bot.entity.position, 'lofii', bot.players.lofii?.entity?.position, 'distance', comeDistance)
  console.log('[move] RESULT followDistance=' + followDistance + ' comeDistance=' + comeDistance)

  bot.quit('move done')
  setTimeout(() => process.exit(0), 1000)
})

setTimeout(() => {
  console.log('[move] overall timeout')
  bot.quit('timeout')
  process.exit(1)
}, 120000)
