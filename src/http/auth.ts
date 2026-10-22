import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

function digest (value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

export function safeEqual (left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right))
}

export function extractBearer (req: IncomingMessage): string | null {
  const header = req.headers.authorization
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() ?? null
}

export function isAuthorized (req: IncomingMessage, token: string): boolean {
  const provided = extractBearer(req)
  if (!provided) return false
  return safeEqual(provided, token)
}
