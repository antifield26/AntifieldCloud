import mineflayer from 'mineflayer'
import util from 'node:util'

const bot = mineflayer.createBot({
  host: process.env.MC_HOST ?? '169.254.77.10',
  port: Number(process.env.MC_PORT ?? 25565),
  username: 'lofii',
  auth: 'offline',
  version: process.env.MC_VERSION ?? '26.1',
  viewDistance: 'short',
  chatLengthLimit: 256,
  physicsEnabled: true,
  checkTimeoutInterval: 60000,
  hideErrors: false
})

function dump (label, args) {
  console.log(`[probe] ${label}`, util.inspect(args, { depth: 4, breakLength: 200, colors: false }))
}

bot.once('spawn', () => {
  console.log('[probe] spawned; players=', Object.entries(bot.players).map(([name, p]) => `${name}:${p.uuid}`))
})

bot.on('chat', (...args) => {
  const [username, message, translate, jsonMsg] = args
  console.log('[probe] chat-event', JSON.stringify({
    username, message, translate,
    json: jsonMsg?.json,
    toString: jsonMsg?.toString?.()
  }))
})

bot.on('messagestr', (...args) => {
  const [message, position, jsonMsg, sender, verified] = args
  console.log('[probe] messagestr', JSON.stringify({
    message, position, sender, verified,
    translate: jsonMsg?.translate,
    json: jsonMsg?.json,
    toString: jsonMsg?.toString?.()
  }))
})

bot.on('message', (...args) => {
  const [jsonMsg, position, sender, verified] = args
  console.log('[probe] message-event', JSON.stringify({
    position, sender, verified,
    translate: jsonMsg?.translate,
    json: jsonMsg?.json,
    toString: jsonMsg?.toString?.()
  }))
})

bot.on('kicked', r => console.log('[probe] KICKED', JSON.stringify(r)))
bot.on('error', e => console.log('[probe] ERROR', e?.message ?? e))
bot.on('end', r => { console.log('[probe] END', r); process.exit(0) })

setTimeout(() => bot.quit('probe done'), Number(process.env.PROBE_MS ?? 45000))
process.on('SIGINT', () => bot.quit('sigint'))
