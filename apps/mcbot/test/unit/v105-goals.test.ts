import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuditLogger } from '../../src/audit.ts'
import type { MovementManager } from '../../src/minecraft/movement.ts'
import type { TaskController } from '../../src/tasks/types.ts'
import type { TaskSnapshot } from '../../src/state.ts'
import { EventBus } from '../../src/events/bus.ts'
import { GoalStore } from '../../src/goals/store.ts'
import { GoalRunner } from '../../src/goals/runner.ts'
import { baseEnv, makeConfig, makeState, waitFor } from '../helpers.ts'

function fakeTasks (events: EventBus): TaskController & { starts: string[] } {
  const starts: string[] = []
  const snapshot = {
    enabled: true,
    active: false,
    name: null,
    state: 'idle',
    startedAt: null,
    elapsedSec: 0,
    progress: {},
    failures: 0,
    lastError: null,
    pendingResume: null,
    queue: []
  } as unknown as TaskSnapshot
  return {
    starts,
    async start (name: string) {
      starts.push(name)
      queueMicrotask(() => {
        events.emit('task', { action: 'completed', task: { name } })
      })
      return { status: 'started' as const }
    },
    requestStop: () => {},
    async stopAndWait () {},
    async depositNow () {},
    async confirmResume () {},
    async discardPending () {},
    snapshot: () => snapshot,
    keepOnline: () => false,
    isActive: () => false
  } as unknown as TaskController & { starts: string[] }
}

test('GoalRunner 串行执行 task→deposit 并持久化为 completed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcbot-goal-'))
  const config = makeConfig({}, { DATA_DIR: dir })
  const state = makeState(config)
  const events = new EventBus(100)
  const tasks = fakeTasks(events)
  const store = new GoalStore(join(dir, 'goals.db'))
  store.init()
  const audit = { append: () => {} } as unknown as AuditLogger
  const runner = new GoalRunner({
    config,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, withScope: () => ({}) } as never,
    state,
    tasks,
    movement: { home: async () => {} } as unknown as MovementManager,
    events,
    audit,
    store
  })
  try {
    const goal = runner.create('owner', '采集并存箱', [{ kind: 'task', taskName: 'woodcutting' }, { kind: 'deposit' }])
    await runner.start(goal.id, 'test')
    await waitFor(() => store.get(goal.id)?.status === 'completed', 2000)
    const restored = store.get(goal.id)
    assert.deepEqual(tasks.starts, ['woodcutting'])
    assert.equal(restored?.status, 'completed')
    assert.deepEqual(restored?.steps.map(step => step.status), ['completed', 'completed'])
  } finally {
    runner.stop()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
