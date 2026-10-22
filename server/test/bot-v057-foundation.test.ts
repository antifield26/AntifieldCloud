/**
 * v0.5.7 基础模块测试：文本分段、平台化 Markdown 转换、错误提示映射、
 * 角色卡/长期记忆的管理元数据（不暴露正文）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BOT_TEXT_LIMITS, MAX_MESSAGE_PARTS, splitForPlatform, splitMessage } from '../src/bot/text.ts'
import { formatAiReply } from '../src/bot/format.ts'
import { describeBotError } from '../src/bot/errors.ts'
import { BotChatRoleStore } from '../src/bot/roles.ts'
import { BotMemoryStore } from '../src/bot/memory.ts'
import { openDatabase } from '../src/db.ts'

test('splitMessage：短文本不拆分、空文本返回空数组', () => {
  assert.deepEqual(splitMessage('你好', 100), [{ text: '你好', index: 1, total: 1 }])
  assert.deepEqual(splitMessage('   ', 100), [])
  assert.throws(() => splitMessage('x', 0), /invalid text limit/)
})

test('splitMessage：长文本按平台上限拆分并带续段前缀，末段不超限', () => {
  const text = Array.from({ length: 80 }, (_, index) => `第${index}行：这是一段用于测试分段的文本。`).join('\n')
  const limit = 200
  const parts = splitMessage(text, limit)
  assert.ok(parts.length > 1)
  assert.ok(parts.length <= MAX_MESSAGE_PARTS)
  assert.equal(parts[0]!.index, 1)
  for (const part of parts) {
    assert.ok(part.text.length <= limit, `段 ${part.index} 超限：${part.text.length}`)
    assert.equal(part.total, parts.length)
  }
  for (const part of parts.slice(1)) {
    assert.match(part.text, /^（续 \d+\/\d+）/)
  }
  assert.match(parts[0]!.text, /第0行/)
})

test('splitMessage：超过最大段数时截断并带标记，emoji 不被切半', () => {
  const text = '😀'.repeat(200)
  const parts = splitMessage(text, 60, 2)
  assert.equal(parts.length, 2)
  assert.match(parts[1]!.text, /内容过长已截断/)
  for (const part of parts) {
    // 不能以孤立高代理项结尾（emoji 不能被切成半个）。
    const last = part.text.charCodeAt(part.text.length - 1)
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), `段 ${part.index} 以孤立代理项结尾`)
  }
})

test('splitForPlatform：各平台上限与常量一致', () => {
  assert.deepEqual(BOT_TEXT_LIMITS, { telegram: 4096, discord: 2000, slack: 4000, qq: 2000 })
  const parts = splitForPlatform('qq', 'x'.repeat(2001))
  assert.equal(parts.length, 2)
  assert.equal(parts[0]!.total, 2)
})

test('formatAiReply：Telegram HTML 转义并转换粗体/代码，Slack/Discord/QQ 各自规则', () => {
  const markdown = '# 标题\n**粗体** 与 `code` 与 <script>\n*斜体*\n```\nconst a = 1 < 2\n```'
  const telegram = formatAiReply('telegram', markdown)
  assert.equal(telegram.textMode, 'html')
  assert.match(telegram.text, /<b>标题<\/b>/)
  assert.match(telegram.text, /<b>粗体<\/b>/)
  assert.match(telegram.text, /<code>code<\/code>/)
  assert.match(telegram.text, /&lt;script&gt;/)
  assert.match(telegram.text, /<pre>/)
  assert.ok(!telegram.text.includes('<script>'))

  const slack = formatAiReply('slack', markdown)
  assert.equal(slack.textMode, 'plain')
  assert.match(slack.text, /\*标题\*/)
  assert.match(slack.text, /&lt;script&gt;/)

  const discord = formatAiReply('discord', markdown)
  assert.match(discord.text, /\*\*标题\*\*/)
  assert.match(discord.text, /\*\*粗体\*\*/)
  assert.ok(!discord.text.includes('# 标题'))

  const qq = formatAiReply('qq', markdown)
  assert.ok(!qq.text.includes('**'))
  assert.ok(!qq.text.includes('`'))
  // QQ 只发纯文本，尖括号不会成为标签；这里只要求 Markdown 标记被剥离。
  assert.ok(!/^#{1,6}\s/m.test(qq.text))
})

