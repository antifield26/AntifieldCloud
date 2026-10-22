/**
 * Discord Gateway 长连接管理器（v0.5.2）。
 * 职责：为每个启用的 Discord Bot 建立 Gateway WebSocket，完成 HELLO/IDENTIFY/RESUME、心跳与
 * MESSAGE_CREATE 解析，并把可对话消息交给注入的回调；异常断开按指数退避重连。
 * 安全边界：Bot Token 只出现在 IDENTIFY/RESUME 帧中，禁止写入日志；本模块不读写数据库/文件；
 * 测试必须注入假 WebSocket 工厂，禁止访问真实 Discord。
 */
import type { BotGatewayStatus, ChatTrigger, GatewayState } from './types.ts'

export const DISCORD_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'
/** GUILDS(1) + GUILD_MESSAGES(512) + DIRECT_MESSAGES(4096) + MESSAGE_CONTENT(32768)。 */
export const DISCORD_GATEWAY_INTENTS = 37377
const INITIAL_RECONNECT_DELAY_MS = 1_000
const MAX_RECONNECT_DELAY_MS = 60_000

export type DiscordGatewayLogLevel = 'info' | 'warn' | 'error'

/** 管理器需要的 Discord Bot 凭据视图；由调用方从 Bot 服务/配置解密后提供。 */
export interface DiscordGatewayBot {
  botId: string
  token: string
  enabled: boolean
  applicationId?: string
}

export type DiscordGatewayTargetKind = 'channel' | 'user'

/** 交给 Bot 服务处理的入站消息；targetKind 固定为 channel（DM 也用频道外部 ID）。 */
export interface DiscordGatewayMessage {
  botId: string
  eventId: string
  targetExternalId: string
  targetKind: DiscordGatewayTargetKind
  userId: string
  userName: string
  text: string
  isDirect: boolean
  chatTrigger: ChatTrigger
}

export interface WebSocketCloseEventLike {
  code?: number
  reason?: string
  wasClean?: boolean
}

/** Node 全局 WebSocket 的最小抽象，便于测试注入假实现。 */
export interface WebSocketLike {
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: WebSocketCloseEventLike) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export interface DiscordGatewayManagerDeps {
  /** Gateway 总开关；false 时 start/sync 都不建立连接。 */
  enabled: boolean
  log: (level: DiscordGatewayLogLevel, message: string, detail?: Record<string, unknown>) => void
  getBots: () => DiscordGatewayBot[]
  /** 异步触发；管理器内部捕获同步异常与 Promise 拒绝，避免中断连接。 */
  onMessage: (event: DiscordGatewayMessage) => void
  /** 测试注入；默认使用全局 WebSocket。 */
  webSocketFactory?: (url: string) => WebSocketLike
  now?: () => Date
}

interface GatewayConnection {
  botId: string
  token: string
  socket: WebSocketLike | null
  state: GatewayState
  lastError: string | null
  seq: number | null
  sessionId: string | null
  resumeUrl: string | null
  botUserId: string | null
  canResume: boolean
  heartbeatMs: number | null
  heartbeatTimer: ReturnType<typeof setTimeout> | null
  awaitingAck: boolean
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectAttempts: number
  reconnecting: boolean
  stopped: boolean
}

/** 这些关闭码表示配置/凭证问题，重连不会成功，直接进入 error 等待人工处理。 */
const FATAL_CLOSE_CODES = new Set<number>([4004, 4010, 4011, 4012, 4013, 4014])

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'unknown_error'
}

function buildGatewayUrl(base: string | null): string {
  const url = new URL(base ?? DISCORD_GATEWAY_URL)
  url.searchParams.set('v', '10')
  url.searchParams.set('encoding', 'json')
  return url.toString()
}

function decodeMessageData(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data as unknown as Uint8Array<ArrayBuffer>)
  return null
}

