/**
 * v0.5.7 诊断与 AI 管线（QQ 单平台，F8/F2/F9/partial）：
 * - 事件 kind/outcome/detail 记录、筛选分页与参数校验、重复事件去重；
 * - deliveries/publish/metrics 的 lastErrorHint；
 * - partial 文本分段失败不自动重试且带固定前缀；
 * - AI 回答清洗→QQ 纯文本、回复上限、图片理解（默认开启）与降级、失败事件 outcome。
 * 不访问真实 QQ 网络或模型；fetch/AI 均为进程内夹具。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { newId } from '../src/util/ids.ts'
import { AppError } from '../src/util/errors.ts'
import {
  c2cWebhook,
  createQqServiceFixture,
  groupWebhook,
  lastMessageText,
  sendWebhook,
} from './bot-qq-fixtures.ts'

type Fixture = ReturnType<typeof createQqServiceFixture>

/** 合法图片附件：域名命中 QQ CDN 后缀白名单。 */
const IMAGE_ATTACHMENT = {
  url: 'https://gchat.qpic.cn/gchatpic_new/1/2/3',
  content_type: 'image/png',
  filename: 'pic.png',
  size: 10,
}

async function chat(fixture: Fixture, input: { id: string; content?: string; userOpenid?: string }): Promise<void> {
  await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { ...input, content: input.content ?? '', userOpenid: input.userOpenid }))
}

async function command(fixture: Fixture, text: string, id: string): Promise<void> {
  await sendWebhook(fixture, c2cWebhook(fixture.appSecret, { id, content: text, userOpenid: 'user-openid-1' }))
}

function insertDelivery(fixture: Fixture, text: string): void {
  const now = '2026-10-22T00:00:00.000Z'
  const target = fixture.service.createTarget(fixture.botId, {
    externalId: 'group-openid-1',
    label: '群',
    kind: 'group',
    allowCommands: false,
    allowNotifications: true,
  })
  fixture.db
    .prepare(
      `INSERT INTO bot_deliveries (id, bot_id, target_id, kind, payload_json, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'notification', ?, 'queued', 0, ?, ?)`,
    )
    .run(newId(), fixture.botId, target.id, JSON.stringify({ text }), now, now)
}

function insertPublish(fixture: Fixture, text: string): string {
  const now = '2026-10-22T00:00:00.000Z'
  const target = fixture.service.createTarget(fixture.botId, {
    externalId: 'group-publish-1',
    label: '发布群',
    kind: 'group',
    allowCommands: false,
    allowNotifications: true,
  })
  const id = newId()
  fixture.db
    .prepare(
      `INSERT INTO bot_publish_jobs (id, bot_id, target_id, content_json, media_file_ids_json, scheduled_at, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', NULL, 'queued', 0, ?, ?)`,
    )
    .run(id, fixture.botId, target.id, JSON.stringify({ text }), now, now)
  return id
}

