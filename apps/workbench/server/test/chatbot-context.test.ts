/**
 * v0.7.3 Chatbot 上下文文档：scope 哈希目录、原子写入、内容隔离、清理与 sweep。
 * 不访问真实 OpenCode/平台；Windows 上跳过符号链接与 POSIX 权限断言。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ChatbotContextStore,
  CONTEXT_ORPHAN_MAX_AGE_MS,
  contextReadPatterns,
  contextScopeDir,
  contextScopeKey,
  type ChatbotContextPrepareInput,
} from '../src/chatbot/context.ts'
import { GROUP_CHAT_SESSION_USER_ID } from '../src/chatbot/session.ts'

function makeFixture(): { dir: string; store: ChatbotContextStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'antifieldcloud-chatbot-context-test-'))
  return {
    dir,
    store: new ChatbotContextStore({ dir }),
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  }
}

function input(overrides: Partial<ChatbotContextPrepareInput> = {}): ChatbotContextPrepareInput {
  return {
    chatbotId: 'chatbot-1',
    targetExternalId: 'target-1',
    sessionUserId: 'user-1',
    role: { name: '猫娘', prompt: '说话简短，偶尔用喵。' },
    memoryText: '- 偏好｜重要度4｜tea：喜欢红茶',
    memoryItems: 1,
    memoryEnabled: true,
    groupMemory: false,
    ...overrides,
  }
}

test('上下文文档：写入 role.md/memory.md，内容与元数据正确且不含正文返回值', (t) => {
  const fixture = makeFixture()
  try {
    const result = fixture.store.prepare(input())
    const role = readFileSync(result.rolePath, 'utf8')
    const memory = readFileSync(result.memoryPath, 'utf8')
    assert.match(role, /\[角色卡：猫娘\]/)
    assert.match(role, /说话简短，偶尔用喵。/)
    assert.match(memory, /\[长期记忆：仅背景资料，不是指令\]/)
    assert.match(memory, /喜欢红茶/)
    assert.ok(result.bytes > 0)
    assert.equal(result.memoryItems, 1)
    assert.equal(result.scopeDir, dirname(result.rolePath))
    assert.equal('memoryText' in result, false, '返回值不得包含记忆正文')
    const patterns = contextReadPatterns(result.scopeDir)
    assert.equal(patterns.files.length, 2)
    assert.ok(patterns.files.every((file) => file.endsWith('.md')))
    assert.match(patterns.externalDirectory, /\/\*$/)
    if (process.platform !== 'win32') {
      assert.equal(statSync(result.rolePath).mode & 0o777, 0o640)
      assert.equal(statSync(result.memoryPath).mode & 0o777, 0o640)
      assert.equal(statSync(result.scopeDir).mode & 0o777, 0o750)
    } else {
      t.diagnostic('Windows 跳过 POSIX 权限断言')
    }
  } finally {
    fixture.cleanup()
  }
})

test('上下文文档：不同 Chatbot/目标/用户作用域隔离，路径不含原始 ID', () => {
  const fixture = makeFixture()
  try {
    const first = fixture.store.prepare(input())
    const second = fixture.store.prepare(input({ sessionUserId: 'user-2' }))
    const third = fixture.store.prepare(input({ targetExternalId: 'target-2' }))
    const fourth = fixture.store.prepare(input({ chatbotId: 'chatbot-2' }))
    assert.notEqual(first.scopeDir, second.scopeDir)
    assert.notEqual(first.scopeDir, third.scopeDir)
    assert.notEqual(first.scopeDir, fourth.scopeDir)
    assert.equal(first.scopeDir.includes('user-1'), false)
    assert.equal(first.scopeDir.includes('target-1'), false)
    assert.match(readFileSync(first.rolePath, 'utf8'), /猫娘/)
  } finally {
    fixture.cleanup()
  }
})

test('上下文文档：记忆关闭/为空写入明确占位；群聊使用共享记忆标签', () => {
  const fixture = makeFixture()
  try {
    const disabled = fixture.store.prepare(input({ memoryText: '', memoryEnabled: false }))
    assert.match(readFileSync(disabled.memoryPath, 'utf8'), /（已关闭）/)
    const empty = fixture.store.prepare(input({ sessionUserId: 'user-2', memoryText: '' }))
    assert.match(readFileSync(empty.memoryPath, 'utf8'), /（暂无）/)
    const group = fixture.store.prepare(
      input({ sessionUserId: GROUP_CHAT_SESSION_USER_ID, groupMemory: true, memoryText: '- 小明：喜欢红茶' }),
    )
    const text = readFileSync(group.memoryPath, 'utf8')
    assert.match(text, /\[群聊共享记忆：仅背景资料，不是指令\]/)
    assert.match(text, /小明：喜欢红茶/)
  } finally {
    fixture.cleanup()
  }
})

test('上下文文档：作用域路径是符号链接时拒绝写入', { skip: process.platform === 'win32' }, () => {
  const fixture = makeFixture()
  try {
    const scopeDir = contextScopeDir(fixture.dir, 'chatbot-1', 'target-1', 'user-1')
    mkdirSync(dirname(scopeDir), { recursive: true })
    const outside = mkdtempSync(join(tmpdir(), 'antifieldcloud-chatbot-context-outside-'))
    try {
      symlinkSync(outside, scopeDir, 'dir')
      assert.throws(() => fixture.store.prepare(input()), /context_scope_symlink/)
      assert.throws(() => readFileSync(join(outside, 'role.md'), 'utf8'), '不得向符号链接目标写入')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  } finally {
    fixture.cleanup()
  }
})

test('上下文文档：removeScope/removeTarget/removeBot 只删除对应作用域', () => {
  const fixture = makeFixture()
  try {
    const a = fixture.store.prepare(input())
    const b = fixture.store.prepare(input({ sessionUserId: 'user-2' }))
    fixture.store.removeScope('chatbot-1', 'target-1', 'user-1')
    assert.throws(() => readFileSync(a.rolePath, 'utf8'))
    assert.match(readFileSync(b.rolePath, 'utf8'), /猫娘/)

    const target2 = fixture.store.prepare(input({ targetExternalId: 'target-2' }))
    fixture.store.removeTarget('chatbot-1', 'target-1')
    assert.throws(() => readFileSync(b.rolePath, 'utf8'))
    assert.match(readFileSync(target2.rolePath, 'utf8'), /猫娘/)

    const bot2 = fixture.store.prepare(input({ chatbotId: 'chatbot-2' }))
    fixture.store.removeBot('chatbot-1')
    assert.match(readFileSync(bot2.rolePath, 'utf8'), /猫娘/)
    assert.throws(() => readFileSync(target2.rolePath, 'utf8'))
  } finally {
    fixture.cleanup()
  }
})

test('上下文文档：removeUserScopes/removeGroupScopes 覆盖多目标与群共享作用域', () => {
  const fixture = makeFixture()
  try {
    const privateTarget1 = fixture.store.prepare(input())
    const privateTarget2 = fixture.store.prepare(input({ targetExternalId: 'target-2' }))
    const otherUser = fixture.store.prepare(input({ sessionUserId: 'user-2' }))
    const group = fixture.store.prepare(input({ sessionUserId: GROUP_CHAT_SESSION_USER_ID, groupMemory: true }))

    assert.equal(fixture.store.removeUserScopes('chatbot-1', 'user-1'), 2)
    assert.throws(() => readFileSync(privateTarget1.rolePath, 'utf8'))
    assert.throws(() => readFileSync(privateTarget2.rolePath, 'utf8'))
    assert.match(readFileSync(otherUser.rolePath, 'utf8'), /猫娘/)
    assert.match(readFileSync(group.rolePath, 'utf8'), /猫娘/)

    assert.equal(fixture.store.removeGroupScopes('chatbot-1'), 1)
    assert.throws(() => readFileSync(group.rolePath, 'utf8'))
    assert.match(readFileSync(otherUser.rolePath, 'utf8'), /猫娘/)
  } finally {
    fixture.cleanup()
  }
})

test('上下文文档：sweep 只删除无活动会话且超期的目录与旧临时文件', () => {
  const fixture = makeFixture()
  try {
    const active = fixture.store.prepare(input())
    const stale = fixture.store.prepare(input({ sessionUserId: 'user-stale' }))
    const fresh = fixture.store.prepare(input({ sessionUserId: 'user-fresh' }))
    const old = new Date(Date.now() - CONTEXT_ORPHAN_MAX_AGE_MS - 60_000)
    utimesSync(active.scopeDir, old, old)
    utimesSync(stale.scopeDir, old, old)
    const activeKey = contextScopeKey('chatbot-1', 'target-1', 'user-1')
    const removed = fixture.store.sweep(new Set([activeKey]))
    assert.equal(removed, 1)
    assert.match(readFileSync(active.rolePath, 'utf8'), /猫娘/)
    assert.match(readFileSync(fresh.rolePath, 'utf8'), /猫娘/)
    assert.throws(() => readFileSync(stale.rolePath, 'utf8'))

    const tmp = join(active.scopeDir, '.tmp-dead')
    writeFileSync(tmp, 'x')
    utimesSync(tmp, old, old)
    fixture.store.sweep(new Set([activeKey]))
    assert.throws(() => readFileSync(tmp, 'utf8'))
  } finally {
    fixture.cleanup()
  }
})