function fatalCloseMessage(code: number): string {
  switch (code) {
    case 4004:
      return 'Discord Gateway 鉴权失败（close 4004），请检查 Bot Token'
    case 4010:
      return 'Discord Gateway 分片配置无效（close 4010）'
    case 4011:
      return 'Discord Gateway 需要分片（close 4011）'
    case 4012:
      return 'Discord Gateway API 版本无效（close 4012）'
    case 4013:
      return 'Discord Gateway intents 无效（close 4013）'
    case 4014:
      return 'Discord MESSAGE_CONTENT intent 未开启或不允许（close 4014）'
    default:
      return `Discord Gateway 关闭（close ${code}）`
  }
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  const ctor = (globalThis as unknown as { WebSocket?: new (target: string) => unknown }).WebSocket
  if (typeof ctor !== 'function') {
    throw new Error('当前 Node 运行时不支持全局 WebSocket')
  }
  return new ctor(url) as WebSocketLike
}

export class DiscordGatewayManager {
  private readonly enabled: boolean
  private readonly log: DiscordGatewayManagerDeps['log']
  private readonly getBots: DiscordGatewayManagerDeps['getBots']
  private readonly onMessage: DiscordGatewayManagerDeps['onMessage']
  private readonly webSocketFactory: (url: string) => WebSocketLike
  private readonly now: () => Date
  private readonly connections = new Map<string, GatewayConnection>()
  private started = false

  constructor(deps: DiscordGatewayManagerDeps) {
    this.enabled = deps.enabled
    this.log = deps.log
    this.getBots = deps.getBots
    this.onMessage = deps.onMessage
    this.webSocketFactory = deps.webSocketFactory ?? defaultWebSocketFactory
    this.now = deps.now ?? (() => new Date())
  }

  /** 连接所有启用且带 Token 的 Bot；重复调用只做一次对账。 */
  start(): void {
    if (!this.enabled) {
      this.log('info', 'Discord Gateway 未启用（BOT_DISCORD_GATEWAY_ENABLED=false）')
      return
    }
    if (this.started) {
      this.sync()
      return
    }
    this.started = true
    this.sync()
  }

  /** 关闭全部连接并停止重连；之后 sync 不会自行恢复，需重新 start。 */
  stop(): void {
    this.started = false
    const count = this.connections.size
    for (const connection of this.connections.values()) {
      this.disposeConnection(connection)
    }
    this.connections.clear()
    if (count > 0) this.log('info', 'Discord Gateway 已停止', { bots: count })
  }

  /** 出站网络恢复时立即唤醒所有待重连连接，跳过长退避；已连接连接不受影响。 */
  wake(): void {
    if (!this.enabled || !this.started) return
    let woken = 0
    for (const connection of this.connections.values()) {
      if (connection.stopped || connection.socket !== null) continue
      if (connection.reconnectTimer) {
        clearTimeout(connection.reconnectTimer)
        connection.reconnectTimer = null
      }
      connection.reconnecting = true
      connection.reconnectAttempts = 0
      connection.lastError = null
      this.connect(connection)
      woken += 1
    }
    if (woken > 0) this.log('info', 'Discord Gateway 网络恢复，立即重连', { bots: woken })
  }

  /** 根据 getBots() 对账：新增连接、移除连接、Token 变化重建、error 状态重试。 */
  sync(): void {
    if (!this.enabled) {
      for (const connection of this.connections.values()) {
        this.disposeConnection(connection)
      }
      this.connections.clear()
      return
    }
    if (!this.started) return

    const desired = new Map<string, DiscordGatewayBot>()
    for (const bot of this.getBots()) {
      if (!bot.enabled) continue
      if (!bot.token) {
        this.log('warn', 'Discord Gateway 跳过缺少 Token 的 Bot', { botId: bot.botId })
        continue
      }
      desired.set(bot.botId, bot)
    }

    for (const [botId, connection] of Array.from(this.connections.entries())) {
      const bot = desired.get(botId)
      if (!bot) {
        this.disposeConnection(connection)
        this.connections.delete(botId)
        continue
      }
      if (bot.token !== connection.token) {
        this.disposeConnection(connection)
        this.connections.delete(botId)
        this.log('info', 'Discord Gateway 凭据变化，重建连接', { botId })
        const next = this.createConnection(bot)
        this.connections.set(botId, next)
        this.connect(next)
        continue
      }
      // sync 是显式对账入口，允许从不可重试的 error 状态再次尝试。
      if (connection.state === 'error' && connection.socket === null && connection.reconnectTimer === null) {
        connection.lastError = null
        connection.reconnecting = false
        connection.reconnectAttempts = 0
        this.connect(connection)
      }
    }

    for (const [botId, bot] of desired) {
      if (this.connections.has(botId)) continue
      const connection = this.createConnection(bot)
      this.connections.set(botId, connection)
      this.connect(connection)
    }
  }

