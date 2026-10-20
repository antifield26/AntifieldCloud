#!/usr/bin/env node
/**
 * Minecraft 世界一致性备份（以 root 运行，由 antifieldcloud-world.timer 调用）。
 *
 * 职责：
 * - 读取 /etc/antifieldcloud/env（可选）、进程环境变量与 server.properties 获得 RCON 与路径配置；
 * - RCON 执行 save-off → save-all flush（等待确认，超时重试一次）→ tar 打包 → finally 必发 save-on；
 * - 归档先写 .part，tar 退出码 0/1 都接受（GNU tar 遇到读取期间文件变化返回 1），随后做 gzip 完整性校验，
 *   校验通过才原子 rename 为 world-<UTC>.tar.gz；0640，属主 antifieldcloud:antifield；
 * - 同时写 .sha256 旁文件与 /var/lib/antifieldcloud/world-backup-status.json（0644，原子 rename）；
 * - 保留最新 4 份 world-<UTC>.tar.gz 及其 .sha256，只删除匹配命名的文件（不碰旧 legacy 归档）。
 *
 * 安全边界：
 * - save-off 期间服务器可能丢数据，因此 save-on 放在 finally，连接断开也会重连后重试；
 * - 状态 JSON 的 error/warnings 使用 ASCII 错误码 + 英文说明，避免 PowerShell 5.1 以 GBK 解码导致 JSON 解析失败；
 * - 状态文件原子写入（同目录临时文件 + rename），写失败会在 stdout/stderr 可见，绝不静默；
 * - 不修改世界目录内容（只读 tar），不删除非本脚本命名的文件，不连接除配置 RCON 之外的服务。
 *
 * 用法：`node scripts/backup-world.mjs`（无参数；`--help` 输出 JSON 说明）。
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { Socket } from 'node:net'
import { Buffer } from 'node:buffer'
import { clearTimeout, setTimeout as startTimer } from 'node:timers'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createGunzip } from 'node:zlib'

const execFileAsync = promisify(execFile)
const GIB = 1024 * 1024 * 1024
/** 归档保留数量：最新 4 份（含本次）。 */
const DEFAULT_KEEP = 4
/** RCON 连接超时。 */
const RCON_CONNECT_TIMEOUT_MS = 10_000
/** save-off / save-on 单次等待上限。 */
const SAVE_TOGGLE_TIMEOUT_MS = 30_000
/** save-all flush 等待上限；首次超时后重试一次。 */
const SAVE_FLUSH_TIMEOUT_MS = 180_000
/** 重试前的等待时间。 */
const RETRY_DELAY_MS = 1_000
/** RCON 响应包最大长度，超过视为协议异常。 */
const RCON_MAX_PACKET_BYTES = 1024 * 1024
/** RCON 协议包类型（响应包类型 0 无需常量）。 */
const RCON_TYPE_COMMAND = 2
const RCON_TYPE_AUTH = 3
/** 归档文件名格式：world-<YYYYMMDDTHHMMSSZ>.tar.gz；旧 legacy 的 world-YYYYMMDD.tar.gz 不匹配。 */
const ARCHIVE_NAME_PATTERN = /^world-(\d{8}T\d{6}Z)\.tar\.gz$/
/** 状态文件默认路径。 */
const DEFAULT_STATUS_FILE = '/var/lib/antifieldcloud/world-backup-status.json'
/** 备份目录默认路径。 */
const DEFAULT_BACKUP_DIR = '/var/lib/antifieldcloud/world-backups'
/** 世界目录默认父路径。 */
const DEFAULT_MC_SERVER_DIR = '/home/antifield/minecraft-server'
/** 归档/旁文件默认属主；组 antifield 是 PC 用户 scp 读取的前提。 */
const DEFAULT_OWNER = 'antifieldcloud:antifield'

/** 本脚本可识别的配置键；/etc/antifieldcloud/env 中其它应用配置会被忽略。 */
const CONFIG_KEYS = new Set([
  'RCON_HOST',
  'RCON_PORT',
  'RCON_PASSWORD',
  'MC_SERVER_DIR',
  'WORLD_BACKUP_DIR',
  'WORLD_BACKUP_STATUS_FILE',
  'WORLD_BACKUP_KEEP',
  'WORLD_BACKUP_OWNER',
  'TAR_BIN',
])

/** 带 ASCII 错误码的异常：状态 JSON 只暴露 code + 英文 message，便于跨语言解析。 */
export class BackupError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'BackupError'
    this.code = code
  }
}

