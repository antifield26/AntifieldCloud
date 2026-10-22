import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCommand } from '../../src/minecraft/commands.ts'

test('parses natural-language commands', () => {
  assert.deepEqual(parseCommand('状态'), { name: 'status' })
  assert.deepEqual(parseCommand('status'), { name: 'status' })
  assert.deepEqual(parseCommand('你在哪'), { name: 'status' })
  assert.deepEqual(parseCommand('过来'), { name: 'come' })
  assert.deepEqual(parseCommand('跟随我'), { name: 'follow' })
  assert.deepEqual(parseCommand('跟随 Antifield'), { name: 'follow', target: 'Antifield' })
  assert.deepEqual(parseCommand('停下'), { name: 'stop' })
  assert.deepEqual(parseCommand('别跟了'), { name: 'stop' })
  assert.deepEqual(parseCommand('看我'), { name: 'look' })
  assert.deepEqual(parseCommand('挥手'), { name: 'wave' })
  assert.deepEqual(parseCommand('帮助'), { name: 'help' })
})

test('does not treat normal chat as a command', () => {
  assert.equal(parseCommand('你能过来吗'), null)
  assert.equal(parseCommand('你好呀'), null)
  assert.equal(parseCommand(''), null)
})

test('ignores punctuation around commands', () => {
  assert.deepEqual(parseCommand('，状态。'), { name: 'status' })
  assert.deepEqual(parseCommand('过来！'), { name: 'come' })
})
