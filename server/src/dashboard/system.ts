/** 主机指标：/proc、/sys、statfs 与 systemctl；只读且带缓存。 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { statfsSync } from 'node:fs'
import os from 'node:os'
import { promisify } from 'node:util'
import type { Config } from '../config.ts'

const execFileAsync = promisify(execFile)

export interface DiskUsage {
  totalBytes: number
  usedBytes: number
  freeBytes: number
}

export interface HostMetrics {
  hostname: string
  uptimeSec: number
  load: [number, number, number]
  cpuPercent: number
  mem: { totalBytes: number; usedBytes: number; availableBytes: number }
  tempC: number | null
  root: DiskUsage
}

function diskUsage(path: string): DiskUsage {
  try {
    const stats = statfsSync(path)
    const blockSize = Number(stats.bsize)
    const total = Number(stats.blocks) * blockSize
    const free = Number(stats.bavail) * blockSize
    return { totalBytes: total, usedBytes: total - free, freeBytes: free }
  } catch {
    return { totalBytes: 0, usedBytes: 0, freeBytes: 0 }
  }
}

interface CpuSample {
  total: number
  idle: number
}

function readLinuxCpu(): CpuSample | null {
  try {
    const stat = readFileSync('/proc/stat', 'utf8')
    const first = stat.split('\n')[0]
    if (!first?.startsWith('cpu ')) return null
    const parts = first.trim().split(/\s+/).slice(1).map(Number)
    const total = parts.reduce((sum, value) => sum + value, 0)
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0)
    return { total, idle }
  } catch {
    return null
  }
}

function readWindowsCpu(): CpuSample {
  let total = 0
  let idle = 0
  for (const cpu of os.cpus()) {
    for (const value of Object.values(cpu.times)) total += value
    idle += cpu.times.idle
  }
  return { total, idle }
}

export class HostMonitor {
  private readonly config: Config
  private lastCpu: CpuSample | null = null
  private lastCpuAt = 0

  constructor(config: Config) {
    this.config = config
  }

  private cpuPercent(): number {
    const sample = process.platform === 'linux' ? readLinuxCpu() : readWindowsCpu()
    if (!sample) return 0
    const now = Date.now()
    if (!this.lastCpu || now - this.lastCpuAt < 200) {
      this.lastCpu = sample
      this.lastCpuAt = now
      return 0
    }
    const totalDelta = sample.total - this.lastCpu.total
    const idleDelta = sample.idle - this.lastCpu.idle
    this.lastCpu = sample
    this.lastCpuAt = now
    if (totalDelta <= 0) return 0
    return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1000) / 10))
  }

  private temperature(): number | null {
    if (process.platform !== 'linux') return null
    try {
      const raw = readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim()
      const value = Number(raw)
      if (!Number.isFinite(value)) return null
      return Math.round((value / 1000) * 10) / 10
    } catch {
      return null
    }
  }

  snapshot(): HostMetrics {
    const total = os.totalmem()
    const free = os.freemem()
    const load = os.loadavg()
    return {
      hostname: os.hostname(),
      uptimeSec: Math.floor(os.uptime()),
      load: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
      cpuPercent: this.cpuPercent(),
      mem: { totalBytes: total, usedBytes: total - free, availableBytes: free },
      tempC: this.temperature(),
      root: diskUsage(this.config.dataDir),
    }
  }
}

type ServiceState = 'active' | 'inactive' | 'unknown'

export class ServiceMonitor {
  private readonly cache = new Map<string, { at: number; state: ServiceState }>()
  private readonly units: Record<string, string>

  constructor(units: Record<string, string>) {
    this.units = units
  }

  async state(name: string): Promise<ServiceState> {
    const unit = this.units[name] ?? name
    const cached = this.cache.get(name)
    if (cached && Date.now() - cached.at < 5000) return cached.state
    let state: ServiceState = 'unknown'
    if (process.platform !== 'win32') {
      try {
        const { stdout } = await execFileAsync('/bin/systemctl', ['is-active', unit], { timeout: 1500 })
        const value = stdout.trim()
        if (value === 'active' || value === 'inactive') state = value
      } catch (error) {
        const stdout = (error as { stdout?: string }).stdout?.trim()
        if (stdout === 'inactive' || stdout === 'failed') state = 'inactive'
      }
    }
    this.cache.set(name, { at: Date.now(), state })
    return state
  }

  async snapshot(): Promise<Record<string, ServiceState>> {
    const entries = await Promise.all(Object.keys(this.units).map(async (name) => [name, await this.state(name)] as const))
    return Object.fromEntries(entries)
  }
}
