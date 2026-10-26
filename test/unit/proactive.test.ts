import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import type { Bot } from 'mineflayer'
import type { ChatSender } from '../../src/minecraft/chat.ts'
import { ProactiveManager } from '../../src/proactive.ts'
import { createLogger } from '../../src/logger.ts'
import { makeConfig } from '../helpers.ts'

const logger = createLogger('error')

test('proactive greets Antifield once and reacts to night', async () => {
  const config = makeConfig({ proactiveEnabled: true, proactiveGreeting: true, proactiveEvents: true })
  const messages: string[] = []
  const sender = {
    say: async (text: string) => {
      messages.push(text)
      return [text]
    }
  } as unknown as ChatSender
  const bot = Object.assign(new EventEmitter(), {
    username: 'lofii',
    isRaining: false,
    time: { isDay: true, day: 1 }
  }) as unknown as Bot & EventEmitter
  const manager = new ProactiveManager(config, logger, sender)
  manager.attach(bot)
  try {
    bot.emit('playerJoined', { username: 'Antifield' })
    await new Promise(resolve => setTimeout(resolve, 10))
    bot.emit('playerJoined', { username: 'Antifield' })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(messages.filter(text => text.includes('回来啦')).length, 1)
    ;(bot as unknown as { time: { isDay: boolean, day: number } }).time = { isDay: false, day: 2 }
    bot.emit('time')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(messages.filter(text => text.includes('天黑了')).length, 1)
  } finally {
    manager.detach()
  }
})
