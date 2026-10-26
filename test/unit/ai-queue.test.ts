import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bot } from 'mineflayer'
import type { ChatSender } from '../../src/minecraft/chat.ts'
import type { OpenCodeClient } from '../../src/ai/opencode.ts'
import { AiChatService } from '../../src/ai/queue.ts'
import { AI_DISABLED_REPLY, FALLBACK_REPLY } from '../../src/ai/prompt.ts'
import { MemoryStore } from '../../src/memory/store.ts'
import { createLogger } from '../../src/logger.ts'
import { makeConfig, makeState, removeDir, tempDir, waitFor } from '../helpers.ts'

const logger = createLogger('error')
const playerName = 'SmokeTester'
const playerUuid = 'c0331953-99bf-361a-b929-38d6e6ae6ba4'

function makeFakeBot (): Bot {
  return {
    entity: { position: { x: 1, y: 64, z: 2 } },
    game: { dimension: 'minecraft:overworld' },
    health: 20,
    food: 20,
    time: { timeOfDay: 1000 },
    isRaining: false,
    thunderState: 0,
    players: {
      [playerName]: { uuid: playerUuid, username: playerName }
    }
  } as unknown as Bot
}

function makeChatSender (sent: string[]): ChatSender {
  return {
    isConnected: () => true,
    say: async (text: string) => {
      sent.push(text)
      return [text]
    }
  } as unknown as ChatSender
}

class FakeClient {
  prompts: string[] = []
  text = '你好呀'
  fail = false

  async generate (prompt: string): Promise<{ text: string, latencyMs: number }> {
    this.prompts.push(prompt)
    if (this.fail) throw new Error('ai unavailable')
    return { text: this.text, latencyMs: 5 }
  }
}

test('AI service replies, writes memory and respects cooldown', async () => {
  const dir = await tempDir('lofii-ai-')
  const memory = new MemoryStore({ dir, maxTurns: 10, retentionDays: 30, logger })
  await memory.init()
  const config = makeConfig({ aiEnabled: true, opencodePassword: 'pw', aiCooldownMs: 1000 })
  const state = makeState(config)
  const sent: string[] = []
  const fakeClient = new FakeClient()
  const service = new AiChatService({
    config,
    logger,
    state,
    memory,
    client: fakeClient as unknown as OpenCodeClient,
    chatSender: makeChatSender(sent),
    getBot: () => makeFakeBot()
  })
  try {
    service.ask(playerName, '你好')
    await waitFor(() => sent.length === 1, 2000)
    assert.equal(sent[0], '你好呀')
    await waitFor(() => memory.stats().turns === 2, 2000)
    await waitFor(() => state.ai.lastLatencyMs === 5, 2000)
    assert.equal(state.ai.lastLatencyMs, 5)
    service.ask(playerName, '再说一句')
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(sent.length, 1)
    assert.equal(fakeClient.prompts.length, 1)
  } finally {
    service.stop()
    await memory.stop()
    await removeDir(dir)
  }
})

test('AI service sends a fallback when the model fails', async () => {
  const dir = await tempDir('lofii-ai-')
  const memory = new MemoryStore({ dir, maxTurns: 10, retentionDays: 30, logger })
  await memory.init()
  const config = makeConfig({ aiEnabled: true, opencodePassword: 'pw' })
  const state = makeState(config)
  const sent: string[] = []
  const fakeClient = new FakeClient()
  fakeClient.fail = true
  const service = new AiChatService({
    config,
    logger,
    state,
    memory,
    client: fakeClient as unknown as OpenCodeClient,
    chatSender: makeChatSender(sent),
    getBot: () => makeFakeBot()
  })
  try {
    service.ask(playerName, '你好')
    await waitFor(() => sent.length === 1, 2000)
    assert.equal(sent[0], FALLBACK_REPLY)
    assert.equal(state.ai.failures, 1)
  } finally {
    service.stop()
    await memory.stop()
    await removeDir(dir)
  }
})

test('AI service explains when AI is disabled', async () => {
  const dir = await tempDir('lofii-ai-')
  const memory = new MemoryStore({ dir, maxTurns: 10, retentionDays: 30, logger })
  await memory.init()
  const config = makeConfig({ aiEnabled: false })
  const state = makeState(config)
  const sent: string[] = []
  const service = new AiChatService({
    config,
    logger,
    state,
    memory,
    client: new FakeClient() as unknown as OpenCodeClient,
    chatSender: makeChatSender(sent),
    getBot: () => makeFakeBot()
  })
  try {
    service.ask(playerName, '你好')
    await waitFor(() => sent.length === 1, 2000)
    assert.equal(sent[0], AI_DISABLED_REPLY)
  } finally {
    service.stop()
    await memory.stop()
    await removeDir(dir)
  }
})