/** 统一错误文案（不输出敏感配置）。 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 抛带错误码的异常。 */
function fail(code, message, cause) {
  throw new BackupError(code, message, cause ? { cause } : undefined)
}

/** UTC 紧凑时间戳：2026-10-25T04:00:00.000Z → 20261025T040000Z。 */
export function formatStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/**
 * 解析 env 风格文件（KEY=VALUE，忽略注释/空行，允许成对引号）。
 * 只返回可识别键，避免把应用密钥带入本进程的输出。
 */
export function parseEnvFile(text) {
  const result = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    if (!CONFIG_KEYS.has(key)) continue
    let value = line.slice(separator + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

/** 解析 server.properties：只读取本脚本需要的键，忽略注释与非法行。 */
export function parseServerProperties(text) {
  const result = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  return result
}

/** 递归统计目录字节数：跳过符号链接，避免环与逃逸读取。 */
export function directoryBytes(path) {
  let total = 0
  const stack = [path]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch (error) {
      fail('world_read_failed', `failed to read directory ${current}: ${errorMessage(error)}`, error)
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        try {
          total += statSync(full).size
        } catch (error) {
          fail('world_read_failed', `failed to stat file ${full}: ${errorMessage(error)}`, error)
        }
      }
    }
  }
  return total
}

/** 可用磁盘空间（字节）；statfs 不可用时返回 0，由调用方按“余量不足”处理。 */
function freeBytes(path) {
  try {
    const stats = statfsSync(path)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return 0
  }
}

/** 解析保留数量：必须是 ≥1 的整数，否则报错而不是静默使用默认值。 */
function parseKeep(raw) {
  const value = Number.parseInt(String(raw ?? DEFAULT_KEEP), 10)
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('keep_invalid', `WORLD_BACKUP_KEEP must be an integer >= 1, got: ${raw}`)
  }
  return value
}

/**
 * 从 env 文件 + 进程环境 + server.properties 组装配置。
 * 优先级：环境变量 > /etc/antifieldcloud/env > server.properties > 默认值。
 */
export function loadConfig(options = {}) {
  const envFile = options.envFile ?? '/etc/antifieldcloud/env'
  let envFromFile = {}
  if (existsSync(envFile)) {
    try {
      envFromFile = parseEnvFile(readFileSync(envFile, 'utf8'))
    } catch (error) {
      fail('env_file_unreadable', `failed to read ${envFile}: ${errorMessage(error)}`, error)
    }
  }
  const processEnv = options.env ?? process.env
  const env = { ...envFromFile }
  for (const key of CONFIG_KEYS) {
    if (processEnv[key] !== undefined && processEnv[key] !== '') env[key] = processEnv[key]
  }

  const mcServerDir = env.MC_SERVER_DIR ?? DEFAULT_MC_SERVER_DIR
  const propertiesPath = join(mcServerDir, 'server.properties')
  let properties = {}
  if (existsSync(propertiesPath)) {
    try {
      properties = parseServerProperties(readFileSync(propertiesPath, 'utf8'))
    } catch (error) {
      fail('server_properties_unreadable', `failed to read ${propertiesPath}: ${errorMessage(error)}`, error)
    }
  }
  if (properties['enable-rcon'] === 'false') {
    fail('rcon_disabled', `enable-rcon=false in ${propertiesPath}`)
  }

  const rconPassword = env.RCON_PASSWORD ?? properties['rcon.password']
  if (!rconPassword) {
    fail('rcon_password_missing', 'RCON password not configured (RCON_PASSWORD in /etc/antifieldcloud/env or rcon.password in server.properties)')
  }
  const rconPortRaw = env.RCON_PORT ?? properties['rcon.port'] ?? '25575'
  const rconPort = Number.parseInt(rconPortRaw, 10)
  if (!Number.isSafeInteger(rconPort) || rconPort < 1 || rconPort > 65535) {
    fail('rcon_port_invalid', `RCON_PORT is invalid: ${rconPortRaw}`)
  }
  const levelName = properties['level-name'] ?? 'world'
  if (!/^[A-Za-z0-9._-]+$/.test(levelName)) {
    fail('level_name_invalid', `level-name contains unsupported characters: ${levelName}`)
  }

  const owner = env.WORLD_BACKUP_OWNER ?? DEFAULT_OWNER
  if (!/^[^:\s]+:[^:\s]+$/.test(owner)) {
    fail('owner_invalid', `WORLD_BACKUP_OWNER must be user:group, got: ${owner}`)
  }

  return {
    rconHost: env.RCON_HOST ?? '127.0.0.1',
    rconPort,
    rconPassword,
    mcServerDir,
    levelName,
    backupDir: env.WORLD_BACKUP_DIR ?? DEFAULT_BACKUP_DIR,
    statusFile: env.WORLD_BACKUP_STATUS_FILE ?? DEFAULT_STATUS_FILE,
    keep: parseKeep(env.WORLD_BACKUP_KEEP),
    owner,
    ownerUser: owner.slice(0, owner.indexOf(':')),
    ownerGroup: owner.slice(owner.indexOf(':') + 1),
    tarBin: env.TAR_BIN ?? 'tar',
    propertiesPath,
  }
}

