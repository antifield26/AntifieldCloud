/**
 * v0.7.0 Chatbot 修复回归：CHATBOT-01/02/03/04/05/06/07/08/10/13/15 + SEC-11 fail-closed。
 * 全部使用进程内假 QQ/AI/搜索与临时 DB，不访问真实平台、模型或网络。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  QQ_TIMESTAMP,
  c2cWebhook,
  createQqServiceFixture,
  groupFullWebhook,
  groupWebhook,
  sendWebhook,
} from './chatbot-qq-fixtures.ts'
import { BurstMerger } from '../src/chatbot/burst.ts'
import { groupMemoryScope } from '../src/chatbot/memory.ts'
import type { ChatbotToolIsolationStatus } from '../src/chatbot/types.ts'
import { AppError } from '../src/util/errors.ts'

const GROUP = 'group-openid-v070'
const MEMBER_A = 'member-openid-v070-a'
const MEMBER_B = 'member-openid-v070-b'
const SAME_NAME = '小红'

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 300; index += 1) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error(`等待超时：${label}`)
}

function createGroupTarget(
  fixture: ReturnType<typeof createQqServiceFixture>,
  mode: 'mention' | 'all' = 'mention',
): void {
  fixture.service.createTarget(fixture.chatbotId, {
    externalId: GROUP,
    label: '测试群',
    kind: 'group',
    allowCommands: false,
    allowNotifications: false,
    allowChat: true,
    groupReplyMode: mode,
  })
}

function turnFromPrompt(prompt: string): { turnId: string; turnToken: string } | null {
  const id = /turn_id=([A-Za-z0-9_-]+)/.exec(prompt)?.[1]
  const token = /turn_token=([A-Za-z0-9_-]+)/.exec(prompt)?.[1]
  return id && token ? { turnId: id, turnToken: token } : null
}

test('CHATBOT-01：孤儿会话清理只删旧默认标题，新命名/前缀相似会话不误删', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true })
  try {
    const deleted: string[] = []
    const remote = [
      { id: 'ses-mapped-legacy', title: 'AntifieldCloud Chat' },
      { id: 'ses-legacy-chat', title: 'AntifieldCloud Chat' },
      { id: 'ses-legacy-memory', title: 'AntifieldCloud Memory' },
      { id: 'ses-custom-chat', title: '旧目标 Chat' },
      { id: 'ses-custom-memory', title: '旧目标 Memory' },
      { id: 'ses-prefix-like', title: 'AntifieldComplexx 群 Chat' },
    ]
    const ai = (fixture.service as unknown as { deps: { ai: Record<string, unknown> } }).deps.ai
    ai.deleteSession = async (id: string) => {
      deleted.push(id)
    }
    ai.listSessions = async () => remote
    const now = new Date().toISOString()
    fixture.db
      .prepare(
        `INSERT INTO chatbot_ai_sessions (chatbot_id, target_external_id, user_id, mode, session_id, model, created_at, updated_at)
         VALUES (?, 'target-x', 'user-x', 'chat', 'ses-mapped-legacy', NULL, ?, ?)`,
      )
      .run(fixture.chatbotId, now, now)
    await (
      fixture.service as unknown as { cleanupRemoteSessions: (ids: string[]) => Promise<void> }
    ).cleanupRemoteSessions([])
    assert.deepEqual(deleted.sort(), ['ses-legacy-chat', 'ses-legacy-memory'], '只删精确旧标题且未映射的会话')
  } finally {
    fixture.cleanup()
  }
})

test('CHATBOT-02：@Chatbot 与非 @ 全量消息混批时整批按被点名处理，不再静默吞掉 @', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: {
      chatbotAiSendToolEnabled: true,
      chatbotChatBurstWindowMs: 300,
      chatbotChatBurstMaxWaitMs: 2000,
      chatbotChatBurstGroupAllWindowMs: 300,
      chatbotChatBurstGroupAllMaxWaitMs: 2000,
    },
    aiHandler: async () => '模型最终文本',
  })
  try {
    createGroupTarget(fixture, 'all')
    const mention = groupWebhook(fixture.appSecret, {
      id: 'v070-mixed-mention',
      content: '<@!102345000> 在吗',
      groupOpenid: GROUP,
      memberOpenid: 'member-openid-v070-mixed',
      userName: '小明',
    })
    const chat = groupFullWebhook(fixture.appSecret, {
      id: 'v070-mixed-chat',
      content: '今天天气不错',
      groupOpenid: GROUP,
      memberOpenid: 'member-openid-v070-mixed',
      userName: '小明',
    })
    await fixture.service.handleWebhook(fixture.chatbotId, mention.headers, mention.body)
    await fixture.service.handleWebhook(fixture.chatbotId, chat.headers, chat.body)
    await fixture.service.waitForIdle()
    assert.equal(fixture.aiCalls.length, 1, '混批只调用一次 AI')
    const prompt = fixture.aiCalls[0]?.prompt ?? ''
    assert.ok(prompt.includes('明确 @你'), '批内含 @ 时提示词按 mention 环境，而不是“没有点名你”')
    assert.equal(prompt.includes('没有点名你'), false)
    assert.equal(fixture.fetch.sent.length, 1, '整批非 silent：模型未调用工具时也走兜底发送')
    assert.ok(fixture.audits.some((item) => item.action === 'chatbot.ai.send_fallback'))
  } finally {
    fixture.cleanup()
  }
})

test('CHATBOT-03/D-13：群记忆 key 用 member_openid，同名成员互不覆盖；/forget 清本人群条目', async () => {
  let nextOps: unknown[] = []
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { chatbotAiMemoryBatchMessages: 1, chatbotAiMemoryIdleFlushSeconds: 0, chatbotChatBurstWindowMs: 0 },
    extractHandler: async () => nextOps as never,
  })
  const scope = groupMemoryScope(GROUP)
  const readRows = () =>
    fixture.db
      .prepare('SELECT mem_key, value FROM chatbot_memory_items WHERE chatbot_id = ? AND user_id = ? ORDER BY mem_key')
      .all(fixture.chatbotId, scope) as unknown as { mem_key: string; value: string }[]
  async function memberSays(memberOpenid: string, id: string): Promise<void> {
    const event = groupWebhook(fixture.appSecret, {
      id,
      content: '<@!102345000> 你好',
      groupOpenid: GROUP,
      memberOpenid,
      userName: SAME_NAME,
    })
    await sendWebhook(fixture, event)
    await sleep(30)
  }
  try {
    createGroupTarget(fixture, 'mention')
    nextOps = [{ op: 'upsert', kind: 'preference', key: 'drink', value: '喜欢红茶', confidence: 0.9, importance: 3 }]
    await memberSays(MEMBER_A, 'v070-a-1')
    nextOps = [{ op: 'upsert', kind: 'preference', key: 'drink', value: '喜欢绿茶', confidence: 0.9, importance: 3 }]
    await memberSays(MEMBER_B, 'v070-b-1')
    const rows = readRows()
    assert.equal(rows.length, 2, '同名成员各自独立条目')
    assert.ok(rows.every((row) => row.value.startsWith(`${SAME_NAME}：`)), '显示名只保存在 value')
    assert.deepEqual(rows.map((row) => row.mem_key).sort(), [`${MEMBER_A}:drink`, `${MEMBER_B}:drink`].sort())

    // B 删除自己的 key 不影响 A
    nextOps = [{ op: 'delete', kind: 'preference', key: 'drink' }]
    await memberSays(MEMBER_B, 'v070-b-2')
    const afterDelete = readRows()
    assert.deepEqual(
      afterDelete.map((row) => row.mem_key),
      [`${MEMBER_A}:drink`],
      'delete 只删除当前发言者自己的条目',
    )

    // /forget confirm（C2C）同时清除该用户在群 scope 下的条目
    fixture.service.createTarget(fixture.chatbotId, {
      externalId: MEMBER_A,
      label: '成员私聊',
      kind: 'user',
      allowCommands: false,
      allowNotifications: false,
      allowChat: true,
    })
    const forget = c2cWebhook(fixture.appSecret, { id: 'v070-forget', userOpenid: MEMBER_A, content: '/forget confirm' })
    await sendWebhook(fixture, forget)
    assert.deepEqual(readRows(), [], '/forget confirm 删除本人贡献的群共享记忆')
    const forgetAudit = fixture.audits.filter((item) => item.action === 'chatbot.memory.forget').at(-1)
    assert.equal(forgetAudit?.detail?.groupItems, 1)
  } finally {
    fixture.cleanup()
  }
})

test('CHATBOT-03：一次性归属迁移把显示名 key 改为 member_openid，无法映射的保留 legacy', async () => {
  const fixture = createQqServiceFixture({ configOverrides: { chatbotAiMemoryBatchMessages: 1 } })
  const scope = groupMemoryScope(GROUP)
  try {
    createGroupTarget(fixture, 'mention')
    const now = new Date().toISOString()
    fixture.db
      .prepare(
        `INSERT INTO chatbot_inbound_targets (chatbot_id, target_external_id, target_kind, user_id, user_name, is_direct, last_seen_at)
         VALUES (?, ?, 'group', ?, ?, 0, ?)`,
      )
      .run(fixture.chatbotId, GROUP, MEMBER_A, SAME_NAME, now)
    const insertItem = (id: string, key: string, value: string): void => {
      fixture.db
        .prepare(
          `INSERT INTO chatbot_memory_items
             (id, chatbot_id, user_id, kind, mem_key, value, confidence, importance, source, created_at, updated_at)
           VALUES (?, ?, ?, 'fact', ?, ?, 0.9, 3, 'chat', ?, ?)`,
        )
        .run(id, fixture.chatbotId, scope, key, value, now, now)
    }
    insertItem('v070-mig-1', `${SAME_NAME}:drink`, '喜欢乌龙茶')
    insertItem('v070-mig-2', '陌生人:secret', '无法归属的记忆')

    const result = fixture.service.migrateGroupMemoryOwners()
    assert.deepEqual(
      { migrated: result.migrated, legacy: result.legacy, skipped: result.skipped },
      { migrated: 1, legacy: 1, skipped: false },
    )
    const rows = fixture.db
      .prepare('SELECT mem_key, value FROM chatbot_memory_items WHERE chatbot_id = ? AND user_id = ? ORDER BY mem_key')
      .all(fixture.chatbotId, scope) as unknown as { mem_key: string; value: string }[]
    assert.ok(rows.some((row) => row.mem_key === `${MEMBER_A}:drink` && row.value.includes('乌龙茶')))
    assert.ok(rows.some((row) => row.mem_key.startsWith('legacy:')))
    assert.equal(fixture.service.migrateGroupMemoryOwners().skipped, true, '迁移只执行一次')
  } finally {
    fixture.cleanup()
  }
})

test('CHATBOT-04：回合异常时先发送已缓冲的工具消息并审计 partialTurn', async () => {
  const toolStatuses: number[] = []
  let fixtureRef: ReturnType<typeof createQqServiceFixture> | null = null
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { chatbotAiSendToolEnabled: true, chatbotChatBurstWindowMs: 0 },
    aiHandler: async (call) => {
      const turn = turnFromPrompt(call.prompt)
      assert.ok(turn)
      for (const text of ['工具消息一', '工具消息二']) {
        toolStatuses.push(
          fixtureRef?.service.handleAiSendTool({ turn_id: turn.turnId, turn_token: turn.turnToken, text }).status ?? 0,
        )
      }
      throw new AppError(502, 'chatbot_ai_empty_response', 'AI 未返回文本')
    },
  })
  fixtureRef = fixture
  try {
    fixture.service.createTarget(fixture.chatbotId, {
      externalId: 'user-openid-v070-tool',
      label: '私聊目标',
      kind: 'user',
      allowCommands: false,
      allowNotifications: false,
      allowChat: true,
    })
    const event = c2cWebhook(fixture.appSecret, {
      id: 'v070-tool-lost',
      userOpenid: 'user-openid-v070-tool',
      content: '你好',
    })
    await sendWebhook(fixture, event)
    assert.deepEqual(toolStatuses, [200, 200])
    assert.deepEqual(
      fixture.fetch.sent.map((item) => item.body.content),
      ['工具消息一', '工具消息二'],
      '异常回合仍发送已缓冲的工具消息',
    )
    const sendAudit = fixture.audits.filter((item) => item.action === 'chatbot.ai.send').at(-1)
    assert.equal(sendAudit?.detail?.partialTurn, true)
    assert.equal(sendAudit?.detail?.messages, 2)
    const events = fixture.service.listEvents(fixture.chatbotId).items
    assert.ok(events.some((item) => item.detail === 'chat_tool_partial'))
  } finally {
    fixture.cleanup()
  }
})

test('CHATBOT-05：/search 与普通 Chat 共用会话串行锁，不并发调用 AI', async () => {
  const USER = 'user-openid-v070-serial'
  let active = 0
  let maxActive = 0
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: {
      chatbotChatBurstWindowMs: 0,
      chatbotSearchEnabled: true,
      chatbotSearchMode: 'prefetch',
      chatbotSearchUrl: 'http://127.0.0.1:8888',
      chatbotSearchAuto: false,
    },
    search: { search: async () => [] },
    aiHandler: async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await sleep(120)
      active -= 1
      return 'AI 回复'
    },
  })
  try {
    fixture.service.createTarget(fixture.chatbotId, {
      externalId: USER,
      label: '私聊目标',
      kind: 'user',
      allowCommands: false,
      allowNotifications: false,
      allowChat: true,
    })
    const chat = c2cWebhook(fixture.appSecret, { id: 'v070-serial-chat', userOpenid: USER, content: '普通消息' })
    const search = c2cWebhook(fixture.appSecret, { id: 'v070-serial-search', userOpenid: USER, content: '/search 关键词' })
    await fixture.service.handleWebhook(fixture.chatbotId, chat.headers, chat.body)
    await sleep(30)
    await fixture.service.handleWebhook(fixture.chatbotId, search.headers, search.body)
    await fixture.service.waitForIdle()
    assert.equal(maxActive, 1, '同一会话同一时刻只允许一个 AI 回合')
    assert.equal(fixture.aiCalls.length, 2)
    assert.equal(fixture.fetch.sent.length, 2)
  } finally {
    fixture.cleanup()
  }
})

test('CHATBOT-06：清空群共享记忆会取消在途抽取，清空后不再写回', async () => {
  const MEMBER = 'member-openid-v070-clear'
  let releaseGate: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { chatbotAiMemoryBatchMessages: 1, chatbotAiMemoryIdleFlushSeconds: 0, chatbotChatBurstWindowMs: 0 },
    extractHandler: async () => {
      await gate
      return [{ op: 'upsert', kind: 'fact', key: 'k1', value: '不应写回', confidence: 0.9, importance: 3 }]
    },
  })
  try {
    createGroupTarget(fixture, 'mention')
    const event = groupWebhook(fixture.appSecret, {
      id: 'v070-clear-1',
      content: '<@!102345000> 记住',
      groupOpenid: GROUP,
      memberOpenid: MEMBER,
      userName: '小明',
    })
    await fixture.service.handleWebhook(fixture.chatbotId, event.headers, event.body)
    await waitFor(() => fixture.extractCalls.length === 1, '抽取开始')
    fixture.service.deleteGroupMemory(fixture.chatbotId, groupMemoryScope(GROUP))
    releaseGate()
    await fixture.service.waitForIdle()
    await sleep(50)
    const rows = fixture.db
      .prepare('SELECT COUNT(*) AS c FROM chatbot_memory_items WHERE chatbot_id = ? AND user_id = ?')
      .get(fixture.chatbotId, groupMemoryScope(GROUP)) as { c: number }
    assert.equal(rows.c, 0, '清空后不允许在途抽取写回')
  } finally {
    fixture.cleanup()
  }
})

test('CHATBOT-07：ChatbotStatus/ChatbotSummary.lastError 从投递/发布失败派生（不是死字段）', async () => {
  const fixture = createQqServiceFixture()
  try {
    const now = new Date().toISOString()
    fixture.db
      .prepare(
        `INSERT INTO chatbot_deliveries (id, chatbot_id, target_id, kind, dedupe_key, payload_json, status, attempts, next_attempt_at, last_error, external_id, created_at, updated_at, sent_at)
         VALUES ('v070-delivery', ?, NULL, 'notification', NULL, '{}', 'failed', 1, NULL, 'qq_access_token_failed', NULL, ?, ?, NULL)`,
      )
      .run(fixture.chatbotId, now, now)
    assert.equal(fixture.service.status().lastError, 'qq_access_token_failed')
    assert.equal(fixture.service.listBots()[0]?.lastError, 'qq_access_token_failed')
  } finally {
    fixture.cleanup()
  }
})

test('CHATBOT-08：未签名洪泛不占用已验签业务桶；业务桶超限才 429；拒绝审计按窗口聚合', async () => {
  const fixture = createQqServiceFixture()
  try {
    const body = Buffer.from(
      JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'flood', content: 'x', author: { user_openid: 'u' } } }),
    )
    const floodHeaders = { 'x-signature-ed25519': '00'.repeat(64), 'x-signature-timestamp': QQ_TIMESTAMP }
    let unauthorized = 0
    let limited = 0
    for (let index = 0; index < 130; index += 1) {
      const result = await fixture.service.handleWebhook(fixture.chatbotId, floodHeaders, body)
      if (result.status === 401) unauthorized += 1
      if (result.status === 429) limited += 1
    }
    assert.equal(unauthorized, 120, '未认证桶 120/min 内返回 401')
    assert.equal(limited, 10, '超出未认证桶返回 429')
    const rejectedAudits = fixture.audits.filter((item) => item.action === 'chatbot.webhook.rejected')
    assert.ok(rejectedAudits.length < 10, '拒绝审计按分钟窗口聚合，不逐条放大')
    assert.ok(rejectedAudits.length >= 1)

    // 合法签名事件不受未认证洪泛影响：业务桶只在验签通过后扣减。
    const signed = c2cWebhook(fixture.appSecret, { id: 'v070-after-flood', content: '/help' })
    const ok = await fixture.service.handleWebhook(fixture.chatbotId, signed.headers, signed.body)
    assert.equal(ok.status, 200)
    assert.equal(fixture.service.listEvents(fixture.chatbotId).total, 1)
  } finally {
    fixture.cleanup()
  }
})

test('CHATBOT-13：burst.clear 取消运行中批次的后续排队，旧消息不会在清空后处理', async () => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const flushes: number[][] = []
  const merger = new BurstMerger<number>({
    windowMs: 0,
    maxWaitMs: 5000,
    maxItems: 10,
    onFlush: async (_key, items) => {
      flushes.push(items)
      if (flushes.length === 1) await gate
    },
  })
  merger.enqueue('k', 1)
  await waitFor(() => flushes.length === 1, '首批开始')
  merger.enqueue('k', 2)
  merger.clear('k')
  release()
  await sleep(80)
  assert.deepEqual(flushes, [[1]], '清空后处理期间累积的消息不得再触发第二批')
})

test('CHATBOT-15：Chatbot 名称匹配按词边界，避免短名/子串过度触发', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true })
  try {
    createGroupTarget(fixture, 'mention')
    const substring = groupFullWebhook(fixture.appSecret, {
      id: 'v070-name-substring',
      content: 'xqq-testx 不是点名',
      groupOpenid: GROUP,
      memberOpenid: 'member-v070-name',
    })
    await sendWebhook(fixture, substring)
    assert.equal(fixture.aiCalls.length, 0, '子串不命中名字提及')
    const word = groupFullWebhook(fixture.appSecret, {
      id: 'v070-name-word',
      content: 'qq-test 帮忙看看',
      groupOpenid: GROUP,
      memberOpenid: 'member-v070-name',
    })
    await sendWebhook(fixture, word)
    assert.equal(fixture.aiCalls.length, 1, '独立词命中名字提及')
  } finally {
    fixture.cleanup()
  }
})

function withIsolation(
  fixture: ReturnType<typeof createQqServiceFixture>,
  status: ChatbotToolIsolationStatus,
): void {
  const ai = (fixture.service as unknown as { deps: { ai: Record<string, unknown> } }).deps.ai
  ai.toolIsolation = () => status
}

function isolationStatus(overrides: Partial<ChatbotToolIsolationStatus> = {}): ChatbotToolIsolationStatus {
  return { supported: false, fallbackCount: 1, fallbackAt: '2026-10-24T00:00:00.000Z', retryAt: null, ...overrides }
}

test('SEC-11：发送工具启用且隔离不可用（重试窗口内）时 fail-closed，不调用 AI 并回复固定提示', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { chatbotAiSendToolEnabled: true, chatbotChatBurstWindowMs: 0 },
  })
  try {
    withIsolation(
      fixture,
      isolationStatus({ retryAt: new Date(Date.now() + 10 * 60_000).toISOString() }),
    )
    fixture.service.createTarget(fixture.chatbotId, {
      externalId: 'user-openid-v070-isolation',
      label: '私聊目标',
      kind: 'user',
      allowCommands: false,
      allowNotifications: false,
      allowChat: true,
    })
    const event = c2cWebhook(fixture.appSecret, {
      id: 'v070-isolation-1',
      userOpenid: 'user-openid-v070-isolation',
      content: '你好',
    })
    await sendWebhook(fixture, event)
    assert.equal(fixture.aiCalls.length, 0, '隔离不可用时不得调用 AI')
    assert.equal(fixture.fetch.sent.length, 1)
    assert.match(String(fixture.fetch.sent[0]?.body.content), /安全隔离不可用/)
    assert.ok(fixture.audits.some((item) => item.action === 'chatbot.ai.isolation_blocked'))
    const audited = fixture.service.listEvents(fixture.chatbotId).items[0]
    assert.equal(audited?.detail, 'ai_isolation_unavailable')
    assert.equal(fixture.service.status().aiToolIsolation?.supported, false)
  } finally {
    fixture.cleanup()
  }
})

test('SEC-11：未启用发送工具时隔离状态不影响既有 Chat（行为保持）', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true, configOverrides: { chatbotChatBurstWindowMs: 0 } })
  try {
    withIsolation(fixture, isolationStatus({ retryAt: new Date(Date.now() + 10 * 60_000).toISOString() }))
    fixture.service.createTarget(fixture.chatbotId, {
      externalId: 'user-openid-v070-nosend',
      label: '私聊目标',
      kind: 'user',
      allowCommands: false,
      allowNotifications: false,
      allowChat: true,
    })
    const event = c2cWebhook(fixture.appSecret, { id: 'v070-nosend-1', userOpenid: 'user-openid-v070-nosend', content: '你好' })
    await sendWebhook(fixture, event)
    assert.equal(fixture.aiCalls.length, 1, '未启用发送工具时保持旧行为（不 fail-closed）')
  } finally {
    fixture.cleanup()
  }
})

test('SEC-11：到达 retryAt 后 service 不再前置阻断，放行给 AI 层重试（10 分钟窗口可恢复）', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { chatbotAiSendToolEnabled: true, chatbotChatBurstWindowMs: 0 },
  })
  try {
    withIsolation(
      fixture,
      isolationStatus({ retryAt: new Date(Date.now() - 1000).toISOString() }),
    )
    fixture.service.createTarget(fixture.chatbotId, {
      externalId: 'user-openid-v070-retry',
      label: '私聊目标',
      kind: 'user',
      allowCommands: false,
      allowNotifications: false,
      allowChat: true,
    })
    const event = c2cWebhook(fixture.appSecret, { id: 'v070-retry-1', userOpenid: 'user-openid-v070-retry', content: '你好' })
    await sendWebhook(fixture, event)
    assert.equal(fixture.aiCalls.length, 1, '到 retryAt 后必须放行给 AI 重试，否则永远无法恢复')
    assert.equal(fixture.fetch.sent.length, 1)
    assert.equal(fixture.audits.some((item) => item.action === 'chatbot.ai.isolation_blocked'), false)
  } finally {
    fixture.cleanup()
  }
})
