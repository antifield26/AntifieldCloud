#!/usr/bin/env node
/**
 * 版本一致性检查脚本（已接入 CI check job）。
 *
 * 比对 package.json 的 version 与 README / CHANGELOG / docs/ACCEPTANCE.md / AGENTS.md（缺失只警告），
 * 以及 lock 根版本、deploy/env.example 的 APP_VERSION、docs/DEPLOY.md 标题；输出单行 JSON，
 * 任一必需项不一致时退出码 1。
 *
 * 用法：`node scripts/check-version.mjs [--json] [--quiet] [--help]`
 * - 只读仓库文件，不修改任何内容；
 * - 版本号识别失败（文件缺失/未找到声明）也计为错误，避免“检查通过但没检查到”的假阳性。
 */
import { readFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const VERSION_PATTERN = /(\d+\.\d+\.\d+)/

/**
 * 工具版本清单：`deploy/tool-versions.json` 是 PC 侧脚本（deploy.ps1/drill.ps1）与 CI 共用的
 * “当前支持的 schema / OpenCode 版本”来源；它必须与 server/src/db.ts 的真实迁移数量一致，
 * 文档中的当前事实版本也由这里交叉校验，避免“代码已升级、文档/脚本还停在旧版本”。
 */
const TOOL_VERSIONS_FILE = 'deploy/tool-versions.json'

/** 读取并以严格格式校验工具版本清单；失败返回 {ok:false,error}。 */
function readToolVersions(root) {
  const path = resolve(root, TOOL_VERSIONS_FILE)
  if (!existsSync(path)) {
    return { ok: false, error: { code: 'tool_versions_missing', message: `${TOOL_VERSIONS_FILE} 不存在` } }
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { ok: false, error: { code: 'tool_versions_invalid', message: `${TOOL_VERSIONS_FILE} 不是合法 JSON` } }
  }
  if (!Number.isSafeInteger(parsed?.schemaVersion) || parsed.schemaVersion < 1) {
    return { ok: false, error: { code: 'tool_versions_invalid', message: `${TOOL_VERSIONS_FILE}.schemaVersion 必须是正整数` } }
  }
  if (typeof parsed?.opencodeVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(parsed.opencodeVersion)) {
    return { ok: false, error: { code: 'tool_versions_invalid', message: `${TOOL_VERSIONS_FILE}.opencodeVersion 必须是 x.y.z` } }
  }
  return { ok: true, schemaVersion: parsed.schemaVersion, opencodeVersion: parsed.opencodeVersion }
}

/** 从 apps/workbench/server/src/db.ts 动态导入 SUPPORTED_SCHEMA_VERSION（只读，不打开 DB）。 */
async function readDbSchemaVersion(root) {
  const path = resolve(root, 'apps/workbench/server/src/db.ts')
  if (!existsSync(path)) return { ok: false, error: { code: 'db_ts_missing', message: 'apps/workbench/server/src/db.ts 不存在' } }
  try {
    const module = await import(pathToFileURL(path).href)
    const version = module.SUPPORTED_SCHEMA_VERSION
    if (!Number.isSafeInteger(version) || version < 1) {
      return { ok: false, error: { code: 'db_schema_invalid', message: 'SUPPORTED_SCHEMA_VERSION 不是正整数' } }
    }
    return { ok: true, version }
  } catch (error) {
    return { ok: false, error: { code: 'db_schema_unreadable', message: `无法导入 apps/workbench/server/src/db.ts：${error instanceof Error ? error.message : String(error)}` } }
  }
}

/** 在一段文本中取第一个版本号并与期望值比较（用于文档“当前事实”交叉校验）。 */
function checkFirstVersion(file, text, pattern, expectedVersion, code, required = true) {
  const result = { file, expected: expectedVersion, version: null, ok: false, error: null, code }
  if (typeof text !== 'string') {
    result.error = 'file_missing'
    return result
  }
  const match = pattern.exec(text)
  if (!match) {
    result.error = 'version_not_found'
    return result
  }
  result.version = match[1]
  result.ok = match[1] === expectedVersion
  if (!result.ok) result.error = 'version_mismatch'
  if (!required) result.ok = true
  return result
}

/** 读取文件文本；失败返回 null（不抛异常，由调用方记错误）。 */
function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 从文本中按规则提取版本号。 */
function extractVersion(text, pattern) {
  if (typeof text !== 'string') return null
  const match = pattern.exec(text)
  return match ? match[1] : null
}

/** 检查单个文件：返回 {file, expected, required, ok, error?}。 */
function checkFile(file, pattern, packageVersion, required = true) {
  const path = resolve(file)
  const result = { file, required, ok: false, version: null, error: null }
  if (!existsSync(path)) {
    result.error = 'file_missing'
    return result
  }
  const text = readText(path)
  if (text === null) {
    result.error = 'file_unreadable'
    return result
  }
  const version = extractVersion(text, pattern)
  if (!version) {
    result.error = 'version_not_found'
    return result
  }
  result.version = version
  result.ok = version === packageVersion
  if (!result.ok) result.error = 'version_mismatch'
  return result
}

/** 执行全部检查并返回结构化结果（含 schema/OpenCode/文档当前事实交叉校验）。 */
export async function checkVersions(root = process.cwd()) {
  const resolvedRoot = resolve(root)
  const rootPackagePath = resolve(resolvedRoot, 'package.json')
  const appPackagePath = resolve(resolvedRoot, 'apps/workbench/package.json')
  const errors = []
  const appPackageText = readText(appPackagePath)
  if (appPackageText === null) {
    return { ok: false, packageVersion: null, checks: [], errors: [{ code: 'app_package_missing', message: `cannot read ${appPackagePath}` }] }
  }
  let packageVersion
  try {
    packageVersion = JSON.parse(appPackageText).version ?? null
  } catch {
    return { ok: false, packageVersion: null, checks: [], errors: [{ code: 'app_package_invalid', message: `${appPackagePath} is not valid JSON` }] }
  }
  if (!packageVersion || !VERSION_PATTERN.test(packageVersion)) {
    return {
      ok: false,
      packageVersion,
      checks: [],
      errors: [{ code: 'app_package_version_invalid', message: `apps/workbench/package.json version is invalid: ${JSON.stringify(packageVersion)}` }],
    }
  }
  // 根编排包与 workbench 必须同版本（v1.0.0 起统一版本轴）。
  const rootPackageText = readText(rootPackagePath)
  if (rootPackageText === null) {
    errors.push({ code: 'root_package_missing', message: `cannot read ${rootPackagePath}` })
  } else {
    try {
      const rootVersion = JSON.parse(rootPackageText).version ?? null
      if (rootVersion !== packageVersion) {
        errors.push({ code: 'root_version_mismatch', message: `package.json: expected ${packageVersion}, found ${rootVersion}` })
      }
    } catch {
      errors.push({ code: 'root_package_invalid', message: `${rootPackagePath} is not valid JSON` })
    }
  }

  const checks = [
    checkFile(resolve(resolvedRoot, 'README.md'), /状态[：:]\s*v?(\d+\.\d+\.\d+)/, packageVersion),
    checkFile(resolve(resolvedRoot, 'CHANGELOG.md'), /^##\s*\[?v?(\d+\.\d+\.\d+)\]?/m, packageVersion),
    checkFile(resolve(resolvedRoot, 'docs/ACCEPTANCE.md'), /当前版本\s*v?(\d+\.\d+\.\d+)/, packageVersion),
    checkFile(resolve(resolvedRoot, 'deploy/env.example'), /APP_VERSION=(\d+\.\d+\.\d+)/, packageVersion),
    checkFile(resolve(resolvedRoot, 'docs/DEPLOY.md'), /^# 部署手册[^\n]*v(\d+\.\d+\.\d+)/m, packageVersion),
    // AGENTS.md 不是严格必需项：缺失/未声明只记警告。
    checkFile(resolve(resolvedRoot, 'AGENTS.md'), /当前版本\s*v?(\d+\.\d+\.\d+)/, packageVersion, false),
  ]
  // lock 根版本：npm ci 不校验它，但 SBOM/审计会误读（OPS4-10）。
  const lockText = readText(resolve(resolvedRoot, 'package-lock.json'))
  if (lockText === null) {
    errors.push({ code: 'lock_missing', message: 'package-lock.json 不存在' })
  } else {
    try {
      const lock = JSON.parse(lockText)
      const versions = [lock.version, lock.packages?.['']?.version].filter(Boolean)
      for (const version of versions) {
        if (version !== packageVersion) {
          errors.push({ code: 'lock_version_mismatch', message: `package-lock.json: expected ${packageVersion}, found ${version}` })
        }
      }
    } catch {
      errors.push({ code: 'lock_invalid', message: 'package-lock.json 不是合法 JSON' })
    }
  }
  for (const check of checks) {
    if (!check.ok) {
      if (check.required) {
        errors.push({ code: check.error ?? 'version_mismatch', message: `${check.file}: expected ${packageVersion}, found ${check.version ?? 'none'}` })
      }
    }
  }

  // ---- 工具版本（schema / OpenCode）交叉校验 ----
  // 这些是“当前事实”门禁：PC 脚本（deploy.ps1/drill.ps1）从 deploy/tool-versions.json 取默认期望值，
  // 文档/CI 中的当前版本必须与 db.ts 的真实迁移数量、以及工具清单一致。
  const toolChecks = []
  const toolVersions = readToolVersions(resolvedRoot)
  if (!toolVersions.ok) {
    errors.push(toolVersions.error)
  } else {
    const dbSchema = await readDbSchemaVersion(resolvedRoot)
    if (!dbSchema.ok) {
      errors.push(dbSchema.error)
    } else if (dbSchema.version !== toolVersions.schemaVersion) {
      errors.push({
        code: 'schema_version_mismatch',
        message: `${TOOL_VERSIONS_FILE}.schemaVersion=${toolVersions.schemaVersion} 与 server/src/db.ts SUPPORTED_SCHEMA_VERSION=${dbSchema.version} 不一致`,
      })
    }

    const allowStaleTools = process.env.CHECK_VERSION_ALLOW_STALE_TOOLS === '1'
    if (!allowStaleTools) {
      // 文档“当前事实”版本检查：只校验当前版本的头部/当前事实句，历史记录由人工判断。
      const docChecks = [
        ['docs/DEPLOY.md', /^##\s*3\.2\s+OpenCode v(\d+\.\d+\.\d+)/m, toolVersions.opencodeVersion, 'opencode'],
        ['docs/DEPLOY.md', /当前 schema \*\*v(\d+)\*\*/, String(toolVersions.schemaVersion), 'schema'],
        ['AGENTS.md', /OpenCode\s*(?:服务端\s*)?(?:\*\*)?v(\d+\.\d+\.\d+)/, toolVersions.opencodeVersion, 'opencode'],
        ['README.md', /OpenCode\s*\*\*v(\d+\.\d+\.\d+)\*\*/, toolVersions.opencodeVersion, 'opencode'],
        ['docs/SECURITY.md', /当前生产\s*\*\*v(\d+\.\d+\.\d+)\*\*/, toolVersions.opencodeVersion, 'opencode'],
        ['docs/BOT.md', /兼容性基于 OpenCode v(\d+\.\d+\.\d+)/, toolVersions.opencodeVersion, 'opencode'],
        ['docs/ACCEPTANCE.md', /OpenCode v(\d+\.\d+\.\d+)/, toolVersions.opencodeVersion, 'opencode'],
      ]
      for (const [file, pattern, expected, kind] of docChecks) {
        const text = readText(resolve(resolvedRoot, file))
        const result = checkFirstVersion(file, text, pattern, expected, `${kind}_doc_version_mismatch`, true)
        toolChecks.push(result)
        if (!result.ok) {
          errors.push({
            code: result.code ?? `${kind}_doc_version_mismatch`,
            message: `${file}: 当前事实期望 ${kind === 'schema' ? 'v' : 'OpenCode v'}${expected}，实际 ${result.version ? `v${result.version}` : result.error}`,
          })
        }
      }
    }
  }

  return { ok: errors.length === 0, packageVersion, toolVersions: toolVersions.ok ? toolVersions : null, checks: [...checks, ...toolChecks], errors }
}

/** CLI 入口：默认输出 JSON；--quiet 只输出一行摘要。 */
async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log(
      JSON.stringify({
        ok: true,
        usage: 'node scripts/check-version.mjs [--json] [--quiet]',
        env: ['CHECK_VERSION_ALLOW_STALE_TOOLS=1 跳过 OpenCode/schema 文档当前事实检查（仅用于文档同步过渡期）'],
      }),
    )
    return
  }
  const result = await checkVersions()
  const unknown = args.filter((arg) => !['--json', '--quiet'].includes(arg))
  if (unknown.length > 0) {
    console.log(JSON.stringify({ ok: false, errors: [{ code: 'invalid_arguments', message: `unknown arguments: ${unknown.join(' ')}` }] }))
    process.exitCode = 1
    return
  }
  if (args.includes('--quiet')) {
    if (result.ok) {
      console.log(`version ok ${result.packageVersion}`)
    } else {
      for (const error of result.errors) console.log(`version mismatch: ${error.code} ${error.message}`)
    }
  } else {
    console.log(JSON.stringify(result))
  }
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