/** 判断进程是否以 root 运行；Windows 上没有 uid 概念，仅测试路径会跳过此检查。 */
function isRoot() {
  return typeof process.getuid !== 'function' || process.getuid() === 0
}

// ---------------------------------------------------------------------------
// RCON 客户端
// ---------------------------------------------------------------------------

/** 构造 RCON 协议包：长度(4) + 请求 id(4) + 类型(4) + 正文 + 两个结束 NUL。 */
function encodeRconPacket(id, type, body) {
  const bodyBuffer = Buffer.from(body, 'utf8')
  const size = 4 + 4 + bodyBuffer.length + 2
  const packet = Buffer.alloc(4 + size)
  packet.writeInt32LE(size, 0)
  packet.writeInt32LE(id, 4)
  packet.writeInt32LE(type, 8)
  bodyBuffer.copy(packet, 12)
  return packet
}

/** 去掉 Minecraft 的 § 颜色码，便于匹配“保存完成”等提示。 */
export function stripColorCodes(text) {
  return text.replace(/§./g, '')
}

/** 最小 RCON 客户端：顺序请求、每次请求独立超时，认证失败抛错。 */
export class RconClient {
  constructor({ host, port, password, connectTimeoutMs = RCON_CONNECT_TIMEOUT_MS }) {
    this.host = host
    this.port = port
    this.password = password
    this.connectTimeoutMs = connectTimeoutMs
    this.socket = null
    this.connected = false
    this.authenticated = false
    this.buffer = Buffer.alloc(0)
    this.nextId = 1
    this.active = null
  }

