/**
 * systemd sd_notify 最小客户端：通过 `/usr/bin/systemd-notify` 子进程发送
 * READY=1 / WATCHDOG=1 / STOPPING=1 / STATUS=…。
 *
 * Node 的 `node:dgram` 只支持 udp4/udp6（不支持 unix_dgram），因此不能直接写 NOTIFY_SOCKET；
 * 这里复用 systemd 自带 CLI。子进程与主进程同 cgroup，unit 使用 `NotifyAccess=all`。
 * 未由 systemd 启动（无 NOTIFY_SOCKET）时全部 no-op；失败只 debug 记录，不影响主流程。
 */
import { execFile } from 'node:child_process'

export type NotifyState = Record<string, string | number | boolean>

/** 生成 sd_notify 文本；值不允许换行，避免注入额外字段（保留给测试/状态文本校验）。 */
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

/** systemd 的 NOTIFY_SOCKET 以 @ 表示抽象命名空间；仅用于 enabled 判断与日志。 */
export function normalizeNotifySocket (raw: string | undefined): string | null {
  if (!raw) return null
  const value = raw.trim()
  if (value === '') return null
  if (value.startsWith('@')) return `\0${value.slice(1)}`
  return value
}

export type NotifyCommandRunner = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv, timeout: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => void

export interface SdNotifyOptions {
  env?: NodeJS.ProcessEnv
  logger?: { debug: (message: string, details?: Record<string, unknown>) => void }
  execFileImpl?: NotifyCommandRunner
}

export class SdNotify {
  private readonly socketPath: string | null
  private readonly logger: SdNotifyOptions['logger']
  private readonly execFileImpl: NotifyCommandRunner
  private readonly env: NodeJS.ProcessEnv

  constructor (options: SdNotifyOptions = {}) {
    this.env = options.env ?? process.env
    this.socketPath = normalizeNotifySocket(this.env.NOTIFY_SOCKET)
    this.logger = options.logger
    this.execFileImpl = options.execFileImpl ?? (execFile as unknown as NotifyCommandRunner)
  }

  get enabled (): boolean {
    return this.socketPath !== null
  }

  ready (): boolean {
    return this.run(['--ready'])
  }

  watchdog (): boolean {
    return this.run(['WATCHDOG=1'])
  }

  stopping (): boolean {
    return this.run(['--stopping'])
  }

  status (text: string): boolean {
    return this.run([`--status=${text.replace(/[\r\n]+/g, ' ').slice(0, 200)}`])
  }

  /** 失败只 debug 记录，不影响主流程；始终返回是否成功发起调用。 */
  private run (args: readonly string[]): boolean {
    if (this.socketPath === null) return false
    try {
      this.execFileImpl('/usr/bin/systemd-notify', args, {
        env: { ...this.env, NOTIFY_SOCKET: this.env.NOTIFY_SOCKET ?? '' },
        timeout: 5000
      }, error => {
        if (error) this.logger?.debug('sd_notify failed', { args: args.join(' '), error: error.message })
      })
      return true
    } catch (error) {
      this.logger?.debug('sd_notify spawn failed', { error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }
}
