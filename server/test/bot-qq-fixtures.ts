/**
 * QQ Bot 服务端测试夹具：AppSecret 派生 Ed25519 密钥、Webhook 签名、进程内 fetch（token/消息/图片）。
 * 测试不访问真实 QQ 网络；所有用例共用固定时间，便于签名时间戳稳定。
 */
import { createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto'
import { rmSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from '../src/config.ts'
import { BotService } from '../src/bot/service.ts'
import type { BotAiImage, BotMemoryItemPrompt, BotMemoryOperation } from '../src/bot/types.ts'
import type { WebSearchResult } from '../src/bot/search.ts'
import { tempDataDir, testConfig, testDb } from './helpers.ts'

export const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
/** 固定测试时间：签名时间戳与服务端 deps.now 必须一致。 */
export const QQ_NOW = new Date('2026-10-22T04:00:00.000Z')
export const QQ_TIMESTAMP = String(Math.floor(QQ_NOW.getTime() / 1000))
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export interface CapturedRequest {
  url: string
  init?: RequestInit
}

export interface SentMessage {
  url: string
  body: Record<string, unknown>
}

export interface QQServiceFetchOptions {
  accessToken?: string
  /** 图片下载返回的字节。 */
  imageBytes?: Buffer
  /** 第 N 次消息发送起返回失败（1 起始；缺省不失败）。 */
  failSendFrom?: number
  /** 下载图片时返回 403。 */
  imageDownloadFails?: boolean
  /** 换取 access_token 失败模式。 */
  tokenFails?: 'unauthorized' | 'network'
}

export interface QQServiceFetch {
  fetchImpl: typeof fetch
  captured: CapturedRequest[]
  sent: SentMessage[]
  state: { sendCalls: number; tokenCalls: number; imageCalls: number }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 进程内 QQ fetch：token 换取、消息发送（POST）与图片下载（GET）三路。 */
export function makeQqServiceFetch(options: QQServiceFetchOptions = {}): QQServiceFetch {
  const captured: CapturedRequest[] = []
  const sent: SentMessage[] = []
  const state = { sendCalls: 0, tokenCalls: 0, imageCalls: 0 }
  const failFrom = options.failSendFrom ?? Number.POSITIVE_INFINITY
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    captured.push({ url, init })
    if (url === QQ_TOKEN_URL) {
      state.tokenCalls += 1
      if (options.tokenFails === 'unauthorized') return jsonResponse({ message: 'unauthorized' }, 401)
      if (options.tokenFails === 'network') throw new Error('connect ECONNREFUSED 127.0.0.1')
      return jsonResponse({ access_token: options.accessToken ?? 'qq-access-token', expires_in: 7200 })
    }
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'GET') {
      state.imageCalls += 1
      if (options.imageDownloadFails) return jsonResponse({ message: 'denied' }, 403)
      return new Response(options.imageBytes ?? Buffer.from('fake-image'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    }
    state.sendCalls += 1
    if (state.sendCalls >= failFrom) return jsonResponse({ message: 'send failed' }, 500)
    if (typeof init?.body === 'string') {
      try {
        sent.push({ url, body: JSON.parse(init.body) as Record<string, unknown> })
      } catch {
        // 非 JSON 请求体不记录。
      }
    }
    return jsonResponse({ id: `qq-out-${state.sendCalls}` })
  }) as typeof fetch
  return { fetchImpl, captured, sent, state }
}

/** 按适配器同一规则（UTF-8 重复/截断到 32 字节）从 AppSecret 派生 Ed25519 密钥。 */
export function deriveQqKeyPair(appSecret: string): {
  privateKey: ReturnType<typeof createPrivateKey>
  publicKey: ReturnType<typeof createPublicKey>
} {
  const raw = Buffer.from(appSecret, 'utf8')
  const seed = Buffer.alloc(32)
  for (let index = 0; index < seed.length; index += 1) {
    seed[index] = raw[index % raw.length]!
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  })
  return { privateKey, publicKey: createPublicKey(privateKey) }
}

export function signQqHeaders(
  privateKey: ReturnType<typeof createPrivateKey>,
  timestamp: string,
  body: Buffer,
): Record<string, string> {
  return {
    'x-signature-ed25519': sign(null, Buffer.concat([Buffer.from(timestamp, 'utf8'), body]), privateKey).toString('hex'),
    'x-signature-timestamp': timestamp,
    'content-type': 'application/json',
  }
}

export interface SignedWebhook {
  body: Buffer
  headers: Record<string, string>
}

/** 用 AppSecret 派生密钥签名一个 QQ 事件推送（op=0）。 */
export function signQqEvent(
  appSecret: string,
  payload: Record<string, unknown>,
  timestamp = QQ_TIMESTAMP,
): SignedWebhook {
  const { privateKey } = deriveQqKeyPair(appSecret)
  const body = Buffer.from(JSON.stringify(payload))
  return { body, headers: signQqHeaders(privateKey, timestamp, body) }
}

export interface AiCall {
  prompt: string
  image?: BotAiImage
}

/** 一次结构化记忆抽取调用的输入（用于断言批次内容/旧摘要迁移）。 */
export interface MemoryExtractInput {
  botId: string
  userId: string
  existing: BotMemoryItemPrompt[]
  legacySummary: string
  userText: string
  assistantText: string
  maxOps: number
}

export interface AuditRecord {
  action: string
  target: string | null
  detail?: Record<string, unknown> | null
}

export interface QqServiceFixture {
  dir: string
  db: DatabaseSync
  config: Config
  service: BotService
  fetch: QQServiceFetch
  aiCalls: AiCall[]
  extractCalls: MemoryExtractInput[]
  /** 每次抽取返回的操作（扁平记录，便于断言 upsert/delete）。 */
  memoryOps: BotMemoryOperation[]
  deletedSessions: string[]
  audits: AuditRecord[]
  botId: string
  appId: string
  appSecret: string
  cleanup: () => void
}

let appIdSeq = 102_345_000
export function nextAppId(): string {
  appIdSeq += 1
  return String(appIdSeq)
}

export interface QqServiceOptions {
  aiEnabled?: boolean
  aiHandler?: (input: AiCall) => Promise<string>
  /** 是否提供 extractMemories（默认 aiEnabled 时提供）。 */
  extractMemories?: boolean
  extractHandler?: (input: MemoryExtractInput) => Promise<BotMemoryOperation[]>
  configOverrides?: Partial<Config>
  fetchOptions?: QQServiceFetchOptions
  /** 可选搜索桩；未提供时 BOT_SEARCH_ENABLED=true 也按未配置搜索处理。 */
  search?: { search(query: string): Promise<WebSearchResult[]> }
}

/** 默认抽取桩：把本批用户文本记成一条 fact，便于断言结构化落库。 */
function defaultExtractOperations(input: MemoryExtractInput): BotMemoryOperation[] {
  const value = input.userText.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!value) return []
  return [{ op: 'upsert', kind: 'fact', key: '最近对话', value, confidence: 0.8, importance: 3 }]
}

