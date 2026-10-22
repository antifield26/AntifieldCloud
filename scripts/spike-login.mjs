import mineflayer from 'mineflayer'

const HOST = process.env.MC_HOST ?? '169.254.77.10'
const PORT = Number(process.env.MC_PORT ?? 25565)
const USERNAME = process.env.BOT_USERNAME ?? 'lofii'
const VERSION = process.env.MC_VERSION ?? '26.1'
const RUN_MS = Number(process.env.SPIKE_MS ?? 90000)

console.log(`[spike] connecting ${USERNAME}@${HOST}:${PORT} version=${VERSION}`)
const bot = mineflayer.createBot({
  host: HOST,
  port: PORT,
  username: USERNAME,
  auth: 'offline',
  version: VERSION,
  viewDistance: 'short',
  chatLengthLimit: 256,
  physicsEnabled: true,
  checkTimeoutInterval: 60000,
  hideErrors: false
})

let spawned = false

bot.once('spawn', () => {
  spawned = true
  console.log('[spike] SPAWN', JSON.stringify({
    position: bot.entity.position,
    yaw: bot.entity.yaw,
    dimension: bot.game.dimension,
    version: bot.version,
    players: Object.keys(bot.players)
  }))
  bot.chat('Lofii spike online')
  setTimeout(() => {
    console.log('[spike] position after 5s', bot.entity.position, 'health', bot.health, 'food', bot.food)
  }, 5000)
})

bot.on('chat', (username, message) => {
  console.log('[spike] CHAT', username, message)
})
bot.on('kicked', (reason) => {
  console.log('[spike] KICKED', JSON.stringify(reason))
})
bot.on('error', (err) => {
  console.log('[spike] ERROR', err?.message ?? err)
})
bot.on('end', (reason) => {
  console.log('[spike] END', reason)
  process.exit(0)
})
bot.on('death', () => {
  console.log('[spike] DEATH at', bot.entity?.position)
})

setTimeout(() => {
  console.log('[spike] still alive after', RUN_MS, 'ms, pos=', bot.entity?.position)
  bot.quit('spike done')
}, RUN_MS)

process.on('SIGINT', () => bot.quit('sigint'))
process.on('SIGTERM', () => bot.quit('sigterm'))
