#!/usr/bin/env node
/**
 * 异地副本（PC 端）：把本机已拉取的“加密归档”复制到远端（rclone），并做链感知保留。
 *
 * 职责：
 * - 只上传 `.tar.gz.age` 加密归档，明文归档一律拒绝上传（计入 plaintextSkipped）；
 * - 上传前校验本地密文 SHA-256（.sha256 旁文件必须存在且匹配）与 <name>.meta.json 元数据；
 * - `rclone copyto --checksum --immutable` 上传归档及其 `.sha256`/`.meta.json` 伴随文件；
 * - 链感知保留：保留“远端最新 full 及其后全部 inc”与最近 N 天归档；绝不删除最新 full；
 * - 删除前做上限保护（--max-delete），默认 dry-run 可预览；
 * - 状态 JSON 输出到 stdout/--json-out（字段：lastRunAt/ok/remoteLabel/uploaded/skipped/failed/
 *   bytes/keptRemote/plaintextSkipped/error），由 backup-offsite.ps1 写回 Pi（0644，应用只读）。
 *
 * 安全边界：
 * - 不读取/打印 age 私钥；不做解密（解密校验由 backup-pull.ps1 的可选 -AgeIdentityPath 负责）；
 * - 状态/日志不含远端凭据、私钥路径或本地绝对路径（remoteLabel 由调用方用 -RemoteLabel 提供）；
 * - 远端只接收密文；本地明文归档不会被选择、不会被上传、也不会被删除；
 * - rclone 通过 execFile 以参数数组调用（无 shell 拼接）。
 *
 * 用法（由 backup-offsite.ps1 调用）：
 *   node scripts/backup-offsite.mjs --backup-root <dir> --remote <rclone-remote:path> \
 *     --remote-label <label> [--keep-days 30] [--max-delete 50] [--dry-run] [--json-out <file>]
 *
 * 退出码：0=成功（含“无新归档”）；1=失败（状态仍输出 ok=false）；2=参数错误。
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 加密归档名（v0.7.0 唯一允许上传的格式）。 */
export const ENCRYPTED_PATTERN = /^snapshot-(\d{8}T\d{6,9}Z)(?:-\d+)?-(full|inc)\.tar\.gz\.age$/
/** 明文归档名（只用于拒绝统计，不允许上传）。 */
export const PLAINTEXT_PATTERN = /^snapshot-(\d{8}T\d{6,9}Z)(?:-\d+)?-(full|inc)\.tar\.gz$/
/** 远端保留的伴随文件后缀（随归档一起上传/删除）。 */
const COMPANION_SUFFIXES = ['.sha256', '.meta.json']

/**
 * 解析归档名里的时间戳（yyyyMMddTHHmmss[1-9 位小数秒]Z）为 epoch 毫秒；失败返回 null。
 * 与 scripts/drill.ps1 的 ConvertFrom-Stamp 语义一致，避免 7/8 位小数秒被静默忽略。
 */
export function parseStamp(name) {
  const match = /^snapshot-(\d{8})T(\d{6})(\d{1,3})?Z(?:-\d+)?-(?:full|inc)\.tar\.gz(?:\.age)?$/.exec(name)
  if (!match) return null
  const [, date, time, fraction] = match
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(4, 6))
  const day = Number(date.slice(6, 8))
  const hour = Number(time.slice(0, 2))
  const minute = Number(time.slice(2, 4))
  const second = Number(time.slice(4, 6))
  const ms = fraction ? Number(fraction.padEnd(3, '0')) : 0
  const value = Date.UTC(year, month - 1, day, hour, minute, second, ms)
  return Number.isFinite(value) ? value : null
}

/** 是否为允许上传的加密归档名。 */
export function isEncryptedName(name) {
  return typeof name === 'string' && ENCRYPTED_PATTERN.test(name)
}

/** 是否为明文归档名（用于拒绝统计；绝不上传）。 */
export function isPlaintextName(name) {
  return typeof name === 'string' && PLAINTEXT_PATTERN.test(name)
}

/** 归档 mode（full|inc）；非归档名返回 null。 */
export function archiveMode(name) {
  const match = ENCRYPTED_PATTERN.exec(name) ?? PLAINTEXT_PATTERN.exec(name)
  return match ? match[2] : null
}

