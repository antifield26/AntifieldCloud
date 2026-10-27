/**
 * 备份归档 age 加密（v0.7.0）：只加密、不管理私钥。
 *
 * 安全边界：
 * - Pi 只读取 age 公钥文件；私钥离线保存，应用/CLI 不读取私钥。
 * - 公钥文件必须 root 属主且组/其他不可写（防止被替换后加密到攻击者密钥）；
 *   测试可用 BACKUP_SKIP_KEY_OWNER_CHECK=1 跳过属主检查（仅本机夹具）。
 * - age 通过 execFile 调用（不经 shell），参数不做字符串拼接。
 * - 失败关闭：加密异常/密文为空时抛错，调用方不得回退明文。
 */
import { execFile } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** age 公钥格式：age1 开头 + 至少 16 位 bech32 字符。 */
export const AGE_RECIPIENT_PATTERN = /^age1[0-9a-z]{16,}$/
/** sidecar schema：外部元数据（明文哈希/大小不在归档内 manifest）。 */
export const ARCHIVE_SIDECAR_SCHEMA = 2
/** 加密归档后缀。 */
export const ENCRYPTED_ARCHIVE_SUFFIX = '.tar.gz.age'
/** 公钥文件上限：防止误读大文件。 */
const MAX_RECIPIENT_FILE_BYTES = 4096

export interface AgeEncryptOptions {
  plainPath: string
  cipherPath: string
  recipient: string
  /** age 可执行文件；默认 `age`。 */
  ageBin?: string
  /** 超时秒数（大归档按体积估算，调用方传入）。 */
  timeoutMs?: number
}

export interface AgeEncryptResult {
  cipherBytes: number
}

/** 解析公钥文件内容；空行/CRLF 容错，非法即抛错。 */
export function parseAgeRecipient(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.length > 0)
  if (!line) throw new Error('age 公钥文件为空')
  if (!AGE_RECIPIENT_PATTERN.test(line)) throw new Error('age 公钥格式无效（应为 age1…）')
  return line
}

export interface ReadAgeRecipientOptions {
  /** 测试夹具跳过 root 属主检查（生产不得设置）。 */
  skipOwnerCheck?: boolean
}

/** 读取并校验公钥文件：存在、普通文件、大小上限、root 属主（Linux）、组/其他不可写。 */
export function readAgeRecipientFile(path: string, options: ReadAgeRecipientOptions = {}): string {
  let stats
  try {
    stats = statSync(path)
  } catch {
    throw new Error(`缺少 age 公钥文件：${path}`)
  }
  if (!stats.isFile()) throw new Error(`age 公钥不是普通文件：${path}`)
  if (stats.size <= 0 || stats.size > MAX_RECIPIENT_FILE_BYTES) {
    throw new Error(`age 公钥文件大小异常：${stats.size} bytes`)
  }
  if (process.platform !== 'win32') {
    const mode = stats.mode & 0o777
    if ((mode & 0o022) !== 0) throw new Error(`age 公钥文件组/其他可写（${mode.toString(8)}）：${path}`)
    const skipOwner = options.skipOwnerCheck === true || process.env.BACKUP_SKIP_KEY_OWNER_CHECK === '1'
    if (!skipOwner && stats.uid !== 0) throw new Error(`age 公钥文件必须由 root 所有：${path}`)
  }
  return parseAgeRecipient(readFileSync(path, 'utf8'))
}

/** 校验 age 可执行文件可用；返回版本输出（可能含换行）。测试夹具 BACKUP_AGE_FAKE=1 时直接通过。 */
export async function assertAgeBinary(ageBin = 'age', timeoutMs = 5000): Promise<string> {
  if (process.env.NODE_ENV === 'test' && process.env.BACKUP_AGE_FAKE === '1') return 'age fake'
  try {
    const { stdout } = await execFileAsync(ageBin, ['--version'], { timeout: timeoutMs, maxBuffer: 64 * 1024 })
    return String(stdout).trim()
  } catch (error) {
    throw new Error(`age 不可用（${ageBin}）：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

/**
 * 加密单个文件：age -r <recipient> -o <cipherPath> <plainPath>。
 * 测试注入：NODE_ENV=test + BACKUP_AGE_FAKE=1 时直接复制（仅验证调用方流程，不验证 age 本身）。
 */
export async function encryptArchiveFile(options: AgeEncryptOptions): Promise<AgeEncryptResult> {
  const ageBin = options.ageBin ?? process.env.BACKUP_AGE_BIN ?? 'age'
  if (process.env.NODE_ENV === 'test' && process.env.BACKUP_AGE_FAKE === '1') {
    // 仅测试：可模拟 age 失败（验证 fail-closed），否则写“密文”前缀 + 明文，
    // 使密文大小/SHA 与明文不同（用于验证 sidecar 的 plainSha256/cipherSha256 分离）。
    if (process.env.BACKUP_AGE_FAKE_FAIL === '1') throw new Error('模拟 age 加密失败')
    writeFileSync(options.cipherPath, Buffer.concat([Buffer.from('age-encryption.org/v1\nfake-age\n'), readFileSync(options.plainPath)]))
  } else {
    await execFileAsync(ageBin, ['-r', options.recipient, '-o', options.cipherPath, options.plainPath], {
      timeout: options.timeoutMs ?? 30 * 60_000,
      maxBuffer: 1024 * 1024,
    })
  }
  let size: number
  try {
    size = statSync(options.cipherPath).size
  } catch {
    throw new Error('age 加密后密文不存在')
  }
  if (size <= 0) throw new Error('age 加密后密文为空')
  return { cipherBytes: size }
}

/** 归档名是否为加密归档（大小写敏感，与 CLI 生成一致）。 */
export function isEncryptedArchiveName(name: string): boolean {
  return name.endsWith(ENCRYPTED_ARCHIVE_SUFFIX)
}

/** sidecar 文件名：<archive>.meta.json。 */
export function archiveSidecarName(archiveName: string): string {
  return `${archiveName}.meta.json`
}

export interface ArchiveSidecarInput {
  name: string
  mode: 'full' | 'inc'
  createdAt: string
  plainSha256: string
  plainSize: number
  cipherSha256: string
  cipherSize: number
  recipient: string
}

/** 外部元数据 sidecar：明文归档 SHA/大小放在归档外，避免自引用。 */
export function buildArchiveSidecar(input: ArchiveSidecarInput): Record<string, unknown> {
  if (!isEncryptedArchiveName(input.name)) throw new Error('sidecar 只用于加密归档')
  if (!/^[0-9a-f]{64}$/.test(input.plainSha256)) throw new Error('plainSha256 格式无效')
  if (!/^[0-9a-f]{64}$/.test(input.cipherSha256)) throw new Error('cipherSha256 格式无效')
  if (!Number.isSafeInteger(input.plainSize) || input.plainSize < 0) throw new Error('plainSize 无效')
  if (!Number.isSafeInteger(input.cipherSize) || input.cipherSize <= 0) throw new Error('cipherSize 无效')
  if (!AGE_RECIPIENT_PATTERN.test(input.recipient)) throw new Error('recipient 无效')
  return {
    schema: ARCHIVE_SIDECAR_SCHEMA,
    name: input.name,
    mode: input.mode,
    createdAt: input.createdAt,
    archiveFormat: 'tar.gz.age',
    encrypted: true,
    encryptedWith: 'age',
    recipient: input.recipient,
    plainSha256: input.plainSha256,
    plainSize: input.plainSize,
    cipherSha256: input.cipherSha256,
    cipherSize: input.cipherSize,
  }
}
