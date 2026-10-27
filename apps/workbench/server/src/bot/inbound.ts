/**
 * Bot 入站处理（D-16 行为保持重构）：Webhook 验签/限流/去重、事件分发、命令与 Chat 路由。
 *
 * 安全边界（与重构前一致）：
 * - Webhook 只按平台签名/时间戳鉴权；验签前只做「明显未认证流量」限流，已验签事件才消耗业务桶；
 * - 命令需目标 allow_commands + 用户白名单（自助命令除外）；群聊/频道不执行任何斜杠命令；
 * - Chat 需目标 allow_chat 或 QQ C2C；工具隔离不可用（SEC-11）时 fail-closed，不进入 AI。
 *
 * 本模块只做路由/校验，命令执行与 Chat 管线由 BotService 通过回调注入，避免与 facade 循环依赖。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../config.ts'
import { AppError } from '../util/errors.ts'
import type { SlidingWindowLimiter } from '../auth/limiter.ts'
import type {
  BotAdapter,
  BotEventOutcome,
  BotRow,
  BotTargetRow,
  GroupReplyMode,
  InboundVerification,
} from './types.ts'

/** 工具隔离不可用时给用户的固定提示（fail-closed，不调用 AI；Chat 管线的防御性检查也复用它）。 */
export const AI_ISOLATION_BLOCKED_TEXT = '安全隔离不可用，暂时停止 AI 对话。'

export interface ParsedCommand {
  command: string
  args: string
}

export interface ChatEnqueueItem {
  bot: BotRow
  result: Extract<InboundVerification, { kind: 'chat' }>
  text: string
}

export interface BurstTimingLike {
  windowMs?: number
  maxWaitMs?: number
}

export interface BotInboundDeps {
  db: DatabaseSync
  config: Config
  log: (level: 'info' | 'warn' | 'error', message: string, detail?: Record<string, unknown>) => void
  audit: (action: string, target: string | null, detail?: Record<string, unknown>) => void
  botRow: (id: string) => BotRow
  adapterFor: (bot: BotRow) => BotAdapter
  inboundTarget: (
    botId: string,
    result: Extract<InboundVerification, { kind: 'command' | 'chat' }>,
  ) => BotTargetRow | undefined
  isCommandUserAllowed: (botId: string, userId: string) => boolean
  commandLimiter: SlidingWindowLimiter
  webhookUnauthenticatedLimiter: SlidingWindowLimiter
  webhookAuthenticatedLimiter: SlidingWindowLimiter
  auditWebhookThrottled: (action: string, botId: string, detail?: Record<string, unknown>) => void
  insertEvent: (
    botId: string,
    eventId: string,
    kind: string,
    outcome: BotEventOutcome,
    detail: string | null,
    targetExternalId: string | null,
    userId: string | null,
  ) => boolean
  markEvent: (
    botId: string,
    eventId: string,
    update: { outcome: BotEventOutcome; detail?: string; target?: string; user?: string },
  ) => void
  recordInbound: (bot: BotRow, result: Extract<InboundVerification, { kind: 'command' | 'chat' }>) => void
  /** 真正执行命令（只读 provider / 自助命令 / `/search`）；由 BotService 提供。 */
  executeCommand: (
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'command' }>,
    parsed: ParsedCommand | null,
    adminAllowed: boolean,
  ) => Promise<void>
  /** 把 Chat 消息放入连续消息合并器；由 BotService 提供。 */
  enqueueChat: (
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'chat' }>,
    text: string,
    timing: BurstTimingLike | undefined,
  ) => void
  /** 跟踪异步任务（测试/停机关闭等待）。 */
  track: (task: Promise<void>) => void
  /** SEC-11：工具隔离是否不可用且仍在重试窗口内。 */
  aiIsolationBlocked: () => boolean
}

/** 过滤控制字符并截断。 */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  let text = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 32 && code !== 127) text += char
  }
  return text.trim().slice(0, max)
}

/** 解析 `/command args`；不是斜杠命令返回 null。 */
export function parseCommandText(text: string): ParsedCommand | null {
  const parsed = /^\/([a-z0-9_]{1,32})(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!parsed) return null
  return { command: parsed[1] ?? '', args: (parsed[2] ?? '').trim() }
}

/**
 * 仅@/名字提及模式：用 Bot 名称做保守文本匹配（大小写不敏感）。
 * 边界要求：ASCII 字母/数字/下划线相邻时不算命中（`lofii` 不匹配 `xlofiix`）；
 * 中文没有空格分词，名字紧贴汉字仍视为命中；单字符名称过于容易误触发，不参与名字匹配（只认平台 mentions）。
 */
