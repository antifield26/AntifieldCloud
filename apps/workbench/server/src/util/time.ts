/** 时间工具：数据库统一 ISO 8601 UTC；展示时由前端转 Asia/Shanghai。 */

export function nowIso(): string {
  return new Date().toISOString()
}

export function isoAfterSeconds(seconds: number, from: Date = new Date()): string {
  return new Date(from.getTime() + seconds * 1000).toISOString()
}

export function isoAfterDays(days: number, from: Date = new Date()): string {
  return isoAfterSeconds(days * 86400, from)
}

export function isExpired(iso: string, now: Date = new Date()): boolean {
  const time = Date.parse(iso)
  return Number.isNaN(time) || time <= now.getTime()
}

export function secondsSince(iso: string, now: Date = new Date()): number {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return Number.POSITIVE_INFINITY
  return Math.max(0, (now.getTime() - time) / 1000)
}

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000)
}
