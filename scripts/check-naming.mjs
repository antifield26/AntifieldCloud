#!/usr/bin/env node
/**
 * 命名门禁：阻止 v1.0.0 之前的旧标识符重新进入活跃代码/脚本/文档。
 *
 * 历史数据（v1.0.0 前的迁移 SQL、迁移测试夹具、docs/legacy 归档、导入的本地数据）
 * 明确豁免；`botmsg` 是外部 MCP 工具名、`Lofii` 是游戏内人格名，均不是旧项目名。
 *
 * 用法：`node scripts/check-naming.mjs [--quiet] [--json]`
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const EXEMPT = [
  /^docs\/legacy\//,
  /^apps\/mcbot\/data-local/,
  /^node_modules\//,
  /^coverage\//,
  /^\.local\//,
  /^apps\/workbench\/server\/src\/db\.ts$/,
  /^apps\/workbench\/server\/test\/chatbot-migration\.test\.ts$/,
  /^scripts\/migrate-v1\.0\.0\.ps1$/, // 生产迁移脚本必须引用旧名称做键/服务/路径迁移
  /^CHANGELOG\.md$/, // v1.0.0 变更日志必须描述旧→新迁移
  /^scripts\/check-naming\.mjs$/, // 门禁自身包含旧标识符规则/说明
  /^package-lock\.json$/,
]

const RULES = [
  [/(?<![A-Za-z_])BOT_[A-Z]/, '旧 env 前缀 BOT_ → CHATBOT_'],
  [/(?<![A-Za-z])LOFII_/, '旧 env 前缀 LOFII_ → MCBOT_'],
  [/\/api\/bot(?:s)?(?:\/|\b)/, '旧 API /api/bot(s) → /api/chatbots'],
  [/\/api\/lofii\//, '旧 API /api/lofii → /api/mcbot'],
  [/lofii-bot/, '旧服务名 lofii-bot → mcbot'],
  [/sync-lofii-tokens\.sh/, '旧脚本 sync-lofii-tokens.sh → sync-mcbot-tokens.sh'],
  [/\bBotService\b/, '旧类名 BotService → ChatbotService'],
  [/(?<![A-Za-z])bot_[a-z]/, '旧表/列/键前缀 bot_ → chatbot_'],
  [/docs\/(?:BOT|DEPLOY|API|BACKUP|SECURITY|ACCEPTANCE|ARCHITECTURE|PLAN|ROADMAP|AUDIT|UI-SPEC)\.md/, '旧文档路径 docs/*.md → docs/app/*.md'],
]

// 允许的行级例外（不是旧项目标识符）。
const LINE_EXEMPT = [
  /botmsg/, // 外部 MCP 工具名
  /path="\/bots"/, // 旧前端路由重定向
  /LEGACY_MEMORY_DIR|bot-memory/, // 一次性数据迁移目录名
  /原 lofii-bot|历史名 lofii-bot|（原 lofii-bot）|mcbot（原 lofii-bot）/, // 迁移说明中的历史名称
]

function isExempt(file) {
  return EXEMPT.some((pattern) => pattern.test(file))
}

function main() {
  const args = process.argv.slice(2)
  const quiet = args.includes('--quiet')
  const json = args.includes('--json')
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
  const findings = []
  for (const file of files) {
    if (isExempt(file)) continue
    if (!/\.(md|mjs|js|ts|tsx|json|yml|yaml|ps1|sh|service|example|conf|css)$/.test(file)) continue
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    text.split(/\r?\n/).forEach((line, index) => {
      if (LINE_EXEMPT.some((pattern) => pattern.test(line))) return
      const mcbotFile = file.startsWith('apps/mcbot/')
      for (const [pattern, reason] of RULES) {
        // mcbot 自身使用 BOT_USERNAME/BOT_HOME_* 等通用变量名，不是旧 QQ Bot env。
        if (mcbotFile && reason.startsWith('旧 env 前缀 BOT_')) continue
        if (pattern.test(line)) {
          findings.push({ file, line: index + 1, rule: reason, text: line.trim().slice(0, 160) })
        }
      }
    })
  }
  if (json) console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2))
  else if (findings.length === 0) console.log(quiet ? 'naming ok' : '命名检查通过：未发现旧标识符')
  else {
    for (const finding of findings) {
      console.log(`${finding.file}:${finding.line}: ${finding.rule}\n  ${finding.text}`)
    }
    console.log(`命名检查失败：${findings.length} 处旧标识符（历史归档/迁移数据已豁免）`)
  }
  if (findings.length > 0) process.exitCode = 1
}

main()
