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

const messages = (process.env.SEND_MESSAGES ?? 'Lofii 状态|Lofii 挥手|Lofii 你好|hello|Lofii 过来').split('|')
let index = 0

bot.once('spawn', () => {
  console.log('[tester] spawned at', bot.entity.position)
  const timer = setInterval(() => {
    const message = messages[index]
    if (message === undefined) {
      clearInterval(timer)
      setTimeout(() => bot.quit('tester done'), 3000)
      return
    }
    index += 1
    console.log('[tester] sending:', message)
    bot.chat(message)
  }, Number(process.env.SEND_INTERVAL_MS ?? 3000))
})

bot.on('chat', (u, m) => console.log('[tester] chat', u, '|', m))
bot.on('kicked', r => console.log('[tester] KICKED', JSON.stringify(r)))
bot.on('error', e => console.log('[tester] ERROR', e?.message ?? e))
bot.on('end', r => { console.log('[tester] END', r); process.exit(0) })
setTimeout(() => { console.log('[tester] overall timeout'); bot.quit('timeout') }, Number(process.env.TEST_MS ?? 30000))
