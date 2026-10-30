import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../src/config.ts'
import { PresenceStore } from '../../src/presence/store.ts'
import { GoalStore, validateGoalSteps } from '../../src/goals/store.ts'
import { baseEnv } from '../helpers.ts'

function tempDir (): string {
  return mkdtempSync(join(tmpdir(), 'mcbot-v105-'))
}

test('v1.0.5 默认开启自动生存/补货，并保留在线模式默认 auto', () => {
  const config = loadConfig(baseEnv(), '1.0.5')
  assert.equal(config.autoSurvival, true)
  assert.equal(config.autoRestock, true)
  assert.equal(config.autoEatBelow, 16)
  assert.equal(config.presenceMode, 'auto')
  assert.match(config.goalsFile, /goals\.db$/)
})

test('PresenceStore 原子持久化 auto/always/off，损坏文件回退 null', () => {
  const dir = tempDir()
  try {
    const store = new PresenceStore(join(dir, 'presence.json'))
    assert.equal(store.load(), null)
    store.save({ mode: 'always', updatedAt: '2026-10-30T00:00:00.000Z', updatedBy: 'test' })
    assert.deepEqual(store.load(), {
      mode: 'always',
      updatedAt: '2026-10-30T00:00:00.000Z',
      updatedBy: 'test'
    })
    writeFileSync(join(dir, 'presence.json'), '{"mode":"bad"}')
    assert.equal(store.load(), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('GoalStore 持久化目标/步骤，重启时把 running 改为 paused', () => {
  const dir = tempDir()
  const file = join(dir, 'goals.db')
  try {
    let store = new GoalStore(file)
    store.init()
    const goal = store.create('owner', '采集→存箱→补种', [
      { kind: 'task', taskName: 'woodcutting' },
      { kind: 'deposit' },
      { kind: 'task', taskName: 'farming' }
    ])
    assert.equal(goal.status, 'pending')
    assert.equal(goal.steps.length, 3)
    store.update(goal.id, { status: 'running', currentStep: 1 })
    store.close()

    store = new GoalStore(file)
    store.init()
    const restored = store.get(goal.id)
    assert.equal(restored?.status, 'paused')
    assert.equal(restored?.currentStep, 1)
    assert.equal(restored?.steps[0]?.taskName, 'woodcutting')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('validateGoalSteps 只允许白名单任务与 task/deposit/home，限制步数', () => {
  assert.deepEqual(validateGoalSteps([{ kind: 'task', taskName: 'clearing' }, { kind: 'home' }], 5), [
    { kind: 'task', taskName: 'clearing' },
    { kind: 'home' }
  ])
  assert.throws(() => validateGoalSteps([], 5))
  assert.throws(() => validateGoalSteps([{ kind: 'task', taskName: 'cooking' }], 5))
  assert.throws(() => validateGoalSteps([{ kind: 'task', taskName: 'clearing' }, { kind: 'deposit' }, { kind: 'home' }], 2))
  assert.throws(() => validateGoalSteps([{ kind: 'other' }], 5))
})
