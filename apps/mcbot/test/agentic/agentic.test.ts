import assert from 'node:assert/strict'
import { test } from 'node:test'
import { autonomyFixture, callTool, startFixture } from './harness.ts'

test('agentic scenario: goal -> start_task -> task_status -> finish -> cleanup', async () => {
  const f = autonomyFixture()
  const { token, runId } = await startFixture(f, '准备一些鱼')
  const start = await callTool(f, token, 'start_task', { run_id: runId, task: 'fishing', reason: '目标需要鱼' })
  assert.equal(start.isError, false)
  assert.deepEqual(f.tasks.started[0], { name: 'fishing', username: 'autonomy', source: 'autonomy' })

  const status = await callTool(f, token, 'task_status', { run_id: runId }, 2)
  assert.equal(status.isError, false)
  assert.match(status.text, /fishing/)

  const finish = await callTool(f, token, 'finish', { run_id: runId, summary: '钓到鱼后结束' }, 3)
  assert.equal(finish.isError, false)
  f.session.finish()
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.equal(f.service.snapshot().state, 'finished')
  assert.equal(f.session.deleted >= 1, true)
})

test('agentic scenario: unsafe task and bad run_id are rejected without side effects', async () => {
  const f = autonomyFixture()
  const { token, runId } = await startFixture(f)
  const badTask = await callTool(f, token, 'start_task', { run_id: runId, task: 'build_base', reason: '越权' })
  const badRun = await callTool(f, token, 'start_task', { run_id: 'not-this-run', task: 'fishing', reason: '伪造' }, 2)
  assert.equal(badTask.isError, true)
  assert.equal(badRun.isError, true)
  assert.equal(f.tasks.started.length, 0)
  await f.service.stop('test')
})

test('agentic scenario: manual stop preempts an active autonomy session', async () => {
  const f = autonomyFixture()
  await startFixture(f)
  await f.service.stop('manual')
  assert.equal(f.service.snapshot().active, false)
  assert.equal(f.service.snapshot().state, 'finished')
  assert.equal(f.session.interrupted, 1)
  assert.equal(f.session.deleted, 1)
})

test('agentic scenario: unknown MCP tool cannot escape the allowlist', async () => {
  const f = autonomyFixture()
  const { token, runId } = await startFixture(f)
  const shell = await callTool(f, token, 'shell', { run_id: runId, reason: '越狱' })
  assert.equal(shell.isError, true)
  assert.equal(shell.status, 200)
  await f.service.stop('test')
})

test('agentic scenario: invalid token gets 401 and no state change', async () => {
  const f = autonomyFixture()
  const { token } = await startFixture(f)
  const wrong = await f.service.handleMcpHttp(token + 'x', { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.equal(wrong.status, 401)
  const valid = await f.service.handleMcpHttp(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
  assert.equal(valid.status, 200)
  await f.service.stop('test')
})
