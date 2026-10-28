#!/usr/bin/env node
/**
 * Agentic 实机验收 conductor（可选，非 CI）。
 *
 * 安全边界：
 * - 只访问显式给出的 loopback mcbot HTTP；不接触 Minecraft 协议/RCON。
 * - 写操作（start/stop）必须显式 --allow-writes；Token 只从环境读取，不打印/不写入报告。
 * - 默认 dry-run：仅检查 health/status；真实 AI 自主会话由部署后的 mcbot 内部 OpenCode 执行。
 *
 * 用法：
 *   MCBOT_READ_TOKEN=... MCBOT_CONTROL_TOKEN=... \
 *     node scripts/agentic-acceptance.mjs --allow-writes --goal "准备食物" --timeout-sec 120 --report .local/agentic-report.json
 */
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

const args = process.argv.slice(2)
function argValue (name, fallback = '') {
  const index = args.indexOf(name)
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback
}
const baseUrl = (argValue('--base-url', process.env.MCBOT_BASE_URL || 'http://127.0.0.1:3010')).replace(/\/+$/, '')
const readToken = process.env.MCBOT_READ_TOKEN || ''
const controlToken = process.env.MCBOT_CONTROL_TOKEN || ''
const allowWrites = args.includes('--allow-writes')
const goal = argValue('--goal', '')
const timeoutSec = Math.max(10, Number(argValue('--timeout-sec', '120')) || 120)
const reportPath = argValue('--report', path.join('.local', `agentic-acceptance-${Date.now()}.json`))
const steps = []
const report = { ok: false, baseUrl, startedAt: new Date().toISOString(), goal, steps, error: null }

function fail (message) {
  report.error = message
  throw new Error(message)
}
function assert (condition, message) {
  if (!condition) fail(message)
}
async function request (method, pathName, token, body) {
  const response = await fetch(baseUrl + pathName, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(15000)
  })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* optional */ }
  return { status: response.status, json }
}
function record (name, ok, detail) {
  steps.push({ at: new Date().toISOString(), name, ok, detail: detail ? String(detail).slice(0, 300) : null })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`)
}
async function main () {
  assert(readToken, 'MCBOT_READ_TOKEN is required')
  assert(baseUrl.startsWith('http://127.0.0.1:') || baseUrl.startsWith('http://localhost:'), 'base-url must be loopback http')
  const health = await request('GET', '/healthz')
  record('healthz', health.status === 200 && health.json?.status === 'ok', `status=${health.status}`)
  const status = await request('GET', '/status', readToken)
  record('status', status.status === 200 && typeof status.json?.version === 'string', `version=${status.json?.version ?? 'unknown'}`)
  if (!allowWrites) {
    record('dry-run', true, '跳过 autonomy 写操作；加 --allow-writes 执行实机验收')
    return
  }
  assert(controlToken, 'MCBOT_CONTROL_TOKEN is required for --allow-writes')
  const start = await request('POST', '/autonomy/start', controlToken, goal ? { goal } : {})
  record('autonomy start', start.status === 200 || start.status === 202, `status=${start.status}`)
  assert(start.json?.ok !== false, `start rejected: ${start.json?.error ?? start.status}`)
  await new Promise(resolve => setTimeout(resolve, 1500))
  const snapshot = await request('GET', '/autonomy', readToken)
  record('autonomy snapshot', snapshot.status === 200 && snapshot.json?.autonomy !== undefined, `state=${snapshot.json?.autonomy?.state ?? 'missing'}`)
  const deadline = Date.now() + timeoutSec * 1000
  let final = snapshot.json?.autonomy ?? null
  while (Date.now() < deadline && final?.active === true) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    const next = await request('GET', '/autonomy', readToken)
    final = next.json?.autonomy ?? final
  }
  record('autonomy active/cleanup', final?.active === false, `state=${final?.state ?? 'unknown'} toolCalls=${final?.toolCalls ?? '?'}`)
  if (final?.active === true) {
    const stop = await request('POST', '/autonomy/stop', controlToken, { reason: 'acceptance_timeout' })
    record('autonomy stop', stop.status === 200 || stop.status === 202, `status=${stop.status}`)
  }
  const events = await request('GET', '/events/recent?limit=100', readToken)
  const autonomyEvents = (events.json?.events ?? []).filter(event => event?.type === 'autonomy')
  record('autonomy events', autonomyEvents.length > 0, `count=${autonomyEvents.length}`)
  report.ok = steps.every(step => step.ok)
}
try {
  await main()
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  console.error(`FAIL ${report.error}`)
} finally {
  report.finishedAt = new Date().toISOString()
  report.steps = steps
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8' })
  console.log(`report: ${reportPath}`)
  process.exit(report.ok ? 0 : 1)
}
