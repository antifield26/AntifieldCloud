import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'
import { OpenCodeClient } from './opencode.ts'

export type IntentAction = 'fish' | 'farm' | 'stopTask' | 'home' | 'deposit' | 'status' | 'chat'

export interface IntentResult {
  action: IntentAction
  confidence: number
}

const ACTIONS = new Set<IntentAction>(['fish', 'farm', 'stopTask', 'home', 'deposit', 'status', 'chat'])
const TASK_HINT = /(钓鱼|鱼|种田|农田|田里|收菜|收工|停止任务|回家|回基地|存箱|存东西|箱子|钓鱼|farm|fish|home|deposit|stop)/i

function parseJson (text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
}

export class IntentClassifier {
  private readonly config: Config
  private readonly logger: Logger
  private readonly client: OpenCodeClient

  constructor (config: Config, logger: Logger, client: OpenCodeClient) {
    this.config = config
    this.logger = logger
    this.client = client
  }

  shouldClassify (text: string): boolean {
    return this.config.aiEnabled &&
      this.config.aiIntentEnabled &&
      !this.config.httpOnlyHighRisk &&
      TASK_HINT.test(text)
  }

  async classify (text: string): Promise<IntentResult | null> {
    if (!this.shouldClassify(text)) return null
    const prompt = [
      '你是一个 Minecraft 机器人意图分类器，只输出 JSON，不要解释。',
      '可选 intent: fish(去钓鱼), farm(去种田/收菜), stopTask(收工/停止任务), home(回家), deposit(存东西/存箱), status(查任务状态), chat(普通聊天)。',
      '只允许这些值；不确定就输出 chat。',
      '输出格式: {"intent":"fish","confidence":0.0}',
      `玩家消息: ${text}`
    ].join('\n')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.aiIntentTimeoutMs)
    try {
      const result = await this.client.generate(prompt, { signal: controller.signal })
      const parsed = parseJson(result.text)
      if (!parsed || typeof parsed !== 'object') return null
      const record = parsed as { intent?: unknown, confidence?: unknown }
      const action = record.intent
      const confidence = Number(record.confidence)
      if (typeof action !== 'string' || !ACTIONS.has(action as IntentAction)) return null
      if (!Number.isFinite(confidence) || confidence < this.config.aiIntentMinConfidence) {
        this.logger.debug('intent: low confidence or invalid', { action, confidence })
        return null
      }
      return { action: action as IntentAction, confidence }
    } catch (error) {
      this.logger.debug('intent: classification failed', {
        error: error instanceof Error ? error.message : String(error)
      })
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}
