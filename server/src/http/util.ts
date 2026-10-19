/** HTTP 工具：客户端 IP、Range、文件名响应头、参数解析。 */
import type { FastifyRequest } from 'fastify'
import type { Actor } from '../files/service.ts'
import { badRequest, unauthorized } from '../util/errors.ts'

export function clientIp(request: FastifyRequest): string {
  const header = request.headers['cf-connecting-ip']
  if (typeof header === 'string' && header.trim()) return header.trim()
  const forwarded = request.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0]!.trim()
  return request.ip
}

export function actorFrom(request: FastifyRequest): Actor {
  if (!request.auth) throw unauthorized()
  return { username: request.auth.user.username, ip: clientIp(request) }
}

export function wantsHtml(request: FastifyRequest): boolean {
  const accept = request.headers.accept
  return typeof accept === 'string' && accept.includes('text/html')
}

export type RangeResult = { start: number; end: number } | null | 'invalid'

/** 只支持单区间 bytes=start-end / bytes=start- / bytes=-suffix。 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'invalid'
  const startRaw = match[1] ?? ''
  const endRaw = match[2] ?? ''
  if (!startRaw && !endRaw) return 'invalid'
  let start: number
  let end: number
  if (!startRaw) {
    const suffix = Number(endRaw)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(startRaw)
    end = endRaw ? Number(endRaw) : size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}

export function contentDisposition(name: string, inline: boolean): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

export function parsePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback
  return parsed
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function requireString(value: unknown, field: string, maxLength = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw badRequest(`字段 ${field} 不合法`, 'invalid_request')
  }
  return value
}

/** multipart 的 filename 默认按 latin1 解码；对非 ASCII 名尝试恢复 UTF-8。 */
export function decodeUploadFilename(name: string): string {
  if (!/[\u0080-\u00ff]/.test(name)) return name
  const recovered = Buffer.from(name, 'latin1').toString('utf8')
  if (recovered.includes('\uFFFD')) return name
  return recovered
}
