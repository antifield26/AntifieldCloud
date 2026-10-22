/**
 * v0.5.7 诊断与 AI 管线（F8/F2/F5/F9/partial）：
 * - 事件 kind/outcome/detail 记录、筛选分页与参数校验、重复事件去重；
 * - deliveries/publish/metrics 的 lastErrorHint；
 * - partial 失败（文本分段/附件）不自动重试且带固定前缀；
 * - AI 回答清洗→平台格式化→textMode 透传、回复上限、图片理解开关与降级、失败事件 outcome。
 * 不访问真实平台或模型；fetch/AI 均为进程内夹具。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import type { Config } from '../src/config.ts'
import { newId } from '../src/util/ids.ts'
import { AppError } from '../src/util/errors.ts'
import { tempDataDir, testConfig, testDb } from './helpers.ts'
import { BotService } from '../src/bot/service.ts'
import type { BotAiImage } from '../src/bot/types.ts'

const SECRET = 'secret-'.repeat(4)

interface AuditRecord {
  action: string
  target: string | null
  detail?: Record<string, unknown> | null
}

interface AiCall {
  mode: string
  prompt: string
  image?: BotAiImage
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

interface FakeState {
  sendCalls: number
  /** 第 N 次发送起返回失败（1 起始；Infinity 表示不失败）。 */
  failSendFrom: number
  getFileFails: boolean
  imageBytes: Buffer
}

interface SetupResult {
  dir: string
  db: ReturnType<typeof testDb>
  config: Config
  service: BotService
  botId: string
  targetId: string
  state: FakeState
  sentBodies: string[]
  aiCalls: AiCall[]
  audits: AuditRecord[]
}

function setup(
  overrides: Partial<Config> = {},
  aiHandler: (call: AiCall) => Promise<string> = async () => 'AI 回复',
): SetupResult {
  const dir = tempDataDir()
  const db = testDb(dir)
  const config = testConfig(dir, {
    botEnabled: true,
    botSecretKey: randomBytes(32).toString('base64'),
    botAiEnabled: true,
    ...overrides,
  })
  const state: FakeState = {
    sendCalls: 0,
    failSendFrom: Number.POSITIVE_INFINITY,
    getFileFails: false,
    imageBytes: Buffer.from('fake-png'),
  }
  const sentBodies: string[] = []
  const aiCalls: AiCall[] = []
  const audits: AuditRecord[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/getFile')) {
      if (state.getFileFails) return jsonResponse({ ok: false, description: 'getFile failed' }, 500)
      return jsonResponse({ ok: true, result: { file_path: 'photos/a.png' } })
    }
    if (url.includes('/file/bot')) {
      return new Response(state.imageBytes, { status: 200, headers: { 'content-type': 'image/png' } })
    }
    state.sendCalls += 1
    if (typeof init?.body === 'string') sentBodies.push(init.body)
    if (state.sendCalls >= state.failSendFrom) return jsonResponse({ ok: false, description: 'send_failed' }, 500)
    return jsonResponse({ ok: true, result: { message_id: 1000 + state.sendCalls } })
  }) as typeof fetch
  const service = new BotService({
    db,
    config,
    log: () => undefined,
    audit: (action, target, detail) => {
      audits.push({ action, target, detail })
    },
    fetch: fetchImpl,
    now: () => new Date('2026-10-22T04:00:00.000Z'),
    ai: {
      chat: async (input) => {
        const call: AiCall = { mode: input.mode, prompt: input.prompt, ...(input.image ? { image: input.image } : {}) }
        aiCalls.push(call)
        return aiHandler(call)
      },
    },
    media: {
      stat: () => ({ filename: 'a.pdf', mime: 'application/pdf', size: 3 }),
      load: async () => ({ filename: 'a.pdf', mime: 'application/pdf', data: Buffer.from('pdf') }),
    },
    providers: {
      status: async () => ({ ok: true }),
      backup: async () => ({ ok: true }),
      world: async () => ({ ok: true }),
      minecraft: async () => ({ online: true }),
      files: async () => [],
    },
  })
  const bot = service.createBot({
    platform: 'telegram',
    name: 'diagnostics',
    token: 'x'.repeat(40),
    webhookSecret: SECRET,
  })
  service.updateBot(bot.id, { enabled: true })
  const target = service.createTarget(bot.id, {
    externalId: '9001',
    label: '群',
    kind: 'group',
    allowCommands: false,
    allowNotifications: true,
    allowChat: true,
  })
  return {
    dir,
    db,
    config,
    service,
    botId: bot.id,
    targetId: target.id,
    state,
    sentBodies,
    aiCalls,
    audits,
  }
}

