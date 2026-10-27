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

test('CHATBOT_SEARCH_MODE 非法值拒绝启动', () => {
  const dir = tempDataDir()
  try {
    assert.throws(
      () => loadConfig({ ...baseEnv(dir), CHATBOT_SEARCH_MODE: 'mcp-typo' }),
      /CHATBOT_SEARCH_MODE 非法/,
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

test('CHATBOT_AI_CONTEXT_READ_ENABLED：生产必须显式设置 CHATBOT_CONTEXT_DIR', () => {
  const dir = tempDataDir()
  try {
    assert.throws(
      () =>
        loadConfig({
          ...baseEnv(dir),
          NODE_ENV: 'production',
          CHATBOT_AI_CONTEXT_READ_ENABLED: 'true',
        }),
      /必须显式设置 CHATBOT_CONTEXT_DIR/,
    )
  } finally {
    cleanupDir(dir)
  }
})

test('CHATBOT_AI_CONTEXT_READ_ENABLED：生产拒绝 DATA_DIR 内路径与通配符', () => {
  const dir = tempDataDir()
  try {
    assert.throws(
      () =>
        loadConfig({
          ...baseEnv(dir),
          NODE_ENV: 'production',
          CHATBOT_AI_CONTEXT_READ_ENABLED: 'true',
          CHATBOT_CONTEXT_DIR: join(dir, 'chatbot-context'),
        }),
      /不能位于 DATA_DIR 内/,
    )
    assert.throws(
      () =>
        loadConfig({
          ...baseEnv(dir),
          CHATBOT_AI_CONTEXT_READ_ENABLED: 'true',
          CHATBOT_CONTEXT_DIR: `${dir}/*`,
        }),
      /不能包含 \* 或 \?/,
    )
    assert.throws(
      () =>
        loadConfig({
          ...baseEnv(dir),
          CHATBOT_AI_CONTEXT_READ_ENABLED: 'true',
          CHATBOT_CONTEXT_DIR: 'relative/context',
        }),
      /必须是绝对路径/,
    )
  } finally {
    cleanupDir(dir)
  }
})

test('CHATBOT_AI_CONTEXT_READ_ENABLED：非生产默认目录可加载；生产缺失目录启动失败', () => {
  const dir = tempDataDir()
  try {
    const dev = loadConfig({ ...baseEnv(dir), CHATBOT_AI_CONTEXT_READ_ENABLED: 'true' })
    assert.equal(dev.chatbotAiContextReadEnabled, true)
    assert.equal(dev.chatbotContextDir, join(dir, 'chatbot-context'))

    const missing = join(tmpdir(), `antifieldcloud-missing-${randomUUID()}`)
    const prod = loadConfig({
      ...baseEnv(dir),
      NODE_ENV: 'production',
      CHATBOT_AI_CONTEXT_READ_ENABLED: 'true',
      CHATBOT_CONTEXT_DIR: missing,
    })
    assert.throws(() => ensureRuntimeDirs(prod), /CHATBOT_CONTEXT_DIR 不存在/)
  } finally {
    cleanupDir(dir)
  }
})

test('LOFII_* 默认值：关闭、loopback 默认地址、读控 Token 为空、2.5s/5s、告警开启', () => {
  const dir = tempDataDir()
  try {
    const config = loadConfig(baseEnv(dir))
    assert.equal(config.lofiiEnabled, false)
    assert.equal(config.lofiiUrl, 'http://127.0.0.1:3010')
    assert.equal(config.lofiiReadToken, '')
    assert.equal(config.lofiiControlToken, '')
    assert.equal(config.lofiiTimeoutMs, 2500)
    assert.equal(config.lofiiPollMs, 5000)
    assert.equal(config.lofiiAlertsEnabled, true)
    // 关闭状态下允许空 Token 与任意（未校验）地址，便于随时开关。
    assert.doesNotThrow(() => loadConfig({ ...baseEnv(dir), LOFII_ENABLED: 'false' }))
  } finally {
    cleanupDir(dir)
  }
})

test('LOFII_URL 去尾斜杠，启用时必须 loopback 且 http(s)', () => {
  const dir = tempDataDir()
  try {
    const config = loadConfig({
      ...baseEnv(dir),
      LOFII_ENABLED: 'true',
      LOFII_READ_TOKEN: 'read-token',
      LOFII_URL: 'http://127.0.0.1:3010/',
    })
    assert.equal(config.lofiiUrl, 'http://127.0.0.1:3010')
    assert.doesNotThrow(() =>
      loadConfig({
        ...baseEnv(dir),
        LOFII_ENABLED: 'true',
        LOFII_READ_TOKEN: 'read-token',
        LOFII_URL: 'http://localhost:3010',
      }),
    )
    assert.throws(
      () =>
        loadConfig({
          ...baseEnv(dir),
          LOFII_ENABLED: 'true',
          LOFII_READ_TOKEN: 'read-token',
          LOFII_URL: 'http://10.0.0.5:3010',
        }),
      /必须指向 loopback/,
    )
    assert.throws(
      () =>
        loadConfig({
          ...baseEnv(dir),
          LOFII_ENABLED: 'true',
          LOFII_READ_TOKEN: 'read-token',
          LOFII_URL: 'ftp://127.0.0.1:3010',
        }),
      /必须是 http\(s\) URL/,
    )
    assert.throws(
      () =>
        loadConfig({
          ...baseEnv(dir),
          LOFII_ENABLED: 'true',
          LOFII_READ_TOKEN: 'read-token',
          LOFII_URL: 'http://user:pass@127.0.0.1:3010',
        }),
      /不允许包含用户名\/密码/,
    )
    for (const lofiiUrl of [
      'http://127.0.0.1:3010/api',
      'http://127.0.0.1:3010/?x=1',
      'http://127.0.0.1:3010/#fragment',
    ]) {
      assert.throws(
        () =>
          loadConfig({
            ...baseEnv(dir),
            LOFII_ENABLED: 'true',
            LOFII_READ_TOKEN: 'read-token',
            LOFII_URL: lofiiUrl,
          }),
        /只允许 scheme:\/\/host\[:port\]/,
      )
    }
  } finally {
    cleanupDir(dir)
  }
})

test('LOFII_ENABLED=true 必须配置 LOFII_READ_TOKEN', () => {
  const dir = tempDataDir()
  try {
    assert.throws(
      () => loadConfig({ ...baseEnv(dir), LOFII_ENABLED: 'true' }),
      /必须配置 LOFII_READ_TOKEN/,
    )
    // 只要读 Token；控制 Token 为空表示只读，允许启动。
    const readonly = loadConfig({ ...baseEnv(dir), LOFII_ENABLED: 'true', LOFII_READ_TOKEN: 'read-only' })
    assert.equal(readonly.lofiiControlToken, '')
  } finally {
    cleanupDir(dir)
  }
})

test('LOFII_TIMEOUT_MS / LOFII_POLL_MS 越界拒绝启动，边界值可加载', () => {
  const dir = tempDataDir()
  try {
    assert.throws(() => loadConfig({ ...baseEnv(dir), LOFII_TIMEOUT_MS: '100' }), /LOFII_TIMEOUT_MS 非法/)
    assert.throws(() => loadConfig({ ...baseEnv(dir), LOFII_TIMEOUT_MS: '10001' }), /LOFII_TIMEOUT_MS 非法/)
    assert.throws(() => loadConfig({ ...baseEnv(dir), LOFII_POLL_MS: '1999' }), /LOFII_POLL_MS 非法/)
    assert.throws(() => loadConfig({ ...baseEnv(dir), LOFII_POLL_MS: '60001' }), /LOFII_POLL_MS 非法/)
    const bounds = loadConfig({ ...baseEnv(dir), LOFII_TIMEOUT_MS: '500', LOFII_POLL_MS: '2000' })
    assert.equal(bounds.lofiiTimeoutMs, 500)
    assert.equal(bounds.lofiiPollMs, 2000)
    const upper = loadConfig({ ...baseEnv(dir), LOFII_TIMEOUT_MS: '10000', LOFII_POLL_MS: '60000' })
    assert.equal(upper.lofiiTimeoutMs, 10_000)
    assert.equal(upper.lofiiPollMs, 60_000)
  } finally {
    cleanupDir(dir)
  }
})

test('LOFII_ALERTS_ENABLED 非法布尔值拒绝启动', () => {
  const dir = tempDataDir()
  try {
    assert.throws(
      () => loadConfig({ ...baseEnv(dir), LOFII_ALERTS_ENABLED: 'maybe' }),
      /LOFII_ALERTS_ENABLED 非法布尔值/,
    )
    assert.equal(loadConfig({ ...baseEnv(dir), LOFII_ALERTS_ENABLED: 'false' }).lofiiAlertsEnabled, false)
  } finally {
    cleanupDir(dir)
  }
})
