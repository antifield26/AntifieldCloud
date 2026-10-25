/**
 * Bot Chat 管线（D-16 行为保持重构）：连续消息合并、per-session 串行、提示词组装、
 * OpenCode 对话、联网搜索、消息发送工具缓冲与异常兜底发送。
 *
 * 安全边界（与重构前一致）：
 * - 只把用户文本/图片/记忆/搜索资料组装进提示词，记忆与搜索结果只作为背景资料；
 * - 发送工具凭据由 BOT_SECRET_KEY 派生（绑定 turnId+目标+用户，3 分钟、单轮 ≤5 条）；
 * - 工具隔离不可用（SEC-11）时 Chat 入口/批次执行前双重 fail-closed，不调用 AI；
 * - 回复/工具消息统一经清洗、纯文本格式化与 2000 字符分段后外发；partial 不自动重试。
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Config } from '../config.ts'
import { AppError } from '../util/errors.ts'
import { newId } from '../util/ids.ts'
import { SlidingWindowLimiter } from '../auth/limiter.ts'
import { BurstMerger, type BurstTiming } from './burst.ts'
import { buildBotPrompt, type BotSendToolPrompt, type GroupChatMode } from './prompts.ts'
import { formatAiReply } from './format.ts'
import { extractRawToolCallText, stripRawToolCallText } from './dsml.ts'
import { GROUP_CHAT_SESSION_USER_ID } from './session.ts'
import type { BotChatRole, BotChatRoleStore } from './roles.ts'
import type { BotGroupRoleStore } from './group-roles.ts'
import { groupMemoryScope, type BotMemoryStore } from './memory.ts'
import {
  formatSearchPromptContext,
  formatSearchSources,
  isSearchFollowUp,
  needsWebSearch,
  normalizeSearchQuery,
  type WebSearchClient,
  type WebSearchResult,
} from './search.ts'
import {
  AI_ISOLATION_BLOCKED_TEXT,
  cleanText,
  errorShortCode,
  sentExternalIdsOf,
} from './inbound.ts'
import type {
  BotAiImage,
  BotEventOutcome,
  BotRow,
  BotServiceDeps,
  BotTargetRow,
  InboundVerification,
} from './types.ts'

const AI_SEND_TOOL_NAME = 'botmsg_send_message'
const AI_SEND_MAX_MESSAGES = 5
const AI_SEND_MAX_TEXT = 1800
const AI_SEND_TURN_TTL_MS = 3 * 60_000

interface ChatBurstItem {
  bot: BotRow
  result: Extract<InboundVerification, { kind: 'chat' }>
  text: string
}

/**
 * 一轮 AI 对话的消息发送上下文：模型通过 MCP 工具把消息写入缓冲区，
 * 回合结束后由服务端统一发送（避免工具调用中途部分外发）。
 * turnToken 由 BOT_SECRET_KEY 做 HMAC，工具路由只认本轮 token。
 */
interface AiSendTurn {
  id: string
  token: string
  targetExternalId: string
  targetKind: BotTargetRow['kind']
  userId: string
  messages: string[]
  expiresAtMs: number
}

interface WebSearchContext {
  query: string
  results: WebSearchResult[]
  /** 搜索失败时保留原因类别（不记录查询正文）。 */
  failed?: boolean
}

type SearchResolution = { kind: 'ok'; context: WebSearchContext | null } | { kind: 'rate_limited' }

/** AI 图片理解允许的 mime；超出范围降级为纯文本。 */
const IMAGE_MIME_ALLOWLIST = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
/** 入站图片下载超时；由适配器 loadImage 执行。 */
const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000
/** 图片无法处理时附在纯文字回答末尾的说明。 */
const IMAGE_DEGRADED_NOTE = '（图片未能处理，已按文字回答）'
const IMAGE_UNSUPPORTED_TEXT = '当前暂不支持处理这张图片，可以用文字描述。'
/** 仅图片无正文时交给模型的用户消息占位，避免空用户消息。 */
const IMAGE_ONLY_USER_TEXT = '（用户发送了一张图片）'

/**
 * 消息发送工具的回合凭据：HMAC(KDF(BOT_SECRET_KEY, 'turn-token'), turnId + 目标 + 用户)。
 * 用域分离子密钥做 HMAC，避免与 AES 凭据加密直接复用同一把密钥（SEC-14）；
 * 绑定目标/用户后，即使 token 从某一轮提示词/会话历史泄漏，也不能跨会话复用。
 */
function aiSendTurnToken(key: Buffer, turnId: string, targetExternalId: string, userId: string): string {
  const hmacKey = createHash('sha256').update(key).update('\u0000turn-token', 'utf8').digest()
  return createHmac('sha256', hmacKey)
    .update(`${turnId}\u0000${targetExternalId}\u0000${userId}`, 'utf8')
    .digest('base64url')
}

