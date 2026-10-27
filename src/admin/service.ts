import type { Config } from '../config.ts'
import type { Logger } from '../logger.ts'
import type { AdminSnapshot, RuntimeState } from '../state.ts'
import { RconClient } from './rcon.ts'

export interface RconLike {
  command: (command: string) => Promise<string>
}

export interface AdminServiceDeps {
  config: Config
  logger: Logger
  state: RuntimeState
  client?: RconLike
}

export interface TpsSnapshot {
  one: number | null
  five: number | null
  fifteen: number | null
}

export function stripColors (text: string): string {
  return text.replace(/§./g, '')
}

export function parseTps (text: string): TpsSnapshot {
  const clean = stripColors(text)
  const payload = clean.includes(':') ? clean.slice(clean.indexOf(':') + 1) : clean
  const numbers = [...payload.matchAll(/(\d+(?:\.\d+)?)/g)]
    .map(match => Number(match[1]))
    .filter(value => Number.isFinite(value))
  return {
    one: numbers[0] ?? null,
    five: numbers[1] ?? null,
    fifteen: numbers[2] ?? null
  }
}

export function parseList (text: string): { count: number | null, max: number | null, players: string[] } {
  const clean = stripColors(text)
  let count: number | null = null
  let max: number | null = null
  let tail = ''
  const english = /There are\s+(\d+)\s+of a max of\s+(\d+)\s+players online:?\s*(.*)/i.exec(clean)
  if (english) {
    count = Number(english[1])
    max = Number(english[2])
    tail = english[3] ?? ''
  } else {
    const chinese = /当前有\s*(\d+)\s*位玩家在线[，,]\s*可容纳最大在线人数为\s*(\d+)/.exec(clean)
    if (chinese) {
      count = Number(chinese[1])
      max = Number(chinese[2])
    }
  }
  const players = tail
    .split(/[,，、\s]+/)
    .map(name => name.trim())
    .filter(name => /^[A-Za-z0-9_]{1,16}$/.test(name))
  return { count, max, players }
}

export function parseWhitelist (text: string): { count: number | null, names: string[] } {
  const clean = stripColors(text)
  const english = /There are\s+(\d+)\s+whitelisted player\(s\):\s*(.*)/i.exec(clean)
  if (english) {
    return {
      count: Number(english[1]),
      names: (english[2] ?? '').split(/[,，、\s]+/).filter(name => /^[A-Za-z0-9_]{1,16}$/.test(name))
    }
  }
  const chinese = /有\s*(\d+)\s*个白名单玩家[：:]\s*(.*)/.exec(clean)
  if (chinese) {
    return {
      count: Number(chinese[1]),
      names: (chinese[2] ?? '').split(/[,，、\s]+/).filter(name => /^[A-Za-z0-9_]{1,16}$/.test(name))
    }
  }
  return { count: null, names: [] }
}

function emptyTps (): TpsSnapshot {
  return { one: null, five: null, fifteen: null }
}

export class AdminService {
  private readonly deps: AdminServiceDeps
  private readonly logger: Logger
  private readonly client: RconLike
  private timer: NodeJS.Timeout | null = null
  private refreshing: Promise<void> | null = null
  private stopped = false
  private lastGood: AdminSnapshot

  constructor (deps: AdminServiceDeps) {
    this.deps = deps
    this.logger = deps.logger
    this.client = deps.client ?? new RconClient(deps.config.rcon)
    this.lastGood = {
      enabled: deps.config.rcon.enabled,
      rcon: false,
      updatedAt: null,
      lastError: null,
      tps: emptyTps(),
      online: { count: null, max: null, players: [] },
      whitelist: { count: null, names: [] },
      backup: { status: 'unknown' }
    }
    deps.state.setAdmin(this.lastGood)
  }

  start (): void {
    if (!this.deps.config.rcon.enabled) {
      this.deps.state.setAdmin({ ...this.lastGood, enabled: false })
      return
    }
    this.stop()
    this.stopped = false
    void this.refresh()
    this.timer = setInterval(() => { void this.refresh() }, this.deps.config.adminPollMs)
    this.timer.unref?.()
  }

  stop (): void {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async refresh (): Promise<void> {
    if (this.stopped) return
    if (!this.deps.config.rcon.enabled) return
    if (this.refreshing) return this.refreshing
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async doRefresh (): Promise<void> {
    try {
      const [tpsText, listText, whitelistText] = await Promise.all([
        this.client.command('tps'),
        this.client.command('list'),
        this.client.command('whitelist list')
      ])
      const tps = parseTps(tpsText)
      const online = parseList(listText)
      const whitelist = parseWhitelist(whitelistText)
      this.lastGood = {
        enabled: true,
        rcon: true,
        updatedAt: new Date().toISOString(),
        lastError: null,
        tps,
        online,
        whitelist,
        backup: { status: 'unknown' }
      }
      this.deps.state.setAdmin(this.lastGood)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn('admin: rcon query failed', { error: message })
      this.lastGood = {
        ...this.lastGood,
        enabled: true,
        rcon: false,
        updatedAt: new Date().toISOString(),
        lastError: message.slice(0, 240)
      }
      this.deps.state.setAdmin(this.lastGood)
    }
  }
}
