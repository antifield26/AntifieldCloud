/**
 * Chatbot 出站文本分段：QQ 官方 Chatbot 单条文本上限 2000 字符，长回答按上限拆分，避免静默截断。
 * 安全边界：只做长度切分与续段标记，不改变正文语义；调用方必须已完成清洗/格式化，
 * 且分段数量有上限，避免超长内容造成大量外发。
 */

/** QQ 官方 Chatbot 单条文本上限（与适配器一致）。 */
export const CHATBOT_TEXT_LIMITS = { qq: 2000 } as const
export type ChatbotTextPlatform = keyof typeof CHATBOT_TEXT_LIMITS

/** 单次回复最多发送的段数；超出部分截断并标记。 */
export const MAX_MESSAGE_PARTS = 4

/** 续段前缀预留空间（`（续 4/4）` 约 8 字符）。 */
const CONTINUATION_RESERVE = 10
const TRUNCATED_MARKER = '…（内容过长已截断）'

export interface MessagePart {
  /** 实际发送的文本（已带续段前缀）。 */
  text: string
  /** 1 起始的段号。 */
  index: number
  total: number
}

/** 续段前缀；只有后续段才添加，避免第一段出现冗余标记。 */
function continuationPrefix(index: number, total: number): string {
  return `（续 ${index}/${total}）`
}

/** 避免把代理对（emoji/生僻字）切成两半。 */
function safeCut(text: string, cut: number): number {
  if (cut <= 0) return 1
  if (cut >= text.length) return text.length
  const code = text.charCodeAt(cut - 1)
  // 高代理项后截断：退一位，让两个码元留在同一段。
  if (code >= 0xd800 && code <= 0xdbff) return cut - 1 > 0 ? cut - 1 : cut
  return cut
}

/** 在段落/换行/空格边界优先切分；找不到自然边界时按硬上限切。 */
function pickCut(text: string, limit: number): number {
  if (text.length <= limit) return text.length
  const window = text.slice(0, limit)
  const paragraph = window.lastIndexOf('\n\n')
  if (paragraph > limit * 0.5) return safeCut(text, paragraph + 2)
  const line = window.lastIndexOf('\n')
  if (line > limit * 0.5) return safeCut(text, line + 1)
  const space = window.lastIndexOf(' ')
  if (space > limit * 0.7) return safeCut(text, space + 1)
  return safeCut(text, limit)
}

/** 把超长末段裁剪到上限内并加截断标记。 */
function clipTail(text: string, limit: number): string {
  const budget = Math.max(1, limit - TRUNCATED_MARKER.length)
  const clipped = text.length > budget ? text.slice(0, safeCut(text, budget)) : text
  return `${clipped}${TRUNCATED_MARKER}`
}

/**
 * 按 `limit` 与最大段数拆分文本。
 * - 第一段可占满 limit，后续段预留续段前缀空间；
 * - 超过 `maxParts` 时只保留前 `maxParts-1` 段与截断后的末段；
 * - 空文本返回空数组，由调用方决定是否发送。
 */
export function splitMessage(text: string, limit: number, maxParts = MAX_MESSAGE_PARTS): MessagePart[] {
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('invalid text limit')
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (!normalized) return []
  const limitInt = Math.floor(limit)
  const max = Math.max(1, Math.min(8, Math.floor(Number.isFinite(maxParts) ? maxParts : MAX_MESSAGE_PARTS)))

  if (normalized.length <= limitInt) return [{ text: normalized, index: 1, total: 1 }]

  const raw: string[] = []
  let rest = normalized
  while (rest.length > 0 && raw.length < 64) {
    const isFirst = raw.length === 0
    const cap = isFirst ? limitInt : Math.max(1, limitInt - CONTINUATION_RESERVE)
    const cut = pickCut(rest, cap)
    raw.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }

  let parts: string[]
  if (raw.length <= max) {
    parts = raw
  } else {
    parts = raw.slice(0, max - 1)
    const tail = raw.slice(max - 1).join('\n')
    // 末段还会加续段前缀，裁剪时预留同样的空间，保证最终发送文本不超过平台上限。
    parts.push(clipTail(tail, Math.max(1, limitInt - CONTINUATION_RESERVE)))
  }

  const total = parts.length
  return parts.map((part, index) => ({
    text: index === 0 ? part : `${continuationPrefix(index + 1, total)}${part}`,
    index: index + 1,
    total,
  }))
}

/** 平台便捷封装：按 QQ 文本上限拆分。 */
export function splitForPlatform(_platform: ChatbotTextPlatform, text: string, maxParts = MAX_MESSAGE_PARTS): MessagePart[] {
  return splitMessage(text, CHATBOT_TEXT_LIMITS.qq, maxParts)
}