  /** 建立 TCP 连接；失败/超时统一抛可诊断错误。 */
  connect() {
    if (this.connected) return Promise.resolve()
    return new Promise((resolvePromise, rejectPromise) => {
      const socket = new Socket()
      this.socket = socket
      const timer = startTimer(() => {
        socket.destroy()
        rejectPromise(new BackupError('rcon_connect_failed', `RCON connect timed out (${this.host}:${this.port}, ${this.connectTimeoutMs}ms)`))
      }, this.connectTimeoutMs)
      const failConnect = (error) => {
        clearTimeout(timer)
        socket.destroy()
        rejectPromise(new BackupError('rcon_connect_failed', `RCON connect failed (${this.host}:${this.port}): ${errorMessage(error)}`, error))
      }
      socket.once('error', failConnect)
      socket.once('connect', () => {
        clearTimeout(timer)
        socket.removeListener('error', failConnect)
        socket.on('error', (error) => this.#failActive(error))
        socket.on('data', (chunk) => this.#onData(chunk))
        socket.on('close', () => this.#failActive(new Error('RCON connection closed')))
        this.connected = true
        resolvePromise()
      })
      socket.connect(this.port, this.host)
    })
  }

  /** 认证：成功返回，失败抛错（绝不回显密码）。 */
  async authenticate() {
    if (this.authenticated) return
    const packet = await this.#request(RCON_TYPE_AUTH, this.password, {
      code: 'rcon_auth_failed',
      label: `RCON auth (${this.host}:${this.port})`,
      timeoutMs: this.connectTimeoutMs,
      accept: (candidate, requestId) =>
        candidate.type === RCON_TYPE_COMMAND && (candidate.id === requestId || candidate.id === -1),
    })
    if (packet.id === -1) {
      throw new BackupError('rcon_auth_failed', `RCON authentication failed (wrong password): ${this.host}:${this.port}`)
    }
    this.authenticated = true
  }

  /** 执行命令并返回剥离颜色码后的响应正文。 */
  async exec(command, { timeoutMs = SAVE_TOGGLE_TIMEOUT_MS, label = command } = {}) {
    if (!this.connected) throw new BackupError('rcon_not_connected', `RCON not connected, cannot run: ${label}`)
    const packet = await this.#request(RCON_TYPE_COMMAND, command, {
      code: 'rcon_command_failed',
      label,
      timeoutMs,
      accept: (candidate, requestId) => candidate.id === requestId,
    })
    return stripColorCodes(packet.body).trim()
  }

  /** 主动关闭连接；不抛错。 */
  close() {
    this.authenticated = false
    this.connected = false
    this.#failActive(new Error('RCON connection closed'))
    if (this.socket) {
      try {
        this.socket.destroy()
      } catch {
        // 关闭失败无需处理。
      }
      this.socket = null
    }
  }

  #onData(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 4) {
      const size = this.buffer.readInt32LE(0)
      if (size < 10 || size > RCON_MAX_PACKET_BYTES) {
        this.#failActive(new Error(`invalid RCON response length: ${size}`))
        this.buffer = Buffer.alloc(0)
        return
      }
      if (this.buffer.length < 4 + size) return
      const packetBuffer = this.buffer.subarray(4, 4 + size)
      this.buffer = this.buffer.subarray(4 + size)
      if (packetBuffer.length < 10) {
        this.#failActive(new Error('truncated RCON response packet'))
        return
      }
      const id = packetBuffer.readInt32LE(0)
      const type = packetBuffer.readInt32LE(4)
      // 正文末尾两个 NUL 属于协议结束符，不属于内容。
      const body = packetBuffer.subarray(8, packetBuffer.length - 2).toString('utf8')
      this.#dispatch({ id, type, body })
    }
  }

  #dispatch(packet) {
    const active = this.active
    if (!active) return
    if (!active.accept(packet, active.id)) return
    clearTimeout(active.timer)
    this.active = null
    active.resolve(packet)
  }

  #request(type, body, { code, label, timeoutMs, accept }) {
    if (this.active) {
      return Promise.reject(new BackupError(code, `RCON request already in progress: ${label}`))
    }
    const id = this.nextId
    this.nextId = this.nextId >= 0x7fffffff ? 1 : this.nextId + 1
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = startTimer(() => {
        this.active = null
        rejectPromise(new BackupError(code, `RCON command timed out (${label}, ${timeoutMs}ms)`))
      }, timeoutMs)
      this.active = { id, accept, resolve: resolvePromise, reject: rejectPromise, timer, code, label }
      try {
        this.socket.write(encodeRconPacket(id, type, body))
      } catch (error) {
        clearTimeout(timer)
        this.active = null
        rejectPromise(new BackupError(code, `RCON send failed (${label}): ${errorMessage(error)}`, error))
      }
    })
  }

  #failActive(error) {
    const active = this.active
    if (!active) return
    clearTimeout(active.timer)
    this.active = null
    active.reject(new BackupError(active.code, `${active.label}: ${errorMessage(error)}`, error))
  }
}

/** 顺序重试：attempts 次，全部失败时抛出最后一次错误说明。 */
async function withRetry(operation, label, attempts) {
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error
      if (attempt < attempts) await sleep(RETRY_DELAY_MS)
    }
  }
  const code = lastError instanceof BackupError ? lastError.code : 'command_failed'
  throw new BackupError(code, `${label} failed after ${attempts} attempts: ${errorMessage(lastError)}`, lastError)
}

/**
 * save-all flush 的响应判定：
 * 服务器中文/英文提示都接受，但明确失败/未知命令要作为错误抛出。
 */
function assertSaveFlushResponse(response) {
  if (!response) {
    fail('save_all_flush_failed', 'save-all flush returned no confirmation')
  }
  if (/unknown|error|exception|failed|失败|未知/i.test(response)) {
    fail('save_all_flush_failed', `save-all flush returned failure text: ${response.slice(0, 200)}`)
  }
  return response
}

// ---------------------------------------------------------------------------
// 归档与状态辅助
// ---------------------------------------------------------------------------

/** 流式计算文件 SHA-256（不整文件读入内存）。 */
export function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', (error) =>
      rejectPromise(new BackupError('sha256_failed', `failed to read ${path} for SHA-256: ${errorMessage(error)}`, error)),
    )
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

/**
 * gzip 完整性校验（等价于 `gzip -t`，使用 Node 内置 zlib：会校验 CRC32 与解压长度）。
 * 返回解压后字节数；失败抛 gzip_check_failed，保证 .part 不会被改名成正式归档。
 */
export function verifyGzipIntegrity(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const gunzip = createGunzip()
    const stream = createReadStream(path)
    let unpacked = 0
    gunzip.on('data', (chunk) => {
      unpacked += chunk.length
    })
    gunzip.on('end', () => resolvePromise(unpacked))
    gunzip.on('error', (error) =>
      rejectPromise(new BackupError('gzip_check_failed', `gzip integrity check failed for ${basename(path)}: ${errorMessage(error)}`, error)),
    )
    stream.on('error', (error) => gunzip.destroy(error))
    stream.pipe(gunzip)
  })
}

