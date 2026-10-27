/**
 * 备份归档（tar.gz）的安全读取：流式解析、只接受常规文件与目录。
 *
 * 安全边界：
 * - 拒绝绝对路径、`..`、反斜杠、控制字符、符号链接/硬链接/设备/FIFO 等条目。
 * - 解压与条目数量都有上限，防止压缩炸弹；extract 使用 `wx`（不覆盖）。
 * - 调用方决定允许的路径前缀（备份归档只允许 `backups/` 与 `files/`），本模块只做通用校验。
 *
 * 归档格式由 scripts/backup.mjs 生成：`backups/db-*.sqlite`、`backups/manifest-*.json`、`files/<xx>/<id>`。
 */
import { closeSync, createReadStream, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { dirname } from 'node:path'
import { AppError } from '../util/errors.ts'

export const DEFAULT_MAX_ENTRIES = 200_000
export const DEFAULT_MAX_ENTRY_BYTES = 4 * 1024 * 1024 * 1024
export const DEFAULT_MAX_UNPACKED_BYTES = 32 * 1024 * 1024 * 1024
export const DEFAULT_CAPTURE_BYTES = 8 * 1024 * 1024

export function invalidArchive(message: string, details?: Record<string, unknown>): AppError {
  return new AppError(422, 'invalid_archive', message, details)
}

export function unsafeArchive(message: string, details?: Record<string, unknown>): AppError {
  return new AppError(422, 'unsafe_archive', message, details)
}

export function archiveTooLarge(message: string): AppError {
  return new AppError(413, 'archive_too_large', message)
}

export interface TarEntryHeader {
  /** 归一化后的归档内相对路径（无前导 `./`，目录不带结尾 `/`）。 */
  path: string
  size: number
  type: 'file' | 'dir'
  mode: number
}

export type TarDecision =
  | { kind: 'skip' }
  /** 读取内容到内存（有上限），完成后放入 captures[key]。 */
  | { kind: 'capture'; key: string }
  /** 解压到指定绝对路径（不覆盖，自动建父目录）。 */
  | { kind: 'extract'; dest: string }

export interface TarScanOptions {
  maxEntries?: number
  maxEntryBytes?: number
  maxUnpackedBytes?: number
  captureMaxBytes?: number
}

export interface TarScanResult {
  entries: number
  unpackedBytes: number
  captures: Map<string, Buffer>
}

class ByteStream {
  private readonly stream: AsyncIterable<Buffer>
  private iterator: AsyncIterator<Buffer>
  private buffer: Buffer = Buffer.alloc(0)
  private offset = 0
  private unpacked = 0
  private readonly maxUnpacked: number
  ended = false

  constructor(stream: AsyncIterable<Buffer>, maxUnpacked: number) {
    this.stream = stream
    this.iterator = stream[Symbol.asyncIterator]()
    this.maxUnpacked = maxUnpacked
  }

  private async pull(): Promise<boolean> {
    const next = await this.iterator.next()
    if (next.done) {
      this.ended = true
      return false
    }
    const chunk = next.value
    this.unpacked += chunk.length
    if (this.unpacked > this.maxUnpacked) {
      throw archiveTooLarge('归档解压后体积超过上限')
    }
    this.buffer = this.buffer.length === this.offset ? chunk : Buffer.concat([this.buffer.subarray(this.offset), chunk])
    this.offset = 0
    return true
  }

  private available(): number {
    return this.buffer.length - this.offset
  }

  async ensure(min: number): Promise<void> {
    while (this.available() < min) {
      if (!(await this.pull())) {
        throw invalidArchive('归档被截断', { wanted: min, available: this.available() })
      }
    }
  }

  async readExact(length: number): Promise<Buffer> {
    await this.ensure(length)
    const out = this.buffer.subarray(this.offset, this.offset + length)
    this.offset += length
    return Buffer.from(out)
  }

  async skip(length: number): Promise<void> {
    let remaining = length
    while (remaining > 0) {
      if (this.available() === 0 && !(await this.pull())) {
        throw invalidArchive('归档被截断', { remaining })
      }
      const take = Math.min(remaining, this.available())
      this.offset += take
      remaining -= take
    }
  }

  async writeToFd(length: number, fd: number): Promise<void> {
    let remaining = length
    while (remaining > 0) {
      if (this.available() === 0 && !(await this.pull())) {
        throw invalidArchive('归档被截断', { remaining })
      }
      const take = Math.min(remaining, this.available())
      const chunk = this.buffer.subarray(this.offset, this.offset + take)
      writeSync(fd, chunk)
      this.offset += take
      remaining -= take
    }
  }

  async close(): Promise<void> {
    try {
      await this.iterator.return?.()
    } catch {
      // 关闭阶段的错误不影响已完成的校验结果。
    }
  }
}

function parseOctal(field: Buffer): number {
  const first = field[0] ?? 0
  if (first & 0x80) {
    // GNU base-256 扩展；只解析非负值。
    if (first === 0xff) throw unsafeArchive('tar 头部含负数大小')
    let value = first & 0x7f
    let overflow = false
    for (let index = 1; index < field.length; index += 1) {
      const next = value * 256 + (field[index] ?? 0)
      if (!Number.isSafeInteger(next)) {
        overflow = true
        break
      }
      value = next
    }
    if (overflow) throw archiveTooLarge('tar 条目过大')
    return value
  }
  const text = field.toString('ascii').replace(/[\0 ]+$/g, '').trim()
  if (!text) return 0
  if (!/^[0-7]+$/.test(text)) throw invalidArchive('tar 头部大小字段非法')
  const value = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(value) || value < 0) throw invalidArchive('tar 头部大小字段非法')
  return value
}

