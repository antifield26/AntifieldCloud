#!/usr/bin/env node
/**
 * 恢复演练校验库 + CLI（node:sqlite，无第三方依赖）。
 *
 * 职责：
 * - parseSidecar：解析 `.sha256` 旁文件（`<sha>  <name>`），校验 SHA 与文件名；
 * - verifyArchiveSha：流式计算归档 SHA-256 并与旁文件/期望值比对；
 * - analyzeTarListing：校验 `tar -tzf` 条目安全（绝对路径、`..`、反斜杠、控制字符、白名单前缀）；
 * - verifyManifest：校验归档 manifest 的 schema（1=旧规则，2=加密特性新规则）/mode/fileCount/files/totalBytes/createdAt；
 * - verifyDb：打开 SQLite 快照执行 `PRAGMA integrity_check`、`PRAGMA foreign_key_check` 并读取
 *   `meta.schema_version`；
 * - CLI：供 scripts/drill.ps1 调用，stdout 单行 JSON，失败退出码 1。
 *
 * 安全边界：只读打开归档与数据库（不写、不修复、不删除）；错误码与 message 保持 ASCII，
 * 避免 PowerShell 5.1 以 GBK 解码 JSON 失败。
 */
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, realpathSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

/** 备份归档允许的顶层前缀：应用数据归档只有 backups/ 与 files/。 */
export const ARCHIVE_PREFIXES = ['backups/', 'files/']
/** 世界归档允许的顶层前缀（drill.ps1 的 -IncludeWorld 校验用）。 */
export const WORLD_PREFIXES = ['world/']

/** 状态/报告 JSON 只输出 ASCII：非 ASCII 替换为 ?，跨编码解析更稳。 */
export function sanitizeAscii(text) {
  return String(text).replace(/[^\x20-\x7e]/g, '?')
}

/** 统一错误对象：{ ok:false, errors:[{code,message}] }。 */
function failure(code, message) {
  return { ok: false, errors: [{ code, message: sanitizeAscii(message) }] }
}

/** 解析 sha256sum 风格的旁文件内容。 */
export function parseSidecar(text, expectedArchiveName = null) {
  if (typeof text !== 'string' || text.trim() === '') {
    return failure('sidecar_missing', 'sidecar file is empty or missing')
  }
  const match = /^([0-9a-fA-F]{64})[ \t]+(\S+)[ \t]*$/m.exec(text.trim())
  if (!match) {
    return failure('sidecar_invalid', 'sidecar is not in "<sha256>  <filename>" format')
  }
  const sha256 = match[1].toLowerCase()
  const name = match[2]
  if (expectedArchiveName && name !== expectedArchiveName) {
    return failure('sidecar_name_mismatch', `sidecar filename ${name} does not match ${expectedArchiveName}`)
  }
  return { ok: true, sha256, name }
}

/** 流式计算文件 SHA-256。 */
export function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', (error) => rejectPromise(error))
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

