/**
 * AI 路点顾问：只在确定性导航失败后，请求一个受控的中间路点建议。
 * 安全边界：不注册工具、不执行方块操作、不直接控制移动；输出必须经 sampler/planner 重新校验，
 * 超时/非法建议一律返回 null，由确定性兜底继续处理。
 */
import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'
import type { OpenCodeClient } from './opencode.ts'
import { blockTop, hasCollision, insideArea } from '../minecraft/routing/sampler.ts'
import type {
  AdvisorInput,
  NavArea,
  NavVector,
  NavWorld,
  RouteAdvice,
  RouteAdvisor
} from '../minecraft/routing/types.ts'

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

function parseAdvice (text: string): RouteAdvice | null {
  const parsed = parseJson(text)
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as { waypoints?: unknown, reason?: unknown }
  if (!Array.isArray(record.waypoints) || record.waypoints.length === 0 || record.waypoints.length > 3) {
    return null
  }
  const waypoints: NavVector[] = []
  for (const item of record.waypoints) {
    if (!item || typeof item !== 'object') return null
    const point = item as { x?: unknown, y?: unknown, z?: unknown }
    const x = Number(point.x)
    const y = Number(point.y)
    const z = Number(point.z)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
    if (Math.abs(x) > 30000000 || Math.abs(z) > 30000000 || y < -256 || y > 512) return null
    waypoints.push({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) })
  }
  return {
    waypoints,
    reason: typeof record.reason === 'string' ? record.reason.slice(0, 200) : null
  }
}

/** 7×7 局部高度摘要：只读方块高度/名称，用于 AI 判断台阶与墙体。 */
export function buildTerrainSummary (world: NavWorld, area: NavArea, start: NavVector): string[] {
  const lines: string[] = []
  for (let dz = -3; dz <= 3; dz += 1) {
    const row: string[] = []
    for (let dx = -3; dx <= 3; dx += 1) {
      const x = Math.floor(start.x) + dx
      const z = Math.floor(start.z) + dz
      let found: string | null = null
      for (let y = Math.floor(start.y) + 2; y >= Math.floor(start.y) - 3; y -= 1) {
        if (!insideArea(area, x, y, z)) continue
        const block = world.blockAt(x, y, z)
        if (!block || !hasCollision(block)) continue
        found = `${Math.round(y + blockTop(block) * 10) / 10}:${block.name}`
        break
      }
      row.push(found ?? '-')
    }
    lines.push(row.join(' '))
  }
  return lines
}

export class PathAdvisor implements RouteAdvisor {
  private readonly config: Config
  private readonly logger: Logger
  private readonly client: OpenCodeClient

  constructor (config: Config, logger: Logger, client: OpenCodeClient) {
    this.config = config
    this.logger = logger
    this.client = client
  }

  get available (): boolean {
    return this.config.pathAiEnabled &&
      this.config.aiEnabled &&
      this.config.opencodePassword.length > 0 &&
      this.config.aiModelId.length > 0
  }

  async suggest (input: AdvisorInput, externalSignal?: AbortSignal): Promise<RouteAdvice | null> {
    if (!this.available) return null
    const prompt = [
      '你是 Minecraft 寻路顾问。只输出 JSON，不要解释。',
      '规则：只使用现有地形；禁止挖掘、放置、传送、跑酷、跨维度；最多 3 个中间路点；每个路点必须是整数方块坐标。',
      '目标是从 start 走到 target；如果不存在规范路径，输出空 waypoints 数组。',
      '输出格式：{"waypoints":[{"x":0,"y":64,"z":0}],"reason":"短说明"}',
      `区域：x ${input.bounds.minX}..${input.bounds.maxX}, z ${input.bounds.minZ}..${input.bounds.maxZ}, y ${input.bounds.minY}..${input.bounds.maxY}`,
      `允许安全区外路径：${input.allowOutsideSafeZone ? '是' : '否'}`,
      `start=${JSON.stringify(input.start)} target=${JSON.stringify(input.target)} failure=${input.failure}`,
      '局部高度摘要（行=z-3..z+3，列=x-3..x+3，值=高度:方块名）：',
      ...input.terrain
    ].join('\n')
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(new Error('external abort'))
    if (externalSignal) externalSignal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('path advisor timeout')), this.config.pathAiTimeoutMs)
    try {
      const result = await this.client.generate(prompt, { signal: controller.signal })
      const advice = parseAdvice(result.text)
      if (!advice) {
        this.logger.warn('path advisor returned invalid advice', { latencyMs: result.latencyMs })
        return null
      }
      this.logger.info('path advisor advice', {
        waypoints: advice.waypoints.length,
        latencyMs: result.latencyMs
      })
      return advice
    } catch (error) {
      this.logger.warn('path advisor failed', {
        error: error instanceof Error ? error.message : String(error)
      })
      return null
    } finally {
      clearTimeout(timer)
      if (externalSignal) externalSignal.removeEventListener('abort', onAbort)
    }
  }
}
