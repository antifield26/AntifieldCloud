/**
 * v0.5.7/v0.5.8 基础模块测试：文本分段、QQ 纯文本 Markdown 剥离、错误提示映射、
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

test('splitForPlatform：QQ 上限 2000 且分段正确', () => {
  assert.deepEqual(BOT_TEXT_LIMITS, { qq: 2000 })
  const parts = splitForPlatform('qq', 'x'.repeat(2001))
  assert.equal(parts.length, 2)
  assert.equal(parts[0]!.total, 2)
  assert.ok(parts.every((part) => part.text.length <= 2000))
})

test('formatAiReply：剥离 Markdown 标记，保留可读正文（QQ 纯文本）', () => {
  const markdown = '# 标题\n**粗体** 与 `code` 与 <script>\n*斜体*\n```\nconst a = 1 < 2\n```'
  const reply = formatAiReply(markdown)
  assert.ok(!reply.includes('**'))
  assert.ok(!reply.includes('`'))
  assert.ok(!/^#{1,6}\s/m.test(reply))
  assert.match(reply, /标题/)
  assert.match(reply, /粗体/)
  assert.match(reply, /code/)
  assert.match(reply, /斜体/)
  // QQ 只发纯文本，尖括号不会成为标签。
  assert.match(reply, /<script>/)
  assert.equal(formatAiReply('   '), '')
})

test('describeBotError：QQ/通用错误码与包装消息映射，未知返回 null', () => {
  assert.match(String(describeBotError('qq_access_token_failed')), /QQ access_token/)
  assert.match(String(describeBotError('bot_ai_timeout: 超时')), /AI 响应超时/)
  assert.match(String(describeBotError('Error: connect ECONNREFUSED 127.0.0.1')), /出站网络不可用/)
  assert.match(String(describeBotError('partial_text_sent（已发送 2/3 段）')), /部分段落已发送/)
  // 适配器 BotPlatformError 消息把错误码嵌在“平台请求失败（status:code）”内，也必须命中。
  assert.match(String(describeBotError('平台请求失败（0:qq_access_token_failed）')), /QQ access_token/)
  assert.match(String(describeBotError('平台请求失败（502:bot_ai_unavailable）')), /AI 服务不可达/)
  assert.match(String(describeBotError('平台请求失败（401:unauthorized）')), /QQ 凭据无效/)
  assert.equal(describeBotError('some_unknown_failure'), null)
  assert.equal(describeBotError(null), null)
})

test('角色卡/长期记忆：管理列表只返回元数据，删除同时清理镜像文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antifieldcloud-bot-v058-store-'))
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

      const memory = new BotMemoryStore(db, join(dir, 'data'), {
        maxItems: 200,
        promptMaxChars: 3000,
        promptMaxItems: 12,
        factProjectTtlDays: 365,
        episodeTtlDays: 90,
        taskTtlDays: 30,
        legacyMaxChars: 4096,
      })
      const applied = memory.applyOperations('bot-1', 'user-1', [
        { op: 'upsert', kind: 'preference', key: 'coffee', value: '记忆正文不应暴露。', confidence: 0.9, importance: 3 },
      ])
      assert.equal(applied.upserts, 1)
      const memoryList = memory.listUsers('bot-1')
      assert.equal(memoryList.total, 1)
      assert.equal(memoryList.items[0]!.itemCount, 1)
      assert.equal(memoryList.items[0]!.kinds.preference, 1)
      assert.ok(!JSON.stringify(memoryList).includes('记忆正文'))
      const items = memory.listItems('bot-1', 'user-1')
      assert.equal(items.total, 1)
      assert.equal(items.items[0]!.kind, 'preference')
      assert.ok(!JSON.stringify(items).includes('记忆正文'))
      assert.equal(memory.deleteItem('bot-1', 'user-1', items.items[0]!.id), true)
      assert.equal(memory.listItems('bot-1', 'user-1').total, 0)
      memory.applyOperations('bot-1', 'user-1', [
        { op: 'upsert', kind: 'fact', key: 'city', value: '常驻杭州', confidence: 0.8, importance: 4 },
      ])
      const deleted = memory.deleteUser('bot-1', 'user-1')
      assert.equal(deleted.deletedItems, 1)
      assert.equal(deleted.deletedState, true)
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})