/** 校验归档实际 SHA-256 与期望值一致。 */
export async function verifyArchiveSha(path, expectedSha256) {
  const expected = String(expectedSha256 ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    return failure('sha256_expected_invalid', `invalid expected sha256: ${expectedSha256}`)
  }
  let actual
  try {
    actual = await sha256File(path)
  } catch (error) {
    return failure('archive_unreadable', `failed to hash archive ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (actual !== expected) {
    return { ok: false, actual, errors: [{ code: 'sha256_mismatch', message: `sha256 mismatch: actual ${actual}, expected ${expected}` }] }
  }
  return { ok: true, actual }
}

/** 判断字符串是否含控制字符（用码点判断，避免正则控制字符范围）。 */
function hasControlChar(text) {
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * 分析 `tar -tzf` 输出的条目名列表。
 * 返回文件条目计数、manifest/DB 路径、世界 level.dat 是否存在与全部不安全条目。
 */
export function analyzeTarListing(text, options = {}) {
  const allowedPrefixes = options.allowedPrefixes ?? ARCHIVE_PREFIXES
  const errors = []
  const entries = []
  const manifests = []
  const databases = []
  let fileEntries = 0
  let directoryEntries = 0
  let hasLevelDat = false
  const lines = String(text ?? '').split(/\r?\n/)
  for (const rawLine of lines) {
    let name = rawLine.trim()
    if (name === '') continue
    entries.push(name)
    const isDirectory = name.endsWith('/')
    // 归一化前导 ./，其余路径保持原样校验。
    while (name.startsWith('./')) name = name.slice(2)
    const path = isDirectory && name.length > 1 ? name.replace(/\/+$/, '') : name
    if (path === '') continue
    if (hasControlChar(path)) {
      errors.push({ code: 'tar_path_control_char', message: `control character in archive path: ${sanitizeAscii(path)}` })
      continue
    }
    if (path.includes('\\')) {
      errors.push({ code: 'tar_path_backslash', message: `backslash in archive path: ${sanitizeAscii(path)}` })
      continue
    }
    if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
      errors.push({ code: 'tar_path_absolute', message: `absolute archive path: ${sanitizeAscii(path)}` })
      continue
    }
    const segments = path.split('/')
    if (segments.some((segment) => segment === '..')) {
      errors.push({ code: 'tar_path_traversal', message: `parent segment in archive path: ${sanitizeAscii(path)}` })
      continue
    }
    if (segments.some((segment) => segment === '' || segment === '.')) {
      errors.push({ code: 'tar_path_invalid', message: `invalid archive path: ${sanitizeAscii(path)}` })
      continue
    }
    // 目录条目以 `/` 结尾；前缀白名单对目录也保留结尾 `/` 再比对。
    const prefixProbe = isDirectory ? `${path}/` : path
    const allowed = allowedPrefixes.some((prefix) => prefixProbe.startsWith(prefix))
    if (!allowed) {
      errors.push({ code: 'tar_path_unexpected_prefix', message: `unexpected archive prefix: ${sanitizeAscii(path)}` })
      continue
    }
    if (isDirectory) {
      directoryEntries += 1
      continue
    }
    if (path.startsWith('files/')) fileEntries += 1
    if (/^backups\/manifest-[^/]+\.json$/.test(path)) manifests.push(path)
    if (/^backups\/db-[^/]+\.sqlite$/.test(path)) databases.push(path)
    if (path === 'world/level.dat') hasLevelDat = true
  }
  return {
    ok: errors.length === 0,
    entries: entries.length,
    fileEntries,
    directoryEntries,
    manifests,
    databases,
    hasLevelDat,
    errors,
  }
}

/** 校验 manifest 对象；expectedMode/expectedFileCount 用于和归档实际内容比对。 */
export function verifyManifest(manifest, options = {}) {
  const errors = []
  const details = {
    schema: null,
    mode: null,
    fileCount: null,
    totalBytes: null,
    database: null,
    createdAt: null,
  }
  const push = (code, message) => errors.push({ code, message: sanitizeAscii(message) })
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    push('manifest_invalid', 'manifest is not a JSON object')
    return { ok: false, details, errors }
  }
  details.schema = manifest.schema ?? null
  details.mode = manifest.mode ?? null
  details.fileCount = manifest.fileCount ?? null
  details.totalBytes = manifest.totalBytes ?? null
  details.database = manifest.database ?? null
  details.createdAt = manifest.createdAt ?? null
  if (manifest.schema !== 1 && manifest.schema !== 2) push('manifest_schema_invalid', `manifest.schema must be 1 or 2, got ${JSON.stringify(manifest.schema)}`)
  if (manifest.mode !== 'full' && manifest.mode !== 'inc') {
    push('manifest_mode_invalid', `manifest.mode must be full|inc, got ${JSON.stringify(manifest.mode)}`)
  }
  if (options.expectedMode && manifest.mode !== options.expectedMode) {
    push('manifest_mode_mismatch', `manifest.mode ${JSON.stringify(manifest.mode)} does not match archive mode ${options.expectedMode}`)
  }
  if (typeof manifest.createdAt !== 'string' || Number.isNaN(Date.parse(manifest.createdAt))) {
    push('manifest_created_at_invalid', 'manifest.createdAt is not a valid ISO timestamp')
  }
  if (!Number.isSafeInteger(manifest.fileCount) || manifest.fileCount < 0) {
    push('manifest_filecount_invalid', `manifest.fileCount must be an integer >= 0, got ${JSON.stringify(manifest.fileCount)}`)
  }
  if (!Array.isArray(manifest.files)) {
    push('manifest_files_invalid', 'manifest.files must be an array')
  } else if (Number.isSafeInteger(manifest.fileCount) && manifest.files.length !== manifest.fileCount) {
    push(
      'manifest_filecount_mismatch',
      `manifest.files length ${manifest.files.length} does not match fileCount ${manifest.fileCount}`,
    )
  }
  if (manifest.totalBytes === undefined || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0) {
    push('manifest_totalbytes_invalid', `manifest.totalBytes must be an integer >= 0, got ${JSON.stringify(manifest.totalBytes)}`)
  }
  if (typeof manifest.database !== 'string' || !/^backups\/db-[^/]+\.sqlite$/.test(manifest.database)) {
    push('manifest_database_invalid', `manifest.database is not a backups/db-*.sqlite path: ${JSON.stringify(manifest.database)}`)
  }
  if (manifest.mode === 'full' && manifest.since !== null && manifest.since !== undefined) {
    push('manifest_since_invalid', 'full archive manifest must have since=null')
  }
  if (manifest.mode === 'inc' && (typeof manifest.since !== 'string' || Number.isNaN(Date.parse(manifest.since)))) {
    push('manifest_since_invalid', 'incremental archive manifest must have a valid since timestamp')
  }
  if (options.expectedFileCount !== undefined && options.expectedFileCount !== null) {
    if (manifest.fileCount !== options.expectedFileCount) {
      push(
        'manifest_filecount_mismatch',
        `manifest.fileCount ${manifest.fileCount} does not match archive files/ entries ${options.expectedFileCount}`,
      )
    }
  }
  return { ok: errors.length === 0, details, errors }
}

/**
 * 校验 SQLite 快照：integrity_check、foreign_key_check、meta.schema_version。
 * 只读打开，不修复任何问题；损坏数据库返回错误而不是抛异常。
 */
export function verifyDb(path, options = {}) {
  const errors = []
  const details = {
    path,
    integrity: [],
    integrityOk: false,
    foreignKeyViolations: [],
    foreignKeyOk: false,
    schemaVersion: null,
    expectedSchemaVersion: options.expectedSchemaVersion ?? null,
  }
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, details, errors: [{ code: 'db_open_failed', message: sanitizeAscii(message) }] }
  }
  try {
    try {
      const rows = db.prepare('PRAGMA integrity_check').all()
      details.integrity = rows.map((row) => sanitizeAscii(Object.values(row)[0]))
      details.integrityOk = details.integrity.length > 0 && details.integrity.every((value) => value === 'ok')
    } catch (error) {
      details.integrity = [`error: ${sanitizeAscii(error instanceof Error ? error.message : String(error))}`]
      details.integrityOk = false
    }
    if (!details.integrityOk) {
      errors.push({ code: 'db_integrity_failed', message: `integrity_check failed: ${details.integrity.join('; ')}` })
    }
    try {
      const violations = db.prepare('PRAGMA foreign_key_check').all()
      details.foreignKeyViolations = violations.slice(0, 20).map((row) => {
        const plain = {}
        for (const [key, value] of Object.entries(row)) plain[key] = sanitizeAscii(String(value))
        return plain
      })
      details.foreignKeyOk = violations.length === 0
    } catch (error) {
      details.foreignKeyOk = false
      errors.push({
        code: 'db_foreign_key_check_failed',
        message: `foreign_key_check failed: ${sanitizeAscii(error instanceof Error ? error.message : String(error))}`,
      })
    }
    if (!details.foreignKeyOk && details.foreignKeyViolations.length > 0) {
      errors.push({ code: 'db_foreign_key_violations', message: `foreign_key_check found ${details.foreignKeyViolations.length} violation(s)` })
    }
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
      details.schemaVersion = row ? Number.parseInt(String(row.value), 10) : null
    } catch (error) {
      details.schemaVersion = null
      errors.push({
        code: 'db_schema_version_missing',
        message: `meta.schema_version not readable: ${sanitizeAscii(error instanceof Error ? error.message : String(error))}`,
      })
    }
    if (details.schemaVersion === null && errors.every((item) => item.code !== 'db_schema_version_missing')) {
      errors.push({ code: 'db_schema_version_missing', message: 'meta.schema_version is missing' })
    }
    if (
      options.expectedSchemaVersion !== undefined &&
      options.expectedSchemaVersion !== null &&
      details.schemaVersion !== options.expectedSchemaVersion
    ) {
      errors.push({
        code: 'schema_version_mismatch',
        message: `schema_version ${details.schemaVersion} does not match expected ${options.expectedSchemaVersion}`,
      })
    }
  } finally {
    try {
      db.close()
    } catch {
      // 关闭失败不影响已完成的只读校验结果。
    }
  }
  return { ok: errors.length === 0, details, errors }
}

/** 读取文件并按 UTF-8 文本解析（失败时返回错误码而不是抛异常）。 */
function readTextFile(path) {
  try {
    return { ok: true, text: readFileSync(path, 'utf8') }
  } catch (error) {
    return failure('file_unreadable', `failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 解析 CLI 参数；未知参数抛错。 */
export function parseArgs(argv) {
  const options = { db: null, manifest: null, tarList: null, sidecar: null, archive: null, expectMode: null, expectFileCount: null, expectedSchemaVersion: null, expectedArchiveName: null, worldTar: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`missing value for ${arg}`)
      return argv[index]
    }
    if (arg === '--db') options.db = next()
    else if (arg === '--manifest') options.manifest = next()
    else if (arg === '--tar-list') options.tarList = next()
    else if (arg === '--sidecar') options.sidecar = next()
    else if (arg === '--archive') options.archive = next()
    else if (arg === '--expect-archive-name') options.expectedArchiveName = next()
    else if (arg === '--expect-mode') {
      const mode = next()
      if (mode !== 'full' && mode !== 'inc') throw new Error(`--expect-mode must be full or inc, got ${mode}`)
      options.expectMode = mode
    } else if (arg === '--expect-file-count') {
      const value = Number.parseInt(next(), 10)
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('--expect-file-count must be an integer >= 0')
      options.expectFileCount = value
    } else if (arg === '--schema-version') {
      const value = Number.parseInt(next(), 10)
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('--schema-version must be a positive integer')
      options.expectedSchemaVersion = value
    } else if (arg === '--help') {
      options.help = true
    } else if (arg === '--world-tar') {
      options.worldTar = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

/** 执行一组校验并返回合并结果（CLI 与测试共用）。 */
export async function runChecks(options) {
  const errors = []
  const warnings = []
  const checks = {}
  const collect = (result) => {
    for (const error of result.errors ?? []) errors.push(error)
    return result
  }

  if (options.sidecar || options.archive) {
    if (!options.archive) return { ok: false, checks, warnings, errors: [{ code: 'invalid_arguments', message: '--sidecar requires --archive' }] }
    checks.archive = {}
    const textResult = readTextFile(options.sidecar ?? `${options.archive}.sha256`)
    if (!textResult.ok) {
      collect(textResult)
    } else {
      const sidecar = parseSidecar(textResult.text, options.expectedArchiveName)
      collect(sidecar)
      if (sidecar.ok) {
        const sha = collect(await verifyArchiveSha(options.archive, sidecar.sha256))
        checks.sidecar = { ok: sidecar.ok && sha.ok, sha256: sidecar.sha256, actual: sha.actual ?? null }
      }
    }
  }

  let listing = null
  if (options.tarList) {
    const textResult = readTextFile(options.tarList)
    if (!textResult.ok) {
      collect(textResult)
    } else {
      listing = collect(analyzeTarListing(textResult.text, { allowedPrefixes: options.worldTar ? WORLD_PREFIXES : ARCHIVE_PREFIXES }))
      checks.tar = {
        ok: listing.ok,
        entries: listing.entries,
        fileEntries: listing.fileEntries,
        manifests: listing.manifests,
        databases: listing.databases,
        hasLevelDat: listing.hasLevelDat,
      }
      if (options.worldTar && listing.ok && !listing.hasLevelDat) {
        errors.push({ code: 'world_level_dat_missing', message: 'world archive does not contain world/level.dat' })
      }
    }
  }

  if (options.manifest) {    const textResult = readTextFile(options.manifest)
    if (!textResult.ok) {
      collect(textResult)
    } else {
      let parsed
      try {
        parsed = JSON.parse(textResult.text)
      } catch (error) {
        collect(failure('manifest_invalid', `manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`))
      }
      if (parsed !== undefined) {
        const manifestResult = collect(
          verifyManifest(parsed, {
            expectedMode: options.expectMode,
            expectedFileCount: options.expectFileCount ?? listing?.fileEntries ?? null,
          }),
        )
        checks.manifest = { ok: manifestResult.ok, details: manifestResult.details }
      }
    }
  } else if (options.expectMode) {
    errors.push({ code: 'invalid_arguments', message: '--expect-mode requires --manifest' })
  }

  if (options.db) {
    const dbResult = collect(verifyDb(options.db, { expectedSchemaVersion: options.expectedSchemaVersion }))
    checks.db = { ok: dbResult.ok, details: dbResult.details }
  }

  return { ok: errors.length === 0, checks, warnings, errors }
}

/** CLI 入口：单行 JSON，失败退出码 1。 */
async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.log(JSON.stringify({ ok: false, checks: {}, warnings: [], errors: [{ code: 'invalid_arguments', message: sanitizeAscii(error instanceof Error ? error.message : String(error)) }] }))
    process.exitCode = 1
    return
  }
  if (options.help) {
    console.log(
      JSON.stringify({
        ok: true,
        usage: 'node scripts/drill-verify.mjs --db <path> [--manifest <path>] [--tar-list <path>] [--sidecar <path> --archive <path>]',
        options: ['--db', '--manifest', '--tar-list', '--sidecar', '--archive', '--expect-archive-name', '--expect-mode', '--expect-file-count', '--schema-version', '--world-tar'],
      }),
    )
    return
  }
  if (!options.db && !options.manifest && !options.tarList && !options.archive) {
    console.log(JSON.stringify({ ok: false, checks: {}, warnings: [], errors: [{ code: 'invalid_arguments', message: 'nothing to verify: pass --db/--manifest/--tar-list/--archive' }] }))
    process.exitCode = 1
    return
  }
  const result = await runChecks(options)
  console.log(JSON.stringify(result))
  if (!result.ok) process.exitCode = 1
}

// 生产 release 可能经 current 符号链接调用；入口判断统一 realpath，避免静默不执行。
if (process.argv[1]) {
  let entryPath = process.argv[1]
  try {
    entryPath = realpathSync(entryPath)
  } catch {
    entryPath = resolve(entryPath)
  }
  if (import.meta.url === pathToFileURL(entryPath).href) main()
}
