/**
 * v0.7.3 Bot Chat 上下文文档集成：首轮/后续提示词、文档落盘、/reset、/forget、角色变更与清理。
 * 全部使用 QQ/OpenCode 进程内夹具，不访问真实平台或模型。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { contextScopeDir } from '../src/bot/context.ts'
import { GROUP_CHAT_SESSION_USER_ID } from '../src/bot/session.ts'
import {
  c2cWebhook,
  createQqServiceFixture,
  groupWebhook,
  lastMessageText,
  sendWebhook,
} from './bot-qq-fixtures.ts'

const USER = 'user-openid-1'
const GROUP = 'group-openid-1'

function seedMemory(fixture: ReturnType<typeof createQqServiceFixture>, value = '喜欢红茶'): void {
  const now = new Date().toISOString()
  fixture.db
    .prepare(
      `INSERT OR REPLACE INTO bot_memory_items
         (id, bot_id, user_id, kind, mem_key, value, confidence, importance, source, created_at, updated_at, last_used_at, expires_at)
       VALUES ('mem-v073', ?, ?, 'preference', 'tea', ?, 0.9, 4, 'chat', ?, ?, NULL, NULL)`,
    )
    .run(fixture.botId, USER, value, now, now)
}

function scopeDir(fixture: ReturnType<typeof createQqServiceFixture>, target: string, sessionUser: string): string {
  return contextScopeDir(fixture.config.botContextDir, fixture.botId, target, sessionUser)
}

test('v0.7.3：文档模式首轮含角色卡正文，后续轮与记忆正文不进 prompt；文档落盘', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { botAiContextReadEnabled: true },
  })
  try {
    seedMemory(fixture)
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'v073-1', content: '今天有点累' }))
    assert.equal(fixture.aiCalls.length, 1)
    const first = fixture.aiCalls[0]!
    assert.match(first.initialPrompt ?? '', /\[角色卡：lofii\]/)
    assert.match(first.initialPrompt ?? '', /上下文文档/)
    assert.equal(first.prompt.includes('[角色卡：lofii]'), false, 'followUp 不含角色卡正文')
    assert.equal(first.prompt.includes('喜欢红茶'), false, 'followUp 不含记忆正文')
    assert.match(lastMessageText(fixture), /AI 回复/)

    const dir = scopeDir(fixture, USER, USER)
    const role = readFileSync(join(dir, 'role.md'), 'utf8')
    const memory = readFileSync(join(dir, 'memory.md'), 'utf8')
    assert.match(role, /\[角色卡：lofii\]/)
    assert.match(memory, /喜欢红茶/)

    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'v073-2', content: '第二句话' }))
    assert.equal(fixture.aiCalls.length, 2)
    const second = fixture.aiCalls[1]!
    assert.equal(second.prompt.includes('[角色卡：lofii]'), false)
    assert.equal(second.prompt.includes('喜欢红茶'), false)
    assert.ok(second.prompt.includes('角色：lofii'))
    assert.equal(second.prompt.includes(join(dir, 'role.md')), true)

    const audit = fixture.audits.filter((item) => item.action === 'bot.ai.chat').at(-1)
    assert.equal(audit?.detail?.context, 'docs')
    assert.ok((audit?.detail?.docBytes as number) > 0)
    assert.equal(JSON.stringify(fixture.audits).includes('喜欢红茶'), false, '审计不含记忆正文')
    assert.equal(JSON.stringify(fixture.audits).includes(dir), false, '审计不含内部路径')
  } finally {
    fixture.cleanup()
  }
})

test('v0.7.3：/reset 与 /forget confirm 删除上下文文档并重建会话', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { botAiContextReadEnabled: true },
  })
  try {
    seedMemory(fixture)
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'v073-reset-1', content: '记住我喜欢红茶' }))
    const dir = scopeDir(fixture, USER, USER)
    assert.equal(existsSync(join(dir, 'memory.md')), true)

    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'v073-reset-2', content: '/reset' }))
    assert.equal(existsSync(dir), false, '/reset 应清理当前作用域文档')

    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'v073-reset-3', content: '重新开始' }))
    assert.equal(existsSync(join(dir, 'role.md')), true, '下一轮应重建文档')

    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'v073-forget-1', content: '/forget confirm' }))
    assert.equal(existsSync(dir), false, '/forget 应清理用户作用域文档')
    const forget = fixture.audits.filter((item) => item.action === 'bot.memory.forget').at(-1)
    assert.ok((forget?.detail?.userScopes as number) >= 1)
  } finally {
    fixture.cleanup()
  }
})

test('v0.7.3：/role set 重置会话并更新角色文档', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { botAiContextReadEnabled: true },
  })
  try {
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'v073-role-1', content: '你好' }))
    const dir = scopeDir(fixture, USER, USER)
    assert.match(readFileSync(join(dir, 'role.md'), 'utf8'), /\[角色卡：lofii\]/)

    await sendWebhook(
      fixture,
      c2cWebhook(fixture.appSecret, { id: 'v073-role-2', content: '/role set 猫娘 说话简短，偶尔用喵。' }),
    )
    assert.equal(existsSync(dir), false, '角色变更应清理旧作用域文档')
    assert.equal(
      (fixture.db.prepare('SELECT COUNT(*) AS c FROM bot_ai_sessions WHERE bot_id = ? AND user_id = ?').get(
        fixture.botId,
        USER,
      ) as { c: number }).c,
      0,
      '角色变更应清理会话映射',
    )

    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'v073-role-3', content: '现在呢' }))
    assert.match(readFileSync(join(dir, 'role.md'), 'utf8'), /\[角色卡：猫娘\]/)
    const latest = fixture.aiCalls.at(-1)!
    assert.match(latest.initialPrompt ?? '', /\[角色卡：猫娘\]/)
    assert.match(latest.initialPrompt ?? '', /说话简短，偶尔用喵。/)
    assert.equal(latest.prompt.includes('说话简短，偶尔用喵。'), false)
  } finally {
    fixture.cleanup()
  }
})

test('v0.7.3：群聊共享会话使用群作用域；管理端群角色变更重置会话与文档', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { botAiContextReadEnabled: true },
  })
  try {
    const target = fixture.service.createTarget(fixture.botId, {
      externalId: GROUP,
      label: '测试群',
      kind: 'group',
      allowCommands: false,
      allowNotifications: false,
      allowChat: true,
      groupReplyMode: 'mention',
    })
    const role = fixture.service.saveGroupRole(fixture.botId, target.id, '群猫娘', '群里也用喵。')
    assert.equal(role.name, '群猫娘')

    await sendWebhook(
      fixture,
      groupWebhook(fixture.appSecret, {
        id: 'v073-group-1',
        content: '@bot 你好',
        groupOpenid: GROUP,
        memberOpenid: 'member-1',
        userName: '小明',
      }),
    )
    const dir = scopeDir(fixture, GROUP, GROUP_CHAT_SESSION_USER_ID)
    assert.match(readFileSync(join(dir, 'role.md'), 'utf8'), /\[角色卡：群猫娘\]/)
    const first = fixture.aiCalls.at(-1)!
    assert.match(first.initialPrompt ?? '', /群里也用喵。/)
    assert.equal(first.sessionUserId, GROUP_CHAT_SESSION_USER_ID)

    await sendWebhook(
      fixture,
      groupWebhook(fixture.appSecret, {
        id: 'v073-group-2',
        content: '@bot 再聊聊',
        groupOpenid: GROUP,
        memberOpenid: 'member-2',
        userName: '小红',
      }),
    )
    const second = fixture.aiCalls.at(-1)!
    assert.equal(second.prompt.includes('[角色卡：群猫娘]'), false)
    assert.equal(second.prompt.includes('群里也用喵。'), false)
    assert.equal(second.prompt.includes('（1 条）') || second.prompt.includes('（0 条）'), true)

    fixture.service.saveGroupRole(fixture.botId, target.id, '新群猫娘', '新的设定。')
    assert.equal(existsSync(dir), false, '群角色变更应清理群作用域文档')
    assert.equal(
      (fixture.db
        .prepare('SELECT COUNT(*) AS c FROM bot_ai_sessions WHERE bot_id = ? AND target_external_id = ?')
        .get(fixture.botId, GROUP) as { c: number }).c,
      0,
      '群角色变更应清理群会话',
    )
  } finally {
    fixture.cleanup()
  }
})

test('v0.7.3：Bot 删除与目标删除清理上下文目录', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { botAiContextReadEnabled: true },
  })
  try {
    const target = fixture.service.createTarget(fixture.botId, {
      externalId: USER,
      label: '用户目标',
      kind: 'user',
      allowCommands: true,
      allowNotifications: false,
      allowChat: true,
    })
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'v073-clean-1', content: '你好' }))
    const dir = scopeDir(fixture, USER, USER)
    assert.equal(existsSync(dir), true)
    fixture.service.deleteTarget(fixture.botId, target.id)
    assert.equal(existsSync(dir), false, '目标删除应清理该目标上下文')

    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'v073-clean-2', content: '再聊' }))
    assert.equal(existsSync(dir), true)
    fixture.service.deleteBot(fixture.botId)
    assert.equal(existsSync(dirname(dirname(dir))), false, 'Bot 删除应清理其全部上下文目录')
  } finally {
    fixture.cleanup()
  }
})

test('v0.7.3：flag=false 时保持旧内联提示词（角色卡/记忆正文每轮发送）', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true })
  try {
    seedMemory(fixture)
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'v073-inline-1', content: '你好' }))
    const call = fixture.aiCalls[0]!
    assert.match(call.prompt, /\[角色卡：lofii\]/)
    assert.match(call.prompt, /喜欢红茶/)
    const audit = fixture.audits.filter((item) => item.action === 'bot.ai.chat').at(-1)
    assert.equal(audit?.detail?.context, 'inline')
  } finally {
    fixture.cleanup()
  }
})
