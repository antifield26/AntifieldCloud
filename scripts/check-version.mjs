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

/** 执行全部检查并返回结构化结果。 */
export function checkVersions(root = process.cwd()) {
  const resolvedRoot = resolve(root)
  const packagePath = resolve(resolvedRoot, 'package.json')
  const errors = []
  const packageText = readText(packagePath)
  if (packageText === null) {
    return { ok: false, packageVersion: null, checks: [], errors: [{ code: 'package_missing', message: `cannot read ${packagePath}` }] }
  }
  let packageVersion
  try {
    packageVersion = JSON.parse(packageText).version ?? null
  } catch {
    return { ok: false, packageVersion: null, checks: [], errors: [{ code: 'package_invalid', message: `${packagePath} is not valid JSON` }] }
  }
  if (!packageVersion || !VERSION_PATTERN.test(packageVersion)) {
    return {
      ok: false,
      packageVersion,
      checks: [],
      errors: [{ code: 'package_version_invalid', message: `package.json version is invalid: ${JSON.stringify(packageVersion)}` }],
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
  return { ok: errors.length === 0, packageVersion, checks, errors }
}

/** CLI 入口：默认输出 JSON；--quiet 只输出一行摘要。 */
function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log(JSON.stringify({ ok: true, usage: 'node scripts/check-version.mjs [--json] [--quiet]' }))
    return
  }
  const result = checkVersions()
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
  main()
}