/** 全量群消息模式：模型以 NO_REPLY（允许 []/标点包裹）表示本轮不发言。 */
function isNoReplyAnswer(answer: string): boolean {
  const trimmed = answer.trim().toUpperCase()
  const unpadded = trimmed.replace(/^[\s"'`]+|[\s"'`]+$/g, '')
  const normalized = unpadded.startsWith('[') && unpadded.endsWith(']')
    ? unpadded.slice(1, -1).trim()
    : unpadded
  return normalized === 'NO_REPLY' || normalized === 'NOREPLY'
}

/** 会话 key：Bot×目标×用户（与 burst 合并键一致）。 */
function botChatKey(botId: string, targetExternalId: string, userId: string): string {
  return `${botId}:${targetExternalId}:${userId}`
}

/**
 * 群聊 AI 会话串行键：同一群的所有成员共享一个 OpenCode 会话，因此按目标串行；
 * 私聊仍按 Bot×目标×用户串行。
 */
function botChatSerializationKey(botId: string, targetExternalId: string, userId: string, isGroup: boolean): string {
  return isGroup ? `${botId}:${targetExternalId}:group` : botChatKey(botId, targetExternalId, userId)
}

/** Chat 管线需要 BotService 提供的能力（facade 反向注入，避免循环依赖）。 */
export interface BotChatHost {
  markEvent: (
    botId: string,
    eventId: string,
    update: { outcome: import('./types.ts').BotEventOutcome; detail?: string; target?: string; user?: string },
  ) => void
  inboundTarget: (
    botId: string,
    result: Extract<InboundVerification, { kind: 'command' | 'chat' }>,
  ) => BotTargetRow | undefined
  inboundDisplayName: (result: Extract<InboundVerification, { kind: 'chat' }>) => string
  targetNameForSession: (botId: string, targetExternalId: string, userId: string, userName?: string | null) => string
  scheduleMemoryUpdate: (
    bot: BotRow,
    userId: string,
    targetExternalId: string,
    userText: string,
    assistantText: string,
    options?: { memoryScope?: string; groupUserName?: string },
  ) => void
  observeAiToolIsolation: (botId: string) => void
  aiIsolationBlocked: () => boolean
  adapterFor: (bot: BotRow) => import('./types.ts').BotAdapter
  trackTask: (task: Promise<void>) => void
}

export interface BotChatDeps {
  config: Config
  key: Buffer | null
  deps: Pick<BotServiceDeps, 'db' | 'log' | 'audit' | 'ai' | 'search' | 'now'> & {
    memory: BotMemoryStore
  }
  roles: BotChatRoleStore
  groupRoles: BotGroupRoleStore
  host: BotChatHost
}

/** 进行中的 AI 对话管线：所有 Chat 回合经同一 per-session 串行锁，避免并发写同一 OpenCode 会话。 */
export class BotChatPipeline {
  private readonly config: Config
  private readonly key: Buffer | null
  private readonly deps: BotChatDeps['deps']
  private readonly roles: BotChatRoleStore
  private readonly groupRoles: BotGroupRoleStore
  private readonly host: BotChatHost
  private readonly chatLimiter: SlidingWindowLimiter
  private readonly aiLimiter: SlidingWindowLimiter
  private readonly searchLimiter: SlidingWindowLimiter
  private readonly chatBursts: BurstMerger<ChatBurstItem>
  private readonly aiSendTurns = new Map<string, AiSendTurn>()
  private readonly chatQueues = new Map<string, Promise<void>>()
  private readonly lastSearchQueries = new Map<string, string>()
  private readonly webSearch: WebSearchClient | null

  constructor(input: BotChatDeps) {
    this.config = input.config
    this.key = input.key
    this.deps = input.deps
    this.roles = input.roles
    this.groupRoles = input.groupRoles
    this.host = input.host
    this.chatLimiter = new SlidingWindowLimiter(60_000, Math.max(1, input.config.botChatRatePerMinute))
    this.aiLimiter = new SlidingWindowLimiter(3_600_000, Math.max(1, input.config.botAiRatePerHour))
    this.searchLimiter = new SlidingWindowLimiter(3_600_000, Math.max(1, input.config.botSearchRatePerHour))
    this.webSearch = input.deps.search ?? null
    const host = this.host
    this.chatBursts = new BurstMerger<ChatBurstItem>({
      windowMs: input.config.botChatBurstWindowMs,
      maxWaitMs: input.config.botChatBurstMaxWaitMs,
      maxItems: input.config.botChatBurstMaxMessages,
      onFlush: (_key, items) => {
        const task = this.executeChatBatch(items)
        host.trackTask(task)
        return task
      },
      onError: (error) => {
        this.deps.log('warn', 'Bot 连续消息批次处理失败', {
          error: error instanceof Error ? error.message : 'unknown',
        })
      },
    })
  }

  /** 入站模块把 Chat 消息放入连续消息合并器（保留原有 burst 时序语义）。 */
  enqueue(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'chat' }>,
    text: string,
    timing: BurstTiming | undefined,
  ): void {
    this.chatBursts.enqueue(botChatKey(bot.id, result.targetExternalId, result.userId), { bot, result, text }, timing)
  }

  /** 排空连续消息缓冲（测试/关闭等待）。 */
  async drain(): Promise<void> {
    await this.chatBursts.drain()
  }

  /** 清理某会话缓冲（/reset、/forget、角色变更），避免旧消息在新上下文继续回复。 */
  clearSession(botId: string, targetExternalId: string, userId: string): void {
    this.chatBursts.clear(botChatKey(botId, targetExternalId, userId))
  }

  /** 清理某用户上次搜索查询（/forget 时）。 */
  clearSearchQuery(botId: string, userId: string): void {
    this.lastSearchQueries.delete(`${botId}:${userId}`)
  }

  /** 停止接收新批次并丢弃缓冲（进程关闭）。 */
  stop(): void {
    this.chatBursts.stop()
  }

  /**
   * v0.6.4：模型消息发送工具入口。工具只把文本写入本轮缓冲，回合结束后统一发送；
   * 路由认证依赖 BOT_SECRET_KEY 派生的 turn_token（HMAC 绑定 turnId+目标+用户），不需要额外共享密钥。
   */
  handleAiSendTool(input: unknown): { status: number; body: unknown } {
    if (!this.config.botEnabled || !this.config.botAiSendToolEnabled || !this.key || !this.deps.ai) {
      return { status: 404, body: { error: { code: 'not_found' } } }
    }
    const body = input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}
    const turnId = typeof body.turn_id === 'string' ? body.turn_id.trim().slice(0, 64) : ''
    const turnToken = typeof body.turn_token === 'string' ? body.turn_token.trim().slice(0, 128) : ''
    const text = cleanText(body.text, AI_SEND_MAX_TEXT)
    if (!turnId || !turnToken) {
      return { status: 400, body: { error: { code: 'invalid_turn' } } }
    }
    if (!text) {
      return { status: 400, body: { error: { code: 'empty_text' } } }
    }
    const turn = this.aiSendTurns.get(turnId)
    if (!turn) return { status: 404, body: { error: { code: 'turn_not_found' } } }
    const actual = Buffer.from(turnToken)
    const expected = Buffer.from(aiSendTurnToken(this.key, turn.id, turn.targetExternalId, turn.userId))
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return { status: 403, body: { error: { code: 'invalid_turn_token' } } }
    }
    if (turn.expiresAtMs <= Date.now()) {
      this.aiSendTurns.delete(turnId)
      return { status: 410, body: { error: { code: 'turn_expired' } } }
    }
    if (turn.messages.length >= AI_SEND_MAX_MESSAGES) {
      return { status: 429, body: { error: { code: 'send_limit' } } }
    }
    turn.messages.push(text)
    return { status: 200, body: { ok: true, index: turn.messages.length } }
  }

  private openAiSendTurn(result: Extract<InboundVerification, { kind: 'chat' }>): AiSendTurn | null {
    if (!this.config.botAiSendToolEnabled || !this.key || !this.deps.ai) return null
    const now = Date.now()
    for (const [id, turn] of this.aiSendTurns) {
      if (turn.expiresAtMs <= now) this.aiSendTurns.delete(id)
    }
    const id = newId()
    const turn: AiSendTurn = {
      id,
      token: aiSendTurnToken(this.key, id, result.targetExternalId, result.userId),
      targetExternalId: result.targetExternalId,
      targetKind: result.targetKind,
      userId: result.userId,
      messages: [],
      expiresAtMs: now + AI_SEND_TURN_TTL_MS,
    }
    this.aiSendTurns.set(id, turn)
    return turn
  }

  private takeAiSendMessages(turn: AiSendTurn | null): string[] {
    if (!turn) return []
    const messages = turn.messages
    turn.messages = []
    return messages
  }

  private closeAiSendTurn(turn: AiSendTurn | null): void {
    if (turn) this.aiSendTurns.delete(turn.id)
  }

  /** 把工具缓冲的消息按顺序发送；来源/图片说明附在最后一条。 */
  private async sendAiToolMessages(
    result: Extract<InboundVerification, { kind: 'chat' }>,
    messages: string[],
    sourceNote: string,
    imageNote: string,
  ): Promise<void> {
    const formatted = messages
      .map((message) => formatAiReply(this.cleanAiReply(message)))
      .filter((message) => message.length > 0)
    if (formatted.length === 0) {
      throw new AppError(502, 'bot_ai_send_empty', '消息发送内容为空')
    }
    const lastIndex = formatted.length - 1
    formatted[lastIndex] = `${formatted[lastIndex]}${sourceNote}${imageNote}`.trim()
    for (const message of formatted) {
      await result.reply(message)
    }
  }

  /**
   * 执行一批连续消息：合并文本、串行调用 AI、只回复一次。
   * 同一会话严格串行：普通消息走 BurstMerger，`/search` 等直调路径复用同一把会话锁；
   * 不同会话可并行。
   */
  private async executeChatBatch(items: ChatBurstItem[], forceSearch = false): Promise<void> {
    if (items.length === 0) return
    const last = items[items.length - 1]
    if (!last) return
    const key = botChatSerializationKey(
      last.bot.id,
      last.result.targetExternalId,
      last.result.userId,
      last.result.targetKind === 'group',
    )
    return this.runChatExclusive(key, () => this.executeChatBatchUnlocked(items, forceSearch))
  }

  /** 按会话串行执行 Chat 回合；同一 key 的批次/命令排队，不同会话互不阻塞。 */
  private runChatExclusive(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.chatQueues.get(key) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(task)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.chatQueues.set(key, tail)
    void tail.finally(() => {
      if (this.chatQueues.get(key) === tail) this.chatQueues.delete(key)
    })
    return run
  }

  private async executeChatBatchUnlocked(items: ChatBurstItem[], forceSearch = false): Promise<void> {
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    const bot = first.bot
    const result = last.result
    // 混批语义：只要批内任一消息是被 @/名字命中（chatTrigger 非 all），整批就按“被点名”处理。
    // 不能由批内最后一条非 @ 全量消息把 @Bot 的请求降级为静默（旧实现会吞掉 @ 回复）。
    const addressedInBatch = items.some((item) => item.result.chatTrigger !== 'all')
    const silent = !addressedInBatch
    const finishAll = (outcome: BotEventOutcome, detail: string) => {
      for (const item of items) {
        this.host.markEvent(bot.id, item.result.eventId, {
          outcome,
          detail,
          target: item.result.targetExternalId,
          user: item.result.userId,
        })
      }
    }
    let sendTurn: AiSendTurn | null = null
    // SEC-11 fail-closed 防御：排在 burst/命令队列里的批次也必须复查，避免升级瞬间继续以未隔离权限调用 AI。
    if (this.host.aiIsolationBlocked()) {
      finishAll('ignored', 'ai_isolation_unavailable')
      if (!silent) await result.reply(AI_ISOLATION_BLOCKED_TEXT).catch(() => undefined)
      return
    }
    try {
      const chatRetry = this.chatLimiter.hit(`${bot.id}:${result.userId}`)
      if (chatRetry > 0) {
        if (!silent) await result.reply(`对话过于频繁（每分钟 ${this.config.botChatRatePerMinute} 次），请稍后再试。`).catch(() => undefined)
        finishAll('rate_limited', 'chat_rate_limited')
        return
      }
      const aiRetry = this.aiLimiter.hit(`${bot.id}:${result.userId}`)
      if (aiRetry > 0) {
        if (!silent) await result.reply(`AI 调用过于频繁（每小时 ${this.config.botAiRatePerHour} 次），请稍后再试。`).catch(() => undefined)
        finishAll('rate_limited', 'ai_rate_limited')
        return
      }
      const target = this.host.inboundTarget(bot.id, result)
      const groupRole = target?.kind === 'group' ? this.groupRoles.getByTargetId(bot.id, target.id) : null
      const role = result.isDirect ? this.roles.get(bot.id, result.userId) : groupRole
      const roleCard = role?.enabled ? role : null
      const isGroup = result.targetKind === 'group'
      const displayName = isGroup ? this.host.inboundDisplayName(result) : ''
      const memoryScope = isGroup ? groupMemoryScope(result.targetExternalId) : result.userId
      const prepared = await this.prepareAiImage(bot, result)
      const texts = items.map((item) => item.text).filter(Boolean)
      const limit = Math.max(1, this.config.botAiMaxPromptChars)
      let merged = texts.join('\n').trim()
      if (merged.length > limit) merged = merged.slice(-limit)
      if (prepared.kind === 'unsupported' && !merged) {
        // 图片无法处理且本批没有任何可用文字：直接提示，不调用模型。
        if (!silent) await result.reply(IMAGE_UNSUPPORTED_TEXT)
        finishAll('ignored', 'image_unsupported')
        return
      }
      // 仅图片无正文时用中性占位，避免向模型发送空用户消息。
      const userText = merged || (result.image ? IMAGE_ONLY_USER_TEXT : '')
      if (!userText) {
        finishAll('ignored', 'empty_content')
        return
      }
      const search = await this.resolveWebSearch(bot, result.userId, userText, forceSearch)
      if (search.kind === 'rate_limited') {
        if (!silent) await result.reply(`联网搜索过于频繁（每小时 ${this.config.botSearchRatePerHour} 次），请稍后再试。`).catch(() => undefined)
        finishAll('rate_limited', 'search_rate_limited')
        return
      }
      const searchContext = search.context ? formatSearchPromptContext(search.context.query, search.context.results) : undefined
      const imageNote = prepared.kind === 'ok' && prepared.degraded && merged ? `\n${IMAGE_DEGRADED_NOTE}` : ''
      const sourceNote = search.context && search.context.results.length > 0 ? formatSearchSources(search.context.results) : ''
      const sessionTitle = `${this.host.targetNameForSession(
        bot.id,
        result.targetExternalId,
        result.userId,
        result.userName,
      )} Chat`
      const promptText = isGroup ? `${displayName}：${userText}` : userText
      sendTurn = this.openAiSendTurn(result)
      const sendToolPrompt: BotSendToolPrompt | undefined = sendTurn
        ? {
            turnId: sendTurn.id,
            turnToken: sendTurn.token,
            toolName: AI_SEND_TOOL_NAME,
            required: !silent,
          }
        : undefined
      const answer = await this.chatWithAi(
        bot,
        result.userId,
        result.targetExternalId,
        promptText,
        roleCard,
        prepared.kind === 'ok' ? prepared.image : undefined,
        searchContext,
        search.context?.results.length ?? 0,
        silent,
        sessionTitle,
        sendToolPrompt,
        memoryScope,
        isGroup,
        isGroup ? (silent ? 'all' : 'mention') : undefined,
      )
      const toolMessages = this.takeAiSendMessages(sendTurn)
      if (sendTurn) {
        if (toolMessages.length > 0) {
          await this.sendAiToolMessages(result, toolMessages, sourceNote, imageNote)
          const memoryText = toolMessages
            .map((message) => this.cleanAiReply(message))
            .filter(Boolean)
            .join('\n')
          if (userText && memoryText) {
            this.host.scheduleMemoryUpdate(bot, result.userId, result.targetExternalId, userText, memoryText, {
              memoryScope,
              ...(isGroup ? { groupUserName: displayName } : {}),
            })
          }
          this.deps.audit('bot.ai.send', `${bot.platform}:${result.targetExternalId}`, {
            bot: bot.id,
            user: result.userId.slice(0, 64),
            messages: toolMessages.length,
            chars: toolMessages.reduce((sum, message) => sum + message.length, 0),
          })
          finishAll('ok', 'chat_tool')
          return
        }
        // 全量群聊未调用工具 = 模型选择不发言（NO_REPLY 的工具化升级）。
        if (silent) {
          finishAll('ignored', 'no_reply')
          return
        }
        // 工具不可用/模型漏调用时的兜底：私聊与 @ 提及仍至少发送一条，避免用户无响应。
        this.deps.audit('bot.ai.send_fallback', bot.id, {
          target: result.targetExternalId,
          user: result.userId.slice(0, 64),
          reason: 'no_tool_call',
        })
      }
      if (!sendTurn && silent && isNoReplyAnswer(answer)) {
        finishAll('ignored', 'no_reply')
        return
      }
      // 模型可能把工具调用协议当作普通文本返回。识别后只提取模型本来要发送的 text 参数；
      // 无法提取时使用固定兜底，绝不把 DSML/tool_token/参数原文回显给用户。
      const rawToolCall = extractRawToolCallText(answer)
      if (rawToolCall.detected) {
        this.deps.audit('bot.ai.tool_call_text', `${bot.platform}:${result.targetExternalId}`, {
          bot: bot.id,
          user: result.userId.slice(0, 64),
          extracted: rawToolCall.text.length > 0,
        })
      }
      const answerCandidate = rawToolCall.detected
        ? rawToolCall.text || '暂时没回应上来，稍后再试。'
        : answer
      const fallbackAnswer = sendTurn && isNoReplyAnswer(answer) ? '暂时没回应上来，稍后再试。' : answerCandidate
      const plain = this.sanitizeAiText(fallbackAnswer)
      const formatted = formatAiReply(plain)
      const replyText = `${formatted}${sourceNote}${imageNote}`
      if (!replyText) {
        finishAll('ignored', 'empty_reply')
        return
      }
      await result.reply(replyText)
      if (userText) {
        this.host.scheduleMemoryUpdate(bot, result.userId, result.targetExternalId, userText, plain, {
          memoryScope,
          ...(isGroup ? { groupUserName: displayName } : {}),
        })
      }
      finishAll('ok', 'chat')
    } catch (error) {
      if (sentExternalIdsOf(error).length > 0) {
        // 长回复已部分外发：只记日志，不补发失败提示。
        this.deps.log('warn', 'Bot Chat 回复部分外发', {
          bot: bot.id,
          sent: sentExternalIdsOf(error).length,
        })
        finishAll('error', 'partial_reply')
        return
      }
      // 回合异常前模型可能已通过 botmsg_send_message 写入缓冲（工具回环 200）。此时必须尽力外发，
      // 不能直接回错误兜底：否则“模型认为已发送、用户却看不到”，且丢失工具消息无审计。
      const buffered = this.takeAiSendMessages(sendTurn)
      if (buffered.length > 0) {
        try {
          await this.sendAiToolMessages(result, buffered, '', '')
          this.deps.audit('bot.ai.send', `${bot.platform}:${result.targetExternalId}`, {
            bot: bot.id,
            user: result.userId.slice(0, 64),
            messages: buffered.length,
            chars: buffered.reduce((sum, message) => sum + message.length, 0),
            partialTurn: true,
            reason: errorShortCode(error),
          })
          finishAll('ok', 'chat_tool_partial')
          return
        } catch (sendError) {
          this.deps.log('warn', 'Bot 回合异常后补发工具消息失败', {
            bot: bot.id,
            error: errorShortCode(sendError),
          })
        }
      }
      finishAll('error', errorShortCode(error))
      if (!silent) await result.reply('暂时没回应上来，稍后再试。').catch(() => undefined)
    } finally {
      this.closeAiSendTurn(sendTurn)
    }
  }

  /**
   * 解析本批是否需要联网搜索：显式 /search 强制；自动模式用保守关键词判断。
   * 搜索失败不阻断 Chat，返回空结果并在提示词中说明不可用；绝不记录查询正文。
   */
  private async resolveWebSearch(
    bot: BotRow,
    userId: string,
    text: string,
    force: boolean,
  ): Promise<SearchResolution> {
    if (!this.config.botSearchEnabled || !this.webSearch) return { kind: 'ok', context: null }
    const followUp = isSearchFollowUp(text)
    // mcp 模式：模型可通过 MCP 工具自行搜索；命中关键词/追问时服务端先预取，保证常见问句稳定。
    if (!force && this.config.botSearchMode === 'mcp' && !followUp && !needsWebSearch(text)) {
      return { kind: 'ok', context: null }
    }
    if (!force && (!this.config.botSearchAuto || (!needsWebSearch(text) && !followUp))) {
      return { kind: 'ok', context: null }
    }
    const key = `${bot.id}:${userId}`
    const normalized = normalizeSearchQuery(text)
    const query = followUp ? this.lastSearchQueries.get(key) ?? normalized : normalized
    if (!query) return { kind: 'ok', context: null }
    const retry = this.searchLimiter.hit(key)
    if (retry > 0) {
      this.deps.audit('bot.search', `${bot.platform}:${bot.id}`, {
        bot: bot.id,
        user: userId.slice(0, 64),
        rateLimited: true,
        forced: force,
      })
      return force ? { kind: 'rate_limited' } : { kind: 'ok', context: null }
    }
    try {
      const results = await this.webSearch.search(query)
      this.lastSearchQueries.set(key, query)
      this.deps.audit('bot.search', `${bot.platform}:${bot.id}`, {
        bot: bot.id,
        user: userId.slice(0, 64),
        results: results.length,
        forced: force,
        followUp,
      })
      if (results.length === 0 && !force) return { kind: 'ok', context: null }
      return { kind: 'ok', context: { query, results } }
    } catch (error) {
      this.deps.log('warn', 'Bot 联网搜索失败', {
        bot: bot.id,
        error: errorShortCode(error),
        forced: force,
      })
      this.deps.audit('bot.search', `${bot.platform}:${bot.id}`, {
        bot: bot.id,
        user: userId.slice(0, 64),
        error: errorShortCode(error),
        forced: force,
      })
      return { kind: 'ok', context: { query: text, results: [], failed: true } }
    }
  }

  /** `/search <关键词>`：复用 Chat 管线强制搜索，结果由 AI 总结并附来源。 */
  async executeSearchChat(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'command' }>,
    args: string,
  ): Promise<void> {
    const target = this.host.inboundTarget(bot.id, result)
    const openQqC2c = result.isDirect && result.targetKind === 'user'
    if ((!target || target.allow_chat !== 1) && !openQqC2c) {
      await result.reply('当前会话未开启普通消息对话，无法使用联网搜索。').catch(() => undefined)
      this.host.markEvent(bot.id, result.eventId, {
        outcome: 'denied',
        detail: 'search_chat_denied',
        target: result.targetExternalId,
        user: result.userId,
      })
      return
    }
    if (!args.trim()) {
      await result.reply('用法：/search <关键词>（联网搜索并由 AI 总结，附来源）').catch(() => undefined)
      this.host.markEvent(bot.id, result.eventId, {
        outcome: 'ignored',
        detail: 'search_empty',
        target: result.targetExternalId,
        user: result.userId,
      })
      return
    }
    if (!this.config.botAiEnabled || !this.deps.ai) {
      await result.reply('AI 未启用，无法使用联网搜索。').catch(() => undefined)
      this.host.markEvent(bot.id, result.eventId, {
        outcome: 'ignored',
        detail: 'ai_disabled',
        target: result.targetExternalId,
        user: result.userId,
      })
      return
    }
    if (!this.config.botSearchEnabled || !this.webSearch) {
      await result.reply('联网搜索未启用，请联系管理员配置 SearXNG。').catch(() => undefined)
      this.host.markEvent(bot.id, result.eventId, {
        outcome: 'ignored',
        detail: 'search_disabled',
        target: result.targetExternalId,
        user: result.userId,
      })
      return
    }
    const chatResult: Extract<InboundVerification, { kind: 'chat' }> = {
      ...result,
      kind: 'chat',
      text: args,
      chatTrigger: result.isDirect ? 'direct' : 'mention',
    }
    await this.executeChatBatch([{ bot, result: chatResult, text: args }], true)
  }

  /**
   * 图片预处理：识别关闭/适配器不支持/下载失败/mime 非法时降级为纯文本。
   * - 有文字：继续回答，末尾追加“图片未能处理”说明；
   * - 无文字：返回 unsupported，由调用方提示用户改用文字描述。
   */
  private async prepareAiImage(
    bot: BotRow,
    result: Extract<InboundVerification, { kind: 'chat' }>,
  ): Promise<{ kind: 'ok'; image?: BotAiImage; degraded: boolean } | { kind: 'unsupported' }> {
    const inbound = result.image
    if (!inbound) return { kind: 'ok', degraded: false }
    const degrade = () =>
      result.text.trim()
        ? ({ kind: 'ok', degraded: true } as const)
        : ({ kind: 'unsupported' } as const)
    if (!this.config.botAiVisionEnabled) {
      this.deps.audit('bot.ai.image', `${bot.platform}:${result.targetExternalId}`, {
        bot: bot.id,
        mime: inbound.mime.slice(0, 50),
        size: inbound.size ?? null,
        skipped: 'vision_disabled',
      })
      return degrade()
    }
    const adapter = this.host.adapterFor(bot)
    if (!adapter.loadImage) {
      this.deps.audit('bot.ai.image', `${bot.platform}:${result.targetExternalId}`, {
        bot: bot.id,
        mime: inbound.mime.slice(0, 50),
        size: inbound.size ?? null,
        skipped: 'unsupported',
      })
      return degrade()
    }
    try {
      const loaded = await adapter.loadImage(inbound, {
        maxBytes: this.config.botAiImageMaxBytes,
        timeoutMs: IMAGE_DOWNLOAD_TIMEOUT_MS,
      })
      const mime = loaded.mime.toLowerCase()
      if (!IMAGE_MIME_ALLOWLIST.has(mime) || loaded.data.length === 0 || loaded.data.length > this.config.botAiImageMaxBytes) {
        this.deps.audit('bot.ai.image', `${bot.platform}:${result.targetExternalId}`, {
          bot: bot.id,
          mime: mime.slice(0, 50),
          size: loaded.data.length,
          skipped: 'invalid',
        })
        return degrade()
      }
      // 审计只记录 mime/大小，不记录图片内容或 base64。
      this.deps.audit('bot.ai.image', `${bot.platform}:${result.targetExternalId}`, {
        bot: bot.id,
        mime: mime.slice(0, 50),
        size: loaded.data.length,
      })
      return {
        kind: 'ok',
        degraded: false,
        image: {
          mime,
          base64: loaded.data.toString('base64'),
          ...(inbound.name ? { name: inbound.name.slice(0, 80) } : {}),
        },
      }
    } catch (error) {
      this.deps.log('warn', 'Bot 入站图片处理失败，降级为纯文本', {
        bot: bot.id,
        code: errorShortCode(error),
      })
      return degrade()
    }
  }

  /** Chat 的统一模型调用：角色卡 + 共享长期记忆 + 用户消息（可选图片）。 */
  private async chatWithAi(
    bot: BotRow,
    userId: string,
    targetExternalId: string,
    text: string,
    roleCard?: Pick<BotChatRole, 'name' | 'prompt'> | null,
    image?: BotAiImage,
    searchContext?: string,
    searchResults = 0,
    replyDecision = false,
    sessionTitle?: string,
    sendTool?: BotSendToolPrompt,
    memoryScope = userId,
    groupMemory = false,
    groupMode?: GroupChatMode,
  ): Promise<string> {
    if (!this.deps.ai) throw new AppError(503, 'ai_disabled', 'AI 未启用')
    // 群聊使用独立的群共享记忆 scope，已登记用户的用户级记忆不会进入群聊提示词。
    const memoryContext = this.deps.memory.buildPromptContext(bot.id, memoryScope, text, groupMemory)
    const prompt = buildBotPrompt({
      roleCard,
      memory: memoryContext.text || undefined,
      groupMemory,
      groupMode,
      searchContext,
      webSearchTool: this.config.botSearchEnabled && this.config.botSearchMode === 'mcp' && !searchContext,
      ...(sendTool ? { sendTool } : { replyDecision }),
      userText: text.slice(0, this.config.botAiMaxPromptChars),
    })
    this.deps.audit('bot.ai.chat', `${bot.platform}:${targetExternalId}`, {
      bot: bot.id,
      user: userId.slice(0, 64),
      chars: text.length,
      ...(roleCard ? { role: true } : {}),
      ...(image ? { image: image.mime.slice(0, 50) } : {}),
      ...(memoryContext.usedItemIds.length > 0 ? { memoryItems: memoryContext.usedItemIds.length } : {}),
      ...(searchContext ? { search: true, searchResults } : {}),
      ...(sendTool ? { sendTool: true } : replyDecision ? { replyDecision: true } : {}),
    })
    let answer: string
    try {
      answer = await this.deps.ai.chat({
        botId: bot.id,
        targetExternalId,
        userId,
        ...(groupMemory ? { sessionUserId: GROUP_CHAT_SESSION_USER_ID, sharedSession: true } : {}),
        prompt,
        ...(sessionTitle ? { sessionTitle } : {}),
        ...(image ? { image } : {}),
      })
    } finally {
      // 同步检查降级（不额外引入微任务，避免影响对话/抽取后续排队的时序）。
      this.host.observeAiToolIsolation(bot.id)
    }
    return answer
  }

  /** 统一外发/记忆清洗：优先提取原始工具调用中的 text 参数，再走常规 sanitize。 */
  private cleanAiReply(value: string): string {
    const rawToolCall = extractRawToolCallText(value)
    return this.sanitizeAiText(rawToolCall.detected ? rawToolCall.text : value)
  }

  /**
   * AI 回答清洗：去除内部路径/URL 与控制字符，保留换行/分段，按配置上限截断。
   * 与 sanitizeExternalText 的固定 1500 截断区分：AI 回答由 QQ 适配器按 2000 上限分段发送。
   */
  private sanitizeAiText(value: string): string {
    if (typeof value !== 'string') return ''
    const replaced = stripRawToolCallText(value)
      .replace(/\r\n?/g, '\n')
      // 某些模型在工具 schema 不可用时会输出 DSML 工具调用文本；不能把内部语法回显给用户。
      .replace(/<\|DSML\|>[\s\S]*?<\/\|DSML\|>/gi, '')
      .replace(/｜｜DSML｜｜[\s\S]*?<\/｜｜DSML｜｜>/g, '')
      .replace(/[｜|]{2}DSML[｜|]{2}/g, '')
      .replace(/(?:[A-Za-z]:\\|\/(?:home|var|etc|opt|run|proc|sys|tmp)\/)[^\s"'`]+/g, '[path]')
      .replace(/(?:ssh|https?):\/\/[^\s"'`]+/g, '[url]')
    let cleaned = ''
    for (const char of replaced) {
      const code = char.codePointAt(0) ?? 0
      if (code === 10 || code === 9 || (code >= 32 && code !== 127)) cleaned += char
    }
    // 保留换行/分段，仅收敛行内多余空白；不要压缩空行。
    cleaned = cleaned
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
      .join('\n')
      .trim()
    return cleaned.slice(0, this.config.botAiMaxReplyChars)
  }

  /** Bot×用户记忆键：批处理、串行队列与 generation 共用。 */

}