  status(botId: string): BotGatewayStatus {
    if (!this.enabled || !this.started) return { state: 'disabled', lastError: null }
    const connection = this.connections.get(botId)
    if (!connection) return { state: 'disabled', lastError: null }
    return { state: connection.state, lastError: connection.lastError }
  }

  private createConnection(bot: DiscordGatewayBot): GatewayConnection {
    return {
      botId: bot.botId,
      token: bot.token,
      socket: null,
      state: 'connecting',
      lastError: null,
      seq: null,
      sessionId: null,
      resumeUrl: null,
      botUserId: null,
      canResume: false,
      heartbeatMs: null,
      heartbeatTimer: null,
      awaitingAck: false,
      reconnectTimer: null,
      reconnectAttempts: 0,
      reconnecting: false,
      stopped: false,
    }
  }

  private connect(connection: GatewayConnection): void {
    if (connection.stopped || !this.started || connection.socket !== null) return
    const url = buildGatewayUrl(connection.canResume && connection.sessionId !== null ? connection.resumeUrl : null)
    let socket: WebSocketLike
    try {
      socket = this.webSocketFactory(url)
    } catch (error) {
      connection.state = 'error'
      connection.lastError = `无法创建 Discord Gateway 连接：${errorMessage(error)}`
      connection.reconnecting = false
      this.log('error', 'Discord Gateway 连接创建失败', {
        botId: connection.botId,
        error: errorMessage(error),
        at: this.nowIso(),
      })
      return
    }

    connection.socket = socket
    connection.state = connection.reconnecting ? 'reconnecting' : 'connecting'
    connection.awaitingAck = false
    socket.onopen = null
    socket.onmessage = (event) => {
      try {
        this.handleRawMessage(connection, socket, event?.data)
      } catch (error) {
        this.log('warn', 'Discord Gateway 消息处理异常', {
          botId: connection.botId,
          error: errorMessage(error),
        })
      }
    }
    socket.onerror = () => {
      this.handleSocketError(connection, socket)
    }
    socket.onclose = (event) => {
      try {
        this.handleSocketClose(connection, socket, event)
      } catch (error) {
        this.log('warn', 'Discord Gateway 关闭处理异常', {
          botId: connection.botId,
          error: errorMessage(error),
        })
      }
    }
  }

  private handleSocketError(connection: GatewayConnection, socket: WebSocketLike): void {
    if (connection.socket !== socket || connection.stopped) return
    connection.lastError = 'Discord Gateway WebSocket 连接错误'
    connection.reconnecting = true
    this.log('warn', 'Discord Gateway 连接错误', { botId: connection.botId, at: this.nowIso() })
    this.detachSocket(connection, 4000, 'websocket error')
    this.scheduleReconnect(connection)
  }

  private handleSocketClose(
    connection: GatewayConnection,
    socket: WebSocketLike,
    event: WebSocketCloseEventLike,
  ): void {
    if (connection.socket !== socket || connection.stopped) return
    connection.socket = null
    this.clearHeartbeat(connection)
    const code = typeof event?.code === 'number' ? event.code : undefined
    const reason = typeof event?.reason === 'string' ? event.reason : ''

    if (code !== undefined && FATAL_CLOSE_CODES.has(code)) {
      connection.state = 'error'
      connection.lastError = fatalCloseMessage(code)
      connection.reconnecting = false
      this.log('error', 'Discord Gateway 已停止（不可重试关闭码）', {
        botId: connection.botId,
        code,
        reason,
        at: this.nowIso(),
      })
      return
    }

    connection.reconnecting = true
    connection.lastError =
      code === undefined ? 'Discord Gateway 连接已断开' : `Discord Gateway 连接已断开（close ${code}）`
    this.log('warn', 'Discord Gateway 连接断开，准备重连', {
      botId: connection.botId,
      code,
      reason,
      at: this.nowIso(),
    })
    this.scheduleReconnect(connection)
  }

