// 展示层格式化工具：字节、时间、百分比与时长。
// 数据层保持 ISO 8601 UTC，本模块统一按 Asia/Shanghai 展示。

const TIME_ZONE = 'Asia/Shanghai'
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

function toParts(date: Date): Record<string, string> {
  const result: Record<string, string> = {}
  for (const part of dateTimeFormatter.formatToParts(date)) {
    if (part.type !== 'literal') result[part.type] = part.value
  }
  return result
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatNumber(value: number, fractionDigits = 0): string {
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: 0,
  }).format(value)
}

export function formatBytes(bytes: number | null | undefined, fractionDigits = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes === 0) return '0 B'
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const digits = unitIndex === 0 ? 0 : value >= 100 ? 0 : fractionDigits
  return `${formatNumber(value, digits)} ${BYTE_UNITS[unitIndex] ?? 'B'}`
}

/** YYYY-MM-DD HH:mm（Asia/Shanghai） */
export function formatDateTime(value: string | null | undefined): string {
  const date = toDate(value)
  if (!date) return '—'
  const parts = toParts(date)
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

/** YYYY-MM-DD HH:mm:ss（Asia/Shanghai） */
export function formatDateTimeWithSeconds(value: string | null | undefined): string {
  const date = toDate(value)
  if (!date) return '—'
  const parts = toParts(date)
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

/** HH:mm:ss（Asia/Shanghai），用于工作台时钟 */
export function formatClock(date: Date): string {
  const parts = toParts(date)
  return `${parts.hour}:${parts.minute}:${parts.second}`
}

/** YYYY-MM-DD（Asia/Shanghai） */
export function formatDate(value: string | null | undefined): string {
  const date = toDate(value)
  if (!date) return '—'
  const parts = toParts(date)
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function formatRelative(value: string | null | undefined, now = Date.now()): string {
  const date = toDate(value)
  if (!date) return '—'
  const diffSeconds = Math.round((now - date.getTime()) / 1000)
  const abs = Math.abs(diffSeconds)
  if (abs < 10) return '刚刚'
  const suffix = diffSeconds >= 0 ? '前' : '后'
  if (abs < 60) return `${abs} 秒${suffix}`
  if (abs < 3600) return `${Math.floor(abs / 60)} 分钟${suffix}`
  if (abs < 86400) return `${Math.floor(abs / 3600)} 小时${suffix}`
  if (abs < 86400 * 7) return `${Math.floor(abs / 86400)} 天${suffix}`
  return formatDateTime(value)
}

export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return '—'
  }
  const seconds = Math.floor(totalSeconds)
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`
  if (minutes > 0) return `${minutes} 分钟`
  return `${seconds} 秒`
}

export function formatPercent(value: number | null | undefined, fractionDigits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value.toFixed(fractionDigits)}%`
}

/** 计算占比并裁剪到 0–100，避免进度条越界。 */
export function percentOf(used: number | null | undefined, total: number | null | undefined): number {
  if (!used || !total || total <= 0) return 0
  return Math.min(100, Math.max(0, (used / total) * 100))
}

/** 将限流秒数转为中文时长。 */
export function formatRetryAfter(seconds: number | null | undefined): string {
  const total = Math.max(1, Math.ceil(seconds ?? 60))
  if (total < 60) return `${total} 秒`
  return `${Math.ceil(total / 60)} 分钟`
}

/** 将秒级运行时长转为「N 天 N 小时」等中文描述（同 formatDuration）。 */
export function formatUptime(seconds: number | null | undefined): string {
  return formatDuration(seconds)
}

export function truncateText(text: string, max = 80): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}