/** 状态/日志文本脱敏：去掉本地绝对路径与远端凭据样式，保留可诊断的错误码/短语。 */
export function sanitizeStatusText(text) {
  if (text === null || text === undefined) return null
  const cleaned = String(text)
    .replace(/[A-Za-z]:\\[^\s"'<>|]+/g, '<path>')
    .replace(/(?:\/|\\\\)(?:var|home|etc|opt|tmp|run|srv|root|mnt|media|Users)(?:\/|\\\\)[^\s"'<>|]+/g, '<path>')
    .replace(/(?:password|passwd|token|secret)=[^\s&]+/gi, '$1=<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 300 ? `${cleaned.slice(0, 300)}…` : cleaned
}

/**
 * 计算链感知保留计划（纯函数，便于测试）。
 * - remoteNames：远端已有的归档名（可含伴随文件，函数内部过滤）；
 * - keepDays：额外保留最近 N 天的归档（即使不属于最新 full 链）；
 * - now：当前时间（毫秒），测试可注入。
 * 返回 { keep, remove, newestFull }；绝不把最新 full 放进 remove。
 */
export function planRetention(remoteNames, { keepDays = 30, now = Date.now() } = {}) {
  const archives = [...new Set((remoteNames ?? []).filter((name) => isEncryptedName(name)))]
    .map((name) => ({ name, stamp: parseStamp(name), mode: archiveMode(name) }))
    .filter((item) => item.stamp !== null)
    .sort((a, b) => a.stamp - b.stamp)
  if (archives.length === 0) return { keep: [], remove: [], newestFull: null }
  const fulls = archives.filter((item) => item.mode === 'full')
  const newestFull = fulls.length > 0 ? fulls[fulls.length - 1] : null
  const keepSet = new Set()
  if (newestFull) {
    for (const item of archives) {
      if (item.stamp >= newestFull.stamp) keepSet.add(item.name)
    }
  }
  const cutoff = now - Math.max(0, keepDays) * 24 * 60 * 60 * 1000
  for (const item of archives) {
    if (item.stamp >= cutoff) keepSet.add(item.name)
  }
  const keep = archives.filter((item) => keepSet.has(item.name)).map((item) => item.name)
  const remove = archives
    .filter((item) => !keepSet.has(item.name))
    .map((item) => item.name)
  return { keep, remove, newestFull: newestFull ? newestFull.name : null }
}

/** 本地归档候选：返回可直接上传的加密归档与拒绝统计。 */
export function selectUploadCandidates(localArchives, remoteNames) {
  const remote = new Set((remoteNames ?? []).filter((name) => isEncryptedName(name)))
  const candidates = []
  const plaintextSkipped = []
  for (const item of localArchives ?? []) {
    if (isPlaintextName(item.name)) {
      plaintextSkipped.push(item.name)
      continue
    }
    if (!isEncryptedName(item.name)) continue
    if (remote.has(item.name)) continue
    candidates.push(item)
  }
  candidates.sort((a, b) => (a.stamp ?? 0) - (b.stamp ?? 0))
  plaintextSkipped.sort()
  return { candidates, plaintextSkipped }
}

/** 解析 sha256sum 风格旁文件；返回小写 hex 或 null。 */
export function parseShaSidecar(text) {
  if (typeof text !== 'string') return null
  const match = /^([0-9a-fA-F]{64})[ \t]+(\S+)[ \t]*$/m.exec(text.trim())
  return match ? match[1].toLowerCase() : null
}

/** 流式计算文件 SHA-256（不加载整个归档）。 */
export function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', (error) => rejectPromise(error))
      .on('end', () => resolvePromise(hash.digest('hex')))
  })
}

/** 校验加密归档的外部元数据（与 Pi CLI 的 sidecar schema 2 对齐）。 */
export function validateMeta(meta, expected = {}) {
  if (!meta || typeof meta !== 'object') return { ok: false, error: 'meta_invalid' }
  if (meta.schema !== 2) return { ok: false, error: 'meta_schema_invalid' }
  if (typeof meta.name !== 'string' || !isEncryptedName(meta.name)) return { ok: false, error: 'meta_name_invalid' }
  if (meta.mode !== 'full' && meta.mode !== 'inc') return { ok: false, error: 'meta_mode_invalid' }
  if (meta.archiveFormat !== 'tar.gz.age' || meta.encrypted !== true) return { ok: false, error: 'meta_format_invalid' }
  if (meta.encryptedWith !== 'age') return { ok: false, error: 'meta_encrypted_with_invalid' }
  if (typeof meta.recipient !== 'string' || !/^age1[0-9a-z]{16,}$/.test(meta.recipient)) {
    return { ok: false, error: 'meta_recipient_invalid' }
  }
  if (typeof meta.plainSha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(meta.plainSha256)) {
    return { ok: false, error: 'meta_plain_sha_invalid' }
  }
  if (!Number.isSafeInteger(meta.plainSize) || meta.plainSize < 0) return { ok: false, error: 'meta_plain_size_invalid' }
  if (typeof meta.cipherSha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(meta.cipherSha256)) {
    return { ok: false, error: 'meta_cipher_sha_invalid' }
  }
  if (!Number.isSafeInteger(meta.cipherSize) || meta.cipherSize <= 0) return { ok: false, error: 'meta_cipher_size_invalid' }
  if (expected.name && meta.name !== expected.name) return { ok: false, error: 'meta_name_mismatch' }
  if (expected.mode && meta.mode !== expected.mode) return { ok: false, error: 'meta_mode_mismatch' }
  if (expected.cipherSha256 && String(meta.cipherSha256).toLowerCase() !== String(expected.cipherSha256).toLowerCase()) {
    return { ok: false, error: 'meta_cipher_sha_mismatch' }
  }
  if (Number.isSafeInteger(expected.cipherSize) && meta.cipherSize !== expected.cipherSize) {
    return { ok: false, error: 'meta_cipher_size_mismatch' }
  }
  return { ok: true }
}

/** 构造状态对象（字段固定，供应用 Dashboard/告警读取；文本脱敏）。 */
export function buildStatus({ ok, remoteLabel, uploaded = 0, skipped = 0, failed = 0, bytes = 0, keptRemote = 0, plaintextSkipped = 0, error = null, now = new Date() }) {
  return {
    lastRunAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    ok: ok === true,
    remoteLabel: String(remoteLabel ?? '').slice(0, 120),
    uploaded: Number(uploaded) || 0,
    skipped: Number(skipped) || 0,
    failed: Number(failed) || 0,
    bytes: Number(bytes) || 0,
    keptRemote: Number(keptRemote) || 0,
    plaintextSkipped: Number(plaintextSkipped) || 0,
    error: error ? sanitizeStatusText(error) : null,
  }
}

/** 递归遍历备份根，收集归档与 sidecar/meta 是否存在（只读，不跟随符号链接）。 */
export function scanLocalArchives(backupRoot) {
  const found = []
  for (const folder of ['daily', 'weekly']) {
    const root = join(backupRoot, folder)
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dateDir = join(root, entry.name)
      for (const file of readdirSync(dateDir, { withFileTypes: true })) {
        if (!file.isFile()) continue
        const name = file.name
        if (!isEncryptedName(name) && !isPlaintextName(name)) continue
        const path = join(dateDir, name)
        const stats = statSync(path)
        found.push({
          name,
          path,
          encrypted: isEncryptedName(name),
          mode: archiveMode(name),
          stamp: parseStamp(name),
          sizeBytes: stats.size,
          hasSidecar: existsSync(`${path}.sha256`),
          hasMeta: existsSync(`${path}.meta.json`),
        })
      }
    }
  }
  found.sort((a, b) => (a.stamp ?? 0) - (b.stamp ?? 0))
  return found
}

/** rclone 运行器：execFile 参数数组，无 shell；测试可注入假 runner。 */
export function createRcloneRunner(rcloneBin = 'rclone') {
  return function run(args, { timeoutMs = 30 * 60 * 1000 } = {}) {
    return new Promise((resolvePromise) => {
      execFile(rcloneBin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0
        resolvePromise({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
    })
  }
}

/** 远端目录拼接（用于 lsf 列表）；校验 remote/remotePath 后返回目录路径。 */
export function remoteBase(remote, remotePath) {
  if (!/^[A-Za-z0-9_.:-]+$/.test(String(remote ?? ''))) throw new Error('invalid_remote')
  if (!/^[A-Za-z0-9_./-]*$/.test(String(remotePath ?? '')) || String(remotePath).includes('..')) throw new Error('invalid_remote_path')
  const base = String(remote).replace(/\/+$/, '')
  const sub = String(remotePath).replace(/^\/+|\/+$/g, '')
  return sub ? `${base}/${sub}` : base
}

/** 远端 rclone 路径拼接：远端/<path>/<name>；拒绝路径穿越/控制字符。 */
export function remoteJoin(remote, remotePath, name) {
  const base = remoteBase(remote, remotePath)
  if (!/^[A-Za-z0-9_.-]+$/.test(String(name ?? ''))) throw new Error('invalid_remote_name')
  return `${base}/${name}`
}

/** 解析命令行参数（仅接受白名单参数）。 */
export function parseArgs(argv) {
  const options = { backupRoot: '', remote: '', remotePath: '', remoteLabel: '', keepDays: 30, maxDelete: 50, dryRun: false, jsonOut: '', rcloneBin: 'rclone', verify: true }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`missing value for ${arg}`)
      return argv[index]
    }
    if (arg === '--backup-root') options.backupRoot = next()
    else if (arg === '--remote') options.remote = next()
    else if (arg === '--remote-path') options.remotePath = next()
    else if (arg === '--remote-label') options.remoteLabel = next()
    else if (arg === '--keep-days') options.keepDays = Math.max(0, Number.parseInt(next(), 10) || 0)
    else if (arg === '--max-delete') options.maxDelete = Math.max(0, Number.parseInt(next(), 10) || 0)
    else if (arg === '--json-out') options.jsonOut = next()
    else if (arg === '--rclone-bin') options.rcloneBin = next()
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--no-verify') options.verify = false
    else if (arg === '--help') options.help = true
    else throw new Error(`unknown_argument:${arg}`)
  }
  return options
}

/** rclone lsf 列表 → 文件名数组（忽略空行与目录行）。 */
export function parseLsfOutput(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.endsWith('/'))
    .map((line) => line.split(/[\\/]/).pop())
}