/** 建立 QQ Bot 服务实例（已创建并启用一个 QQ Bot）；用完调用 fixture.cleanup()。 */
export function createQqServiceFixture(options: QqServiceOptions = {}): QqServiceFixture {
  const dir = tempDataDir()
  const db = testDb(dir)
  const config = testConfig(dir, {
    botEnabled: true,
    botSecretKey: randomBytes(32).toString('base64'),
    botAiEnabled: options.aiEnabled ?? false,
    ...options.configOverrides,
  })
  const fetch = makeQqServiceFetch(options.fetchOptions)
  const aiCalls: AiCall[] = []
  const extractCalls: MemoryExtractInput[] = []
  const memoryOps: BotMemoryOperation[] = []
  const deletedSessions: string[] = []
  const audits: AuditRecord[] = []
  const appId = nextAppId()
  const appSecret = `qq-app-secret-${randomBytes(8).toString('hex')}`
  const aiHandler = options.aiHandler ?? (async () => 'AI 回复')
  const withExtraction = options.extractMemories ?? true
  const service = new BotService({
    db,
    config,
    log: () => undefined,
    audit: (action, target, detail) => {
      audits.push({ action, target, detail })
    },
    fetch: fetch.fetchImpl,
    now: () => QQ_NOW,
    ...(options.aiEnabled
      ? {
          ai: {
            chat: async (input: { prompt: string; image?: BotAiImage }) => {
              const call: AiCall = {
                prompt: input.prompt,
                ...(input.image ? { image: input.image } : {}),
              }
              aiCalls.push(call)
              return aiHandler(call)
            },
            ...(withExtraction
              ? {
                  extractMemories: async (input: MemoryExtractInput) => {
                    extractCalls.push(input)
                    const ops = options.extractHandler
                      ? await options.extractHandler(input)
                      : defaultExtractOperations(input)
                    memoryOps.push(...ops)
                    return ops
                  },
                }
              : {}),
            deleteSession: async (sessionId: string) => {
              deletedSessions.push(sessionId)
            },
            cleanup: () => {
              const cutoff = new Date(Date.now() - config.botAiSessionRetentionDays * 86_400_000).toISOString()
              return Number(db.prepare('DELETE FROM bot_ai_sessions WHERE updated_at < ?').run(cutoff).changes)
            },
          },
        }
      : {}),
    ...(options.search ? { search: options.search } : {}),
    providers: {
      status: async () => ({ ok: true }),
      backup: async () => ({ ok: true }),
      world: async () => ({ ok: true }),
      minecraft: async () => ({ online: true }),
      files: async () => [{ name: 'a.txt', sizeLabel: '1 KB' }],
    },
  })
  const bot = service.createBot({
    platform: 'qq',
    name: 'qq-test',
    token: appSecret,
    config: { appId },
  })
  service.updateBot(bot.id, { enabled: true })
  return {
    dir,
    db,
    config,
    service,
    fetch,
    aiCalls,
    extractCalls,
    memoryOps,
    deletedSessions,
    audits,
    botId: bot.id,
    appId,
    appSecret,
    cleanup: () => {
      db.close()
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    },
  }
}

