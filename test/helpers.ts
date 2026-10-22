import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Config } from '../src/config.ts'
import { loadConfig } from '../src/config.ts'
import { RuntimeState } from '../src/state.ts'

export function baseEnv (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    HTTP_TOKEN: '0123456789abcdef0123456789abcdef',
    AI_ENABLED: 'false',
    DATA_DIR: path.join(os.tmpdir(), 'lofii-bot-test-data'),
    ...overrides
  }
}

export function makeConfig (overrides: Partial<Config> = {}, envOverrides: Record<string, string | undefined> = {}): Config {
  return { ...loadConfig(baseEnv(envOverrides), '0.1.0'), ...overrides }
}

export function makeState (config: Config): RuntimeState {
  return new RuntimeState({
    version: config.version,
    username: config.botUsername,
    host: config.mcHost,
    port: config.mcPort,
    minecraftVersion: config.mcVersion === false ? 'auto' : config.mcVersion,
    presenceEnabled: config.presenceEnabled,
    presencePollMs: config.presencePollMs,
    presenceGraceMs: config.presenceGraceMs,
    presenceCheckMs: config.presenceCheckMs,
    aiEnabled: config.aiEnabled,
    aiProvider: config.aiModelProvider,
    aiModel: config.aiModelId
  })
}

export async function waitFor (predicate: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

export async function tempDir (prefix = 'lofii-bot-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

export async function removeDir (dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
