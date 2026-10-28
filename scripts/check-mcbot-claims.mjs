/**
 * mcbot 文档-实现一致性检查。
 *
 * 以代码常量为真相，校验 README / docs/mcbot / AGENTS / app API 的关键声明与 env 模板；
 * 只读仓库文件，不修改任何内容。失败时输出逐条错误并以 1 退出。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(process.cwd())
const errors = []
const checked = []

function read (relative) {
  try {
    return readFileSync(resolve(root, relative), 'utf8')
  } catch (error) {
    errors.push(`${relative}: 无法读取 (${error instanceof Error ? error.message : String(error)})`)
    return ''
  }
}

function requireText (relative, needle, label = needle) {
  const text = read(relative)
  checked.push(`${relative}:${label}`)
  if (!text.includes(needle)) errors.push(`${relative}: 缺少声明 "${label}"`)
}

function forbidText (relative, needle, label = needle) {
  const text = read(relative)
  if (text.includes(needle)) errors.push(`${relative}: 存在陈旧/冲突声明 "${label}"`)
}

const toolsModule = await import(pathToFileURL(resolve(root, 'apps/mcbot/src/autonomy/tools.ts')).href)
const aiToolsModule = await import(pathToFileURL(resolve(root, 'apps/mcbot/src/ai/tools.ts')).href)
const autonomyTools = [...toolsModule.AUTONOMY_RAW_TOOLS]
const taskNames = [...toolsModule.AUTONOMY_TASK_NAMES]
const readOnlyContextSections = [...aiToolsModule.READ_ONLY_AI_TOOL_NAMES]
const permissionPrefix = toolsModule.AUTONOMY_PERMISSION_PREFIX

if (autonomyTools.length !== 10) errors.push(`工具数量应为 10，实际 ${autonomyTools.length}`)
if (taskNames.length !== 10) errors.push(`任务数量应为 10，实际 ${taskNames.length}`)

const toolDocs = ['docs/mcbot/README.md', 'docs/mcbot/API.md']
for (const file of toolDocs) {
  for (const tool of autonomyTools) requireText(file, tool, `tool:${tool}`)
  requireText(file, permissionPrefix, `permission:${permissionPrefix}`)
}
for (const taskName of taskNames) requireText('docs/mcbot/README.md', taskName, `task:${taskName}`)
for (const section of readOnlyContextSections) requireText('docs/mcbot/README.md', section, `ai-context:${section}`)

const envKeys = [
  'AUTONOMY_ENABLED',
  'AUTONOMY_MAX_MINUTES',
  'AUTONOMY_MAX_TOOL_CALLS',
  'AUTONOMY_MAX_FAILURES',
  'AUTONOMY_GOAL_MAX_CHARS',
  'AUTONOMY_DECISION_TIMEOUT_MS',
  'AUTONOMY_MCP_WARMUP_MS',
  'AUTONOMY_SCAN_RADIUS',
  'AUTONOMY_SCAN_MAX_BLOCKS',
  'AUTONOMY_SCAN_BLOCKS',
  'AUTONOMY_CHEST_READ_ENABLED',
  'AUTONOMY_CHEST_PATH_TIMEOUT_MS',
  'AUTONOMY_EAT_BELOW',
  'AUTONOMY_ACTION_COOLDOWN_MS',
  'AUTONOMY_EVENT_DEBOUNCE_MS',
  'AUTONOMY_MAX_REPROMPTS',
  'AUTONOMY_TASKS'
]
for (const key of envKeys) {
  requireText('apps/mcbot/deploy/env.example', key, `env:${key}`)
  requireText('apps/mcbot/deploy/bootstrap-env.sh', key, `bootstrap:${key}`)
  requireText('docs/mcbot/API.md', key, `doc-env:${key}`)
}

requireText('docs/mcbot/CONSISTENCY-AUDIT.md', '文档声明', 'audit-matrix')
requireText('docs/mcbot/CONSISTENCY-AUDIT.md', '代码', 'audit-code-column')
requireText('docs/mcbot/CONSISTENCY-AUDIT.md', '状态', 'audit-status-column')
requireText('README.md', 'v1.0.3', 'readme-version')
requireText('docs/mcbot/README.md', 'v1.0.3', 'mcbot-readme-version')
requireText('docs/app/API.md', 'mcbot **v1.0.3**', 'app-api-upstream-version')
requireText('CHANGELOG.md', '## [v1.0.3]', 'changelog-version')
requireText('docs/app/ACCEPTANCE.md', 'v1.0.3', 'acceptance-version')
requireText('docs/app/DEPLOY.md', 'v1.0.3', 'deploy-title')
requireText('deploy/tool-versions.json', '"mcbotVersion": "1.0.3"', 'tool-version')
requireText('deploy/env.example', 'APP_VERSION=1.0.3', 'app-version')

const rootPackage = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
if (rootPackage.version !== '1.0.3') errors.push(`package.json version 应为 1.0.3，实际 ${rootPackage.version}`)

const stalePatterns = [
  ['docs/app/API.md', '生产当前 v1.0.1', '旧生产版本'],
  ['README.md', 'mcbot **v1.0.0**', '旧 mcbot 版本'],
  ['docs/mcbot/README.md', 'AI 没有任何工具/命令执行能力', 'AI 无工具旧声明'],
  ['docs/mcbot/README.md', 'AI 输出只用于聊天；不会触发任何游戏操作', 'AI 只聊天旧声明']
]
for (const [file, needle, label] of stalePatterns) forbidText(file, needle, label)

if (read('docs/mcbot/README.md').includes('只读受控工具 `status/inventory/task_status`')) {
  errors.push('docs/mcbot/README.md: 仍把提示词上下文段称为"只读受控工具"')
}

if (errors.length > 0) {
  console.error(JSON.stringify({ ok: false, checks: checked.length, errors }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, checks: checked.length, tools: autonomyTools.length, tasks: taskNames.length, envKeys: envKeys.length }))
