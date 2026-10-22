import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractChatMessage,
  hasWakeWord,
  sanitizeInput,
  sanitizeOutgoing,
  splitOutgoing,
  stripWakeWord
} from '../../src/minecraft/chat.ts'

const players = {
  SmokeTester: { uuid: 'c0331953-99bf-361a-b929-38d6e6ae6ba4' },
  Antifield: { uuid: '3890dd7d-94a9-354d-8adc-351bffd69d12' }
}

test('extractChatMessage parses a vanilla player chat packet', () => {
  const jsonMsg = {
    toString: () => '<SmokeTester> hello from SmokeTester',
    json: { translate: '<%s> %s', with: ['SmokeTester', { text: 'hello from SmokeTester' }] }
  }
  const parsed = extractChatMessage(jsonMsg, 'chat', 'c0331953-99bf-361a-b929-38d6e6ae6ba4', players)
  assert.deepEqual(parsed, { username: 'SmokeTester', message: 'hello from SmokeTester' })
})

test('extractChatMessage ignores system messages and unknown senders', () => {
  const jsonMsg = {
    toString: () => 'SmokeTester joined the game',
    json: { translate: 'multiplayer.player.joined', with: ['SmokeTester'] }
  }
  assert.equal(extractChatMessage(jsonMsg, 'system', null, players), null)
  assert.equal(extractChatMessage(jsonMsg, 'chat', null, {}), null)
})

test('extractChatMessage falls back to rendered <name> format', () => {
  const jsonMsg = { toString: () => '<Antifield> 你好', json: {} }
  const parsed = extractChatMessage(jsonMsg, 'chat', null, players)
  assert.deepEqual(parsed, { username: 'Antifield', message: '你好' })
})

test('wake word matching and stripping', () => {
  assert.equal(hasWakeWord('Lofii 你好'), true)
  assert.equal(hasWakeWord('@Lofii 状态'), true)
  assert.equal(hasWakeWord('xlofii'), false)
  assert.equal(hasWakeWord('hello'), false)
  assert.equal(stripWakeWord('Lofii， 状态'), '状态')
  assert.equal(stripWakeWord('@Lofii 你好'), '你好')
  assert.equal(stripWakeWord('hi Lofii hello'), 'hello')
})

test('sanitizeInput strips formatting and truncates code points', () => {
  assert.equal(sanitizeInput('§a你好\n世界\u0000', 100), '你好 世界')
  assert.equal(Array.from(sanitizeInput('你好世界', 2)).length, 2)
})

test('sanitizeOutgoing never produces a slash command', () => {
  assert.equal(sanitizeOutgoing('/op Antifield'), '／op Antifield')
  assert.equal(sanitizeOutgoing('§c红色\n换行'), '红色 换行')
})

test('splitOutgoing respects line limits and marks truncation', () => {
  const lines = splitOutgoing('a'.repeat(500), 240, 2)
  assert.equal(lines.length, 2)
  assert.equal(Array.from(lines[1] ?? '').length, 240)
  assert.ok((lines[1] ?? '').endsWith('…'))
  assert.deepEqual(splitOutgoing('   ', 240, 3), [])
})

test('splitOutgoing keeps every line under the chat limit', () => {
  const lines = splitOutgoing('Lofii 你好 '.repeat(80), 100, 3)
  assert.ok(lines.length <= 3)
  for (const line of lines) assert.ok(Array.from(line).length <= 100)
})
