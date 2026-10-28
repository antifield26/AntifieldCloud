import { loadConfig } from './config.ts'
import { createLogger } from './logger.ts'
import { readPackageInfo } from './version.ts'
import { RuntimeState } from './state.ts'
import { AuditLogger } from './audit.ts'
import { Defender } from './combat/defender.ts'
import { AdminService } from './admin/service.ts'
import { AlertManager } from './alerts/manager.ts'
import { HistoryService } from './history/service.ts'
import { HistoryStore } from './history/store.ts'
import { EventBus } from './events/bus.ts'
import { StatePublisher } from './events/state-publisher.ts'
import { MemoryStore } from './memory/store.ts'
import { ChatSender } from './minecraft/chat.ts'
import { MovementManager } from './minecraft/movement.ts'
import { MinecraftClient } from './minecraft/bot.ts'
import { CommandExecutor } from './minecraft/commands.ts'
import { OpenCodeClient } from './ai/opencode.ts'
import { OpenCodeSessionClient } from './ai/session.ts'
import { IntentClassifier } from './ai/intent.ts'
import { AiChatService } from './ai/queue.ts'
import { AutonomyService } from './autonomy/service.ts'
import { ChatRouter } from './chat/router.ts'
import { HttpApi } from './http/server.ts'
import { PresenceManager } from './presence/manager.ts'
import { TaskManager } from './tasks/manager.ts'
import { TaskStore } from './tasks/store.ts'
import { ProactiveManager } from './proactive.ts'
import { SdNotify } from './runtime/sdnotify.ts'
import { MemoryGuard } from './runtime/memory-guard.ts'