function parseString(field: Buffer): string {
  const end = field.indexOf(0)
  const raw = end >= 0 ? field.subarray(0, end) : field
  return raw.toString('utf8')
}

function parseChecksum(field: Buffer): number {
  const text = field.toString('ascii').replace(/[\0 ]+/g, ' ').trim()
  if (!/^[0-7]+$/.test(text)) throw invalidArchive('tar 头部校验和非法')
  return Number.parseInt(text, 8)
}

function headerChecksum(header: Buffer): number {
  let sum = 0
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : (header[index] ?? 0)
  }
  return sum
}

/** 归一化并校验归档内路径；返回去掉 `./` 的 posix 相对路径。 */
export function normalizeArchivePath(raw: string): string {
  if (!raw || raw.includes('\0')) throw unsafeArchive('归档路径含非法字符')
  if (raw.includes('\\')) throw unsafeArchive('归档路径含反斜杠')
  let path = raw.replace(/^\.\//, '')
  while (path.startsWith('./')) path = path.slice(2)
  // 目录条目通常以 `/` 结尾；归一化时去掉结尾斜杠。
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  if (path.startsWith('/')) throw unsafeArchive('归档路径不能是绝对路径', { path })
  if (path.length > 1024) throw unsafeArchive('归档路径过长')
  const segments = path.split('/')
  for (const segment of segments) {
    if (segment === '..') throw unsafeArchive('归档路径不能包含 ..', { path })
    if (segment === '' || segment === '.') throw unsafeArchive('归档路径不合法', { path })
  }
  return segments.join('/')
}

function parseHeader(header: Buffer): { path: string; size: number; type: 'file' | 'dir'; mode: number } {
  const expected = parseChecksum(header.subarray(148, 156))
  if (headerChecksum(header) !== expected) throw invalidArchive('tar 头部校验和不匹配')
  const baseName = parseString(header.subarray(0, 100))
  const prefix = parseString(header.subarray(345, 500))
  const rawPath = prefix ? `${prefix}/${baseName}` : baseName
  const typeflag = header[156]
  const size = parseOctal(header.subarray(124, 136))
  const modeField = header.subarray(100, 108).toString('ascii').replace(/[\0 ]+$/g, '').trim()
  const mode = /^[0-7]+$/.test(modeField) ? Number.parseInt(modeField, 8) : 0o644
  if (typeflag === 0 || typeflag === 0x30) {
    if (size < 0) throw invalidArchive('tar 条目大小为负')
    return { path: normalizeArchivePath(rawPath), size, type: 'file', mode }
  }
  if (typeflag === 0x35) {
    if (size !== 0) throw unsafeArchive('目录条目不应包含内容', { path: rawPath })
    return { path: normalizeArchivePath(rawPath), size: 0, type: 'dir', mode }
  }
  if (typeflag === 0x78 || typeflag === 0x67 || typeflag === 0x4c || typeflag === 0x4b) {
    // 备份归档不使用 PAX/GNU 长文件名扩展；出现即拒绝，避免绕过路径校验。
    throw unsafeArchive('归档包含不支持的扩展条目')
  }
  throw unsafeArchive('归档包含符号链接/硬链接/设备等不允许的条目', { typeflag })
}

function pad512(size: number): number {
  const remainder = size % 512
  return remainder === 0 ? 0 : 512 - remainder
}

/**
 * 流式扫描 tar.gz。handler 对每个条目返回 skip/capture/extract。
 * 解压总字节、条目数量、单条目大小、内存捕获大小都有上限。
 */
export async function scanTarGz(
  filePath: string,
  handler: (header: TarEntryHeader) => TarDecision,
  options: TarScanOptions = {},
): Promise<TarScanResult> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES
  const maxUnpackedBytes = options.maxUnpackedBytes ?? DEFAULT_MAX_UNPACKED_BYTES
  const captureMaxBytes = options.captureMaxBytes ?? DEFAULT_CAPTURE_BYTES
  const gunzip = createGunzip()
  const source = createReadStream(filePath)
  source.on('error', (error) => gunzip.destroy(error))
  source.pipe(gunzip)
  const reader = new ByteStream(gunzip, maxUnpackedBytes)
  const captures = new Map<string, Buffer>()
  let entries = 0
  let unpackedBytes = 0
  try {
    for (;;) {
      const header = await reader.readExact(512)
      if (header.every((byte) => byte === 0)) {
        const second = await reader.readExact(512)
        if (!second.every((byte) => byte === 0)) throw invalidArchive('tar 结束标记不合法')
        break
      }
      entries += 1
      if (entries > maxEntries) throw archiveTooLarge('归档条目数量超过上限')
      const parsed = parseHeader(header)
      if (parsed.size > maxEntryBytes) throw archiveTooLarge('归档内单个条目超过上限')
      const decision = handler({ path: parsed.path, size: parsed.size, type: parsed.type, mode: parsed.mode })
      const padding = pad512(parsed.size)
      if (decision.kind === 'skip') {
        await reader.skip(parsed.size + padding)
        unpackedBytes += parsed.size
        continue
      }
      if (decision.kind === 'capture') {
        if (parsed.size > captureMaxBytes) throw archiveTooLarge('归档元数据文件过大')
        const data = await reader.readExact(parsed.size + padding)
        captures.set(decision.key, Buffer.from(data.subarray(0, parsed.size)))
        unpackedBytes += parsed.size
        continue
      }
      // extract
      mkdirSync(dirname(decision.dest), { recursive: true, mode: 0o700 })
      let fd: number
      try {
        fd = openSync(decision.dest, 'wx', 0o600)
      } catch {
        throw invalidArchive('归档包含重复文件条目或目标不可写')
      }
      try {
        await reader.writeToFd(parsed.size, fd)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      await reader.skip(padding)
      unpackedBytes += parsed.size
    }
    return { entries, unpackedBytes, captures }
  } catch (error) {
    if (error instanceof AppError) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (/write|EEXIST|ENOENT|ENOSPC|EACCES/i.test(message)) {
      throw new AppError(500, 'restore_io_failed', `归档读取/写入失败：${message}`)
    }
    throw invalidArchive(`归档无法解压：${message}`)
  } finally {
    await reader.close()
    source.destroy()
    gunzip.destroy()
  }
}

export interface ArchiveInspection {
  entries: number
  fileEntries: number
  totalFileBytes: number
  hasManifest: boolean
  hasDatabase: boolean
  databasePaths: string[]
  manifestRaw: string | null
}

/** 只读扫描：校验全部条目安全性，统计文件条目并捕获 manifest（不落盘）。 */
export async function inspectTarGz(filePath: string, options: TarScanOptions = {}): Promise<ArchiveInspection> {
  let manifestKey: string | null = null
  let fileEntries = 0
  let totalFileBytes = 0
  const databasePaths: string[] = []
  const result = await scanTarGz(
    filePath,
    (header) => {
      if (!(header.path.startsWith('files/') || header.path.startsWith('backups/'))) {
        throw unsafeArchive('归档包含备份目录之外的文件', { path: header.path })
      }
      if (header.type === 'file') {
        if (header.path.startsWith('files/')) {
          fileEntries += 1
          totalFileBytes += header.size
        }
        if (/^backups\/db-.*\.sqlite$/.test(header.path)) {
          databasePaths.push(header.path)
        }
        if (/^backups\/manifest-.*\.json$/.test(header.path)) {
          if (manifestKey) throw unsafeArchive('归档包含多个 manifest')
          manifestKey = header.path
          return { kind: 'capture', key: 'manifest' }
        }
      }
      return { kind: 'skip' }
    },
    options,
  )
  const manifestRaw = result.captures.has('manifest')
    ? (result.captures.get('manifest') as Buffer).toString('utf8')
    : null
  return {
    entries: result.entries,
    fileEntries,
    totalFileBytes,
    hasManifest: manifestRaw !== null,
    hasDatabase: databasePaths.length === 1,
    databasePaths,
    manifestRaw,
  }
}
