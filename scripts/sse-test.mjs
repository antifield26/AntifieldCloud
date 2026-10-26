const base = (process.env.LOFII_HTTP_URL ?? 'http://127.0.0.1:3010').replace(/\/+$/, '')
const token = process.env.LOFII_HTTP_TOKEN ?? ''
const durationMs = Number(process.env.SSE_MS ?? 15000)
if (!token) {
  console.error('LOFII_HTTP_TOKEN is required')
  process.exit(1)
}

const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), durationMs)
try {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }
  if (process.env.LAST_EVENT_ID) headers['Last-Event-ID'] = process.env.LAST_EVENT_ID
  const response = await fetch(`${base}/events`, { headers, signal: controller.signal })
  console.log('[sse] status', response.status, response.headers.get('content-type'))
  if (!response.ok) {
    console.log(await response.text())
    process.exit(1)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const event = frame.split('\n').find(line => line.startsWith('event: '))?.slice(7) ?? 'message'
      const id = frame.split('\n').find(line => line.startsWith('id: '))?.slice(4) ?? ''
      const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
      console.log('[sse]', event, id, data.slice(0, 500))
    }
  }
} catch (error) {
  if (error?.name !== 'AbortError') {
    console.error('[sse] error', error?.message ?? error)
    process.exitCode = 1
  }
} finally {
  clearTimeout(timer)
}
