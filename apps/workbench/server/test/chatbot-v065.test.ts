/**
 * v0.6.5：/role show 只对用户自定义角色卡展示详细文本；默认角色卡不展示内置设定。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CHAT_ROLE } from '../src/chatbot/roles.ts'
import { roleShowText } from '../src/chatbot/templates.ts'

test('v0.6.5：/role show 自定义角色展示完整详情，默认角色卡不展示详情', () => {
  const prompt = '你是一位耐心的老师。\n回答时先给结论，再分步骤解释。'
  const custom = roleShowText({ name: '老师', prompt, enabled: true })
  assert.match(custom, /当前角色：老师（专属，使用中）/)
  assert.match(custom, /角色卡详情：/)
  assert.ok(custom.endsWith(prompt), '应完整展示角色卡正文')

  const disabled = roleShowText({ name: '老师', prompt, enabled: false })
  assert.match(disabled, /当前角色：老师（专属，已暂停）/)
  assert.ok(disabled.endsWith(prompt))

  const fallback = roleShowText(null)
  assert.equal(fallback, `当前角色：${DEFAULT_CHAT_ROLE.name}（默认）`)
  assert.equal(fallback.includes(DEFAULT_CHAT_ROLE.prompt), false)
  assert.equal(fallback.includes('角色卡详情'), false)
})