  private handleRawMessage(connection: GatewayConnection, socket: WebSocketLike, data: unknown): void {
    if (connection.socket !== socket || connection.stopped) return
    const text = decodeMessageData(data)
    if (text === null) return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this.log('warn', 'Discord Gateway 收到无法解析的消息', { botId: connection.botId })
      return
    }
    const payload = asRecord(parsed)
    if (!payload) return
    this.handlePayload(connection, socket, payload)
  }

  private handlePayload(
    connection: GatewayConnection,
    socket: WebSocketLike,
    payload: Record<string, unknown>,
  ): void {
    const op = payload.op
    if (typeof op !== 'number') return
    if (typeof payload.s === 'number' && Number.isFinite(payload.s)) connection.seq = payload.s
    const type = typeof payload.t === 'string' ? payload.t : null

    switch (op) {
      case 0:
        if (type === 'READY') this.handleReady(connection, payload.d)
        else if (type === 'RESUMED') this.handleResumed(connection)
        else if (type === 'MESSAGE_CREATE') this.handleMessageCreate(connection, payload.d)
        break
      case 1:
        this.sendHeartbeat(connection, socket, true)
        break
      case 7:
        this.handleReconnectRequest(connection)
        break
      case 9:
        this.handleInvalidSession(connection, payload.d)
        break
      case 10:
        this.handleHello(connection, socket, payload.d)
        break
      case 11:
        connection.awaitingAck = false
        break
      default:
        break
    }
  }

  private handleHello(connection: GatewayConnection, socket: WebSocketLike, data: unknown): void {
    const hello = asRecord(data)
    const interval = hello?.heartbeat_interval
    if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) {
      connection.lastError = 'Discord Gateway HELLO 心跳间隔无效'
      connection.reconnecting = true
      this.log('error', 'Discord Gateway HELLO 心跳间隔无效', { botId: connection.botId })
      this.detachSocket(connection, 4000, 'invalid hello')
      this.scheduleReconnect(connection)
      return
    }
    this.clearHeartbeat(connection)
    connection.heartbeatMs = Math.max(1, Math.floor(interval))
    this.scheduleHeartbeat(connection, socket, Math.floor(Math.random() * connection.heartbeatMs))
    this.authenticate(connection, socket)
  }

  private authenticate(connection: GatewayConnection, socket: WebSocketLike): void {
    if (connection.canResume && connection.sessionId !== null && connection.seq !== null) {
      this.sendJson(connection, socket, {
        op: 6,
        d: { token: connection.token, session_id: connection.sessionId, seq: connection.seq },
      })
      return
    }
    this.sendJson(connection, socket, {
      op: 2,
      d: {
        token: connection.token,
        intents: DISCORD_GATEWAY_INTENTS,
        properties: { os: process.platform, browser: 'AntifieldCloud', device: 'AntifieldCloud' },
      },
    })
  }

  private scheduleHeartbeat(connection: GatewayConnection, socket: WebSocketLike, delayMs: number): void {
    if (connection.stopped || connection.socket !== socket) return
    if (connection.heartbeatTimer !== null) clearTimeout(connection.heartbeatTimer)
    connection.heartbeatTimer = setTimeout(() => {
      connection.heartbeatTimer = null
      if (connection.stopped || connection.socket !== socket) return
      this.sendHeartbeat(connection, socket, false)
    }, Math.max(0, delayMs))
  }

  private sendHeartbeat(connection: GatewayConnection, socket: WebSocketLike, requested: boolean): void {
    if (connection.stopped || connection.socket !== socket) return
    if (!requested && connection.awaitingAck) {
      connection.lastError = 'Discord Gateway 心跳超时'
      connection.reconnecting = true
      this.log('warn', 'Discord Gateway 心跳未确认，重建连接', { botId: connection.botId })
      this.detachSocket(connection, 4000, 'heartbeat timeout')
      this.scheduleReconnect(connection)
      return
    }
    connection.awaitingAck = true
    if (!this.sendJson(connection, socket, { op: 1, d: connection.seq })) return
    const interval = connection.heartbeatMs
    if (interval === null) return
    // 服务端 op1 要求立即心跳时也重置下一次定时器，避免旧定时器紧接着误判为心跳超时。
    this.scheduleHeartbeat(connection, socket, interval)
  }

  private sendJson(connection: GatewayConnection, socket: WebSocketLike, payload: unknown): boolean {
    if (connection.stopped || connection.socket !== socket) return false
    try {
      socket.send(JSON.stringify(payload))
      return true
    } catch (error) {
      connection.lastError = `Discord Gateway 发送失败：${errorMessage(error)}`
      connection.reconnecting = true
      this.log('warn', 'Discord Gateway 发送失败', {
        botId: connection.botId,
        error: errorMessage(error),
      })
      this.detachSocket(connection, 4000, 'send failed')
      this.scheduleReconnect(connection)
      return false
    }
  }

  private handleReady(connection: GatewayConnection, data: unknown): void {
    const ready = asRecord(data)
    if (!ready) return
    const user = asRecord(ready.user)
    if (user && typeof user.id === 'string') connection.botUserId = user.id
    if (typeof ready.session_id === 'string' && ready.session_id) connection.sessionId = ready.session_id
    if (typeof ready.resume_gateway_url === 'string' && ready.resume_gateway_url) {
      connection.resumeUrl = ready.resume_gateway_url
    }
    connection.canResume = connection.sessionId !== null
    connection.reconnectAttempts = 0
    connection.reconnecting = false
    connection.state = 'connected'
    connection.lastError = null
    this.log('info', 'Discord Gateway 已连接', {
      botId: connection.botId,
      userId: connection.botUserId,
      at: this.nowIso(),
    })
  }

  private handleResumed(connection: GatewayConnection): void {
    connection.canResume = true
    connection.reconnectAttempts = 0
    connection.reconnecting = false
    connection.state = 'connected'
    connection.lastError = null
    this.log('info', 'Discord Gateway 会话已恢复', { botId: connection.botId, at: this.nowIso() })
  }

  private handleReconnectRequest(connection: GatewayConnection): void {
    if (connection.stopped || connection.socket === null) return
    connection.reconnecting = true
    connection.state = 'reconnecting'
    this.log('info', 'Discord Gateway 收到 RECONNECT', { botId: connection.botId, at: this.nowIso() })
    this.detachSocket(connection, 4000, 'reconnect requested')
    // 服务端要求重连时立即重建，不进入退避等待。
    this.connect(connection)
  }

  private handleInvalidSession(connection: GatewayConnection, data: unknown): void {
    if (connection.stopped) return
    if (data === false) {
      connection.canResume = false
      connection.sessionId = null
      connection.resumeUrl = null
      connection.seq = null
      this.log('warn', 'Discord Gateway 会话失效，将重新 IDENTIFY', { botId: connection.botId })
    } else {
      this.log('info', 'Discord Gateway 会话可恢复', { botId: connection.botId })
    }
    connection.reconnecting = true
    this.detachSocket(connection, 4000, 'invalid session')
    this.scheduleReconnect(connection)
  }

  private handleMessageCreate(connection: GatewayConnection, data: unknown): void {
    if (connection.state !== 'connected' || connection.botUserId === null) return
    const message = asRecord(data)
    if (!message) return
    const author = asRecord(message.author)
    if (!author || typeof author.id !== 'string') return
    if (author.id === connection.botUserId) return
    if (author.bot === true) return
    if (typeof message.webhook_id === 'string' && message.webhook_id) return

    const content = typeof message.content === 'string' ? message.content : ''
    if (content.trim() === '') return
    const channelId = typeof message.channel_id === 'string' ? message.channel_id : ''
    if (!channelId) return
    const messageId = typeof message.id === 'string' ? message.id : ''
    if (!messageId) return

    const isDirect = typeof message.guild_id !== 'string' || message.guild_id === ''
    const mentions = Array.isArray(message.mentions) ? message.mentions : []
    const isMention = mentions.some((mention) => {
      const record = asRecord(mention)
      return record !== null && record.id === connection.botUserId
    })
    const referenced = asRecord(message.referenced_message)
    const referencedAuthor = referenced ? asRecord(referenced.author) : null
    const isReply = referencedAuthor !== null && referencedAuthor.id === connection.botUserId

    const chatTrigger: ChatTrigger | null = isDirect ? 'direct' : isReply ? 'reply' : isMention ? 'mention' : null
    // 普通频道消息不进入 Chat，只有私聊、@ Bot 或回复 Bot 才消费。
    if (chatTrigger === null) return

    this.dispatch(connection, {
      botId: connection.botId,
      eventId: `dc_msg:${messageId}`,
      targetExternalId: channelId,
      targetKind: 'channel',
      userId: author.id,
      userName: typeof author.username === 'string' ? author.username : 'unknown',
      text: content,
      isDirect,
      chatTrigger,
    })
  }

  private dispatch(connection: GatewayConnection, event: DiscordGatewayMessage): void {
    queueMicrotask(() => {
      if (connection.stopped) return
      try {
        const result = this.onMessage(event) as unknown
        if (
          result !== null &&
          (typeof result === 'object' || typeof result === 'function') &&
          typeof (result as { then?: unknown }).then === 'function'
        ) {
          void (result as Promise<unknown>).then(undefined, (error) => {
            this.log('warn', 'Discord Gateway 消息处理失败', {
              botId: event.botId,
              error: errorMessage(error),
            })
          })
        }
      } catch (error) {
        this.log('warn', 'Discord Gateway 消息处理失败', {
          botId: event.botId,
          error: errorMessage(error),
        })
      }
    })
  }

  private scheduleReconnect(connection: GatewayConnection): void {
    if (connection.stopped || !this.started || connection.state === 'error') return
    if (connection.reconnectTimer !== null) return
    const attempt = connection.reconnectAttempts
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, INITIAL_RECONNECT_DELAY_MS * 2 ** Math.min(attempt, 10))
    connection.reconnectAttempts = Math.min(attempt + 1, 10)
    connection.reconnecting = true
    connection.state = 'reconnecting'
    this.log('info', 'Discord Gateway 准备重连', {
      botId: connection.botId,
      attempt: attempt + 1,
      delayMs: delay,
      at: this.nowIso(),
    })
    connection.reconnectTimer = setTimeout(() => {
      connection.reconnectTimer = null
      if (connection.stopped || !this.started) return
      this.connect(connection)
    }, Math.max(0, delay))
  }

  private detachSocket(connection: GatewayConnection, code: number, reason: string): void {
    this.clearHeartbeat(connection)
    const socket = connection.socket
    connection.socket = null
    if (!socket) return
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    try {
      socket.close(code, reason)
    } catch {
      // 关闭失败不影响内部状态回收；重连由调用方继续推进。
    }
  }

  private clearHeartbeat(connection: GatewayConnection): void {
    if (connection.heartbeatTimer !== null) {
      clearTimeout(connection.heartbeatTimer)
      connection.heartbeatTimer = null
    }
    connection.heartbeatMs = null
    connection.awaitingAck = false
  }

  private disposeConnection(connection: GatewayConnection): void {
    connection.stopped = true
    connection.reconnecting = false
    if (connection.reconnectTimer !== null) {
      clearTimeout(connection.reconnectTimer)
      connection.reconnectTimer = null
    }
    this.detachSocket(connection, 1000, 'stop')
    connection.state = 'disabled'
    connection.lastError = null
  }

  private nowIso(): string {
    try {
      return this.now().toISOString()
    } catch {
      return ''
    }
  }
}
