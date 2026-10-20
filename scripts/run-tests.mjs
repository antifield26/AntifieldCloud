#!/usr/bin/env node
/**
 * 测试收集器：把 server/test 的 TypeScript 测试与 scripts/test 的 Node 测试交给 node --test。
 *
 * 约定：
 * - server/test 下的 *.test.ts 由 Node 26 原生 TypeScript 擦除直接运行；
 * - scripts/test 下的 *.test.mjs 是运维脚本（备份/演练）自身的单元测试；
 * - 找不到任何测试时输出提示并以 0 退出（保持旧行为，避免空仓库 CI 误报）。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

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

const serverTests = collect('server/test', '.test.ts')
const scriptTests = collect('scripts/test', '.test.mjs')
const files = [...serverTests, ...scriptTests].sort()
if (files.length === 0) {
  console.log('no test files found')
  process.exit(0)
}
console.log(`运行 ${files.length} 个测试文件（server=${serverTests.length}，scripts=${scriptTests.length}）`)

// --coverage 由 CI 覆盖率 job 使用：只统计 server/src，阈值略低于当前基线并逐步收紧。
const coverage = process.argv.includes('--coverage')
const coverageArgs = coverage
  ? [
      '--experimental-test-coverage',
      '--test-coverage-include=server/src/**/*.ts',
      '--test-coverage-exclude=server/src/**/*.d.ts',
      '--test-coverage-lines=75',
      '--test-coverage-functions=75',
      '--test-coverage-branches=65',
    ]
  : []
const result = spawnSync(process.execPath, [...coverageArgs, '--test', ...files], { stdio: 'inherit' })
process.exit(result.status ?? 1)
