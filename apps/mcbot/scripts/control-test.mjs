const base = (process.env.MCBOT_HTTP_URL ?? 'http://127.0.0.1:3010').replace(/\/+$/, '')
const readToken = process.env.MCBOT_HTTP_TOKEN ?? ''
const controlToken = process.env.MCBOT_CONTROL_TOKEN ?? ''
if (!readToken || !controlToken) {
  console.error('MCBOT_HTTP_TOKEN and MCBOT_CONTROL_TOKEN are required')
  process.exit(1)
}

async function request (method, path, token, body) {
  const headers = { Authorization: `Bearer ${token}` }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await response.text()
  console.log(`[control] ${method} ${path} -> ${response.status} ${text.slice(0, 400)}`)
  return { status: response.status, text }
}

const action = process.argv[2] ?? 'status'
if (action === 'status') {
  await request('GET', '/task', readToken)
} else if (action === 'start') {
  await request('POST', '/task/start', controlToken, { name: process.argv[3] ?? 'fishing' })
} else if (action === 'stop') {
  await request('POST', '/task/stop', controlToken, {})
} else if (action === 'resume') {
  await request('POST', '/task/resume', controlToken, process.argv[3] ? { taskId: process.argv[3] } : {})
} else if (action === 'move') {
  await request('POST', '/move', controlToken, { action: process.argv[3] ?? 'home', target: process.argv[4] })
} else if (action === 'forbidden') {
  await request('POST', '/task/start', readToken, { name: 'fishing' })
  await request('GET', '/task', controlToken)
} else {
  console.error('usage: node control-test.mjs status|start [fishing|farming]|stop|resume [taskId]|move <home|come|follow|stop> [target]|forbidden')
  process.exit(2)
}
