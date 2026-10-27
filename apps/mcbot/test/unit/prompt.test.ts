import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildGameContext,
  buildPrompt,
  sanitizeAiOutput
} from '../../src/ai/prompt.ts'

test('buildPrompt contains persona, player message and recent memory', () => {
  const prompt = buildPrompt({
    player: 'Antifield',
    message: '你好',
    context: '游戏状态：主世界',
    turns: [
      { role: 'user', text: '旧消息', at: new Date().toISOString() },
      { role: 'assistant', text: '旧回复', at: new Date().toISOString() }
    ],
    maxChars: 2000
  })
  assert.ok(prompt.includes('Lofii'))
  assert.ok(prompt.includes('Antifield 对你说：你好'))
  assert.ok(prompt.includes('旧消息'))
  assert.ok(prompt.length <= 2000)
})

test('buildPrompt drops old memory to respect the budget', () => {
  const turns = Array.from({ length: 60 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    text: `turn-${index}-${'x'.repeat(50)}`,
    at: new Date().toISOString()
  }))
  const prompt = buildPrompt({
    player: 'Antifield',
    message: '最新消息',
    context: '游戏状态',
    turns,
    maxChars: 1200
  })
  assert.ok(prompt.length <= 1200)
  assert.ok(prompt.includes('最新消息'))
  assert.ok(!prompt.includes('turn-0-'))
})

test('sanitizeAiOutput removes formatting and control characters', () => {
  const cleaned = sanitizeAiOutput('**你好** `世界`\n```js\ncode\n```\n§a绿色')
  assert.equal(cleaned.includes('**'), false)
  assert.equal(cleaned.includes('`'), false)
  assert.equal(cleaned.includes('§'), false)
  assert.ok(cleaned.includes('你好'))
})

test('buildGameContext handles disconnected bot', () => {
  assert.ok(buildGameContext(null).includes('未连接'))
})
