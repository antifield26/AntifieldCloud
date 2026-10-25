/** ARCH-08/SEC-09：配置解析失败即退出，不再静默回退。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.ts'
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
