/**
 * Chatbot 出站连通性探测：外网 -> QQ 平台 API（Pi 直连，不依赖代理隧道）。
 * 安全边界：只发只读 GET，不携带 Chatbot Token/AppSecret，不记录响应正文。
 */
import type { ChatbotPlatform } from './types.ts'

export interface ProbeResult {
  reachable: boolean
  latencyMs: number | null
  status: number | null
  error: string | null
}

export interface ConnectivitySnapshot {
  checkedAt: string | null
  checking: boolean
  internet: ProbeResult
  platforms: Partial<Record<ChatbotPlatform, ProbeResult>>
}

const PLATFORM_PROBE_URLS: Record<ChatbotPlatform, string> = {
  qq: 'https://chatbots.qq.com/',
}

const EMPTY_PROBE: ProbeResult = { reachable: false, latencyMs: null, status: null, error: null }

function errorText(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'timeout'
    return error.message.slice(0, 160)
  }
  return 'unknown'
}

export interface ConnectivityDeps {
  enabled: boolean
  intervalSeconds: number
  timeoutSeconds: number
  getPlatforms: () => ChatbotPlatform[]
  fetchImpl?: typeof fetch
  log?: (level: 'info' | 'warn', message: string, detail?: Record<string, unknown>) => void
  onRecover?: () => void
  onDown?: () => void
}

export class ChatbotConnectivityMonitor {
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
    const timeoutMs = this.deps.timeoutSeconds * 1000
    try {
      // 外网探测只用中立站点；QQ 平台可达性由下方 platforms.qq 单独探测。
      const internet = await this.probeHttp('https://www.qq.com/', timeoutMs)
      const platformNames = Array.from(new Set(this.deps.getPlatforms()))
      const platformEntries = await Promise.all(
        platformNames.map(async (platform) => {
          const url = PLATFORM_PROBE_URLS[platform]
          const result = url ? await this.probeHttp(url, timeoutMs) : { ...EMPTY_PROBE }
          return [platform, result] as const
        }),
      )
      const platforms: Partial<Record<ChatbotPlatform, ProbeResult>> = {}
      for (const [platform, result] of platformEntries) platforms[platform] = result

      const next: ConnectivitySnapshot = {
        checkedAt: new Date().toISOString(),
        checking: false,
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
        headers: { accept: '*/*', 'user-agent': 'AntifieldComplexx-connectivity/1' },
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
      this.deps.log?.('info', 'Chatbot 连通性检查完成', {
        internet: reachable,
        platforms: Object.keys(next.platforms),
      })
      return
    }
    if (reachable === this.lastInternetReachable) return
    this.lastInternetReachable = reachable
    if (reachable) {
      this.deps.log?.('info', 'Chatbot 出站网络已恢复')
      this.deps.onRecover?.()
    } else {
      this.deps.log?.('warn', 'Chatbot 出站网络不可用')
      this.deps.onDown?.()
    }
  }
}
