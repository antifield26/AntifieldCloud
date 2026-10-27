import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseListResponse,
  parseTpsResponse,
  parseWhitelistResponse,
  validatePlayerName,
} from '../src/mc/service.ts'

test('解析中文玩家列表', () => {
  const parsed = parseListResponse('§6当前有§c2§6位玩家在线，可容纳最大在线人数为§c5§6位玩家。\n')
  assert.equal(parsed.online, 2)
  assert.equal(parsed.max, 5)
  assert.deepEqual(parsed.names, [])
})

test('解析英文玩家列表与玩家名', () => {
  const parsed = parseListResponse('There are 2 of a max of 5 players online: Steve, Alex')
  assert.equal(parsed.online, 2)
  assert.equal(parsed.max, 5)
  assert.deepEqual(parsed.names, ['Steve', 'Alex'])
})

test('解析白名单列表', () => {
  const names = parseWhitelistResponse('There are 3 whitelisted player(s): Antifield, Steve, Alex')
  assert.deepEqual(names, ['Antifield', 'Steve', 'Alex'])
  assert.deepEqual(parseWhitelistResponse('There are 0 whitelisted player(s):'), [])
})

test('解析 TPS（含颜色码）', () => {
  const tps = parseTpsResponse('§6TPS from last 1m, 5m, 15m: §a20.0§r, §a19.8§r, §a19.5\n')
  assert.deepEqual(tps, { m1: 20, m5: 19.8, m15: 19.5 })
  assert.equal(parseTpsResponse('no numbers here'), null)
})

test('玩家名校验', () => {
  assert.equal(validatePlayerName(' Steve_1 '), 'Steve_1')
  assert.throws(() => validatePlayerName('ab'), /3–16/)
  assert.throws(() => validatePlayerName('bad name'), /3–16/)
  assert.throws(() => validatePlayerName('x'.repeat(17)), /3–16/)
})
