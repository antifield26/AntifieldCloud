/**
 * Chatbot 核心回归（QQ 单平台）：凭据加密、Webhook 验签/命令/去重、通知与发布队列。
 * 测试不访问真实 QQ 网络，全部使用注入的 fetch 夹具与固定 AppSecret。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, verify } from 'node:crypto'
import {
  QQ_TIMESTAMP,
  c2cWebhook,
  createQqServiceFixture,
  deriveQqKeyPair,
  lastMessageText,
  sendWebhook,
  signQqEvent,
} from './chatbot-qq-fixtures.ts'
import { ChatbotService } from '../src/chatbot/service.ts'
import type { ChatbotMemoryOperation, ChatbotPlatform } from '../src/chatbot/types.ts'
import { decryptBotSecret, encryptBotSecret } from '../src/chatbot/crypto.ts'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

test('Chatbot 凭据加密可往返且篡改失败', () => {
  const key = randomBytes(32)
  const encrypted = encryptBotSecret(key, { token: 'x'.repeat(20) })
  const decoded = decryptBotSecret(key, encrypted)
  assert.equal(decoded.token, 'x'.repeat(20))
  assert.throws(() => decryptBotSecret(randomBytes(32), encrypted))
  assert.throws(() => decryptBotSecret(key, { ...encrypted, ciphertext: 'AAAA' }))
})

test('QQ Webhook：op=13 回调校验返回签名，非法签名被拒绝', async () => {
  const fixture = createQqServiceFixture()
  try {
    const challengeBody = Buffer.from(
      JSON.stringify({ op: 13, d: { plain_token: 'plain-token-abc', event_ts: '1725442341' } }),
    )
    const challenge = await fixture.service.handleWebhook(fixture.chatbotId, {}, challengeBody)
    assert.equal(challenge.status, 200)
    const payload = challenge.body as { plain_token: string; signature: string }
    assert.equal(payload.plain_token, 'plain-token-abc')
    const { publicKey } = deriveQqKeyPair(fixture.appSecret)
    assert.equal(
      verify(
        null,
        Buffer.from('1725442341plain-token-abc', 'utf8'),
        publicKey,
        Buffer.from(payload.signature, 'hex'),
      ),
      true,
    )
    // op=13 成功校验写审计（不记录 plain_token/签名）。
    const challengeAudit = fixture.audits.filter((item) => item.action === 'chatbot.webhook.challenge')
    assert.equal(challengeAudit.length, 1)
    assert.equal(challengeAudit[0]?.target, fixture.chatbotId)
    assert.equal(challengeAudit[0]?.detail ?? null, null)
    assert.equal(JSON.stringify(challengeAudit).includes(payload.signature), false, '审计不得记录签名')
    assert.equal(JSON.stringify(challengeAudit).includes('plain-token-abc'), false, '审计不得记录 plain_token')

    const rejected = await fixture.service.handleWebhook(
      fixture.chatbotId,
      { 'x-signature-ed25519': '00'.repeat(64), 'x-signature-timestamp': QQ_TIMESTAMP },
      Buffer.from(JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', d: {} })),
    )
    assert.equal(rejected.status, 401)
    assert.deepEqual(rejected.body, { error: { code: 'invalid_signature' } })

    // op=13 不得把任意事件 JSON 当作 plain_token 签名（签名预言机回归）。
    const oracle = await fixture.service.handleWebhook(
      fixture.chatbotId,
      {},
      Buffer.from(
        JSON.stringify({
          op: 13,
          d: {
            plain_token: JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'forged' } }),
            event_ts: QQ_TIMESTAMP,
          },
        }),
      ),
    )
    assert.equal(oracle.status, 400)
    assert.deepEqual(oracle.body, { error: { code: 'invalid_payload' } })

    // CHATBOT_ENABLED=false 时公开入口返回 404。
    const disabled = new ChatbotService({
      db: fixture.db,
      config: { ...fixture.config, chatbotEnabled: false },
      log: () => undefined,
      audit: () => undefined,
      providers: {
        status: async () => ({}),
        backup: async () => ({}),
        world: async () => ({}),
        minecraft: async () => ({}),
        files: async () => [],
      },
    })
    const hidden = await disabled.handleWebhook(fixture.chatbotId, {}, Buffer.from('{}'))
    assert.equal(hidden.status, 404)
  } finally {
    fixture.cleanup()
  }
})

test('QQ Webhook：命令回复、事件去重与审计', async () => {
  const fixture = createQqServiceFixture()
  try {
    fixture.service.createTarget(fixture.chatbotId, {
      externalId: 'group-openid-1',
      label: 'QQ 群',
      kind: 'group',
      allowCommands: true,
      allowNotifications: true,
      allowChat: false,
    })
    fixture.service.createTarget(fixture.chatbotId, {
      externalId: 'user-openid-1',
      label: '管理员',
      kind: 'user',
      allowCommands: true,
      allowNotifications: false,
    })
    const webhook = c2cWebhook(fixture.appSecret, { id: 'c2c-cmd-1', content: '/status' })
    const first = await sendWebhook(fixture, webhook)
    assert.equal(first.status, 200)
    assert.deepEqual(first.body, { opcode: 12 })
    assert.match(lastMessageText(fixture), /应用状态/)
    assert.equal(fixture.fetch.sent.at(-1)?.body.msg_id, 'c2c-cmd-1', 'C2C 被动回复带 msg_id')
    assert.ok(fixture.audits.some((item) => item.action === 'chatbot.command'))

    const messageCount = fixture.fetch.sent.length
    const duplicate = await sendWebhook(fixture, webhook)
    assert.equal(duplicate.status, 200)
    assert.deepEqual(duplicate.body, { opcode: 12 })
    assert.equal(fixture.fetch.sent.length, messageCount, '重复事件不重复外发')

    const events = fixture.service.listEvents(fixture.chatbotId)
    assert.equal(events.total, 1)
    assert.equal(events.items[0]?.outcome, 'ok')
    assert.equal(events.items[0]?.kind, 'command')
  } finally {
    fixture.cleanup()
  }
})

test('QQ 通知队列：告警按目标投递，文本已脱敏', async () => {
  const fixture = createQqServiceFixture()
  try {
    fixture.service.updateBot(fixture.chatbotId, { enabled: true })
    fixture.service.createTarget(fixture.chatbotId, {
      externalId: 'group-openid-1',
      label: 'QQ 群',
      kind: 'group',
      allowCommands: false,
      allowNotifications: true,
    })
    fixture.service.notifyAlert({
      id: 10,
      event: 'disk_low',
      severity: 'warning',
      status: 'firing',
      title: '磁盘不足',
      message: '失败路径 /home/antifield/secret.txt ssh://internal',
      createdAt: '2026-10-22T04:00:00.000Z',
    })
    await fixture.service.processDeliveries()
    const body = fixture.fetch.sent.at(-1)?.body
    assert.equal(typeof body?.content, 'string')
    assert.match(String(body?.content), /磁盘不足/)
    assert.equal(String(body?.content).includes('/home/antifield/secret.txt'), false, '通知不得包含内部路径')
    const delivery = fixture.service.listDeliveries(fixture.chatbotId)[0]
    assert.equal(delivery?.status, 'sent')
    assert.equal(delivery?.kind, 'notification')
    assert.ok(fixture.fetch.captured.every((item) => !item.url.includes(fixture.appSecret)), 'AppSecret 不得进入 URL')
  } finally {
    fixture.cleanup()
  }
})

test('QQ 发布队列：二次确认后才入队，纯文本发送', async () => {
  const fixture = createQqServiceFixture()
  try {
    const target = fixture.service.createTarget(fixture.chatbotId, {
      externalId: 'group-openid-1',
      label: 'QQ 群',
      kind: 'group',
      allowCommands: false,
      allowNotifications: true,
    })
    assert.throws(
      () => fixture.service.createPublish(fixture.chatbotId, { targetId: target.id, text: '无确认' }),
      /二次确认/,
    )
    assert.throws(
      () => fixture.service.createPublish(fixture.chatbotId, { targetId: target.id, text: 'x'.repeat(2001), confirmText: 'PUBLISH' }),
      /2000/,
    )
    const job = fixture.service.createPublish(fixture.chatbotId, {
      targetId: target.id,
      text: '发布测试',
      confirmText: 'PUBLISH',
    })
    await fixture.service.processPublishJobs()
    const sent = fixture.service.listPublishJobs(fixture.chatbotId).find((item) => item.id === job.id)
    assert.equal(sent?.status, 'sent')
    assert.equal(sent?.text, '发布测试')
    assert.match(String(fixture.fetch.sent.at(-1)?.body.content), /发布测试/)
  } finally {
    fixture.cleanup()
  }
})

test('QQ 单平台：非 QQ 平台创建被拒绝，发送只走 QQ API', async () => {
  const fixture = createQqServiceFixture()
  try {
    assert.throws(
      () =>
        fixture.service.createBot({
          platform: 'telegram' as unknown as ChatbotPlatform,
          name: 'legacy',
          token: 'x'.repeat(20),
        }),
      /不支持的平台/,
    )
    const chatbot = fixture.service.listBots()[0]
    assert.equal(chatbot?.platform, 'qq')
    assert.deepEqual(chatbot?.setupSteps.length ? 'has-setup' : 'no-setup', 'has-setup')
    void jsonResponse
  } finally {
    fixture.cleanup()
  }
})

test('QQ 事件签名时间戳过期时拒绝（stale_signature）', async () => {
  const fixture = createQqServiceFixture()
  try {
    const staleTs = String(Math.floor(new Date('2026-10-22T00:00:00.000Z').getTime() / 1000))
    const webhook = signQqEvent(
      fixture.appSecret,
      {
        op: 0,
        t: 'C2C_MESSAGE_CREATE',
        d: { id: 'stale-1', content: '你好', author: { user_openid: 'u1' } },
      },
      staleTs,
    )
    const result = await fixture.service.handleWebhook(fixture.chatbotId, webhook.headers, webhook.body)
    assert.equal(result.status, 401)
    assert.deepEqual(result.body, { error: { code: 'stale_signature' } })
  } finally {
    fixture.cleanup()
  }
})

test('v0.6.0 AI 工具隔离降级：写审计并在 ChatbotStatus 暴露状态（不含提示词）', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true })
  try {
    const ai = (fixture.service as unknown as { deps: { ai?: { toolIsolation?: () => unknown } } }).deps.ai
    assert.ok(ai, '夹具应提供 AI')
    let isolation = { supported: true, fallbackCount: 0, fallbackAt: null as string | null }
    ai.toolIsolation = () => isolation
    assert.deepEqual(fixture.service.status().aiToolIsolation, isolation)

    // 模拟 OpenCode 拒绝 permissions 后发生一次降级。
    isolation = { supported: false, fallbackCount: 1, fallbackAt: '2026-10-23T00:00:00.000Z' }
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'ai-fallback-1', content: '你好' }))
    const fallbackAudits = fixture.audits.filter((item) => item.action === 'chatbot.ai.permissions_fallback')
    assert.equal(fallbackAudits.length, 1, '降级必须写审计，不能只藏在日志里')
    assert.equal(fallbackAudits[0]?.target, fixture.chatbotId)
    assert.equal(fallbackAudits[0]?.detail?.fallbackCount, 1)
    assert.equal(fallbackAudits[0]?.detail?.supported, false)
    assert.equal(JSON.stringify(fallbackAudits).includes('你好'), false, '降级审计不得包含提示词')
    assert.deepEqual(fixture.service.status().aiToolIsolation, isolation)

    // 降级次数不再增加时只审计一次。
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'ai-fallback-2', content: '再聊' }))
    assert.equal(fixture.audits.filter((item) => item.action === 'chatbot.ai.permissions_fallback').length, 1)
  } finally {
    fixture.cleanup()
  }
})

test('v0.6.0 未配置 AI 时 ChatbotStatus.aiToolIsolation 为 null', () => {
  const fixture = createQqServiceFixture()
  try {
    assert.equal(fixture.service.status().aiToolIsolation, null)
  } finally {
    fixture.cleanup()
  }
})

test('v0.6.0 legacy 迁移：ops=0 保留 fallback，产出条目后才标记迁移', async () => {
  const userId = 'user-openid-1'
  let ops: ChatbotMemoryOperation[] = []
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    extractHandler: async () => ops,
    configOverrides: { chatbotAiMemoryBatchMessages: 1 },
  })
  try {
    const now = '2026-10-22T00:00:00.000Z'
    fixture.db
      .prepare(
        `INSERT INTO chatbot_ai_memories (chatbot_id, user_id, memory_id, summary, summary_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(fixture.chatbotId, userId, '11111111-1111-4111-8111-111111111111', '旧摘要：用户喜欢深色模式', now, now)
    const migratedAt = (): string | null =>
      (
        fixture.db
          .prepare('SELECT legacy_migrated_at FROM chatbot_memory_state WHERE chatbot_id = ? AND user_id = ?')
          .get(fixture.chatbotId, userId) as { legacy_migrated_at: string | null } | undefined
      )?.legacy_migrated_at ?? null

    // 第一批：模型返回空操作 → 不迁移，旧摘要 fallback 继续注入并继续作为迁移输入。
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'legacy-ops0-1', content: '第一轮对话' }))
    await fixture.service.waitForIdle() // 等待回复后才入队的记忆抽取任务完成
    assert.equal(migratedAt(), null, 'ops=0 不得标记旧摘要已迁移')
    assert.ok(
      (fixture.aiCalls.at(-1)?.prompt ?? '').includes('[旧记忆（待迁移）]'),
      'ops=0 后旧摘要 fallback 仍应注入',
    )
    assert.equal(fixture.extractCalls[0]?.legacySummary.includes('深色模式'), true)
    const firstAudit = fixture.audits.filter((item) => item.action === 'chatbot.memory.extract').at(-1)
    assert.equal(firstAudit?.detail?.migrated, 0)

    // 第二批：模型产出可迁移条目 → 标记迁移。
    ops = [{ op: 'upsert', kind: 'fact', key: 'theme', value: '喜欢深色模式', confidence: 0.9, importance: 3 }]
    await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id: 'legacy-ops0-2', content: '第二轮对话' }))
    await fixture.service.waitForIdle()
    assert.ok(migratedAt(), '产出条目后应标记迁移')
    const audits = fixture.audits.filter((item) => item.action === 'chatbot.memory.extract')
    assert.equal(audits.length, 2)
    assert.equal(audits[1]?.detail?.migrated, 1)
    assert.ok(ops.length === 1)
  } finally {
    fixture.cleanup()
  }
})