/** 写 .sha256 旁文件：`<sha>  <name>\n`（与 sha256sum 兼容）。 */
function writeSidecar(archivePath, sha256) {
  writeFileSync(`${archivePath}.sha256`, `${sha256}  ${basename(archivePath)}\n`, { mode: 0o640 })
  chmodSync(`${archivePath}.sha256`, 0o640)
}

/** 原子写状态 JSON：同目录临时文件 + rename；失败清理临时文件，避免累积 .tmp。 */
function writeStatusFile(statusFile, status) {
  const directory = dirname(statusFile)
  mkdirSync(directory, { recursive: true })
  const tempPath = join(directory, `.${basename(statusFile)}.tmp-${process.pid}`)
  try {
    writeFileSync(tempPath, `${JSON.stringify(status)}\n`, { mode: 0o644 })
    chmodSync(tempPath, 0o644)
    renameSync(tempPath, statusFile)
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath)
    } catch {
      // 清理失败不影响原始错误。
    }
    throw new BackupError('status_write_failed', `failed to write status file ${statusFile}: ${errorMessage(error)}`, error)
  }
}

/** 列出目录中匹配 world-<UTC>.tar.gz 的归档，按 UTC 时间戳倒序（最新在前）。 */
export function listWorldArchives(backupDir) {
  const archives = []
  for (const name of readdirSync(backupDir)) {
    const match = ARCHIVE_NAME_PATTERN.exec(name)
    if (match) archives.push({ name, stamp: match[1] })
  }
  archives.sort((left, right) => right.stamp.localeCompare(left.stamp))
  return archives
}

/**
 * 保留最新 keep 份归档及其 .sha256，删除更旧的同名归档/旁文件。
 * 只删除与命名表达式完全匹配的文件（旧 legacy `world-YYYYMMDD.tar.gz` 不匹配，不会被删）。
 */
export function pruneArchives(backupDir, keep, logger = () => {}) {
  const archives = listWorldArchives(backupDir)
  const removed = []
  for (const archive of archives.slice(keep)) {
    const archivePath = join(backupDir, archive.name)
    const sidecarPath = `${archivePath}.sha256`
    for (const path of [archivePath, sidecarPath]) {
      if (!existsSync(path)) continue
      try {
        unlinkSync(path)
        removed.push(path)
      } catch (error) {
        fail('prune_failed', `failed to remove old archive ${path}: ${errorMessage(error)}`, error)
      }
    }
    logger(`已清理旧世界归档：${archive.name}`)
  }
  return { kept: archives.slice(0, keep).map((archive) => archive.name), removed }
}

/** 清理崩溃遗留的 .part 文件：仅删除超过 6 小时且匹配世界归档命名的文件。 */
function cleanStaleParts(backupDir, warnings, logger = () => {}) {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000
  for (const name of readdirSync(backupDir)) {
    if (!/^world-\d{8}T\d{6}Z\.tar\.gz\.part$/.test(name)) continue
    const path = join(backupDir, name)
    try {
      if (statSync(path).mtimeMs < cutoff) {
        unlinkSync(path)
        logger(`已清理陈旧半成品：${name}`)
      }
    } catch (error) {
      // 删除失败必须可诊断，不能静默：记入 warnings（状态 JSON 可见）。
      if (!warnings.includes('stale_part_cleanup_failed')) warnings.push('stale_part_cleanup_failed')
      logger(`警告：清理陈旧半成品失败（${name}）：${errorMessage(error)}`)
    }
  }
}

/** 目录必须为 antifieldcloud:antifield 0770，PC 用户 antifield（同组）才能 scp 读取组内文件。
 *  不使用 setgid：脚本已显式 chown 归档，且 systemd 的 RestrictSUIDSGID 会阻止设置 SGID 位。 */
async function prepareBackupDirectory(backupDir, config, { skipOwnership }) {
  mkdirSync(backupDir, { recursive: true, mode: 0o750 })
  if (skipOwnership) return
  try {
    await execFileAsync('chown', [`${config.ownerUser}:${config.ownerGroup}`, backupDir])
    chmodSync(backupDir, 0o770)
  } catch (error) {
    fail(
      'backup_dir_ownership_failed',
      `failed to set ${config.ownerUser}:${config.ownerGroup} 0770 on ${backupDir}: ${errorMessage(error)}`,
      error,
    )
  }
}

