import { readFileSync } from 'node:fs'

export interface PackageInfo {
  name: string
  version: string
}

export function readPackageInfo (): PackageInfo {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  const parsed = JSON.parse(raw) as { name?: unknown, version?: unknown }
  const name = typeof parsed.name === 'string' ? parsed.name : 'lofii-bot'
  const version = typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  return { name, version }
}
