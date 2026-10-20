/**
 * 进程入口：加载配置、确保目录、打开 SQLite、启动 Fastify、定时维护与优雅退出。
 * 生产环境由 systemd 以 antifieldcloud 用户运行；仅监听 127.0.0.1。
 */
import { resolve } from 'node:path'
import { buildApp } from './app.ts'
import { ensureRuntimeDirs, loadConfig } from './config.ts'
import { openDatabase } from './db.ts'

async function main(): Promise<void> {
  const config = loadConfig()
  ensureRuntimeDirs(config)
  const db = openDatabase({ path: resolve(config.dataDir, 'db.sqlite'), verbose: true })
  const context = await buildApp(config, db)

  // 清理崩溃/断电遗留的上传临时文件（超过 24h 的 .part）。
  const cleanedTemps = context.files.storage.cleanupTempFiles()
  if (cleanedTemps > 0) context.app.log.warn({ cleanedTemps }, '已清理残留上传临时文件')

  const maintenance = setInterval(() => context.runMaintenance(), 60 * 60 * 1000)
  maintenance.unref()

  let stopping = false
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    context.app.log.info({ signal }, '正在关闭')
    clearInterval(maintenance)
    context.alerts.stop()
    // http-proxy 的 WS 隧道不会随 server.close() 自动断开；先关闭再 app.close()，
    // 否则存在活动隧道时 Fastify 会等到 Node 的 120s keep-alive 超时。
    context.proxy.close()
    try {
      await context.app.close()
    } finally {
      db.close()
    }
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('unhandledRejection', (reason) => {
    context.app.log.error({ err: reason }, '未处理的 Promise 拒绝')
  })
  // 兜底：任何未捕获异常都记录后退出，交给 systemd 重启，避免进程处于半坏状态。
  process.on('uncaughtException', (error) => {
    try {
      context.app.log.fatal({ err: error }, '未捕获异常，进程退出')
    } catch {
      console.error('未捕获异常，进程退出：', error)
    }
    process.exit(1)
  })

  await context.app.listen({ host: config.host, port: config.port })
  context.alerts.start()
  context.startMetrics()
  context.app.log.info(
    {
      address: `http://${config.host}:${config.port}`,
      dataDir: config.dataDir,
      webDist: config.webDistDir,
      env: config.nodeEnv,
    },
    'AntifieldCloud 已启动',
  )
  const users = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }
  if (users.c === 0) {
    context.app.log.warn('尚未创建管理员：请在 Pi 上运行 provisioning')
  }
}

main().catch((error: unknown) => {
  console.error('启动失败：', error)
  process.exit(1)
})
