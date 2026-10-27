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

bot.once('spawn', () => {
  console.log('[sender] spawned at', bot.entity.position)
  setTimeout(() => bot.chat(process.env.SEND_TEXT ?? 'hello from SmokeTester'), 1500)
})
bot.on('chat', (u, m) => console.log('[sender] chat', u, m))
bot.on('kicked', r => console.log('[sender] KICKED', JSON.stringify(r)))
bot.on('error', e => console.log('[sender] ERROR', e?.message ?? e))
bot.on('end', r => { console.log('[sender] END', r); process.exit(0) })
setTimeout(() => bot.quit('sender done'), Number(process.env.SEND_MS ?? 12000))