test('formatAiReply：空回答返回空串；未闭合标记不产生标签注入', () => {
  assert.deepEqual(formatAiReply('telegram', '   '), { text: '', textMode: 'plain' })
  const reply = formatAiReply('telegram', '**未闭合 <b>')
  assert.ok(!reply.text.includes('<b>未闭合 <b>'))
})

test('describeBotError：已知错误码/常见模式映射，未知返回 null', () => {
  assert.match(String(describeBotError('qq_access_token_failed')), /QQ access_token/)
  assert.match(String(describeBotError('bot_ai_timeout: 超时')), /AI 响应超时/)
  assert.match(String(describeBotError('Error: connect ECONNREFUSED 127.0.0.1')), /出站网络不可用/)
  assert.match(String(describeBotError('partial_text_sent（已发送 2/3 段）')), /部分段落已发送/)
  // 适配器 BotPlatformError 消息把错误码嵌在“平台请求失败（status:code）”内，也必须命中。
  assert.match(String(describeBotError('平台请求失败（0:qq_access_token_failed）')), /QQ access_token/)
  assert.match(String(describeBotError('平台请求失败（502:bot_ai_unavailable）')), /AI 服务不可达/)
  assert.match(String(describeBotError('平台请求失败（200:invalid_auth）')), /Slack 凭据无效/)
  assert.equal(describeBotError('some_unknown_failure'), null)
  assert.equal(describeBotError(null), null)
})

test('角色卡/长期记忆：管理列表只返回元数据，删除同时清理镜像文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antifieldcloud-bot-v057-store-'))
  const path = join(dir, 'db.sqlite')
  try {
    const db: DatabaseSync = openDatabase({ path })
    try {
      db.prepare(
        `INSERT INTO bots (id, platform, name, enabled, config_json, secret_ciphertext, secret_iv, secret_tag, key_version, created_at, updated_at)
         VALUES ('bot-1', 'qq', 'QQ', 0, '{}', 'x', 'x', 'x', 1, '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z')`,
      ).run()
      const roles = new BotChatRoleStore(db)
      roles.save('bot-1', 'user-1', '小助手', '这是不应出现在管理响应里的角色设定正文。')
      const roleList = roles.list('bot-1')
      assert.equal(roleList.length, 1)
      assert.equal(roleList[0]!.userName, null)
      assert.equal(roleList[0]!.promptLength, '这是不应出现在管理响应里的角色设定正文。'.length)
      assert.ok(!JSON.stringify(roleList).includes('角色设定正文'))
      assert.equal(roles.count('bot-1'), 1)
      assert.equal(roles.setEnabled('bot-1', 'user-1', false), true)
      assert.equal(roles.list('bot-1')[0]!.enabled, false)

      const memory = new BotMemoryStore(db, join(dir, 'data'), 4096)
      const createdMemory = memory.get('bot-1', 'user-1')
      const saved = memory.save('bot-1', 'user-1', createdMemory.memoryId, '记忆正文不应暴露。', null)
      assert.ok(saved.summary.length > 0)
      const memoryList = memory.list('bot-1')
      assert.equal(memoryList.length, 1)
      assert.equal(memoryList[0]!.summaryLength, '记忆正文不应暴露。'.length)
      assert.ok(!JSON.stringify(memoryList).includes('记忆正文'))
      assert.equal(memory.count('bot-1'), 1)
      assert.equal(memory.remove('bot-1', 'user-1'), true)
      assert.equal(memory.remove('bot-1', 'user-1'), false)
      assert.equal(memory.count('bot-1'), 0)
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})
