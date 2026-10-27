const token = process.env.HTTP_TOKEN ?? '0123456789abcdef0123456789abcdef'
const base = process.env.HTTP_BASE ?? 'http://127.0.0.1:3010'
const duration = Number(process.env.POLL_MS ?? 35000)
const started = Date.now()
let last = ''
while (Date.now() - started < duration) {
  try {
    const response = await fetch(`${base}/status`, { headers: { Authorization: `Bearer ${token}` } })
    const status = await response.json()
    const line = `state=${status.state} connected=${status.minecraft.connected} online=${status.server.online} others=${status.presence.otherPlayers} decision=${status.presence.lastDecision}`
    if (line !== last) {
      console.log(`+${((Date.now() - started) / 1000).toFixed(1)}s ${line}`)
      last = line
    }
  } catch (error) {
    console.log(`+${((Date.now() - started) / 1000).toFixed(1)}s ERROR ${error.message}`)
  }
  await new Promise(resolve => setTimeout(resolve, 1000))
}
