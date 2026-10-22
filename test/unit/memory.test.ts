import assert from 'node:assert/strict'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { MemoryStore } from '../../src/memory/store.ts'
import { createLogger } from '../../src/logger.ts'
import { removeDir, tempDir } from '../helpers.ts'

const logger = createLogger('error')
const uuid = '3890dd7d-94a9-354d-8adc-351bffd69d12'

test('stores and reloads per-player memory', async () => {
  const dir = await tempDir('lofii-memory-')
  try {
    const store = new MemoryStore({ dir, maxTurns: 2, retentionDays: 30, logger })
    await store.init()
    await store.append('Antifield', uuid, '你好', '你好呀')
    assert.deepEqual(store.load('Antifield', uuid).map(turn => turn.text), ['你好', '你好呀'])
    assert.deepEqual(store.stats(), { players: 1, turns: 2 })

    const files = await readdir(dir)
    assert.equal(files.filter(name => name.endsWith('.json')).length, 1)
    const parsed = JSON.parse(await readFile(path.join(dir, files[0] ?? ''), 'utf8')) as { player: string }
    assert.equal(parsed.player, 'Antifield')

    const second = new MemoryStore({ dir, maxTurns: 2, retentionDays: 30, logger })
    await second.init()
    assert.deepEqual(second.load('Antifield', uuid).map(turn => turn.text), ['你好', '你好呀'])
    await second.stop()
    await store.stop()
  } finally {
    await removeDir(dir)
  }
})

test('trims memory to the configured turn count', async () => {
  const dir = await tempDir('lofii-memory-')
  try {
    const store = new MemoryStore({ dir, maxTurns: 1, retentionDays: 30, logger })
    await store.init()
    await store.append('Antifield', uuid, 'one', 'a')
    await store.append('Antifield', uuid, 'two', 'b')
    await store.append('Antifield', uuid, 'three', 'c')
    assert.deepEqual(store.load('Antifield', uuid).map(turn => turn.text), ['three', 'c'])
    await store.stop()
  } finally {
    await removeDir(dir)
  }
})

test('quarantines corrupt memory files', async () => {
  const dir = await tempDir('lofii-memory-')
  try {
    const broken = path.join(dir, `${uuid}.json`)
    await writeFile(broken, '{not json', 'utf8')
    const store = new MemoryStore({ dir, maxTurns: 2, retentionDays: 30, logger })
    await store.init()
    assert.equal(store.load('Antifield', uuid).length, 0)
    const files = await readdir(dir)
    assert.ok(files.some(name => name.includes('.corrupt-')))
    await store.stop()
  } finally {
    await removeDir(dir)
  }
})

test('drops turns older than the retention window', async () => {
  const dir = await tempDir('lofii-memory-')
  try {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    const recent = new Date().toISOString()
    await writeFile(path.join(dir, `${uuid}.json`), JSON.stringify({
      version: 1,
      player: 'Antifield',
      uuid,
      updatedAt: recent,
      turns: [
        { role: 'user', text: 'old', at: old },
        { role: 'assistant', text: 'old reply', at: old },
        { role: 'user', text: 'new', at: recent },
        { role: 'assistant', text: 'new reply', at: recent }
      ]
    }), 'utf8')
    const store = new MemoryStore({ dir, maxTurns: 4, retentionDays: 30, logger })
    await store.init()
    assert.deepEqual(store.load('Antifield', uuid).map(turn => turn.text), ['new', 'new reply'])
    await store.stop()
  } finally {
    await removeDir(dir)
  }
})
