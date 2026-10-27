/** 只读状态文件解析：大小上限、非法内容与缺失文件降级（DATA-05）。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_STATUS_FILE_BYTES, readStatusFile } from '../src/util/status.ts'

test('状态文件：合法对象读取，缺失/非对象/坏 JSON 降级 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afc-status-'))
  try {
    const valid = join(dir, 'ok.json')
    writeFileSync(valid, JSON.stringify({ lastRunAt: '2026-10-20T00:00:00.000Z', ok: true, kept: ['a'] }))
    assert.deepEqual(readStatusFile(valid), {
      lastRunAt: '2026-10-20T00:00:00.000Z',
      ok: true,
      kept: ['a'],
    })

    assert.equal(readStatusFile(join(dir, 'missing.json')), null)

    const invalid = join(dir, 'invalid.json')
    writeFileSync(invalid, 'not-json')
    assert.equal(readStatusFile(invalid), null)

    const array = join(dir, 'array.json')
    writeFileSync(array, '[1,2,3]')
    assert.equal(readStatusFile(array), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test(`状态文件超过 ${MAX_STATUS_FILE_BYTES} 字节降级 null（DATA-05）`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'afc-status-size-'))
  try {
    const exact = join(dir, 'exact.json')
    // 构造恰好等于上限的合法 JSON（key/value 全 ASCII，字节数=字符数）。
    const prefix = '{"padding":"'
    const suffix = '"}'
    const padding = 'x'.repeat(MAX_STATUS_FILE_BYTES - prefix.length - suffix.length)
    const exactText = `${prefix}${padding}${suffix}`
    assert.equal(Buffer.byteLength(exactText, 'utf8'), MAX_STATUS_FILE_BYTES)
    writeFileSync(exact, exactText)
    assert.notEqual(readStatusFile(exact), null, '恰好达到上限仍可读取')

    const oversized = join(dir, 'oversized.json')
    writeFileSync(oversized, `${prefix}${padding}x${suffix}`)
    assert.equal(readStatusFile(oversized), null, '超过上限应降级 null')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
