/**
 * systemd sd_notify 最小客户端：通过 NOTIFY_SOCKET 的 unix datagram 发送
 * READY=1 / WATCHDOG=1 / STOPPING=1。未由 systemd 启动（无 NOTIFY_SOCKET）时全部 no-op。
 * 不依赖第三方库；在 Windows 等不支持 unix datagram 的环境自动降级为 disabled。
 */
import { createSocket, type Socket } from 'node:dgram'

export type NotifyState = Record<string, string | number | boolean>

const unixDgramSocket = (): Socket => (createSocket as unknown as (type: string) => Socket)('unix_dgram')

const ABSTRACT_PREFIX = '@'

/** 生成 sd_notify 文本；值不允许换行，避免注入额外字段。 */
export function formatNotifyMessage (state: NotifyState): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(state)) {
    const text = String(value)
    if (text.includes('\n') || text.includes('\r')) {
      throw new Error(`sd_notify value must not contain newlines: ${key}`)
    }
    lines.push(`${key}=${text}`)
  }
  return lines.join('\n')
}

/** systemd 的 NOTIFY_SOCKET 以 @ 表示抽象命名空间。 */
export function normalizeNotifySocket (raw: string | undefined): string | null {
  if (!raw) return null
  const value = raw.trim()
  if (value === '') return null
  if (value.startsWith(ABSTRACT_PREFIX)) return `\0${value.slice(1)}`
  return value
}

export interface SdNotifyOptions {
  env?: NodeJS.ProcessEnv
  logger?: { debug: (message: string, details?: Record<string, unknown>) => void }
  socketFactory?: (type: 'unix_dgram') => Socket
}

export class SdNotify {
  private readonly socketPath: string | null
  private readonly logger: SdNotifyOptions['logger']
  private readonly socketFactory: () => Socket
  private readonly env: NodeJS.ProcessEnv

  constructor (options: SdNotifyOptions = {}) {
    this.env = options.env ?? process.env
    this.socketPath = normalizeNotifySocket(this.env.NOTIFY_SOCKET)
    this.logger = options.logger
    this.socketFactory = () => (options.socketFactory ? options.socketFactory('unix_dgram') : unixDgramSocket())
  }

  get enabled (): boolean {
    return this.socketPath !== null
  }

  ready (): boolean {
    return this.notify({ READY: 1 })
  }

  watchdog (): boolean {
    return this.notify({ WATCHDOG: 1 })
  }

  stopping (): boolean {
    return this.notify({ STOPPING: 1 })
  }

  status (text: string): boolean {
    return this.notify({ STATUS: text })
  }

  /** 失败只 debug 记录，不影响主流程；始终返回是否成功发送。 */
  notify (state: NotifyState): boolean {
    if (this.socketPath === null) return false
    let socket: Socket | null = null
    try {
      const message = formatNotifyMessage(state)
      socket = this.socketFactory()
      const sender = socket as unknown as {
        send: (message: Buffer, path: string, callback: (error: Error | null) => void) => void
      }
      sender.send(Buffer.from(message), this.socketPath, error => {
        if (error) this.logger?.debug('sd_notify send failed', { error: error.message })
      })
      return true
    } catch (error) {
      this.logger?.debug('sd_notify failed', { error: error instanceof Error ? error.message : String(error) })
      return false
    } finally {
      try { socket?.close() } catch { /* ignore */ }
    }
  }
}