/** 给归档与旁文件设置权限/属主；非 root 且未跳过属主设置时报错。 */
async function applyOwnership(paths, config, { skipOwnership }) {
  for (const path of paths) chmodSync(path, 0o640)
  if (skipOwnership) return
  try {
    await execFileAsync('chown', [`${config.ownerUser}:${config.ownerGroup}`, ...paths])
  } catch (error) {
    fail('chown_failed', `chown ${config.ownerUser}:${config.ownerGroup} failed: ${errorMessage(error)}`, error)
  }
}

/**
 * 默认 tar 执行器：异步 spawn `tar -czf ... -C ... --exclude ... world`。
 * GNU tar 在“读取期间文件变化”时返回 1（归档仍可用），这里把 1 作为可容忍结果返回，
 * 由调用方做 gzip 完整性校验；其它非零退出码视为失败。
 */
async function runTar({ tarBin, args }) {
  try {
    await execFileAsync(tarBin, args, { maxBuffer: 8 * 1024 * 1024 })
    return { exitCode: 0 }
  } catch (error) {
    const exitCode = typeof error?.code === 'number' ? error.code : null
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    if (exitCode === 1) return { exitCode, stderrTail: stderr.slice(-500) }
    fail('tar_failed', `tar exited with ${exitCode === null ? 'unknown code' : `code ${exitCode}`}: ${stderr.slice(-500) || errorMessage(error)}`, error)
  }
}

/** 状态 JSON 会跨 PowerShell 5.1 解析：把非 ASCII 字符替换掉，避免中文/本地化 stderr 破坏 JSON 编码。 */
function sanitizeAscii(text) {
  return String(text).replace(/[^\x20-\x7e]/g, '?')
}

/** 记录一条错误：保留第一个错误作为 error/message，其余进入 errors 数组。 */
function recordError(result, code, message) {
  const safeMessage = sanitizeAscii(message)
  result.errors.push({ code, message: safeMessage })
  if (!result.error) {
    result.error = sanitizeAscii(code)
    result.message = safeMessage
  }
  result.ok = false
}

/**
 * 执行一次世界备份。返回结果对象（不抛错），并保证：
 * - 只要本次成功连接过 RCON，就一定会尝试 save-on（失败重试）；
 * - 无论成败都尝试写状态 JSON（写失败在 stdout/stderr 可见）；
 * - 归档成功后才写旁文件、清理旧归档与输出 kept。
 */
