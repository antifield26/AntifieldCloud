/**
 * Minecraft 集成：SLP + RCON 只读状态 + 白名单增删。
 * 不提供启停、任意命令、封禁/OP/踢人。
 */
import { execFile } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import type { Config } from '../config.ts'
import type { Actor } from '../files/service.ts'
import { audit } from '../auth/audit.ts'
import { badRequest, conflict, notFound, rconUnavailable } from '../util/errors.ts'
import { nowIso } from '../util/time.ts'
import { pingStatus, stripColors } from './slp.ts'
import { rconCommand, RconError } from './rcon.ts'

const execFileAsync = promisify(execFile)
const PLAYER_NAME = /^[A-Za-z0-9_]{3,16}$/

export interface McTps {
  m1: number
  m5: number
  m15: number
}

export interface McStatus {
  online: boolean
  version: string
  motd: string
  players: { online: number; max: number; names: string[] }
  tps: McTps | null
  whitelistCount: number | null
  serviceActive: 'active' | 'inactive' | 'unknown'
  publicAddress: string
  checkedAt: string
  error: string | null
}

export interface WhitelistSnapshot {
  names: string[]
  checkedAt: string
  error: string | null
}

export function validatePlayerName(name: string): string {
  const trimmed = name.trim()
  if (!PLAYER_NAME.test(trimmed)) throw badRequest('玩家名仅允许 3–16 位字母、数字、下划线', 'invalid_name')
  return trimmed
}

export function parseListResponse(text: string): { online: number; max: number; names: string[] } {
  const clean = stripColors(text).replace(/\r/g, '').trim()
  const numbers = (clean.match(/\d+/g) ?? []).map((value) => Number(value))
  const online = numbers[0] ?? 0
  const max = numbers[1] ?? 0
  const names = namesAfterColon(clean)
  return { online, max, names }
}

export function parseWhitelistResponse(text: string): string[] {
  return namesAfterColon(stripColors(text).replace(/\r/g, '').trim())
}

function namesAfterColon(text: string): string[] {
  const index = Math.max(text.lastIndexOf(':'), text.lastIndexOf('：'))
  if (index < 0) return []
  return text
    .slice(index + 1)
    .split(/[,，、;；]/)
    .map((name) => name.trim())
    .filter((name) => PLAYER_NAME.test(name))
}

export function parseTpsResponse(text: string): McTps | null {
  const clean = stripColors(text).replace(/\r/g, '')
  const match = clean.match(/last 1m,\s*5m,\s*15m:\s*([\d.]+)\D+([\d.]+)\D+([\d.]+)/i)
  if (match) {
    return { m1: Number(match[1]), m5: Number(match[2]), m15: Number(match[3]) }
  }
  const floats = (clean.match(/\d+(?:\.\d+)?/g) ?? []).map(Number)
  if (floats.length >= 3) return { m1: floats[0]!, m5: floats[1]!, m15: floats[2]! }
  return null
}

export class MinecraftService {
  private readonly db: DatabaseSync
  private readonly config: Config
  private cache: { at: number; status: McStatus } | null = null
  private pending: Promise<McStatus> | null = null

  constructor(db: DatabaseSync, config: Config) {
    this.db = db
    this.config = config
  }

  private async serviceActive(): Promise<'active' | 'inactive' | 'unknown'> {
    if (process.platform === 'win32') return 'unknown'
    try {
      const { stdout } = await execFileAsync('/bin/systemctl', ['is-active', this.config.mcSystemdUnit], {
        timeout: 1500,
      })
      const value = stdout.trim()
      if (value === 'active' || value === 'inactive') return value
      return 'unknown'
    } catch (error) {
      const output = (error as { stdout?: string }).stdout?.trim()
      if (output === 'inactive' || output === 'failed') return 'inactive'
      return 'unknown'
    }
  }

  private async rcon(command: string): Promise<string> {
    try {
      return await rconCommand(
        {
          host: this.config.rconHost,
          port: this.config.rconPort,
          password: this.config.rconPassword,
          timeoutMs: 4000,
        },
        command,
      )
    } catch (error) {
      if (error instanceof RconError) throw error
      throw new RconError(error instanceof Error ? error.message : 'RCON 未知错误')
    }
  }