/**
 * 主流程（可注入依赖便于测试）：
 * deps = { runRclone, sha256File, now, logger }
 */
export async function runOffsite(options, deps = {}) {
  const runRclone = deps.runRclone ?? createRcloneRunner(options.rcloneBin)
  const hashFile = deps.sha256File ?? sha256File
  const now = deps.now ?? (() => Date.now())
  const log = deps.logger ?? ((message) => console.error(message))
  const statusBase = { remoteLabel: options.remoteLabel }
  if (!options.backupRoot || !options.remote) {
    return { exitCode: 2, status: buildStatus({ ...statusBase, ok: false, error: 'missing_backup_root_or_remote' }) }
  }
  let remoteDirectory
  try {
    remoteDirectory = remoteBase(options.remote, options.remotePath)
  } catch (error) {
    return { exitCode: 2, status: buildStatus({ ...statusBase, ok: false, error: sanitizeStatusText(error instanceof Error ? error.message : String(error)) }) }
  }
  const localArchives = scanLocalArchives(options.backupRoot)
  const plaintextSkipped = localArchives.filter((item) => !item.encrypted).length

  // 远端列表
  const listResult = await runRclone(['lsf', '--files-only', '--max-depth', '1', remoteDirectory])
  if (listResult.code !== 0) {
    return { exitCode: 1, status: buildStatus({ ...statusBase, ok: false, plaintextSkipped, error: sanitizeStatusText(`rclone_lsf_failed: ${listResult.stderr || listResult.stdout}`) }) }
  }
  const remoteNames = parseLsfOutput(listResult.stdout)
  const { candidates, plaintextSkipped: plainNames } = selectUploadCandidates(localArchives, remoteNames)
  let uploaded = 0
  let failed = 0
  let bytes = 0
  for (const candidate of candidates) {
    // 只允许上传带密文 SHA 与 meta 的加密归档；缺失即失败（不静默）。
    if (!candidate.hasSidecar || !candidate.hasMeta) {
      failed += 1
      log(`skip invalid encrypted archive (missing sidecar/meta): ${candidate.name}`)
      continue
    }
    let expectedSha
    try {
      expectedSha = parseShaSidecar(readFileSync(`${candidate.path}.sha256`, 'utf8'))
      const meta = JSON.parse(readFileSync(`${candidate.path}.meta.json`, 'utf8'))
      const metaCheck = validateMeta(meta, {
        name: candidate.name,
        mode: candidate.mode,
        cipherSha256: expectedSha,
        cipherSize: candidate.sizeBytes,
      })
      if (!metaCheck.ok) throw new Error(metaCheck.error)
    } catch (error) {
      failed += 1
      log(`skip invalid encrypted archive (${sanitizeStatusText(error instanceof Error ? error.message : String(error))}): ${candidate.name}`)
      continue
    }
    if (!expectedSha) {
      failed += 1
      log(`skip invalid sidecar: ${candidate.name}`)
      continue
    }
    if (!options.dryRun) {
      const actual = await hashFile(candidate.path)
      if (actual !== expectedSha) {
        failed += 1
        log(`local ciphertext sha mismatch: ${candidate.name}`)
        continue
      }
    }
    const filesToUpload = [candidate.name, ...COMPANION_SUFFIXES.map((suffix) => `${candidate.name}${suffix}`)]
    let uploadOk = true
    for (const fileName of filesToUpload) {
      const localPath = fileName === candidate.name ? candidate.path : `${candidate.path}${fileName.slice(candidate.name.length)}`
      if (!existsSync(localPath)) { uploadOk = false; break }
      if (options.dryRun) continue
      const copy = await runRclone(['copyto', '--checksum', localPath, remoteJoin(options.remote, options.remotePath, fileName)])
      if (copy.code !== 0) {
        uploadOk = false
        log(`rclone copyto failed (${sanitizeStatusText(copy.stderr || copy.stdout)}): ${fileName}`)
        break
      }
      if (options.verify && fileName === candidate.name) {
        const sizeCheck = await runRclone(['size', '--json', remoteJoin(options.remote, options.remotePath, fileName)])
        const remoteSize = (() => {
          try {
            return Number(JSON.parse(sizeCheck.stdout).bytes)
          } catch {
            return NaN
          }
        })()
        if (sizeCheck.code === 0 && Number.isFinite(remoteSize) && remoteSize !== candidate.sizeBytes) {
          uploadOk = false
          log(`remote size mismatch: ${fileName}`)
          break
        }
      }
    }
    if (!uploadOk) { failed += 1; continue }
    uploaded += 1
    bytes += candidate.sizeBytes
  }
  const skipped = Math.max(0, localArchives.filter((item) => item.encrypted).length - candidates.length - failed)

  // 上传后重新列远端，计算链感知保留；只删 `.age` 归档及伴随文件。
  const afterUpload = options.dryRun
    ? [...remoteNames]
    : parseLsfOutput((await runRclone(['lsf', '--files-only', '--max-depth', '1', remoteDirectory])).stdout)
  const plan = planRetention(afterUpload, { keepDays: options.keepDays, now: now() })
  if (plan.remove.length > options.maxDelete) {
    return { exitCode: 1, status: buildStatus({ ...statusBase, ok: false, uploaded, skipped, failed, bytes, plaintextSkipped, keptRemote: plan.keep.length, error: sanitizeStatusText(`delete_limit_exceeded: ${plan.remove.length} > ${options.maxDelete}`) }) }
  }
  if (!options.dryRun) {
    for (const name of plan.remove) {
      for (const fileName of [name, ...COMPANION_SUFFIXES.map((suffix) => `${name}${suffix}`)]) {
        const deletion = await runRclone(['deletefile', remoteJoin(options.remote, options.remotePath, fileName)])
        if (deletion.code !== 0) {
          failed += 1
          log(`rclone deletefile failed: ${fileName}`)
        }
      }
    }
  }
  const keptRemote = options.dryRun ? plan.keep.length : plan.keep.length
  const status = buildStatus({ ...statusBase, ok: failed === 0, uploaded, skipped, failed, bytes, keptRemote, plaintextSkipped: plainNames.length, error: failed > 0 ? 'partial_failure' : null })
  return { exitCode: status.ok ? 0 : 1, status }
}

/** CLI 入口。 */
async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.log(JSON.stringify(buildStatus({ ok: false, error: sanitizeStatusText(error instanceof Error ? error.message : String(error)) })))
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log(JSON.stringify({ ok: true, usage: 'node scripts/backup-offsite.mjs --backup-root <dir> --remote <rclone-remote> [--remote-path <path>] [--remote-label <label>] [--keep-days 30] [--max-delete 50] [--dry-run] [--json-out <file>]' }))
    return
  }
  const result = await runOffsite(options)
  if (options.jsonOut) {
    writeFileSync(options.jsonOut, `${JSON.stringify(result.status)}\n`, { encoding: 'utf8' })
  }
  console.log(JSON.stringify(result.status))
  process.exitCode = result.exitCode
}

// 生产经 scripts/ 直接执行；realpath 判断避免被其它入口误触发。
if (process.argv[1]) {
  let entryPath = process.argv[1]
  try {
    entryPath = resolve(entryPath)
  } catch {
    entryPath = process.argv[1]
  }
  const selfPath = fileURLToPath(import.meta.url)
  if (resolve(selfPath) === resolve(entryPath) || basename(selfPath) === basename(entryPath)) main()
}
