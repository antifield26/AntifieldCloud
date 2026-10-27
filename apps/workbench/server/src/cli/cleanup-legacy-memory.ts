/**
 * 旧滚动摘要清理 CLI（v0.5.11 验收后执行一次）：
 * 只删除 legacy_migrated_at 已置位的用户的 chatbot_ai_memories 行与镜像文件；
 * 默认 dry-run，必须显式 --confirm 才实际删除；不输出任何正文。
 */
import { join } from 'node:path'
import { loadConfig } from '../config.ts'
import { openDatabase } from '../db.ts'
import { nowIso } from '../util/time.ts'
import { ChatbotMemoryStore, memoryOptionsFromConfig } from '../chatbot/memory.ts'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dryRun = !args.includes('--confirm')
  const config = loadConfig()
  const db = openDatabase({ path: join(config.dataDir, 'db.sqlite') })
  try {
    const memory = new ChatbotMemoryStore(db, config.dataDir, memoryOptionsFromConfig(config))
    const result = memory.cleanupLegacyMigrated(dryRun)
    if (!dryRun) {
      db.prepare('INSERT INTO audit_log (ts, actor, action, target, detail_json) VALUES (?, ?, ?, NULL, ?)').run(
        nowIso(),
        'cli',
        'chatbot.memory.legacy_cleanup',
        JSON.stringify(result),
      )
    }
    console.log(JSON.stringify({ dryRun, ...result }))
  } finally {
    db.close()
  }
}

main().catch((error: unknown) => {
  console.error('legacy memory cleanup failed:', error instanceof Error ? error.message : 'unknown')
  process.exitCode = 1
})