function cleanup(result: SetupResult): void {
  result.db.close()
  rmSync(result.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}

let eventSeq = 1

async function gatewayChat(
  service: BotService,
  botId: string,
  input: Partial<{
    targetExternalId: string
    targetKind: 'channel' | 'user' | 'group'
    userId: string
    text: string
    isDirect: boolean
    chatTrigger: 'direct' | 'mention' | 'reply' | 'message'
    messageId: string
    image: { ref: string; mime: string; name?: string; size?: number }
  }> = {},
): Promise<void> {
  eventSeq += 1
  await service.handleGatewayMessage(botId, {
    eventId: `gw-diag-${eventSeq}`,
    targetExternalId: input.targetExternalId ?? '9001',
    targetKind: input.targetKind ?? 'group',
    userId: input.userId ?? 'user-1',
    userName: '用户',
    text: input.text ?? '你好',
    isDirect: input.isDirect ?? false,
    chatTrigger: input.chatTrigger ?? 'mention',
    messageId: input.messageId ?? `m-${eventSeq}`,
    ...(input.image ? { image: input.image } : {}),
  })
  await service.waitForIdle()
}

let updateSeq = 500

async function webhookMessage(
  service: BotService,
  botId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const result = await service.handleWebhook(
    botId,
    { 'x-telegram-bot-api-secret-token': SECRET },
    Buffer.from(JSON.stringify(body)),
  )
  await service.waitForIdle()
  return result
}

async function webhookCommand(
  service: BotService,
  botId: string,
  text: string,
  options: { chatId?: string; userId?: string } = {},
): Promise<{ status: number; body: unknown }> {
  updateSeq += 1
  return webhookMessage(service, botId, {
    update_id: updateSeq,
    message: {
      text,
      chat: { id: Number(options.chatId ?? '9001'), type: 'group' },
      from: { id: Number(options.userId ?? '7001') },
    },
  })
}

function insertDelivery(db: ReturnType<typeof testDb>, botId: string, targetId: string, text: string): void {
  const now = '2026-10-22T00:00:00.000Z'
  db.prepare(
    `INSERT INTO bot_deliveries (id, bot_id, target_id, kind, payload_json, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'notification', ?, 'queued', 0, ?, ?)`,
  ).run(newId(), botId, targetId, JSON.stringify({ text }), now, now)
}

function insertPublish(
  db: ReturnType<typeof testDb>,
  botId: string,
  targetId: string,
  text: string,
  mediaIds: string[] = [],
): string {
  const id = newId()
  const now = '2026-10-22T00:00:00.000Z'
  db.prepare(
    `INSERT INTO bot_publish_jobs (id, bot_id, target_id, content_json, media_file_ids_json, scheduled_at, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, 'queued', 0, ?, ?)`,
  ).run(id, botId, targetId, JSON.stringify({ text }), JSON.stringify(mediaIds), now, now)
  return id
}

test('v0.5.7：入站事件记录 kind/outcome/detail；支持 outcome 筛选、分页与参数校验', async () => {
  const ctx = setup()
  try {
    await gatewayChat(ctx.service, ctx.botId, { chatTrigger: 'mention', text: '正常对话' })
    const ok = ctx.service.listEvents(ctx.botId)
    assert.equal(ok.total, 1)
    assert.equal(ok.items[0]?.kind, 'chat')
    assert.equal(ok.items[0]?.outcome, 'ok')
    assert.equal(ok.items[0]?.detail, 'chat')
    assert.equal(ok.items[0]?.targetExternalId, '9001')
    assert.equal(ok.items[0]?.userId, 'user-1')
    assert.ok(ok.items[0]?.receivedAt)
    assert.ok(ok.items[0]?.updatedAt)

    await gatewayChat(ctx.service, ctx.botId, { targetExternalId: 'unregistered', chatTrigger: 'mention' })
    await gatewayChat(ctx.service, ctx.botId, { targetExternalId: '9001', chatTrigger: 'message' })
    const all = ctx.service.listEvents(ctx.botId)
    assert.equal(all.total, 3)
    assert.deepEqual(all.items.map((item) => item.outcome).sort(), ['denied', 'ignored', 'ok'])

    const denied = ctx.service.listEvents(ctx.botId, { outcome: 'denied' })
    assert.equal(denied.total, 1)
    assert.equal(denied.items[0]?.detail, 'chat_denied')
    const ignored = ctx.service.listEvents(ctx.botId, { outcome: 'ignored' })
    assert.equal(ignored.total, 1)
    assert.equal(ignored.items[0]?.detail, 'trigger_not_allowed')

    const page = ctx.service.listEvents(ctx.botId, { limit: 1, offset: 1 })
    assert.equal(page.total, 3)
    assert.equal(page.items.length, 1)
    assert.equal(ctx.service.listEvents(ctx.botId, { limit: 0 }).items.length, 1, 'limit 下限归一为 1')
    assert.equal(ctx.service.listEvents(ctx.botId, { hours: 0 }).total, 3, 'hours 下限归一为 1')
    assert.throws(
      () => ctx.service.listEvents(ctx.botId, { outcome: 'bogus' }),
      (error: unknown) => error instanceof AppError && error.statusCode === 400,
    )
  } finally {
    cleanup(ctx)
  }
})

test('v0.5.7：Webhook 命令事件 ok/rate_limited/ignored 与重复事件去重', async () => {
  const ctx = setup({ botCommandRatePerMinute: 1 })
  try {
    // 命令需要目标 allow_commands + user 白名单。
    ctx.service.updateTarget(ctx.botId, ctx.targetId, { allowCommands: true })
    ctx.service.createTarget(ctx.botId, {
      externalId: '7001',
      label: '管理员',
      kind: 'user',
      allowCommands: true,
      allowNotifications: false,
    })
    const first = await webhookCommand(ctx.service, ctx.botId, '/status')
    assert.equal(first.status, 200)
    const okEvent = ctx.service.listEvents(ctx.botId, { outcome: 'ok' }).items.at(-1)
    assert.equal(okEvent?.kind, 'command')
    assert.equal(okEvent?.detail, 'command_status')

    const second = await webhookCommand(ctx.service, ctx.botId, '/status')
    assert.equal(second.status, 200)
    const limited = ctx.service.listEvents(ctx.botId, { outcome: 'rate_limited' })
    assert.equal(limited.total, 1)
    assert.equal(limited.items[0]?.detail, 'command_rate_limited')

    // 重复事件仍按现有语义返回 duplicate 且不新增事件行。
    updateSeq += 1
    const duplicateBody = {
      update_id: updateSeq,
      message: { text: '/status', chat: { id: 9001, type: 'group' }, from: { id: 7002 } },
    }
    const beforeTotal = ctx.service.listEvents(ctx.botId).total
    const firstSend = await webhookMessage(ctx.service, ctx.botId, duplicateBody)
    assert.equal(firstSend.status, 200)
    const secondSend = await webhookMessage(ctx.service, ctx.botId, duplicateBody)
    assert.deepEqual(secondSend.body, { ok: true, duplicate: true })
    assert.equal(ctx.service.listEvents(ctx.botId).total, beforeTotal + 1)

    // 适配器 ignored 结果带事件 ID 时也记录 outcome=ignored。
    updateSeq += 1
    const ignoredUpdate = updateSeq
    await webhookMessage(ctx.service, ctx.botId, {
      update_id: ignoredUpdate,
      message: { chat: { id: 9001, type: 'group' }, from: { id: 7001 } },
    })
    const ignored = ctx.service.listEvents(ctx.botId, { outcome: 'ignored' })
    assert.ok(ignored.items.some((item) => item.eventId === `tg:update:${ignoredUpdate}`))
  } finally {
    cleanup(ctx)
  }
})

test('v0.5.7：deliveries/publish/metrics 输出 lastErrorHint 中文提示', () => {
  const ctx = setup()
  try {
    insertDelivery(ctx.db, ctx.botId, ctx.targetId, '通知正文')
    ctx.db
      .prepare("UPDATE bot_deliveries SET status = 'failed', attempts = 1, last_error = 'bot_ai_timeout: 超时' WHERE bot_id = ?")
      .run(ctx.botId)
    insertPublish(ctx.db, ctx.botId, ctx.targetId, '发布正文')
    ctx.db
      .prepare(
        "UPDATE bot_publish_jobs SET status = 'failed', attempts = 5, last_error = 'partial_text_sent（已发送部分段落）：发送失败' WHERE bot_id = ?",
      )
      .run(ctx.botId)

    const delivery = ctx.service.listDeliveries(ctx.botId)[0]
    assert.equal(delivery?.lastErrorHint, 'AI 响应超时：可稍后重试，或检查 OpenCode 服务状态')
    const job = ctx.service.listPublishJobs(ctx.botId)[0]
    assert.match(String(job?.lastErrorHint), /部分段落已发送/)
    const metrics = ctx.service.metrics(ctx.botId)
    assert.ok(metrics.lastError)
    assert.ok(metrics.lastErrorHint)
  } finally {
    cleanup(ctx)
  }
})

test('v0.5.7：通知投递部分外发标记 partial_text_sent 且不再自动重试', async () => {
  const ctx = setup()
  try {
    insertDelivery(ctx.db, ctx.botId, ctx.targetId, '长'.repeat(5000))
    ctx.state.sendCalls = 0
    ctx.state.failSendFrom = 2
    await ctx.service.processDeliveries()
    const row = ctx.db
      .prepare('SELECT status, attempts, last_error, next_attempt_at FROM bot_deliveries WHERE bot_id = ?')
      .get(ctx.botId) as { status: string; attempts: number; last_error: string; next_attempt_at: string | null }
    assert.equal(row.status, 'failed')
    assert.equal(row.attempts, 5, 'partial 失败 attempts 用尽')
    assert.match(row.last_error, /^partial_text_sent（已发送 1 段）：/)
    assert.equal(row.next_attempt_at, null)
    assert.ok(ctx.audits.some((item) => item.action === 'bot.delivery.partial'))

    const callsAfterFirst = ctx.state.sendCalls
    await ctx.service.processDeliveries()
    assert.equal(ctx.state.sendCalls, callsAfterFirst, '已部分外发的投递不得自动重试')
  } finally {
    cleanup(ctx)
  }
})

test('v0.5.7：发布任务区分 partial_text_sent 与 partial_media_sent，且不自动重试', async () => {
  const ctx = setup()
  try {
    // 文本部分外发
    const textJob = insertPublish(ctx.db, ctx.botId, ctx.targetId, '长'.repeat(5000))
    ctx.state.sendCalls = 0
    ctx.state.failSendFrom = 2
    await ctx.service.processPublishJobs()
    const textRow = ctx.db.prepare('SELECT status, attempts, last_error FROM bot_publish_jobs WHERE id = ?').get(textJob) as {
      status: string
      attempts: number
      last_error: string
    }
    assert.equal(textRow.status, 'failed')
    assert.equal(textRow.attempts, 5)
    assert.match(textRow.last_error, /^partial_text_sent/)
    assert.ok(ctx.audits.some((item) => item.action === 'bot.publish.partial' && item.detail?.kind === 'text'))

    // 附件部分外发（非图片附件逐个发送）
    const mediaJob = insertPublish(ctx.db, ctx.botId, ctx.targetId, '', ['file-1', 'file-2'])
    ctx.state.sendCalls = 0
    ctx.state.failSendFrom = 2
    await ctx.service.processPublishJobs()
    const mediaRow = ctx.db.prepare('SELECT status, attempts, last_error FROM bot_publish_jobs WHERE id = ?').get(mediaJob) as {
      status: string
      attempts: number
      last_error: string
    }
    assert.equal(mediaRow.status, 'failed')
    assert.match(mediaRow.last_error, /^partial_media_sent/)
    assert.ok(ctx.audits.some((item) => item.action === 'bot.publish.partial' && item.detail?.kind === 'media'))

    const callsAfter = ctx.state.sendCalls
    await ctx.service.processPublishJobs()
    assert.equal(ctx.state.sendCalls, callsAfter, 'partial 发布任务不得自动重试')
  } finally {
    cleanup(ctx)
  }
})

test('v0.5.7：AI 回答清洗→平台格式化（textMode=html），解除 1500 截断并按配置上限截断', async () => {
  // /ask 分支：默认 AI 桩返回纯文本，仍应以 Telegram HTML parse_mode 发送。
  const basic = setup()
  try {
    basic.service.updateTarget(basic.botId, basic.targetId, { allowCommands: true })
    basic.service.createTarget(basic.botId, {
      externalId: '7001',
      label: '管理员',
      kind: 'user',
      allowCommands: true,
      allowNotifications: false,
    })
    await webhookCommand(basic.service, basic.botId, '/ask 介绍一下', { userId: '7001' })
    const payload = JSON.parse(basic.sentBodies.at(-1) ?? '{}') as Record<string, unknown>
    assert.equal(payload.parse_mode, 'HTML')
    assert.equal(payload.text, 'AI 回复')
  } finally {
    cleanup(basic)
  }

  // Chat 分支：2000 字回答不再被固定 1500 截断。
  const long = setup({}, async () => '长'.repeat(2000))
  try {
    await gatewayChat(long.service, long.botId, { text: '长回答' })
    const payload = JSON.parse(long.sentBodies.at(-1) ?? '{}') as Record<string, unknown>
    assert.equal(String(payload.text).length, 2000, '1500 固定截断应已解除')
  } finally {
    cleanup(long)
  }

  // BOT_AI_MAX_REPLY_CHARS 生效。
  const capped = setup({ botAiMaxReplyChars: 1500 }, async () => '答'.repeat(3000))
  try {
    await gatewayChat(capped.service, capped.botId, { text: '超长回答' })
    const payload = JSON.parse(capped.sentBodies.at(-1) ?? '{}') as Record<string, unknown>
    assert.equal(String(payload.text).length, 1500)
  } finally {
    cleanup(capped)
  }

  // 内部路径/URL 与控制字符被清洗；Markdown 转 Telegram HTML。
  const sanitized = setup({}, async () => '# 标题\n**粗体** 见 /home/antifield/secret.txt 与 https://internal.example/x\u0007')
  try {
    await gatewayChat(sanitized.service, sanitized.botId, { text: '清洗测试' })
    const payload = JSON.parse(sanitized.sentBodies.at(-1) ?? '{}') as Record<string, unknown>
    const text = String(payload.text)
    assert.match(text, /<b>标题<\/b>/)
    assert.match(text, /<b>粗体<\/b>/)
    assert.match(text, /\[path\]/)
    assert.match(text, /\[url\]/)
    assert.equal(text.includes('/home/'), false)
    assert.equal(text.includes('internal.example'), false)
    assert.equal(text.includes('\u0007'), false)
  } finally {
    cleanup(sanitized)
  }
})

test('v0.5.7：图片理解开启时加载图片交给 AI，审计只记 mime/大小', async () => {
  const ctx = setup({ botAiVisionEnabled: true }, async () => '看到图片了')
  try {
    await gatewayChat(ctx.service, ctx.botId, {
      text: '这是什么',
      image: { ref: 'file-1', mime: 'image/png', name: 'pic.png' },
    })
    assert.equal(ctx.aiCalls.length, 1)
    assert.equal(ctx.aiCalls[0]?.image?.mime, 'image/png')
    assert.equal(ctx.aiCalls[0]?.image?.base64, Buffer.from('fake-png').toString('base64'))
    const payload = JSON.parse(ctx.sentBodies.at(-1) ?? '{}') as Record<string, unknown>
    assert.equal(payload.text, '看到图片了')
    const imageAudit = ctx.audits.filter((item) => item.action === 'bot.ai.image').at(-1)
    assert.equal(imageAudit?.detail?.mime, 'image/png')
    assert.equal(imageAudit?.detail?.size, Buffer.from('fake-png').length)
    assert.equal(JSON.stringify(ctx.audits).includes(Buffer.from('fake-png').toString('base64')), false)
    const event = ctx.service.listEvents(ctx.botId, { outcome: 'ok' }).items.at(-1)
    assert.equal(event?.detail, 'chat')
  } finally {
    cleanup(ctx)
  }
})

test('v0.5.7：vision 关闭/下载失败/无 loadImage 时按文本降级或提示', async () => {
  // vision 关闭且有文字：忽略图片继续，回复末尾追加说明。
  const disabled = setup({ botAiVisionEnabled: false }, async () => '按文字回答')
  try {
    await gatewayChat(disabled.service, disabled.botId, {
      text: '看看这张图',
      image: { ref: 'file-1', mime: 'image/png' },
    })
    assert.equal(disabled.aiCalls[0]?.image, undefined)
    const payload = JSON.parse(disabled.sentBodies.at(-1) ?? '{}') as Record<string, unknown>
    assert.match(String(payload.text), /按文字回答\n（图片未能处理，已按文字回答）/)
    assert.ok(disabled.audits.some((item) => item.action === 'bot.ai.image' && item.detail?.skipped === 'vision_disabled'))
  } finally {
    cleanup(disabled)
  }

  // vision 关闭且只有图片：提示用文字描述，不调用模型。
  const imageOnly = setup({ botAiVisionEnabled: false })
  try {
    await gatewayChat(imageOnly.service, imageOnly.botId, {
      text: '',
      image: { ref: 'file-1', mime: 'image/png' },
    })
    assert.equal(imageOnly.aiCalls.length, 0)
    const payload = JSON.parse(imageOnly.sentBodies.at(-1) ?? '{}') as Record<string, unknown>
    assert.equal(payload.text, '当前暂不支持处理这张图片，可以用文字描述。')
    const ignored = imageOnly.service.listEvents(imageOnly.botId, { outcome: 'ignored' })
    assert.equal(ignored.items.at(-1)?.detail, 'image_unsupported')
  } finally {
    cleanup(imageOnly)
  }

  // 下载失败且有文字：降级为纯文本并追加说明。
  const failed = setup({ botAiVisionEnabled: true }, async () => '降级回答')
  try {
    failed.state.getFileFails = true
    await gatewayChat(failed.service, failed.botId, {
      text: '图片下载失败',
      image: { ref: 'file-1', mime: 'image/png' },
    })
    assert.equal(failed.aiCalls[0]?.image, undefined)
    const payload = JSON.parse(failed.sentBodies.at(-1) ?? '{}') as Record<string, unknown>
    assert.match(String(payload.text), /（图片未能处理，已按文字回答）/)
  } finally {
    cleanup(failed)
  }

  // 适配器无 loadImage：同样降级。
  const noLoader = setup({ botAiVisionEnabled: true }, async () => '无加载器回答')
  const patch = noLoader.service as unknown as { adapterFor: (row: unknown) => unknown }
  try {
    patch.adapterFor = () => ({
      platform: 'telegram',
      async send(_target: unknown, content: { text: string }) {
        noLoader.sentBodies.push(JSON.stringify({ text: content.text }))
        return { externalId: 'mock' }
      },
    })
    await gatewayChat(noLoader.service, noLoader.botId, {
      text: '没有加载器',
      image: { ref: 'file-1', mime: 'image/png' },
    })
    assert.equal(noLoader.aiCalls[0]?.image, undefined)
    assert.match(String(JSON.parse(noLoader.sentBodies.at(-1) ?? '{}').text), /（图片未能处理，已按文字回答）/)
    assert.ok(noLoader.audits.some((item) => item.action === 'bot.ai.image' && item.detail?.skipped === 'unsupported'))
  } finally {
    cleanup(noLoader)
  }
})

test('v0.5.7：AI 调用失败记录 error 事件并回复兜底文案', async () => {
  const ctx = setup({}, async () => {
    throw new AppError(504, 'bot_ai_timeout', 'AI 响应超时')
  })
  try {
    await gatewayChat(ctx.service, ctx.botId, { text: '会失败' })
    const payload = JSON.parse(ctx.sentBodies.at(-1) ?? '{}') as Record<string, unknown>
    assert.equal(payload.text, '暂时没回应上来，稍后再试。')
    const errors = ctx.service.listEvents(ctx.botId, { outcome: 'error' })
    assert.equal(errors.total, 1)
    assert.equal(errors.items[0]?.detail, 'bot_ai_timeout')
  } finally {
    cleanup(ctx)
  }
})
