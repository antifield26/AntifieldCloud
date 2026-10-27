/** v0.7.0 已知问题回归：模型把 DSML 工具调用协议当普通文本返回时，不得回显给用户。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { c2cWebhook, createQqServiceFixture, lastMessageText, sendWebhook } from './chatbot-qq-fixtures.ts'
import { extractRawToolCallText, hasRawToolCallText, stripRawToolCallText } from '../src/chatbot/dsml.ts'

// 实际模型输出形状：<｜｜DSML｜｜ calls> ... </｜｜DSML｜｜ parameter>（两侧各两个全角竖线）。
const B = '\uFF5C\uFF5C'
const DSML_RAW = [
  `<${B}DSML${B} calls>`,
  `<${B}DSML${B} invoke name="botmsg_send_message">`,
  `<${B}DSML${B} parameter name="text" string="true">早上好呀，今天也要开心！</${B}DSML${B} parameter>`,
  `<${B}DSML${B} parameter name="turn_id" string="true">turn-1</${B}DSML${B} parameter>`,
  `<${B}DSML${B} parameter name="turn_token" string="true">secret-turn-token</${B}DSML${B} parameter>`,
  `</${B}DSML${B} invoke>`,
  `</${B}DSML${B} calls>`,
].join('\n')

test('DSML 文本：识别并提取 parameter text，剥离全部工具协议', () => {
  assert.equal(hasRawToolCallText(DSML_RAW), true)
  const extracted = extractRawToolCallText(DSML_RAW)
  assert.equal(extracted.detected, true)
  assert.equal(extracted.text, '早上好呀，今天也要开心！')
  const stripped = stripRawToolCallText(`前缀\n${DSML_RAW}\n后缀`)
  assert.equal(stripped.includes('DSML'), false)
  assert.equal(stripped.includes('turn_token'), false)
  assert.equal(stripped.includes('secret-turn-token'), false)
  assert.equal(stripped.includes('botmsg_send_message'), false)
  assert.equal(stripped.includes('前缀'), true)
  assert.equal(stripped.includes('后缀'), true)
})

test('DSML 文本：无 text 参数时检测到原始调用但不提取正文', () => {
  const raw = `<${B}DSML${B} calls>\n<${B}DSML${B} invoke name="botmsg_send_message">\n<${B}DSML${B} parameter name="turn_id" string="true">t</${B}DSML${B} parameter>\n</${B}DSML${B} invoke>\n</${B}DSML${B} calls>`
  const extracted = extractRawToolCallText(raw)
  assert.equal(extracted.detected, true)
  assert.equal(extracted.text, '')
  assert.equal(stripRawToolCallText(raw), '')
})

test('Chat 兜底：原始工具调用文本只发送 text 参数，且审计记录', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    aiHandler: async () => DSML_RAW,
    configOverrides: { chatbotChatBurstWindowMs: 0, chatbotAiSendToolEnabled: true },
  })
  try {
    const webhook = c2cWebhook(fixture.appSecret, { id: 'dsml-chat-1', content: '早上好' })
    await sendWebhook(fixture, webhook)
    const reply = lastMessageText(fixture)
    assert.equal(reply, '早上好呀，今天也要开心！')
    assert.equal(reply.includes('DSML'), false)
    assert.equal(reply.includes('botmsg_send_message'), false)
    assert.equal(reply.includes('secret-turn-token'), false)
    assert.ok(fixture.audits.some((entry) => entry.action === 'chatbot.ai.tool_call_text'))
  } finally {
    fixture.cleanup()
  }
})

test('Chat 兜底：无 text 参数的原始工具调用不发送任何协议文本', async () => {
  const raw = `<${B}DSML${B} calls>\n<${B}DSML${B} invoke name="botmsg_send_message">\n<${B}DSML${B} parameter name="turn_token" string="true">secret-turn-token</${B}DSML${B} parameter>\n</${B}DSML${B} invoke>\n</${B}DSML${B} calls>`
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    aiHandler: async () => raw,
    configOverrides: { chatbotChatBurstWindowMs: 0, chatbotAiSendToolEnabled: true },
  })
  try {
    const webhook = c2cWebhook(fixture.appSecret, { id: 'dsml-chat-2', content: '你好' })
    await sendWebhook(fixture, webhook)
    const reply = lastMessageText(fixture)
    assert.equal(reply, '暂时没回应上来，稍后再试。')
    assert.equal(reply.includes('DSML'), false)
    assert.equal(reply.includes('secret-turn-token'), false)
  } finally {
    fixture.cleanup()
  }
})

test('发送工具关闭时同样不回显原始工具调用', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    aiHandler: async () => DSML_RAW,
    configOverrides: { chatbotChatBurstWindowMs: 0, chatbotAiSendToolEnabled: false },
  })
  try {
    const webhook = c2cWebhook(fixture.appSecret, { id: 'dsml-chat-3', content: '你好' })
    await sendWebhook(fixture, webhook)
    const reply = lastMessageText(fixture)
    assert.equal(reply, '早上好呀，今天也要开心！')
    assert.equal(reply.includes('DSML'), false)
  } finally {
    fixture.cleanup()
  }
})