export function isBotNameMentioned(botName: string, text: string): boolean {
  const name = botName.trim().toLowerCase()
  if (name.length < 2) return false
  const haystack = text.toLowerCase()
  const isWordChar = (char: string): boolean => /[a-z0-9_]/i.test(char)
  let from = 0
  while (from <= haystack.length - name.length) {
    const index = haystack.indexOf(name, from)
    if (index < 0) return false
    const before = index === 0 ? '' : haystack[index - 1]!
    const after = haystack[index + name.length] ?? ''
    if (!isWordChar(before) && !isWordChar(after)) return true
    from = index + name.length
  }
  return false
}

/** 群消息模式只允许 mention/all；非群聊目标固定 mention。 */
export function normalizeGroupReplyMode(value: unknown, kind: BotTargetRow['kind']): GroupReplyMode {
  const mode = value === 'all' ? 'all' : value === 'mention' ? 'mention' : value === undefined ? undefined : null
  if (mode === null) throw new AppError(400, 'invalid_request', '群消息模式无效')
  if (kind !== 'group') {
    if (mode === 'all') throw new AppError(400, 'invalid_request', '仅群聊目标支持接收全部消息')
    return 'mention'
  }
  return mode ?? 'mention'
}

/** 通知/命令回复只保留用户可见文本，去除内部路径与 URL（审计 BOT-04）。 */
export function sanitizeExternalText(value: string): string {
  return value
    .replace(/(?:[A-Za-z]:\\|\/(?:home|var|etc|opt|run|proc|sys|tmp)\/)[^\s"'`]+/g, '[path]')
    .replace(/(?:ssh|https?):\/\/[^\s"'`]+/g, '[url]')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, 1500)
}

/** 适配器部分发送失败时挂在错误对象上的已发送 ID；用于禁止自动重试。 */
export function sentExternalIdsOf(error: unknown): string[] {
  if (!error || typeof error !== 'object') return []
  const value = (error as { sentExternalIds?: unknown }).sentExternalIds
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** 诊断 detail 只记录短代码：优先 AppError.code，其次通用 error。 */
export function errorShortCode(error: unknown): string {
  if (error instanceof AppError) return error.code.slice(0, 60)
  return 'error'
}

/** 读取单个请求头（大小写无关，取第一个值并去空白）。 */
export function headerText(headers: Record<string, string | string[] | undefined>, name: string): string {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name.toLowerCase()) continue
    const raw = Array.isArray(value) ? value[0] : value
    return typeof raw === 'string' ? raw.trim() : ''
  }
  return ''
}

/** QQ 事件签名头的形状（存在且格式合法才说明可能是平台请求，用于区分明显未认证流量）。 */
export function hasSignedEventHeaders(headers: Record<string, string | string[] | undefined>): boolean {
  return (
    /^[0-9a-f]{128}$/i.test(headerText(headers, 'x-signature-ed25519')) &&
    /^\d{1,12}$/.test(headerText(headers, 'x-signature-timestamp'))
  )
}

/** Webhook/命令分发：只依赖显式回调，不直接持有 BotService。 */
export class BotInboundHandler {
  private readonly deps: BotInboundDeps

  constructor(deps: BotInboundDeps) {
    this.deps = deps
  }

  async handleWebhook(
    botId: string,
    headers: Record<string, string | string[] | undefined>,
    body: Buffer,
  ): Promise<{ status: number; body: unknown }> {
    const { config, log, audit } = this.deps
    if (!config.botEnabled) return { status: 404, body: { error: { code: 'not_found' } } }
    let bot: BotRow
    try {
      bot = this.deps.botRow(botId)
    } catch {
      return { status: 404, body: { error: { code: 'not_found' } } }
    }
    if (!bot.enabled) return { status: 404, body: { error: { code: 'not_found' } } }
    // BOT-08/SEC-06：明显未认证流量（无签名头，含 op=13 挑战）走独立桶，
    // 不占用已验签事件的业务桶，避免知道 botId 的人用无效请求饿死真实平台事件。
    const signedShape = hasSignedEventHeaders(headers)
    if (!signedShape && this.deps.webhookUnauthenticatedLimiter.hit(bot.id) > 0) {
      this.deps.auditWebhookThrottled('bot.webhook.rate_limited', bot.id, { bucket: 'unauthenticated' })
      return { status: 429, body: { error: { code: 'rate_limited' } } }
    }
    let result: InboundVerification
    try {
      result = await this.deps.adapterFor(bot).verifyInbound({ botId, headers, body })
    } catch {
      log('warn', 'Bot Webhook 验签异常', { bot: bot.id })
      return { status: 400, body: { error: { code: 'invalid_request' } } }
    }
    if (result.kind === 'rejected') {
      // 形状合法但签名错误/过期：同样计入未认证桶；达到上限后用 429 抑制后续噪声（审计已聚合）。
      if (signedShape && this.deps.webhookUnauthenticatedLimiter.hit(bot.id) > 0) {
        this.deps.auditWebhookThrottled('bot.webhook.rate_limited', bot.id, { bucket: 'unauthenticated' })
        return { status: 429, body: { error: { code: 'rate_limited' } } }
      }
      this.deps.auditWebhookThrottled('bot.webhook.rejected', bot.id, { code: result.code })
      return { status: result.status, body: { error: { code: result.code } } }
    }
    if (result.kind === 'challenge') {
      // op=13 成功校验只审计事件本身，不记录 plain_token/签名（可能被用于推断签名材料）。
      audit('bot.webhook.challenge', bot.id)
      return { status: 200, body: result.body }
    }
    // 已验签事件才消耗业务桶（command/chat 必然经过 op=0 签名校验；带 eventId 的 ignored 也是签名事件）。
    const verifiedEvent =
      result.kind === 'command' || result.kind === 'chat' || (result.kind === 'ignored' && Boolean(result.eventId))
    if (verifiedEvent && this.deps.webhookAuthenticatedLimiter.hit(bot.id) > 0) {
      this.deps.auditWebhookThrottled('bot.webhook.rate_limited', bot.id, { bucket: 'authenticated' })
      return { status: 429, body: { error: { code: 'rate_limited' } } }
    }
    if (result.kind === 'ignored') {
      if (result.detail) audit('bot.event.ignored', bot.id, { event: result.detail.slice(0, 80) })
      // 适配器可给出去重事件 ID；带 ID 时记录 ignored 结果供诊断查询。
      if (result.eventId) {
        this.deps.insertEvent(bot.id, result.eventId, 'ignored', 'ignored', result.detail ?? null, null, null)
      }
      return { status: 200, body: result.ackBody ?? { ok: true } }
    }
    const inserted = this.deps.insertEvent(
      bot.id,
      result.eventId,
      result.kind,
      'received',
      null,
      result.targetExternalId,
      result.userId,
    )
    if (!inserted) return { status: 200, body: result.ackBody ?? { ok: true, duplicate: true } }
    this.deps.recordInbound(bot, result)
    if (result.kind === 'command') {
      if (!result.isDirect) {
        // v0.6.3 起群聊/频道不再接受斜杠命令；静默确认，避免平台重推。
        audit('bot.command.disabled', bot.id, {
          target: result.targetExternalId,
          user: result.userId.slice(0, 64),
        })
        this.deps.markEvent(bot.id, result.eventId, {
          outcome: 'ignored',
          detail: 'commands_disabled',
          target: result.targetExternalId,
          user: result.userId,
        })
        return { status: 200, body: result.ackBody ?? { ok: true } }
      }
      return this.dispatchCommand(bot, result)
    }
    return this.dispatchChat(bot, result)
  }

  private async dispatchCommand(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'command' }>,
  ): Promise<{ status: number; body: unknown }> {
    const parsed = parseCommandText(result.text)
    const command = parsed?.command ?? ''
    const ack = () => result.ackBody ?? { ok: true }
    // /help、/role（私聊）、/reset、/forget、/memory、/search 面向所有用户；其余命令需目标 allow_commands + user 白名单。
    const openCommand =
      command === 'help' ||
      command === 'role' ||
      command === 'reset' ||
      command === 'forget' ||
      command === 'memory' ||
      command === 'search'
    const target = this.deps.inboundTarget(bot.id, result)
    const adminAllowed = Boolean(
      target && target.allow_commands === 1 && this.deps.isCommandUserAllowed(bot.id, result.userId),
    )
    if (!openCommand && !adminAllowed) {
      this.deps.audit('bot.command.denied', bot.id, {
        target: result.targetExternalId,
        user: result.userId.slice(0, 64),
      })
      this.deps.markEvent(bot.id, result.eventId, {
        outcome: 'denied',
        detail: 'command_denied',
        target: result.targetExternalId,
        user: result.userId,
      })
      return { status: 200, body: ack() }
    }
    const retry = this.deps.commandLimiter.hit(`${bot.id}:${result.userId}`)
    if (retry > 0) {
      void result.reply('命令过于频繁，请稍后再试。').catch(() => undefined)
      this.deps.markEvent(bot.id, result.eventId, {
        outcome: 'rate_limited',
        detail: 'command_rate_limited',
        target: result.targetExternalId,
        user: result.userId,
      })
      return { status: 200, body: ack() }
    }
    const task = this.deps.executeCommand(bot, result, parsed, adminAllowed).catch((error: unknown) => {
      this.deps.log('warn', 'Bot 命令执行失败', {
        bot: bot.id,
        error: error instanceof Error ? error.message : 'unknown',
      })
      this.deps.markEvent(bot.id, result.eventId, {
        outcome: 'error',
        detail: sentExternalIdsOf(error).length > 0 ? 'partial_reply' : errorShortCode(error),
        target: result.targetExternalId,
        user: result.userId,
      })
    })
    this.deps.track(task)
    return { status: 200, body: ack() }
  }

  private async dispatchChat(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'chat' }>,
  ): Promise<{ status: number; body: unknown }> {
    const target = this.deps.inboundTarget(bot.id, result)
    const ack = () => result.ackBody ?? { ok: true }
    const mark = (outcome: BotEventOutcome, detail: string) =>
      this.deps.markEvent(bot.id, result.eventId, {
        outcome,
        detail,
        target: result.targetExternalId,
        user: result.userId,
      })
    // QQ C2C 的接触面由 QQ 平台“谁可添加 Bot”控制；Chat 对任意 C2C 开放，命令仍走目标白名单。
    const openQqC2c = result.isDirect && result.targetKind === 'user'
    if ((!target || target.allow_chat !== 1) && !openQqC2c) {
      this.deps.audit('bot.chat.denied', bot.id, { target: result.targetExternalId })
      mark('denied', 'chat_denied')
      return { status: 200, body: ack() }
    }
    if (!this.deps.config.botAiEnabled) {
      mark('ignored', 'ai_disabled')
      return { status: 200, body: ack() }
    }
    // SEC-11 fail-closed：工具隔离不可用时直接拒绝新 Chat（不排队、不调用 AI），并留审计/事件；
    // 全量群消息保持静默（不向群内发送系统提示），私聊/@ 回复固定提示。
    if (this.deps.aiIsolationBlocked()) {
      this.deps.audit('bot.ai.isolation_blocked', bot.id, {
        target: result.targetExternalId,
        user: result.userId.slice(0, 64),
        reason: 'permissions_denied',
      })
      if (result.chatTrigger === 'all') {
        mark('ignored', 'ai_isolation_unavailable')
      } else {
        mark('denied', 'ai_isolation_unavailable')
        await result.reply(AI_ISOLATION_BLOCKED_TEXT).catch(() => undefined)
      }
      return { status: 200, body: ack() }
    }
    const text = cleanText(result.text, this.deps.config.botAiMaxPromptChars)
    // 允许只有图片没有正文的消息进入 AI 管线。
    if (!text && !result.image) {
      mark('ignored', 'empty_content')
      return { status: 200, body: ack() }
    }
    let effective = result
    if (result.targetKind === 'group' && target) {
      // 全量模式消息进入后，再按目标设置过滤：仅@/名字模式未命中则静默忽略；
      // 命中 @/名字时标记为 mention（必回复），未命中且目标为 all 时交给模型决策。
      if (result.chatTrigger === 'all') {
        const addressed = result.mentionedBot === true || isBotNameMentioned(bot.name, result.text)
        if (target.chat_trigger === 'mention' && !addressed) {
          mark('ignored', 'mention_filtered')
          return { status: 200, body: ack() }
        }
        if (addressed) effective = { ...result, chatTrigger: 'mention' }
      }
    }
    this.deps.audit('bot.chat', `${bot.platform}:${result.targetExternalId}`, {
      bot: bot.id,
      user: result.userId.slice(0, 64),
      chars: text.length,
      ...(result.image ? { image: result.image.mime.slice(0, 50) } : {}),
      ...(target ? {} : { open: 'qq_c2c' }),
      ...(target?.kind === 'group' ? { replyMode: target.chat_trigger } : {}),
    })
    // 连续消息合并 + 同会话串行由 Chat 管线负责；Webhook 仍立即 ack。
    // 全量群消息使用更长窗口，减少对非 @ 闲聊逐条调用 AI 的次数；@/名字命中的消息仍即时回复。
    const burstTiming =
      effective.chatTrigger === 'all'
        ? {
            windowMs: this.deps.config.botChatBurstGroupAllWindowMs,
            maxWaitMs: this.deps.config.botChatBurstGroupAllMaxWaitMs,
          }
        : undefined
    this.deps.enqueueChat(bot, effective, text, burstTiming)
    return { status: 200, body: ack() }
  }
}
