const base = process.env.HTTP_BASE ?? 'http://127.0.0.1:3010'
const token = process.env.HTTP_TOKEN ?? '0123456789abcdef0123456789abcdef'

async function call (label, path, options = {}) {
  const headers = { ...(options.headers ?? {}) }
  if (options.auth) headers.Authorization = `Bearer ${token}`
  if (options.json !== undefined) headers['Content-Type'] = 'application/json'
  try {
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.json !== undefined ? JSON.stringify(options.json) : options.body
    })
    const text = await response.text()
    console.log(`${label} -> ${response.status} ${text}`)
  } catch (error) {
    console.log(`${label} -> ERROR ${error instanceof Error ? error.message : String(error)}`)
  }
}

await call('healthz', '/healthz')
await call('status-noauth', '/status')
await call('status-auth', '/status', { auth: true })
await call('say-auth', '/say', { method: 'POST', auth: true, json: { message: '来自 HTTP 的问候' } })
await call('say-noauth', '/say', { method: 'POST', json: { message: 'no auth' } })
await call('say-slash', '/say', { method: 'POST', auth: true, json: { message: '/op SmokeTester' } })
await call('say-empty', '/say', { method: 'POST', auth: true, json: { message: '' } })
await call('say-long', '/say', { method: 'POST', auth: true, json: { message: 'x'.repeat(800) } })
await call('say-bad-json', '/say', { method: 'POST', auth: true, body: 'not-json', headers: { 'Content-Type': 'application/json' } })
await call('get-say', '/say', { auth: true })
await call('404', '/nope')