  status(force = false): Promise<McStatus> {
    if (!force && this.cache && Date.now() - this.cache.at < 10_000) return Promise.resolve(this.cache.status)
    if (this.pending) return this.pending
    this.pending = this.collectStatus()
      .then((status) => {
        this.cache = { at: Date.now(), status }
        return status
      })
      .finally(() => {
        this.pending = null
      })
    return this.pending
  }

  private async collectStatus(): Promise<McStatus> {
    const serviceActive = await this.serviceActive()
    let slpError: string | null = null
    let slp = null as Awaited<ReturnType<typeof pingStatus>> | null
    try {
      slp = await pingStatus(this.config.mcHost, this.config.mcPort)
    } catch (error) {
      slpError = error instanceof Error ? error.message : '服务器未响应'
    }

    let list: { online: number; max: number; names: string[] } | null = null
    let tps: McTps | null = null
    let whitelist: string[] | null = null
    let rconError: string | null = null
    try {
      const listText = await this.rcon('list')
      list = parseListResponse(listText)
      try {
        tps = parseTpsResponse(await this.rcon('tps'))
      } catch {
        tps = null
      }
      try {
        whitelist = parseWhitelistResponse(await this.rcon('whitelist list'))
      } catch {
        whitelist = null
      }
    } catch (error) {
      rconError = error instanceof Error ? error.message : 'RCON 不可用'
    }

    const online = slp !== null
    const names = list?.names.length ? list.names : (slp?.samplePlayers ?? [])
    const error = [slpError, rconError].filter((value): value is string => Boolean(value)).join('；') || null
    return {
      online,
      version: slp?.version ?? '',
      motd: slp?.motd ?? '',
      players: {
        online: list?.online ?? slp?.playersOnline ?? 0,
        max: list?.max ?? slp?.playersMax ?? 0,
        names,
      },
      tps,
      whitelistCount: whitelist ? whitelist.length : null,
      serviceActive,
      publicAddress: this.config.mcPublicAddress,
      checkedAt: nowIso(),
      error,
    }
  }

  async whitelist(): Promise<WhitelistSnapshot> {
    try {
      const names = parseWhitelistResponse(await this.rcon('whitelist list')).sort((a, b) => a.localeCompare(b))
      return { names, checkedAt: nowIso(), error: null }
    } catch (error) {
      throw rconUnavailable(error instanceof Error ? `RCON 不可用：${error.message}` : 'RCON 不可用')
    }
  }

  async addWhitelist(actor: Actor, rawName: string): Promise<WhitelistSnapshot> {
    const name = validatePlayerName(rawName)
    const before = await this.whitelist()
    if (before.names.some((existing) => existing.toLowerCase() === name.toLowerCase())) {
      throw conflict(`${name} 已在白名单中`, 'already_whitelisted')
    }
    await this.runWhitelistCommand(`whitelist add ${name}`)
    const after = await this.whitelist()
    if (!after.names.some((existing) => existing.toLowerCase() === name.toLowerCase())) {
      throw rconUnavailable('白名单命令未生效，请检查服务器日志')
    }
    audit(this.db, actor.username, 'whitelist_add', name, null, actor.ip)
    this.cache = null
    return after
  }

  async removeWhitelist(actor: Actor, rawName: string): Promise<WhitelistSnapshot> {
    const name = validatePlayerName(rawName)
    const before = await this.whitelist()
    const existing = before.names.find((item) => item.toLowerCase() === name.toLowerCase())
    if (!existing) throw notFound(`${name} 不在白名单中`, 'not_whitelisted')
    await this.runWhitelistCommand(`whitelist remove ${existing}`)
    const after = await this.whitelist()
    if (after.names.some((item) => item.toLowerCase() === name.toLowerCase())) {
      throw rconUnavailable('白名单移除未生效，请检查服务器日志')
    }
    audit(this.db, actor.username, 'whitelist_remove', existing, null, actor.ip)
    this.cache = null
    return after
  }

  private async runWhitelistCommand(command: string): Promise<void> {
    try {
      await this.rcon(command)
    } catch (error) {
      throw rconUnavailable(error instanceof Error ? `RCON 不可用：${error.message}` : 'RCON 不可用')
    }
  }
}