test('v0.5.7：入站事件记录 kind/outcome/detail；支持 outcome 筛选、分页与参数校验', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true })
  try {
    await chat(fixture, { id: 'evt-ok-1', content: '正常对话' })
    const ok = fixture.service.listEvents(fixture.botId)
    assert.equal(ok.total, 1)
    assert.equal(ok.items[0]?.kind, 'chat')
    assert.equal(ok.items[0]?.outcome, 'ok')
    assert.equal(ok.items[0]?.detail, 'chat')
    assert.equal(ok.items[0]?.targetExternalId, 'user-openid-1')
    assert.equal(ok.items[0]?.userId, 'user-openid-1')
    assert.ok(ok.items[0]?.receivedAt)
    assert.ok(ok.items[0]?.updatedAt)

    // 群目标未开 allow_chat → denied。
    fixture.service.createTarget(fixture.botId, {
      externalId: 'group-openid-1',
      label: '群',
      kind: 'group',
      allowCommands: false,
      allowNotifications: false,
      allowChat: false,
    })
    await sendWebhook(
      fixture,
      groupWebhook(fixture.appSecret, {
        id: 'evt-denied-1',
        content: '<@!102345000> 你好',
        groupOpenid: 'group-openid-1',
      }),
    )
    const all = fixture.service.listEvents(fixture.botId)
    assert.equal(all.total, 2)
    assert.deepEqual(all.items.map((item) => item.outcome).sort(), ['denied', 'ok'])

    const denied = fixture.service.listEvents(fixture.botId, { outcome: 'denied' })
    assert.equal(denied.total, 1)
    assert.equal(denied.items[0]?.detail, 'chat_denied')

    const page = fixture.service.listEvents(fixture.botId, { limit: 1, offset: 1 })
    assert.equal(page.total, 2)
    assert.equal(page.items.length, 1)
    assert.equal(fixture.service.listEvents(fixture.botId, { limit: 0 }).items.length, 1, 'limit 下限归一为 1')
    assert.equal(fixture.service.listEvents(fixture.botId, { hours: 0 }).total, 2, 'hours 下限归一为 1')
    assert.throws(
      () => fixture.service.listEvents(fixture.botId, { outcome: 'bogus' }),
      (error: unknown) => error instanceof AppError && error.statusCode === 400,
    )
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.7：命令事件 ok/rate_limited 与重复事件去重；适配器 ignored 事件入库', async () => {
  const fixture = createQqServiceFixture({
    configOverrides: { botCommandRatePerMinute: 1 },
  })
  try {
    fixture.service.createTarget(fixture.botId, {
      externalId: 'user-openid-1',
      label: '管理员',
      kind: 'user',
      allowCommands: true,
      allowNotifications: false,
    })
    await command(fixture, '/status', 'cmd-1')
    const okEvent = fixture.service.listEvents(fixture.botId, { outcome: 'ok' }).items.at(-1)
    assert.equal(okEvent?.kind, 'command')
    assert.equal(okEvent?.detail, 'command_status')

    await command(fixture, '/status', 'cmd-2')
    const limited = fixture.service.listEvents(fixture.botId, { outcome: 'rate_limited' })
    assert.equal(limited.total, 1)
    assert.equal(limited.items[0]?.detail, 'command_rate_limited')

    // 重复事件：返回 opcode 12 确认且不新增事件行。
    const duplicate = c2cWebhook(fixture.appSecret, { id: 'cmd-3', content: '/status', userOpenid: 'user-openid-1' })
    const firstSend = await sendWebhook(fixture, duplicate)
    assert.equal(firstSend.status, 200)
    const beforeTotal = fixture.service.listEvents(fixture.botId).total
    const secondSend = await sendWebhook(fixture, duplicate)
    assert.deepEqual(secondSend.body, { opcode: 12 })
    assert.equal(fixture.service.listEvents(fixture.botId).total, beforeTotal)

    // 空内容事件由适配器返回 ignored（带 eventId），诊断记录 outcome=ignored。
    await chat(fixture, { id: 'ignored-1', content: '' })
    const ignored = fixture.service.listEvents(fixture.botId, { outcome: 'ignored' })
    assert.ok(ignored.items.some((item) => item.eventId === 'ignored-1'))
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.7：deliveries/publish/metrics 输出 lastErrorHint 中文提示', () => {
  const fixture = createQqServiceFixture()
  try {
    insertDelivery(fixture, '通知正文')
    fixture.db
      .prepare("UPDATE bot_deliveries SET status = 'failed', attempts = 1, last_error = 'bot_ai_timeout: 超时' WHERE bot_id = ?")
      .run(fixture.botId)
    insertPublish(fixture, '发布正文')
    fixture.db
      .prepare(
        "UPDATE bot_publish_jobs SET status = 'failed', attempts = 5, last_error = 'partial_text_sent（已发送 2 段）：发送失败' WHERE bot_id = ?",
      )
      .run(fixture.botId)

    const delivery = fixture.service.listDeliveries(fixture.botId)[0]
    assert.equal(delivery?.lastErrorHint, 'AI 响应超时：可稍后重试，或检查 OpenCode 服务状态')
    const job = fixture.service.listPublishJobs(fixture.botId)[0]
    assert.match(String(job?.lastErrorHint), /部分段落已发送/)
    const metrics = fixture.service.metrics(fixture.botId)
    assert.ok(metrics.lastError)
    assert.ok(metrics.lastErrorHint)
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.7：通知投递部分外发标记 partial_text_sent 且不再自动重试', async () => {
  const fixture = createQqServiceFixture({ fetchOptions: { failSendFrom: 2 } })
  try {
    insertDelivery(fixture, '长'.repeat(5000))
    await fixture.service.processDeliveries()
    const row = fixture.db
      .prepare('SELECT status, attempts, last_error, next_attempt_at FROM bot_deliveries WHERE bot_id = ?')
      .get(fixture.botId) as { status: string; attempts: number; last_error: string; next_attempt_at: string | null }
    assert.equal(row.status, 'failed')
    assert.equal(row.attempts, 5, 'partial 失败 attempts 用尽')
    assert.match(row.last_error, /^partial_text_sent（已发送 1 段）：/)
    assert.equal(row.next_attempt_at, null)
    assert.ok(fixture.audits.some((item) => item.action === 'bot.delivery.partial'))

    const callsAfterFirst = fixture.fetch.state.sendCalls
    await fixture.service.processDeliveries()
    assert.equal(fixture.fetch.state.sendCalls, callsAfterFirst, '已部分外发的投递不得自动重试')
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.7：发布任务部分外发标记 partial_text_sent 且不自动重试', async () => {
  const fixture = createQqServiceFixture({ fetchOptions: { failSendFrom: 2 } })
  try {
    const jobId = insertPublish(fixture, '长'.repeat(5000))
    await fixture.service.processPublishJobs()
    const row = fixture.db.prepare('SELECT status, attempts, last_error FROM bot_publish_jobs WHERE id = ?').get(jobId) as {
      status: string
      attempts: number
      last_error: string
    }
    assert.equal(row.status, 'failed')
    assert.equal(row.attempts, 5)
    assert.match(row.last_error, /^partial_text_sent/)
    assert.ok(fixture.audits.some((item) => item.action === 'bot.publish.partial'))

    const callsAfter = fixture.fetch.state.sendCalls
    await fixture.service.processPublishJobs()
    assert.equal(fixture.fetch.state.sendCalls, callsAfter, 'partial 发布任务不得自动重试')
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.7：AI 回答清洗→QQ 纯文本，解除 1500 截断并按配置上限截断', async () => {
  // /ask 分支：Markdown 被剥离为纯文本发送。
  const basic = createQqServiceFixture({ aiEnabled: true, aiHandler: async () => '# 标题\n**粗体** 回复' })
  try {
    basic.service.createTarget(basic.botId, {
      externalId: 'user-openid-1',
      label: '管理员',
      kind: 'user',
      allowCommands: true,
      allowNotifications: false,
    })
    await command(basic, '/ask 介绍一下', 'ask-1')
    const text = lastMessageText(basic)
    assert.ok(text.includes('标题'))
    assert.ok(text.includes('粗体 回复'))
    assert.equal(text.includes('**'), false, 'QQ 纯文本应剥离 Markdown')
    assert.equal(text.includes('# 标题'), false)
  } finally {
    basic.cleanup()
  }

  // Chat 分支：2000 字回答不再被固定 1500 截断。
  const long = createQqServiceFixture({ aiEnabled: true, aiHandler: async () => '长'.repeat(2000) })
  try {
    await chat(long, { id: 'chat-long-1', content: '长回答' })
    assert.equal(lastMessageText(long).length, 2000, '1500 固定截断应已解除')
  } finally {
    long.cleanup()
  }

  // BOT_AI_MAX_REPLY_CHARS 生效。
  const capped = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { botAiMaxReplyChars: 1500 },
    aiHandler: async () => '答'.repeat(3000),
  })
  try {
    await chat(capped, { id: 'chat-cap-1', content: '超长回答' })
    assert.equal(lastMessageText(capped).length, 1500)
  } finally {
    capped.cleanup()
  }

  // 内部路径/URL 与控制字符被清洗。
  const sanitized = createQqServiceFixture({
    aiEnabled: true,
    aiHandler: async () => '见 /home/antifield/secret.txt 与 https://internal.example/x\u0007',
  })
  try {
    await chat(sanitized, { id: 'chat-sanitize-1', content: '清洗测试' })
    const text = lastMessageText(sanitized)
    assert.match(text, /\[path\]/)
    assert.match(text, /\[url\]/)
    assert.equal(text.includes('/home/'), false)
    assert.equal(text.includes('internal.example'), false)
    assert.equal(text.includes('\u0007'), false)
  } finally {
    sanitized.cleanup()
  }
})

test('v0.5.7：图片理解默认开启，QQ 入站图片下载后交给 AI，审计只记 mime/大小', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true, aiHandler: async () => '看到图片了' })
  try {
    assert.equal(fixture.config.botAiVisionEnabled, true, 'v0.5.8 起图片理解默认开启')
    await sendWebhook(
      fixture,
      c2cWebhook(fixture.appSecret, {
        id: 'img-1',
        content: '这是什么',
        attachments: [IMAGE_ATTACHMENT],
      }),
    )
    assert.equal(fixture.aiCalls.length, 1)
    assert.equal(fixture.aiCalls[0]?.image?.mime, 'image/png')
    assert.equal(fixture.aiCalls[0]?.image?.base64, Buffer.from('fake-image').toString('base64'))
    assert.ok(String(fixture.aiCalls[0]?.prompt).includes('这是什么'))
    assert.equal(lastMessageText(fixture), '看到图片了')
    const imageAudit = fixture.audits.filter((item) => item.action === 'bot.ai.image').at(-1)
    assert.equal(imageAudit?.detail?.mime, 'image/png')
    assert.equal(imageAudit?.detail?.size, Buffer.from('fake-image').length)
    assert.equal(JSON.stringify(fixture.audits).includes(Buffer.from('fake-image').toString('base64')), false)
    const event = fixture.service.listEvents(fixture.botId, { outcome: 'ok' }).items.at(-1)
    assert.equal(event?.detail, 'chat')
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.7：仅图片无正文时用中性占位送入模型', async () => {
  const fixture = createQqServiceFixture({ aiEnabled: true, aiHandler: async () => '图片收到' })
  try {
    await sendWebhook(
      fixture,
      c2cWebhook(fixture.appSecret, { id: 'img-only-1', content: '', attachments: [IMAGE_ATTACHMENT] }),
    )
    assert.equal(fixture.aiCalls.length, 1)
    assert.ok(fixture.aiCalls[0]?.prompt.includes('（用户发送了一张图片）'))
    assert.equal(fixture.aiCalls[0]?.image?.mime, 'image/png')
    assert.equal(lastMessageText(fixture), '图片收到')
    assert.equal(fixture.memoryCalls.length, 1, '占位文本用于记忆摘要')
  } finally {
    fixture.cleanup()
  }
})

