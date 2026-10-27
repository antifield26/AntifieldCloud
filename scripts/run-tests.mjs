#!/usr/bin/env node
/**
 * 测试收集器（workspaces 版）：把应用包的 TypeScript 测试与 scripts/test 的运维脚本测试交给 node --test。
 *
 * 约定：
 * - `--app-dir <dir>` 指向应用包目录（默认 apps/workbench；相对路径基于当前 cwd）；
 * - 应用测试位于 `<app>/server/test/*.test.ts`，运维脚本测试位于仓库 `scripts/test/*.test.mjs`；
 * - 子进程统一以仓库根为 cwd 运行，保持既有测试中的 `process.cwd()`/相对路径语义；
 * - `--coverage` 由 CI 覆盖率 job 使用：只统计 `<app>/server/src`，阈值沿用旧基线，回退即失败；
 * - 找不到任何测试时输出提示并以 0 退出（保持旧行为，避免空仓库 CI 误报）。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 读取形如 `--name value` 的参数值。 */
function readArg(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

/** 递归收集目录下指定后缀的测试文件；目录不存在时返回空数组。 */
function collect(dir, suffix) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...collect(full, suffix))
    else if (name.endsWith(suffix)) out.push(full)
  }
  return out
}

const args = process.argv.slice(2)
const appDirArg = readArg(args, '--app-dir')
const appDir = appDirArg ? resolve(process.cwd(), appDirArg) : resolve(repoRoot, 'apps', 'workbench')
const appDirRelative = relative(repoRoot, appDir).replaceAll('\\', '/') || '.'

const serverTests = collect(join(appDir, 'server', 'test'), '.test.ts')
const scriptTests = collect(join(repoRoot, 'scripts', 'test'), '.test.mjs')
const files = [...serverTests, ...scriptTests].sort()
if (files.length === 0) {
  console.log('no test files found')
  process.exit(0)
}
console.log(`运行 ${files.length} 个测试文件（app=${serverTests.length}，scripts=${scriptTests.length}，appDir=${appDirRelative}）`)

// --coverage 由 CI 覆盖率 job 使用：只统计应用 server/src；阈值贴近 v0.6.6 基线
// （Lines 92.34% / Branches 77.48% / Functions 87.23%），留少量波动空间，回退即失败（OPS-18）。
const coverage = args.includes('--coverage')
const coverageArgs = coverage
  ? [
      '--experimental-test-coverage',
      `--test-coverage-include=${appDirRelative}/server/src/**/*.ts`,
      `--test-coverage-exclude=${appDirRelative}/server/src/**/*.d.ts`,
      '--test-coverage-lines=91',
      '--test-coverage-functions=85',
      '--test-coverage-branches=76',
    ]
  : []
const result = spawnSync(process.execPath, [...coverageArgs, '--test', ...files], { stdio: 'inherit', cwd: repoRoot })
process.exit(result.status ?? 1)
