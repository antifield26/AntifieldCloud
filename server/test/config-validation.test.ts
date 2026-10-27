/** ARCH-08/SEC-09：配置解析失败即退出，不再静默回退。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { ensureRuntimeDirs, loadConfig } from '../src/config.ts'
import { cleanupDir, tempDataDir } from './helpers.ts'

function baseEnv(dir: string): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DATA_DIR: dir,
    WEB_DIST_DIR: dir,
    APP_ORIGIN: 'https://app.example.com',
    AI_ORIGIN: 'https://ai.example.com',
  }
}

test('NODE_ENV 非法值拒绝启动（不再静默当 development）', () => {
  const dir = tempDataDir()
  try {
    assert.throws(
      () => loadConfig({ ...baseEnv(dir), NODE_ENV: 'staging' }),
      /NODE_ENV 非法/,
    )
  } finally {
    cleanupDir(dir)
  }
})

test('OPENCODE_URL 必须 loopback（防止代理凭据发往外部主机）', () => {
  const dir = tempDataDir()
  try {
    assert.throws(
      () => loadConfig({ ...baseEnv(dir), OPENCODE_URL: 'http://10.0.0.5:4096' }),
      /必须指向 loopback/,
    )
    assert.doesNotThrow(() => loadConfig({ ...baseEnv(dir), OPENCODE_URL: 'http://127.0.0.1:4096' }))
  } finally {
    cleanupDir(dir)
  }
})

test('APP_ORIGIN 与 AI_ORIGIN 不能相同', () => {
  const dir = tempDataDir()
  try {
    assert.throws(
      () => loadConfig({ ...baseEnv(dir), AI_ORIGIN: 'https://app.example.com' }),
      /不能相同/,
    )
  } finally {
    cleanupDir(dir)
  }
})

test('BOT_SEARCH_MODE 非法值拒绝启动', () => {
  const dir = tempDataDir()
  try {
    assert.throws(
      () => loadConfig({ ...baseEnv(dir), BOT_SEARCH_MODE: 'mcp-typo' }),
      /BOT_SEARCH_MODE 非法/,
    )
  } finally {
    cleanupDir(dir)
  }
})

test('APP_VERSION 未设置时使用开发默认值，不再回退到历史版本号', () => {
  const dir = tempDataDir()
  try {
    const config = loadConfig(baseEnv(dir))
    assert.equal(config.appVersion, '0.0.0-dev')
  } finally {
    cleanupDir(dir)
  }
})

test('BOT_AI_CONTEXT_READ_ENABLED：生产必须显式设置 BOT_CONTEXT_DIR', () => {
  const dir = tempDataDir()
  try {
    assert.throws(
      () =>
        loadConfig({
          ...baseEnv(dir),
          NODE_ENV: 'production',
          BOT_AI_CONTEXT_READ_ENABLED: 'true',
        }),
      /必须显式设置 BOT_CONTEXT_DIR/,
    )
  } finally {
    cleanupDir(dir)
  }
})

test('BOT_AI_CONTEXT_READ_ENABLED：生产拒绝 DATA_DIR 内路径与通配符', () => {
  const dir = tempDataDir()
  try {
    assert.throws(
      () =>
        loadConfig({
          ...baseEnv(dir),
          NODE_ENV: 'production',
          BOT_AI_CONTEXT_READ_ENABLED: 'true',
          BOT_CONTEXT_DIR: join(dir, 'bot-context'),
        }),
      /不能位于 DATA_DIR 内/,
    )
    assert.throws(
      () =>
        loadConfig({
          ...baseEnv(dir),
          BOT_AI_CONTEXT_READ_ENABLED: 'true',
          BOT_CONTEXT_DIR: `${dir}/*`,
        }),
      /不能包含 \* 或 \?/,
    )
    assert.throws(
      () =>
        loadConfig({
          ...baseEnv(dir),
          BOT_AI_CONTEXT_READ_ENABLED: 'true',
          BOT_CONTEXT_DIR: 'relative/context',
        }),
      /必须是绝对路径/,
    )
  } finally {
    cleanupDir(dir)
  }
})

test('BOT_AI_CONTEXT_READ_ENABLED：非生产默认目录可加载；生产缺失目录启动失败', () => {
  const dir = tempDataDir()
  try {
    const dev = loadConfig({ ...baseEnv(dir), BOT_AI_CONTEXT_READ_ENABLED: 'true' })
    assert.equal(dev.botAiContextReadEnabled, true)
    assert.equal(dev.botContextDir, join(dir, 'bot-context'))

    const missing = join(tmpdir(), `antifieldcloud-missing-${randomUUID()}`)
    const prod = loadConfig({
      ...baseEnv(dir),
      NODE_ENV: 'production',
      BOT_AI_CONTEXT_READ_ENABLED: 'true',
      BOT_CONTEXT_DIR: missing,
    })
    assert.throws(() => ensureRuntimeDirs(prod), /BOT_CONTEXT_DIR 不存在/)
  } finally {
    cleanupDir(dir)
  }
})