export async function runBackup(options = {}) {
  const now = options.now ?? new Date()
  const startedAtMs = Date.now()
  const result = {
    ok: false,
    startedAt: now.toISOString(),
    lastRunAt: null,
    archiveName: null,
    sizeBytes: 0,
    sha256: null,
    durationMs: 0,
    kept: [],
    error: null,
    message: null,
    errors: [],
    warnings: [],
    saveOffOk: false,
    saveOnOk: null,
    tarExitCode: null,
  }
  const logger = options.logger ?? (() => {})
  const skipOwnership = options.skipOwnership ?? false
  const allowNonRoot = options.allowNonRoot ?? false
  const tarRunner = options.tarRunner ?? runTar
  let config = null
  let rcon = null
  let saveOffAttempted = false
  let rconEverAuthenticated = false
  let archiveCommitted = false

  const saveOn = async () => {
    if (!rconEverAuthenticated && !saveOffAttempted) {
      result.saveOnOk = null
      result.saveOnSkipped = true
      return null
    }
    let lastError = null
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        if (!rcon || !rcon.authenticated || !rcon.connected) {
          try {
            rcon?.close()
          } catch {
            // 旧连接关闭失败不影响重建。
          }
          rcon = createRcon(config)
          await rcon.connect()
          await rcon.authenticate()
        }
        await rcon.exec('save-on', { timeoutMs: SAVE_TOGGLE_TIMEOUT_MS, label: 'save-on' })
        result.saveOnOk = true
        logger('已恢复服务器保存（save-on）')
        return null
      } catch (error) {
        lastError = error
        try {
          rcon?.close()
        } catch {
          // 忽略关闭失败。
        }
        rcon = null
        if (attempt < 3) await sleep(RETRY_DELAY_MS)
      }
    }
    result.saveOnOk = false
    const message = `save-on failed after 3 attempts; Minecraft may still be in save-off state, run "save-on" manually: ${errorMessage(lastError)}`
    logger(`错误：${message}`)
    return message
  }

  try {
    if (!allowNonRoot && !isRoot()) {
      fail('not_root', 'backup-world.mjs must run as root (systemd runs it as root; tests may pass allowNonRoot)')
    }
    config = options.config ?? loadConfig(options)
    result.config = {
      rconHost: config.rconHost,
      rconPort: config.rconPort,
      mcServerDir: config.mcServerDir,
      levelName: config.levelName,
      backupDir: config.backupDir,
      keep: config.keep,
    }

    // --- 预检（必须在 save-off 之前）：世界目录、备份目录可写、磁盘余量（世界体积 * 1.5）---
    const worldDir = join(config.mcServerDir, config.levelName)
    if (!existsSync(worldDir) || !statSync(worldDir).isDirectory()) {
      fail('world_dir_missing', `world directory does not exist: ${worldDir}`)
    }
    await prepareBackupDirectory(config.backupDir, config, { skipOwnership })
    const probePath = join(config.backupDir, `.write-probe-${process.pid}`)
    try {
      writeFileSync(probePath, 'probe')
      unlinkSync(probePath)
    } catch (error) {
      fail('backup_dir_unwritable', `backup directory is not writable: ${config.backupDir} (${errorMessage(error)})`, error)
    }
    const worldBytes = directoryBytes(worldDir)
    result.worldBytes = worldBytes
    const required = Math.ceil(worldBytes * 1.5)
    const available = freeBytes(config.backupDir)
    if (available < required) {
      fail(
        'disk_space_insufficient',
        `insufficient disk space: world ${(worldBytes / GIB).toFixed(2)} GiB, need >= ${(required / GIB).toFixed(2)} GiB (1.5x), available ${(available / GIB).toFixed(2)} GiB`,
      )
    }
    cleanStaleParts(config.backupDir, result.warnings, logger)

    // --- RCON：save-off → save-all flush（超时重试一次）---
    rcon = createRcon(config)
    await rcon.connect()
    await rcon.authenticate()
    rconEverAuthenticated = true
    saveOffAttempted = true
    await withRetry(
      async () => {
        const response = await rcon.exec('save-off', { timeoutMs: SAVE_TOGGLE_TIMEOUT_MS, label: 'save-off' })
        logger(`save-off 已确认：${response.slice(0, 200) || '(无输出)'}`)
      },
      'save-off',
      2,
    )
    result.saveOffOk = true
    await withRetry(
      async () => {
        const response = await rcon.exec('save-all flush', {
          timeoutMs: SAVE_FLUSH_TIMEOUT_MS,
          label: 'save-all flush',
        })
        assertSaveFlushResponse(response)
        logger(`save-all flush 已确认：${response.slice(0, 200) || '(无输出)'}`)
      },
      'save-all flush',
      2,
    )

    // --- tar 到 .part，gzip 完整性校验通过后才原子改名 ---
    const archiveName = `world-${formatStamp(now)}.tar.gz`
    const archivePath = join(config.backupDir, archiveName)
    if (existsSync(archivePath)) {
      fail('archive_exists', `archive already exists (concurrent run?): ${archivePath}`)
    }
    const partPath = `${archivePath}.part`
    if (existsSync(partPath)) {
      fail('part_exists', `partial archive already exists, inspect manually: ${partPath}`)
    }
    const tarArgs = [
      '-czf',
      partPath,
      '--exclude',
      'session.lock',
      '--exclude',
      `${config.levelName}/session.lock`,
      '-C',
      config.mcServerDir,
      config.levelName,
    ]
    try {
      logger(`开始打包世界：${worldDir}（${(worldBytes / GIB).toFixed(2)} GiB）`)
      let tarResult
      try {
        tarResult = await tarRunner({ tarBin: config.tarBin, args: tarArgs, cwd: config.mcServerDir })
      } catch (error) {
        if (error instanceof BackupError) throw error
        fail('tar_failed', `tar runner failed: ${errorMessage(error)}`, error)
      }
      result.tarExitCode = tarResult?.exitCode ?? 0
      if (result.tarExitCode !== 0) {
        // GNU tar 的 1 表示“读取期间文件变化”，归档可能仍完整：记为 warning，交由 gzip 校验判定。
        result.warnings.push('tar_exit_1_warn')
        logger(`警告：tar 退出码 ${result.tarExitCode}（file changed while reading），继续做 gzip 完整性校验`)
      }
      const unpackedBytes = await verifyGzipIntegrity(partPath)
      if (unpackedBytes <= 0) fail('gzip_check_failed', 'gzip integrity check produced 0 bytes')
      const sizeBytes = statSync(partPath).size
      if (sizeBytes <= 0) fail('archive_empty', 'archive file is empty, tar result is not trustworthy')
      const sha256 = await sha256File(partPath)
      renameSync(partPath, archivePath)
      archiveCommitted = true
      writeSidecar(archivePath, sha256)
      await applyOwnership([archivePath, `${archivePath}.sha256`], config, { skipOwnership })
      result.archiveName = archiveName
      result.sizeBytes = sizeBytes
      result.sha256 = sha256
      logger(`归档完成：${archiveName}（${sizeBytes} bytes，sha256=${sha256}）`)
    } catch (error) {
      // 失败时清理本次半成品（.part）；已提交的归档保留（不能因为后续步骤失败而删掉合法备份）。
      if (!archiveCommitted && existsSync(partPath)) {
        try {
          rmSync(partPath, { force: true })
        } catch (cleanupError) {
          if (!result.warnings.includes('part_cleanup_failed')) result.warnings.push('part_cleanup_failed')
          logger(`警告：删除半成品失败（${partPath}）：${errorMessage(cleanupError)}`)
        }
      }
      throw error
    }

    // --- 保留策略：只删除匹配命名的旧归档/旁文件 ---
    const prune = pruneArchives(config.backupDir, config.keep, logger)
    result.kept = prune.kept
    result.removed = prune.removed
    result.ok = result.errors.length === 0
  } catch (error) {
    if (error instanceof BackupError) {
      recordError(result, error.code, error.message)
    } else {
      recordError(result, 'unexpected_error', errorMessage(error))
    }
  } finally {
    const saveOnError = await saveOn()
    if (saveOnError) {
      // save-on 失败属于严重状态：即使归档成功也标记失败，避免“保存被关闭”无人发现。
      recordError(result, 'save_on_failed', saveOnError)
    }
    if (rcon) {
      try {
        rcon.close()
      } catch {
        // 忽略关闭失败。
      }
    }
    result.durationMs = Date.now() - startedAtMs
    result.lastRunAt = new Date().toISOString()
    const status = {
      lastRunAt: result.lastRunAt,
      startedAt: result.startedAt,
      ok: result.ok,
      archiveName: result.archiveName,
      sizeBytes: result.sizeBytes,
      sha256: result.sha256,
      durationMs: result.durationMs,
      kept: result.kept,
      keptCount: result.kept.length,
      error: result.error,
      message: result.message,
      errors: result.errors,
      warnings: result.warnings,
      saveOffOk: result.saveOffOk,
      saveOnOk: result.saveOnOk ?? null,
      tarExitCode: result.tarExitCode,
      world: config?.levelName ?? null,
      worldBytes: result.worldBytes ?? null,
      backupDir: config?.backupDir ?? null,
    }
    if (config) {
      try {
        writeStatusFile(config.statusFile, status)
      } catch (error) {
        const message = `failed to write status file ${config.statusFile}: ${errorMessage(error)}`
        recordError(result, 'status_write_failed', message)
        console.error(message)
      }
    }
  }
  // 最终 ok 与错误集合保持一致：有 errors 就一定不是成功。
  result.ok = result.ok === true && result.errors.length === 0
  return result
}