test('v0.5.7：图片识别关闭/下载失败/无 loadImage 时按文本降级或提示', async () => {
  // 识别关闭且有文字：忽略图片继续，回复末尾追加说明。
  const disabled = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { botAiVisionEnabled: false },
    aiHandler: async () => '按文字回答',
  })
  try {
    await sendWebhook(
      disabled,
      c2cWebhook(disabled.appSecret, { id: 'img-2', content: '看看这张图', attachments: [IMAGE_ATTACHMENT] }),
    )
    assert.equal(disabled.aiCalls[0]?.image, undefined)
    assert.match(lastMessageText(disabled), /按文字回答\n（图片未能处理，已按文字回答）/)
    assert.ok(disabled.audits.some((item) => item.action === 'bot.ai.image' && item.detail?.skipped === 'vision_disabled'))
  } finally {
    disabled.cleanup()
  }

  // 识别关闭且只有图片：提示用文字描述，不调用模型。
  const imageOnly = createQqServiceFixture({
    aiEnabled: true,
    configOverrides: { botAiVisionEnabled: false },
  })
  try {
    await sendWebhook(imageOnly, c2cWebhook(imageOnly.appSecret, { id: 'img-3', content: '', attachments: [IMAGE_ATTACHMENT] }))
    assert.equal(imageOnly.aiCalls.length, 0)
    assert.equal(lastMessageText(imageOnly), '当前暂不支持处理这张图片，可以用文字描述。')
    const ignored = imageOnly.service.listEvents(imageOnly.botId, { outcome: 'ignored' })
    assert.equal(ignored.items.at(-1)?.detail, 'image_unsupported')
  } finally {
    imageOnly.cleanup()
  }

  // 下载失败且有文字：降级为纯文本并追加说明。
  const failed = createQqServiceFixture({
    aiEnabled: true,
    fetchOptions: { imageDownloadFails: true },
    aiHandler: async () => '降级回答',
  })
  try {
    await sendWebhook(failed, c2cWebhook(failed.appSecret, { id: 'img-4', content: '图片下载失败', attachments: [IMAGE_ATTACHMENT] }))
    assert.equal(failed.aiCalls[0]?.image, undefined)
    assert.match(lastMessageText(failed), /（图片未能处理，已按文字回答）/)
  } finally {
    failed.cleanup()
  }

  // 适配器无 loadImage：同样降级。
  const noLoader = createQqServiceFixture({ aiEnabled: true, aiHandler: async () => '无加载器回答' })
  const internals = noLoader.service as unknown as { adapterFor: (row: unknown) => object }
  const originalAdapterFor = internals.adapterFor
  try {
    // 代理真实适配器，仅屏蔽 loadImage；验证/发送仍走真实实现。
    internals.adapterFor = (row: unknown) => {
      const adapter = originalAdapterFor.call(noLoader.service, row) as object
      return Object.assign(Object.create(adapter), { loadImage: undefined }) as object
    }
    await sendWebhook(
      noLoader,
      c2cWebhook(noLoader.appSecret, { id: 'img-5', content: '没有加载器', attachments: [IMAGE_ATTACHMENT] }),
    )
    assert.equal(noLoader.aiCalls[0]?.image, undefined)
    assert.match(lastMessageText(noLoader), /（图片未能处理，已按文字回答）/)
    assert.ok(noLoader.audits.some((item) => item.action === 'bot.ai.image' && item.detail?.skipped === 'unsupported'))
  } finally {
    internals.adapterFor = originalAdapterFor
    noLoader.cleanup()
  }
})

test('v0.5.7：AI 调用失败记录 error 事件并回复兜底文案', async () => {
  const fixture = createQqServiceFixture({
    aiEnabled: true,
    aiHandler: async () => {
      throw new AppError(504, 'bot_ai_timeout', 'AI 响应超时')
    },
  })
  try {
    await chat(fixture, { id: 'ai-error-1', content: '会失败' })
    assert.equal(lastMessageText(fixture), '暂时没回应上来，稍后再试。')
    const errors = fixture.service.listEvents(fixture.botId, { outcome: 'error' })
    assert.equal(errors.total, 1)
    assert.equal(errors.items[0]?.detail, 'bot_ai_timeout')
  } finally {
    fixture.cleanup()
  }
})
