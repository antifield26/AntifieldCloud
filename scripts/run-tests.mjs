import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/** 收集 server/test 下所有 .test.ts，交给 node --test 运行。 */
function collect(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...collect(full))
    else if (name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

const files = collect('server/test').sort()
if (files.length === 0) {
  console.log('no test files found')
  process.exit(0)
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
process.exit(result.status ?? 1)
