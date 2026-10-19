#!/usr/bin/env node
/**
 * 依赖边界检查（CI 用）：
 * 服务端运行时只安装 `dependencies`（`npm ci --omit=dev`），这里静态扫描 server/src 的裸模块导入，
 * 确认没有引用 devDependencies 或未声明的包。避免本地有 node_modules 时漏掉生产依赖缺失。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join, relative } from 'node:path'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const prodDependencies = new Set(Object.keys(pkg.dependencies ?? {}))
const devDependencies = new Set(Object.keys(pkg.devDependencies ?? {}))
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)])

function walk(dir) {
  const files = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) files.push(...walk(full))
    else if (name.endsWith('.ts')) files.push(full)
  }
  return files
}

// 匹配静态 import/export、动态 import() 与 require()；只取模块说明符。
const specifierPattern =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function packageName(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

const problems = []
let scanned = 0
for (const file of walk(join(process.cwd(), 'server', 'src'))) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(specifierPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3]
    if (!specifier) continue
    if (specifier.startsWith('.') || specifier.startsWith('/')) continue
    if (specifier.startsWith('node:')) continue
    if (builtins.has(specifier)) continue
    if (specifier.startsWith('@types/')) continue
    scanned++
    const name = packageName(specifier)
    if (prodDependencies.has(name)) continue
    const where = `${relative(process.cwd(), file)}: ${specifier}`
    if (devDependencies.has(name)) problems.push(`运行时文件引用了 devDependency：${where}`)
    else problems.push(`运行时文件引用了未声明的依赖：${where}`)
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`)
  process.exit(1)
}
console.log(`依赖边界检查通过：扫描 server/src，裸导入 ${scanned} 处，均属于 dependencies 或 Node 内置模块`)
