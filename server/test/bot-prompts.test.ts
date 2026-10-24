/**
 * v0.5.9 提示词：普通 Chat 使用角色卡（个人卡或内置 lofii），固定安全边界与记忆注入；
 * 任务模式与自定义提示词已随 /ask 移除。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { SAFETY_BOUNDARY, buildBotPrompt } from '../src/bot/prompts.ts'
import { DEFAULT_CHAT_ROLE } from '../src/bot/roles.ts'

test('提示词：默认使用内置 lofii 角色、固定安全边界；无记忆时不注入空记忆段', () => {
  const prompt = buildBotPrompt({ userText: '整理一下备份现状' })
  assert.ok(prompt.includes('[系统提示]'))
  assert.ok(prompt.includes('[角色卡：lofii]'))
  assert.ok(prompt.includes(DEFAULT_CHAT_ROLE.prompt))
  // 默认角色卡只保留名字 + 对话风格，不再注入详细人设/背景，避免影响用户对话调整出的个性。
  assert.match(DEFAULT_CHAT_ROLE.prompt, /对话风格/u)
  assert.ok(DEFAULT_CHAT_ROLE.prompt.length <= 220)
  assert.equal(DEFAULT_CHAT_ROLE.prompt.includes('猫系'), false)
  assert.equal(DEFAULT_CHAT_ROLE.prompt.includes('撒娇'), false)
  assert.ok(!prompt.includes('[模式：'))
  assert.ok(!prompt.includes('/ask'))
  assert.ok(prompt.includes(SAFETY_BOUNDARY))
  assert.equal(prompt.includes('[长期记忆'), false, '无记忆时不注入空记忆段')
  assert.match(prompt, /整理一下备份现状$/)
})

test('提示词：群聊环境声明未点名时不要每轮发言，点名时正常回复', () => {
  const all = buildBotPrompt({ groupMode: 'all', replyDecision: true, userText: '大家在聊天' })
  assert.ok(all.includes('[群聊环境]'))
  assert.ok(all.includes('没有点名你'))
  assert.ok(all.includes('不要每轮都回复'))
  assert.ok(all.includes('普通闲聊保持沉默'))

  const mention = buildBotPrompt({ groupMode: 'mention', userText: '叫一下 Bot' })
  assert.ok(mention.includes('[群聊环境]'))
  assert.ok(mention.includes('明确 @你'))
  assert.equal(mention.includes('没有点名你'), false)

  const tool = buildBotPrompt({
    groupMode: 'all',
    userText: '普通群聊',
    sendTool: { turnId: 't1', turnToken: 'token1', toolName: 'send_message', required: false },
  })
  assert.ok(tool.includes('本轮不要求发送'))
  assert.ok(tool.includes('普通闲聊不需要每轮调用工具'))
})

test('提示词：个人角色卡覆盖 lofii，并保留安全边界与记忆', () => {
  const prompt = buildBotPrompt({
    roleCard: { name: '猫娘', prompt: '说话简短，偶尔用喵。' },
    memory: '用户喜欢深色模式',
    userText: '你好',
  })
  assert.ok(prompt.includes('[角色卡：猫娘]'))
  assert.ok(prompt.includes('说话简短，偶尔用喵。'))
  assert.equal(prompt.includes('[角色卡：lofii]'), false)
  assert.ok(prompt.includes(SAFETY_BOUNDARY))
  assert.ok(prompt.includes('用户喜欢深色模式'))
  assert.match(prompt, /\[用户消息\]\n你好$/)
})
