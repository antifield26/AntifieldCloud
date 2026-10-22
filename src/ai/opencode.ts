import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'

export type AiErrorKind = 'timeout' | 'http' | 'network' | 'invalid' | 'aborted'

export class AiError extends Error {
  readonly kind: AiErrorKind
  readonly status: number | null

  constructor (kind: AiErrorKind, message: string, status: number | null = null) {
    super(message)
    this.name = 'AiError'
    this.kind = kind
    this.status = status
  }
}

export interface GenerateResult {
  text: string
  latencyMs: number
}

export interface GenerateOptions {
  signal?: AbortSignal
}

type FetchLike = typeof fetch

interface GenerateResponse {
  data?: {
    text?: unknown
  }
}

const RETRY_DELAY_MS = 500

function sleep (ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class OpenCodeClient {
  private readonly config: Config
  private readonly logger: Logger
  private readonly fetchImpl: FetchLike

  constructor (config: Config, logger: Logger, fetchImpl: FetchLike = fetch) {
    this.config = config
    this.logger = logger
    this.fetchImpl = fetchImpl
  }

  private authHeader (): string {
    const raw = `${this.config.opencodeUsername}:${this.config.opencodePassword}`
    return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`
  }

  async generate (prompt: string, options: GenerateOptions = {}): Promise<GenerateResult> {
    const startedAt = Date.now()
    const external = options.signal
    let lastError: unknown = null

    for (let attempt = 0; attempt < 2; attempt++) {
      if (external?.aborted) throw new AiError('aborted', 'request aborted')
      const controller = new AbortController()
      const onAbort = (): void => controller.abort(new Error('external abort'))
      if (external) external.addEventListener('abort', onAbort, { once: true })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort(new Error('ai timeout'))
      }, this.config.aiTimeoutMs)
      try {
        const response = await this.fetchImpl(`${this.config.opencodeUrl}/api/experimental/generate`, {
          method: 'POST',
          headers: {
            Authorization: this.authHeader(),
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            prompt,
            model: {
              id: this.config.aiModelId,
              providerID: this.config.aiModelProvider
            }
          }),
          signal: controller.signal
        })
        if (!response.ok) {
          const body = await response.text().catch(() => '')
          const detail = body.slice(0, 200)
          if (response.status >= 500 && attempt === 0) {
            lastError = new AiError('http', `OpenCode ${response.status}`, response.status)
            await sleep(RETRY_DELAY_MS)
            continue
          }
          throw new AiError('http', `OpenCode ${response.status}${detail ? `: ${detail}` : ''}`, response.status)
        }
        const payload = await response.json() as GenerateResponse
        const text = payload?.data?.text
        if (typeof text !== 'string' || text.trim() === '') {
          throw new AiError('invalid', 'OpenCode returned empty text')
        }
        return { text, latencyMs: Date.now() - startedAt }
      } catch (error) {
        if (external?.aborted) throw new AiError('aborted', 'request aborted')
        if (timedOut) throw new AiError('timeout', `OpenCode timed out after ${this.config.aiTimeoutMs}ms`)
        if (this.isAbort(error)) throw new AiError('aborted', 'request aborted')
        if (error instanceof AiError) {
          if (error.kind === 'http' && error.status !== null && error.status >= 500 && attempt === 0) {
            lastError = error
            await sleep(RETRY_DELAY_MS)
            continue
          }
          throw error
        }
        lastError = error
        if (attempt === 0) {
          await sleep(RETRY_DELAY_MS)
          continue
        }
        throw new AiError('network', error instanceof Error ? error.message : String(error))
      } finally {
        clearTimeout(timer)
        if (external) external.removeEventListener('abort', onAbort)
      }
    }

    if (lastError instanceof AiError) throw lastError
    throw new AiError('network', lastError instanceof Error ? lastError.message : String(lastError))
  }

  private isAbort (error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    const name = (error as { name?: unknown }).name
    return name === 'AbortError'
  }
}
