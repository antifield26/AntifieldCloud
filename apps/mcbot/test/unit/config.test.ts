import assert from 'node:assert/strict'
import test from 'node:test'
import { ConfigError, loadConfig } from '../../src/config.ts'
import { baseEnv } from '../helpers.ts'

test('loads defaults with minimal environment', () => {
  const config = loadConfig(baseEnv(), '0.1.0')
  assert.equal(config.version, '0.1.0')
  assert.equal(config.botUsername, 'lofii')
  assert.equal(config.mcHost, '127.0.0.1')
  assert.equal(config.mcPort, 25565)
  assert.equal(config.httpHost, '127.0.0.1')
  assert.equal(config.httpPort, 3010)
  assert.deepEqual(config.commandAllowlist, ['Antifield'])
  assert.equal(config.aiEnabled, false)
  assert.equal(config.mcVersion, '26.1')
})

test('requires an HTTP token of reasonable length', () => {
  assert.throws(() => loadConfig({ ...baseEnv(), HTTP_TOKEN: undefined }), ConfigError)
  assert.throws(() => loadConfig({ ...baseEnv(), HTTP_TOKEN: 'short' }), ConfigError)
})

test('requires OpenCode password when AI is enabled', () => {
  assert.throws(() => loadConfig({ ...baseEnv(), AI_ENABLED: 'true' }), ConfigError)
  const config = loadConfig({ ...baseEnv(), AI_ENABLED: 'true', OPENCODE_PASSWORD: 'secret' }, '0.1.0')
  assert.equal(config.aiEnabled, true)
  assert.equal(config.aiModelProvider, 'opencode-go')
  assert.equal(config.aiModelId, 'deepseek-v4.1-flash')
})

test('refuses non-loopback HTTP unless explicitly allowed', () => {
  assert.throws(() => loadConfig({ ...baseEnv(), HTTP_HOST: '0.0.0.0' }), ConfigError)
  const config = loadConfig({ ...baseEnv(), HTTP_HOST: '0.0.0.0', HTTP_ALLOW_NON_LOOPBACK: 'true' }, '0.1.0')
  assert.equal(config.httpHost, '0.0.0.0')
})

test('parses command allowlist safely', () => {
  assert.deepEqual(loadConfig({ ...baseEnv(), COMMAND_ALLOWLIST: 'Antifield, mcbot ,Antifield' }, '0.1.0').commandAllowlist, ['Antifield', 'mcbot'])
  assert.throws(() => loadConfig({ ...baseEnv(), COMMAND_ALLOWLIST: ' , ' }, '0.1.0'), ConfigError)
})

test('validates numbers and booleans', () => {
  assert.throws(() => loadConfig({ ...baseEnv(), HTTP_PORT: 'nope' }, '0.1.0'), ConfigError)
  assert.throws(() => loadConfig({ ...baseEnv(), HTTP_PORT: '70000' }, '0.1.0'), ConfigError)
  assert.throws(() => loadConfig({ ...baseEnv(), PRESENCE_ENABLED: 'maybe' }, '0.1.0'), ConfigError)
})
