import { loadConfig } from './config.ts'
import { createLogger } from './logger.ts'
import { readPackageInfo } from './version.ts'
import { RuntimeState } from './state.ts'
import { MemoryStore } from './memory/store.ts'
import { ChatSender } from './minecraft/chat.ts'
import { MovementManager } from './minecraft/movement.ts'
import { MinecraftClient } from './minecraft/bot.ts'
import { CommandExecutor } from './minecraft/commands.ts'
import { OpenCodeClient } from './ai/opencode.ts'
import { AiChatService } from './ai/queue.ts'
import { ChatRouter } from './chat/router.ts'
import { HttpApi } from './http/server.ts'
import { PresenceManager } from './presence/manager.ts'

async function main (): Promise<void> {
  const packageInfo = readPackageInfo()
  const config = loadConfig(process.env, packageInfo.version)
  const logger = createLogger(config.logLevel)
  const state = new RuntimeState({
    version: config.version,
    username: config.botUsername,
    host: config.mcHost,
    port: config.mcPort,
    minecraftVersion: config.mcVersion === false ? 'auto' : config.mcVersion,
    presenceEnabled: config.presenceEnabled,
    presencePollMs: config.presencePollMs,
    presenceGraceMs: config.presenceGraceMs,
    presenceCheckMs: config.presenceCheckMs,
    aiEnabled: config.aiEnabled,
    aiProvider: config.aiModelProvider,
    aiModel: config.aiModelId
  })

  const memory = new MemoryStore({
    dir: config.memoryDir,
    maxTurns: config.memoryMaxTurns,
    retentionDays: config.memoryRetentionDays,
    logger: logger.withScope('memory')
  })
  await memory.init()
  state.setMemory(memory.stats())

  const movement = new MovementManager(logger.withScope('movement'))
  const client = new MinecraftClient({
    config,
    logger: logger.withScope('minecraft'),
    state,
    movement
  })

  const chatSender = new ChatSender(() => client.getBot(), logger.withScope('chat'), {
    maxLineChars: config.aiMaxLineChars,
    maxLines: config.aiMaxLines,
    gapMs: 250
  })
  movement.setNotify(message => {
    void chatSender.say(message, 'movement').catch(() => {})
  })

  const commands = new CommandExecutor({
    config,
    logger: logger.withScope('commands'),
    chatSender,
    movement,
    getBot: () => client.getBot()
  })

  const aiClient = new OpenCodeClient(config, logger.withScope('opencode'))
  const ai = new AiChatService({
    config,
    logger: logger.withScope('ai'),
    state,
    memory,
    client: aiClient,
    chatSender,
    getBot: () => client.getBot()
  })

  const router = new ChatRouter({
    config,
    logger: logger.withScope('chat'),
    state,
    chatSender,
    commands,
    ai
  })
  client.setChatHandler(message => router.handle(message))

  const http = new HttpApi({
    config,
    logger: logger.withScope('http'),
    state,
    chatSender
  })
  await http.start()

  const presence = new PresenceManager({
    config,
    logger: logger.withScope('presence'),
    state,
    controller: client
  })
  presence.start()

  logger.info('lofii-bot started', {
    version: config.version,
    bot: config.botUsername,
    server: `${config.mcHost}:${config.mcPort}`,
    presenceEnabled: config.presenceEnabled,
    forceOnline: config.forceOnline,
    aiEnabled: config.aiEnabled,
    model: `${config.aiModelProvider}/${config.aiModelId}`,
    http: `${config.httpHost}:${config.httpPort}`
  })

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('shutting down', { signal })
    const force = setTimeout(() => {
      logger.warn('forced shutdown after timeout')
      process.exit(1)
    }, 12000)
    force.unref?.()
    try {
      ai.stop()
      await presence.stop()
      await client.stop('shutdown')
      await http.stop()
      await memory.stop()
    } catch (error) {
      logger.warn('shutdown error', { error: error instanceof Error ? error.message : String(error) })
    } finally {
      logger.info('goodbye')
      process.exit(0)
    }
  }

  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('uncaughtException', error => {
    logger.error('uncaught exception', { error: error.message, stack: error.stack })
    process.exit(1)
  })
  process.on('unhandledRejection', reason => {
    logger.error('unhandled rejection', { reason: reason instanceof Error ? reason.message : String(reason) })
  })
}

main().catch(error => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  process.stderr.write(`${new Date().toISOString()} [ERROR] startup failed: ${message}\n`)
  process.exit(1)
})