async function main (): Promise<void> {
  const packageInfo = readPackageInfo()
  const config = loadConfig(process.env, packageInfo.version)
  const logger = createLogger(config.logLevel)
  const sdnotify = new SdNotify({ logger: logger.withScope('watchdog') })
  if (sdnotify.enabled) logger.info('systemd notify socket detected', { watchdogEnabled: config.watchdog.enabled })
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
    aiModel: config.aiModelId,
    taskEnabled: config.taskEnabled,
    autonomyEnabled: config.autonomyEnabled,
    autonomyMaxToolCalls: config.autonomyMaxToolCalls
  })

  const memory = new MemoryStore({
    dir: config.memoryDir,
    maxTurns: config.memoryMaxTurns,
    retentionDays: config.memoryRetentionDays,
    logger: logger.withScope('memory')
  })
  await memory.init()
  state.setMemory(memory.stats())

  const events = new EventBus(config.sseBufferEvents)
  const historyStore = config.history.enabled
    ? new HistoryStore(config.history.file, config.history.retentionDays, logger.withScope('history'))
    : null
  if (historyStore) {
    try {
      await historyStore.init()
    } catch (error) {
      logger.error('history init failed; history/alert storage disabled', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  const history = new HistoryService({
    store: historyStore,
    state,
    logger: logger.withScope('history'),
    sampleMs: config.history.sampleMs,
    enabled: config.history.enabled && historyStore !== null
  })
  const audit = new AuditLogger({
    file: config.auditFile,
    maxBytes: config.auditMaxBytes,
    retentionDays: config.auditRetentionDays,
    logger: logger.withScope('audit')
  })
  await audit.init()
  audit.append({
    event: 'service.start',
    source: 'system',
    actor: 'system',
    action: 'start',
    result: 'accepted',
    details: { version: config.version }
  })

  const movement = new MovementManager(logger.withScope('movement'), config)
  const client = new MinecraftClient({
    config,
    logger: logger.withScope('minecraft'),
    state,
    movement
  })

  const chatSender = new ChatSender(() => client.getBot(), logger.withScope('chat'), {
    maxLineChars: config.aiMaxLineChars,
    maxLines: config.aiMaxLines,
    gapMs: 250,
    onSay: event => {
      events.emit('chat', {
        direction: 'out',
        source: event.source,
        text: event.text,
        lines: event.lines
      })
    }
  })
  movement.setNotify(message => {
    void chatSender.say(message, 'movement').catch(() => {})
  })
  const defender = new Defender({
    config,
    logger: logger.withScope('defense'),
    movement,
    audit,
    getBot: () => client.getBot()
  })

  const alerts = new AlertManager({
    config,
    logger: logger.withScope('alerts'),
    state,
    events,
    store: historyStore,
    getBot: () => client.getBot()
  })
  alerts.start()
  const memoryGuard = new MemoryGuard({
    limitMb: config.rssLimitMb,
    checkMs: config.rssCheckMs,
    logger: logger.withScope('memory-guard'),
    onHigh: (rssMb, limitMb) => {
      alerts.raise('memory_high', `内存占用偏高：${rssMb} MB（阈值 ${limitMb} MB）`, { rssMb, limitMb }, 'warning')
    }
  })
  client.setDisconnectHandler(reason => {
    alerts.raise('disconnected', `Lofii 断线：${reason}`, { reason }, 'error')
  })

  const admin = new AdminService({
    config,
    logger: logger.withScope('admin'),
    state
  })
  admin.start()
  history.start()

  const tasks = new TaskManager({
    config,
    logger: logger.withScope('tasks'),
    state,
    chatSender,
    movement,
    events,
    audit,
    store: new TaskStore(config.taskStateFile, logger.withScope('tasks.store')),
    getBot: () => client.getBot(),
    defender: config.defenseEnabled ? defender : undefined,
    alerts,
    getServerTimeTicks: () => admin.timeNow()
  })
  await tasks.init()
  let restockTimer: NodeJS.Timeout | null = null
  if (config.autoRestock) {
    restockTimer = setInterval(() => { void tasks.autoRestock() }, config.autoRestockIntervalMs)
    restockTimer.unref?.()
  }

  const commands = new CommandExecutor({
    config,
    logger: logger.withScope('commands'),
    chatSender,
    movement,
    tasks,
    audit,
    getBot: () => client.getBot()
  })

  const aiClient = new OpenCodeClient(config, logger.withScope('opencode'))
  const sessionClient = new OpenCodeSessionClient(config, logger.withScope('opencode.session'))
  const intent = new IntentClassifier(config, logger.withScope('intent'), aiClient)
  const ai = new AiChatService({
    config,
    logger: logger.withScope('ai'),
    state,
    memory,
    client: aiClient,
    chatSender,
    getBot: () => client.getBot()
  })
  const autonomy = new AutonomyService({
    config,
    logger: logger.withScope('autonomy'),
    state,
    audit,
    events,
    chatSender,
    movement,
    tasks,
    opencode: sessionClient,
    getBot: () => client.getBot()
  })

  const router = new ChatRouter({
    config,
    logger: logger.withScope('chat'),
    state,
    chatSender,
    commands,
    intent,
    ai,
    events,
    audit,
    autonomy
  })
  client.setChatHandler(message => router.handle(message))

  const proactive = new ProactiveManager(config, logger.withScope('proactive'), chatSender)
  client.setSpawnHandler(() => {
    proactive.attach(client.getBot())
  })

  const http = new HttpApi({
    config,
    logger: logger.withScope('http'),
    state,
    chatSender,
    movement,
    tasks,
    events,
    audit,
    history: historyStore ?? undefined,
    getBot: () => client.getBot(),
    autonomy
  })
  await http.start()
  // systemd Type=notify：启动完成后必须发送 READY=1；未由 systemd 启动时自动 no-op。
  sdnotify.ready()
  let heartbeatTimer: NodeJS.Timeout | null = null
  if (config.watchdog.enabled && sdnotify.enabled) {
    heartbeatTimer = setInterval(() => { sdnotify.watchdog() }, config.watchdog.heartbeatMs)
    heartbeatTimer.unref?.()
  }
  memoryGuard.start()

  const presence = new PresenceManager({
    config,
    logger: logger.withScope('presence'),
    state,
    controller: client,
    keepOnline: () => tasks.keepOnline() || autonomy.isActive()
  })
  tasks.setTaskEndedHandler(() => presence.notifyTaskEnded())
  presence.start()
  const statePublisher = new StatePublisher({ state, events })
  statePublisher.start()

  logger.info('mcbot started', {
    version: config.version,
    bot: config.botUsername,
    server: `${config.mcHost}:${config.mcPort}`,
    presenceEnabled: config.presenceEnabled,
    forceOnline: config.forceOnline,
    aiEnabled: config.aiEnabled,
    model: `${config.aiModelProvider}/${config.aiModelId}`,
    http: `${config.httpHost}:${config.httpPort}`,
    controlEnabled: config.httpControlEnabled && config.httpControlToken !== '',
    sseMaxClients: config.sseMaxClients,
    rconEnabled: config.rcon.enabled,
    historyEnabled: config.history.enabled,
    alertsEnabled: config.alerts.enabled,
    autonomyEnabled: config.autonomyEnabled
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
      sdnotify.stopping()
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (restockTimer) clearInterval(restockTimer)
      memoryGuard.stop()
      ai.stop()
      await autonomy.shutdown()
      statePublisher.stop()
      alerts.stop()
      admin.stop()
      history.stop()
      await tasks.shutdown()
      proactive.detach()
      await presence.stop()
      await client.stop('shutdown')
      await http.stop()
      await audit.close()
      historyStore?.close()
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
