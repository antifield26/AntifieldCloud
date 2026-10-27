export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogMeta {
  [key: string]: unknown
}

export interface Logger {
  debug: (message: string, meta?: LogMeta) => void
  info: (message: string, meta?: LogMeta) => void
  warn: (message: string, meta?: LogMeta) => void
  error: (message: string, meta?: LogMeta) => void
  withScope: (scope: string) => Logger
}

const LEVEL_VALUE: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
}

const SECRET_KEYS = /token|password|secret|authorization|api[-_]?key/i
const SECRET_TEXT = [
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /(Basic\s+)[A-Za-z0-9+/=-]+/gi,
  /(password["'\s:=]+)[^\s"',}]+/gi,
  /(token["'\s:=]+)[^\s"',}]+/gi
] as const

function redactText (text: string): string {
  let result = text
  for (const pattern of SECRET_TEXT) {
    result = result.replace(pattern, '$1[redacted]')
  }
  return result
}

function redactValue (value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactText(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map(item => redactValue(item, seen))
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    output[key] = SECRET_KEYS.test(key) ? '[redacted]' : redactValue(item, seen)
  }
  return output
}

function serializeMeta (meta: LogMeta): string {
  try {
    return JSON.stringify(redactValue(meta, new WeakSet()))
  } catch {
    return '"[unserializable]"'
  }
}

export function createLogger (level: LogLevel = 'info', scope = ''): Logger {
  const threshold = LEVEL_VALUE[level]
  const prefix = scope ? `[${scope}] ` : ''
  const write = (entryLevel: LogLevel, message: string, meta?: LogMeta): void => {
    if (LEVEL_VALUE[entryLevel] < threshold) return
    const suffix = meta && Object.keys(meta).length > 0 ? ` ${serializeMeta(meta)}` : ''
    const line = `${new Date().toISOString()} [${entryLevel.toUpperCase()}] ${prefix}${redactText(message)}${suffix}`
    if (entryLevel === 'error' || entryLevel === 'warn') {
      process.stderr.write(`${line}\n`)
    } else {
      process.stdout.write(`${line}\n`)
    }
  }
  return {
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
    withScope: (nextScope: string) => createLogger(level, scope ? `${scope}:${nextScope}` : nextScope)
  }
}