export interface C2cInput {
  id?: string
  content?: string
  attachments?: Array<Record<string, unknown>>
  userOpenid?: string
}

/** 构造并签名 C2C 私聊消息事件。 */
export function c2cWebhook(appSecret: string, input: C2cInput = {}): SignedWebhook {
  return signQqEvent(appSecret, {
    op: 0,
    t: 'C2C_MESSAGE_CREATE',
    d: {
      id: input.id ?? 'c2c-msg-1',
      content: input.content ?? '',
      timestamp: QQ_TIMESTAMP,
      author: { user_openid: input.userOpenid ?? 'user-openid-1' },
      ...(input.attachments ? { attachments: input.attachments } : {}),
    },
  })
}

export interface GroupInput {
  id?: string
  content: string
  groupOpenid: string
  memberOpenid?: string
}

/** 构造并签名群 @Bot 消息事件（content 需带 @ 前缀时由适配器剥离）。 */
export function groupWebhook(appSecret: string, input: GroupInput): SignedWebhook {
  return signQqEvent(appSecret, {
    op: 0,
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: input.id ?? 'group-msg-1',
      content: input.content,
      timestamp: QQ_TIMESTAMP,
      group_openid: input.groupOpenid,
      author: { member_openid: input.memberOpenid ?? 'member-openid-1' },
    },
  })
}

export interface GroupFullInput extends GroupInput {
  /** 全量群消息的 mentions（含 bot:true 表示 @Bot）。 */
  mentions?: Array<Record<string, unknown>>
}

/** 构造并签名全量群消息事件（需 QQ 后台开启“接收所有消息”）。 */
export function groupFullWebhook(appSecret: string, input: GroupFullInput): SignedWebhook {
  return signQqEvent(appSecret, {
    op: 0,
    t: 'GROUP_MESSAGE_CREATE',
    d: {
      id: input.id ?? 'group-full-msg-1',
      content: input.content,
      timestamp: QQ_TIMESTAMP,
      group_openid: input.groupOpenid,
      author: { member_openid: input.memberOpenid ?? 'member-openid-1' },
      ...(input.mentions ? { mentions: input.mentions } : {}),
    },
  })
}

/** 发送一条已签名的 QQ Webhook；默认等待异步 Chat/命令处理结束。 */
export async function sendWebhook(
  fixture: QqServiceFixture,
  webhook: SignedWebhook,
): Promise<{ status: number; body: unknown }> {
  const result = await fixture.service.handleWebhook(fixture.botId, webhook.headers, webhook.body)
  await fixture.service.waitForIdle()
  return result
}

/** 最近一条消息发送的正文（QQ 被动回复/主动通知）。 */
export function lastMessageText(fixture: QqServiceFixture): string {
  const body = fixture.fetch.sent.at(-1)?.body
  return typeof body?.content === 'string' ? body.content : ''
}
