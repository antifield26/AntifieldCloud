/**
 * v0.5.7 自助命令（QQ 单平台）：/reset 与 /forget confirm。
 * 覆盖全用户开放（不要求目标/用户白名单）、群聊、会话与记忆/镜像清理、幂等与审计无正文。
 * 不访问真实平台或模型；事件使用 AppSecret 签名，fetch 为进程内夹具。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { c2cWebhook, createQqServiceFixture, groupWebhook, lastMessageText, sendWebhook } from './bot-qq-fixtures.ts'

const USER_ID = 'user-openid-1'
const GROUP_ID = 'group-openid-1'

type Fixture = ReturnType<typeof createQqServiceFixture>

async function command(fixture: Fixture, text: string, id: string): Promise<void> {
  await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id, content: text, userOpenid: USER_ID }))
}

async function groupCommand(fixture: Fixture, text: string, id: string): Promise<void> {
  await sendWebhook(
    fixture,
    groupWebhook(fixture.appSecret, {
      id,
      content: `<@!102345000> ${text}`,
      groupOpenid: GROUP_ID,
      memberOpenid: 'member-openid-1',
    }),
  )
}

function sessionModes(fixture: Fixture, target: string, userId: string): string[] {
  const rows = fixture.db
    .prepare('SELECT mode FROM bot_ai_sessions WHERE bot_id = ? AND target_external_id = ? AND user_id = ? ORDER BY mode')
    .all(fixture.botId, target, userId) as unknown as { mode: string }[]
  return rows.map((row) => row.mode)
}

function seedSession(fixture: Fixture, target: string, userId: string, mode: 'chat' | 'task', sessionId: string): void {
  fixture.db
    .prepare(
      `INSERT INTO bot_ai_sessions (bot_id, target_external_id, user_id, mode, session_id, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'm', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')`,
    )
    .run(fixture.botId, target, userId, mode, sessionId)
}

test('v0.5.7：/reset 对所有用户开放，删除当前目标的 chat+task 会话并保留其他目标/用户', async () => {
  const fixture = createQqServiceFixture()
  try {
    seedSession(fixture, USER_ID, USER_ID, 'chat', 'chat-old')
    seedSession(fixture, USER_ID, USER_ID, 'task', 'task-old')
    seedSession(fixture, GROUP_ID, USER_ID, 'chat', 'group-old')
    seedSession(fixture, USER_ID, 'other-user', 'chat', 'other-user')

    await command(fixture, '/reset', 'reset-1')
    assert.equal(lastMessageText(fixture), '已重置当前对话（长期记忆保留）。')
    assert.deepEqual(sessionModes(fixture, USER_ID, USER_ID), [])
    assert.deepEqual(sessionModes(fixture, GROUP_ID, USER_ID), ['chat'], '其他目标会话保留')
    assert.deepEqual(sessionModes(fixture, USER_ID, 'other-user'), ['chat'], '其他用户会话保留')
    assert.ok(fixture.audits.some((item) => item.action === 'bot.reset'))
    assert.equal(JSON.stringify(fixture.audits).includes('chat-old'), false)

    // 没有会话时同样回复固定文案（幂等）。
    await command(fixture, '/reset', 'reset-2')
    assert.equal(lastMessageText(fixture), '已重置当前对话（长期记忆保留）。')
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.7：/forget 必须 confirm；清除结构化记忆+旧摘要镜像+该 Bot×用户全部会话，且幂等', async () => {
  const fixture = createQqServiceFixture()
  try {
    fixture.db
      .prepare(
        `INSERT INTO bot_memory_items
           (id, bot_id, user_id, kind, mem_key, value, confidence, importance, source, created_at, updated_at, last_used_at, expires_at)
         VALUES ('item-1', ?, ?, 'preference', '深色模式', '用户喜欢深色模式，这是记忆正文。', 0.8, 3, 'chat',
                 '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z', NULL, NULL)`,
      )
      .run(fixture.botId, USER_ID)
    const legacyId = '11111111-1111-4111-8111-111111111111'
    fixture.db
      .prepare(
        `INSERT INTO bot_ai_memories (bot_id, user_id, memory_id, summary, summary_session_id, created_at, updated_at)
         VALUES (?, ?, ?, '旧摘要正文', 'memory-session', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z')`,
      )
      .run(fixture.botId, USER_ID, legacyId)
    const mirrorPath = join(fixture.dir, 'bot-memory', `memory-${legacyId}.md`)
    mkdirSync(join(fixture.dir, 'bot-memory'), { recursive: true })
    writeFileSync(mirrorPath, '# memo\n旧摘要正文\n', 'utf8')
    seedSession(fixture, USER_ID, USER_ID, 'chat', 'chat-1')
    seedSession(fixture, USER_ID, USER_ID, 'task', 'task-1')
    seedSession(fixture, GROUP_ID, USER_ID, 'chat', 'chat-2')
    seedSession(fixture, USER_ID, 'other-user', 'chat', 'other-user')

    await command(fixture, '/forget', 'forget-1')
    assert.match(lastMessageText(fixture), /\/forget confirm/)
    assert.equal(
      (fixture.db.prepare('SELECT COUNT(*) AS c FROM bot_memory_items WHERE bot_id = ? AND user_id = ?').get(fixture.botId, USER_ID) as {
        c: number
      }).c,
      1,
      '未确认时不得删除记忆',
    )

    await command(fixture, '/forget confirm', 'forget-2')
    assert.match(lastMessageText(fixture), /^已清除长期记忆与全部对话上下文（记忆条目 1 条/)
    assert.equal(
      (fixture.db.prepare('SELECT COUNT(*) AS c FROM bot_memory_items WHERE bot_id = ? AND user_id = ?').get(fixture.botId, USER_ID) as {
        c: number
      }).c,
      0,
    )
    assert.equal(
      (fixture.db.prepare('SELECT COUNT(*) AS c FROM bot_ai_memories WHERE bot_id = ? AND user_id = ?').get(fixture.botId, USER_ID) as {
        c: number
      }).c,
      0,
    )
    assert.equal(existsSync(mirrorPath), false, '旧摘要镜像文件应删除')
    const remaining = fixture.db
      .prepare('SELECT COUNT(*) AS c FROM bot_ai_sessions WHERE bot_id = ? AND user_id = ?')
      .get(fixture.botId, USER_ID) as { c: number }
    assert.equal(remaining.c, 0, '该用户全部 target/mode 会话都应清理')
    assert.deepEqual(sessionModes(fixture, USER_ID, 'other-user'), ['chat'], '其他用户会话保留')
    const forgetAudit = fixture.audits.filter((item) => item.action === 'bot.memory.forget').at(-1)
    assert.ok(forgetAudit, '应审计 bot.memory.forget')
    assert.equal(JSON.stringify(forgetAudit).includes('深色模式'), false, '审计不得包含记忆正文')

    // 幂等：再次确认仍回复同一句且不报错。
    await command(fixture, '/forget confirm', 'forget-3')
    assert.equal(lastMessageText(fixture), '已清除长期记忆与全部对话上下文。')
  } finally {
    fixture.cleanup()
  }
})

test('v0.6.3：群聊不再接受任何斜杠命令（含 /reset /forget /role）', async () => {
  const fixture = createQqServiceFixture()
  try {
    fixture.service.createTarget(fixture.botId, {
      externalId: GROUP_ID,
      label: '群',
      kind: 'group',
      allowCommands: true,
      allowNotifications: false,
      allowChat: true,
    })
    fixture.db
      .prepare(
        `INSERT INTO bot_memory_items
           (id, bot_id, user_id, kind, mem_key, value, confidence, importance, source, created_at, updated_at, last_used_at, expires_at)
         VALUES ('item-group-1', ?, 'member-openid-1', 'fact', '城市', '住在上海', 0.8, 3, 'chat',
                 '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z', NULL, NULL)`,
      )
      .run(fixture.botId)
    seedSession(fixture, GROUP_ID, 'member-openid-1', 'chat', 'group-chat')

    for (const [index, text] of ['/status', '/reset', '/forget confirm', '/role set 群角色 不应生效'].entries()) {
      await groupCommand(fixture, text, `group-${index + 1}`)
      assert.equal(fixture.fetch.sent.length, 0, `${text} 不应回复`)
    }
    assert.deepEqual(sessionModes(fixture, GROUP_ID, 'member-openid-1'), ['chat'], '群聊命令不应清理会话')
    assert.equal(
      (fixture.db.prepare("SELECT COUNT(*) AS c FROM bot_memory_items WHERE bot_id = ? AND user_id = 'member-openid-1'").get(
        fixture.botId,
      ) as { c: number }).c,
      1,
      '群聊 /forget 不应清除记忆',
    )
    assert.equal(
      (fixture.db.prepare('SELECT COUNT(*) AS c FROM bot_chat_roles WHERE bot_id = ?').get(fixture.botId) as { c: number }).c,
      0,
    )
    assert.ok(fixture.audits.some((item) => item.action === 'bot.command.disabled'))
  } finally {
    fixture.cleanup()
  }
})
