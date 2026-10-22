/**
 * Bot 出站连通性探测：代理端口存活 -> 外网 -> 各平台 API 三层检查。
 * 安全边界：只发只读 GET，不携带 Bot Token/AppSecret，不记录响应正文；代理 URL 仅展示主机/端口。
 */
import { connect } from 'node:net'
import type { BotPlatform } from './types.ts'

export interface ProbeResult {
  reachable: boolean
  latencyMs: number | null
  status: number | null
  error: string | null
}

export interface ConnectivitySnapshot {
  checkedAt: string | null
  checking: boolean
  /** 代理隧道/设备在线：代理端口可达且外网探测成功；未配置代理时直接看外网。 */
  deviceOnline: boolean
  proxy: {
    configured: boolean
    host: string | null
    port: number | null
    portReachable: boolean
    latencyMs: number | null
    error: string | null
  }
  internet: ProbeResult
  platforms: Partial<Record<BotPlatform, ProbeResult>>
}

const PLATFORM_PROBE_URLS: Record<BotPlatform, string> = {
  qq: 'https://bots.qq.com/',
}

const EMPTY_PROBE: ProbeResult = { reachable: false, latencyMs: null, status: null, error: null }

function errorText(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'timeout'
    return error.message.slice(0, 160)
  }
  return 'unknown'
}

function parseProxy(value: string): { host: string; port: number } | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
    if (!url.hostname || !Number.isFinite(port) || port <= 0 || port > 65535) return null
    return { host: url.hostname, port }
  } catch {
    return null
  }
}

export interface ConnectivityDeps {
  enabled: boolean
  intervalSeconds: number
  timeoutSeconds: number
  proxyUrl: string
  getPlatforms: () => BotPlatform[]
  fetchImpl?: typeof fetch
  /** 测试注入：返回代理端口是否可连接。 */
  probePort?: (host: string, port: number, timeoutMs: number) => Promise<boolean>
  log?: (level: 'info' | 'warn', message: string, detail?: Record<string, unknown>) => void
  onRecover?: () => void
  onDown?: () => void
}

export class BotConnectivityMonitor {
  private readonly deps: ConnectivityDeps
  private timer: NodeJS.Timeout | null = null
  private checking = false
  private everChecked = false
  private lastInternetReachable = false
  private snapshotValue: ConnectivitySnapshot

  constructor(deps: ConnectivityDeps) {
    this.deps = deps
    this.snapshotValue = {
      checkedAt: null,
      checking: false,
      deviceOnline: false,
      proxy: { configured: Boolean(parseProxy(deps.proxyUrl)), host: null, port: null, portReachable: false, latencyMs: null, error: null },
      internet: { ...EMPTY_PROBE },
      platforms: {},
    }
  }

  start(): void {
    if (!this.deps.enabled || this.timer) return
    void this.checkNow()
    this.timer = setInterval(() => {
      void this.checkNow()
    }, this.deps.intervalSeconds * 1000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  snapshot(): ConnectivitySnapshot {
    return this.snapshotValue
  }

  async checkNow(): Promise<ConnectivitySnapshot> {
    if (this.checking) return this.snapshotValue
    this.checking = true
    this.snapshotValue = { ...this.snapshotValue, checking: true }
    const proxy = parseProxy(this.deps.proxyUrl)
    const timeoutMs = this.deps.timeoutSeconds * 1000
    try {
      let portReachable = false
      let proxyLatency: number | null = null
      let proxyError: string | null = null
      if (proxy) {
        const started = Date.now()
        try {
          portReachable = this.deps.probePort
            ? await this.deps.probePort(proxy.host, proxy.port, timeoutMs)
            : await probeTcp(proxy.host, proxy.port, timeoutMs)
          proxyLatency = Date.now() - started
          if (!portReachable) proxyError = 'port_unreachable'
        } catch (error) {
          proxyError = errorText(error)
        }
      }

      const canProbe = !proxy || portReachable
      // 外网探测只用中立站点；QQ 平台可达性由下方 platforms.qq 单独探测。
      const internet = canProbe
        ? await this.probeHttp('https://www.qq.com/', timeoutMs)
        : { ...EMPTY_PROBE, error: 'proxy_port_unreachable' }
      const platformNames = Array.from(new Set(this.deps.getPlatforms()))
      const platformEntries = await Promise.all(
        platformNames.map(async (platform) => {
          const url = PLATFORM_PROBE_URLS[platform]
          const result = canProbe && url
            ? await this.probeHttp(url, timeoutMs)
            : { ...EMPTY_PROBE, error: 'proxy_port_unreachable' }
          return [platform, result] as const
        }),
      )
      const platforms: Partial<Record<BotPlatform, ProbeResult>> = {}
      for (const [platform, result] of platformEntries) platforms[platform] = result

      const next: ConnectivitySnapshot = {
        checkedAt: new Date().toISOString(),
        checking: false,
        deviceOnline: proxy ? portReachable && internet.reachable : internet.reachable,
        proxy: {
          configured: Boolean(proxy),
          host: proxy?.host ?? null,
          port: proxy?.port ?? null,
          portReachable,
          latencyMs: proxyLatency,
          error: proxyError,
        },
        internet,
        platforms,
      }
      this.snapshotValue = next
      this.emitTransition(next)
      return next
    } catch (error) {
      const next: ConnectivitySnapshot = {
        checkedAt: new Date().toISOString(),
        checking: false,
        deviceOnline: false,
        proxy: {
          configured: Boolean(proxy),
          host: proxy?.host ?? null,
          port: proxy?.port ?? null,
          portReachable: false,
          latencyMs: null,
          error: errorText(error),
        },
        internet: { ...EMPTY_PROBE, error: errorText(error) },
        platforms: {},
      }
      this.snapshotValue = next
      this.emitTransition(next)
      return next
    } finally {
      this.checking = false
    }
  }

  private async probeHttp(url: string, timeoutMs: number): Promise<ProbeResult> {
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await (this.deps.fetchImpl ?? fetch)(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: '*/*', 'user-agent': 'AntifieldCloud-connectivity/1' },
      })
      // 4xx/5xx 也说明网络路径和 TLS 可用；只把传输失败判为不可达。
      return { reachable: true, latencyMs: Date.now() - started, status: response.status, error: null }
    } catch (error) {
      return { reachable: false, latencyMs: Date.now() - started, status: null, error: errorText(error) }
    } finally {
      clearTimeout(timer)
    }
  }

  private emitTransition(next: ConnectivitySnapshot): void {
    const reachable = next.internet.reachable
    if (!this.everChecked) {
      this.everChecked = true
      this.lastInternetReachable = reachable
      this.deps.log?.('info', 'Bot 连通性检查完成', {
        proxyPort: next.proxy.portReachable,
        internet: reachable,
        platforms: Object.keys(next.platforms),
      })
      return
    }
    if (reachable === this.lastInternetReachable) return
    this.lastInternetReachable = reachable
    if (reachable) {
      this.deps.log?.('info', 'Bot 出站网络已恢复', { proxyPort: next.proxy.portReachable })
      this.deps.onRecover?.()
    } else {
      this.deps.log?.('warn', 'Bot 出站网络不可用', { proxyPort: next.proxy.portReachable })
      this.deps.onDown?.()
    }
  }
}

function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    let settled = false
    const done = (value: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}
