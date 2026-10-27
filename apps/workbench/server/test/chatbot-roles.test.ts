/** v0.5.5 私聊角色卡 Store：单卡覆盖、停用/启用、删除与 Chatbot 级联。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanupDir, tempDataDir, testDb } from './helpers.ts'
import {
  ChatbotChatRoleStore,
  normalizeRolePrompt,
  validateRole,
} from '../src/chatbot/roles.ts'

const CHATBOT_ID = 'role-chatbot'
const OTHER_CHATBOT_ID = 'role-other-chatbot'
const USER = 'role-user'

function seedBot(db: ReturnType<typeof testDb>, id: string): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO chatbots
       (id, platform, name, enabled, config_json, secret_ciphertext, secret_iv, secret_tag, key_version, created_at, updated_at)
     VALUES (?, 'telegram', '角色卡测试 Chatbot', 1, '{}', 'x', 'x', 'x', 1, ?, ?)`,
  ).run(id, now, now)
}

test('v0.5.5 角色卡：保存/覆盖/停用/启用/删除，创建时间保留', () => {
  const dir = tempDataDir()
  const db = testDb(dir)
  try {
    seedBot(db, CHATBOT_ID)
    const store = new ChatbotChatRoleStore(db)
    assert.equal(store.get(CHATBOT_ID, USER), null)

    const first = store.save(CHATBOT_ID, USER, '猫娘', '说话简短，偶尔用喵。')
    assert.equal(first.enabled, true)
    assert.equal(first.name, '猫娘')
    const createdAt = first.createdAt

    const second = store.save(CHATBOT_ID, USER, '老师', '用耐心、分步骤的方式解释。')
    assert.equal(second.name, '老师')
    assert.equal(second.prompt, '用耐心、分步骤的方式解释。')
    assert.equal(second.createdAt, createdAt)
    assert.ok(second.updatedAt >= first.updatedAt)

    assert.equal(store.setEnabled(CHATBOT_ID, USER, false), true)
    assert.equal(store.get(CHATBOT_ID, USER)?.enabled, false)
    assert.equal(store.setEnabled(CHATBOT_ID, USER, true), true)
    assert.equal(store.get(CHATBOT_ID, USER)?.enabled, true)

    assert.equal(store.remove(CHATBOT_ID, USER), true)
    assert.equal(store.get(CHATBOT_ID, USER), null)
    assert.equal(store.remove(CHATBOT_ID, USER), false)
  } finally {
    db.close()
    cleanupDir(dir)
  }
})

test('v0.5.5 角色卡：按 Chatbot×用户隔离，Chatbot 删除级联清理', () => {
  const dir = tempDataDir()
  const db = testDb(dir)
  try {
    seedBot(db, CHATBOT_ID)
    seedBot(db, OTHER_CHATBOT_ID)
    const store = new ChatbotChatRoleStore(db)
    store.save(CHATBOT_ID, USER, 'A', 'A 的设定')
    store.save(OTHER_CHATBOT_ID, USER, 'B', 'B 的设定')
    assert.equal(store.get(CHATBOT_ID, USER)?.name, 'A')
    assert.equal(store.get(OTHER_CHATBOT_ID, USER)?.name, 'B')

    db.prepare('DELETE FROM chatbots WHERE id = ?').run(CHATBOT_ID)
    assert.equal(store.get(CHATBOT_ID, USER), null)
    assert.equal(store.get(OTHER_CHATBOT_ID, USER)?.name, 'B')
  } finally {
    db.close()
    cleanupDir(dir)
  }
})

test('v0.5.5 角色卡校验：名字/设定长度、空白、保留标记', () => {
  assert.equal(normalizeRolePrompt('  第一行\r\n第二行\t  '), '第一行\n第二行')
  assert.equal(validateRole('', '设定'), 'role_name_empty')
  assert.equal(validateRole('有 空格', '设定'), 'role_name_has_whitespace')
  assert.equal(validateRole('[名]', '设定'), 'role_name_invalid_chars')
  assert.equal(validateRole('a'.repeat(33), '设定'), 'role_name_too_long')
  assert.equal(validateRole('名字', normalizeRolePrompt('   ')), 'role_prompt_empty')
  assert.equal(validateRole('名字', 'x'.repeat(1001)), 'role_prompt_too_long')
  assert.equal(validateRole('名字', '包含 [安全边界] 的设定'), 'role_prompt_reserved_marker')
  assert.equal(validateRole('名字', '正常设定'), null)
})