/** 构造 RCON 客户端。 */
function createRcon(config) {
  return new RconClient({
    host: config.rconHost,
    port: config.rconPort,
    password: config.rconPassword,
    connectTimeoutMs: RCON_CONNECT_TIMEOUT_MS,
  })
}

/** CLI 入口：输出单行 JSON，失败退出码 1。 */
async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log(
      JSON.stringify({
        ok: true,
        usage: 'node scripts/backup-world.mjs',
        env: [...CONFIG_KEYS],
        note: 'run as root by deploy/antifieldcloud-world.service; no positional arguments',
      }),
    )
    return
  }
  if (args.length > 0) {
    console.log(JSON.stringify({ ok: false, error: 'invalid_arguments', message: `unsupported arguments: ${args.join(' ')}` }))
    process.exitCode = 1
    return
  }
  let result
  try {
    result = await runBackup()
  } catch (error) {
    // runBackup 内部已兜底；这里只防御未预期异常，保证 stdout 仍是单行 JSON。
    result = { ok: false, error: 'unexpected_error', message: sanitizeAscii(errorMessage(error)) }
  }
  console.log(JSON.stringify(result))
  if (!result.ok) process.exitCode = 1
}

// 生产经 /opt/antifieldcloud/current 符号链接调用；import.meta.url 是真实路径，
// 入口判断必须同样 realpath，否则 main() 不执行会静默退出 0。
if (process.argv[1]) {
  let entryPath = process.argv[1]
  try {
    entryPath = realpathSync(entryPath)
  } catch {
    entryPath = resolve(entryPath)
  }
  if (import.meta.url === pathToFileURL(entryPath).href) main()
}
