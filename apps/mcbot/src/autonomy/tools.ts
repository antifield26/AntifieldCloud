/**
 * 自主会话的 MCP 工具定义与名称约束。
 *
 * 工具名保持窄集合；模型只能通过这些工具触发现有任务/移动能力。
 * OpenCode 会以 `<MCP server 名>_<tool>` 暴露工具，权限白名单使用完整前缀。
 */
import type { TaskName } from '../state.ts'

export const AUTONOMY_MCP_SERVER = 'mcbot_autonomy'
export const AUTONOMY_PERMISSION_PREFIX = `${AUTONOMY_MCP_SERVER}_*`
export const AUTONOMY_TOOL_NAME_PREFIX = `${AUTONOMY_MCP_SERVER}_`

export const AUTONOMY_TASK_NAMES: TaskName[] = [
  'fishing',
  'farming',
  'woodcutting',
  'mining',
  'forest',
  'sleep',
  'patrol',
  'guard',
  'escort',
  'explore'
]

export const AUTONOMY_RAW_TOOLS = [
  'start_task',
  'stop_task',
  'go_home',
  'deposit',
  'task_status',
  'observe',
  'inspect_chest',
  'eat',
  'equip',
  'finish'
] as const

export type AutonomyToolName = typeof AUTONOMY_RAW_TOOLS[number]

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required: string[]
    additionalProperties: false
  }
}

const runIdSchema = {
  type: 'string',
  description: '当前自主会话的 run_id；必须原样使用系统提示中的值。'
}
const reasonSchema = {
  type: 'string',
  description: '选择该动作的简短理由（最多 120 字符，不得包含命令或路径）。'
}

function commonProperties (): Record<string, unknown> {
  return {
    run_id: runIdSchema,
    reason: reasonSchema
  }
}

export function buildToolDefinitions (): McpToolDefinition[] {
  return [
    {
      name: 'start_task',
      description: `启动一个现有的自动化任务。任务名只能是：${AUTONOMY_TASK_NAMES.join(', ')}。只有当前没有活动任务/排队任务时才能启动。`,
      inputSchema: {
        type: 'object',
        properties: {
          ...commonProperties(),
          task: {
            type: 'string',
            enum: AUTONOMY_TASK_NAMES
          }
        },
        required: ['run_id', 'task', 'reason'],
        additionalProperties: false
      }
    },
    {
      name: 'stop_task',
      description: '停止当前活动任务；没有活动任务时返回错误。',
      inputSchema: {
        type: 'object',
        properties: commonProperties(),
        required: ['run_id', 'reason'],
        additionalProperties: false
      }
    },
    {
      name: 'go_home',
      description: '在当前没有活动任务时返回基地。',
      inputSchema: {
        type: 'object',
        properties: commonProperties(),
        required: ['run_id', 'reason'],
        additionalProperties: false
      }
    },
    {
      name: 'deposit',
      description: '在当前没有活动任务时把背包物品存入基地箱子。',
      inputSchema: {
        type: 'object',
        properties: commonProperties(),
        required: ['run_id', 'reason'],
        additionalProperties: false
      }
    },
    {
      name: 'task_status',
      description: '读取当前任务快照（名称、状态、进度、失败数、队列）。',
      inputSchema: {
        type: 'object',
        properties: { run_id: runIdSchema },
        required: ['run_id'],
        additionalProperties: false
      }
    },
    {
      name: 'observe',
      description: '只读刷新环境：坐标/血量/饥饿/时间/天气、玩家/敌对生物、背包/护甲、任务状态，以及附近方块和容器。不改变世界。',
      inputSchema: {
        type: 'object',
        properties: { run_id: runIdSchema },
        required: ['run_id'],
        additionalProperties: false
      }
    },
    {
      name: 'inspect_chest',
      description: '只读打开附近一个安全区内、allowlist 容器并返回物品摘要；不取物。只在没有活动任务时可用。',
      inputSchema: {
        type: 'object',
        properties: {
          run_id: runIdSchema,
          target: {
            type: 'string',
            description: 'observe 返回的容器坐标，格式 x,y,z。'
          },
          reason: reasonSchema
        },
        required: ['run_id', 'target', 'reason'],
        additionalProperties: false
      }
    },
    {
      name: 'eat',
      description: '从背包选择一个指定食物吃掉；只在饥饿低于阈值且没有活动任务时可用。item 必须是背包中存在的食物名。',
      inputSchema: {
        type: 'object',
        properties: {
          run_id: runIdSchema,
          item: { type: 'string', description: '背包中的食物物品名。' },
          reason: reasonSchema
        },
        required: ['run_id', 'item', 'reason'],
        additionalProperties: false
      }
    },
    {
      name: 'equip',
      description: '把背包中的指定护甲/工具/武器装备到对应槽位；只在没有活动任务时可用。item 必须是背包中存在的装备名。',
      inputSchema: {
        type: 'object',
        properties: {
          run_id: runIdSchema,
          item: { type: 'string', description: '背包中的护甲/工具/武器物品名。' },
          reason: reasonSchema
        },
        required: ['run_id', 'item', 'reason'],
        additionalProperties: false
      }
    },
    {
      name: 'finish',
      description: '结束本次自主会话；在目标完成或确认无法继续时调用。',
      inputSchema: {
        type: 'object',
        properties: {
          run_id: runIdSchema,
          summary: {
            type: 'string',
            description: '本次自主会话的简短结果（最多 200 字符）。'
          }
        },
        required: ['run_id', 'summary'],
        additionalProperties: false
      }
    }
  ]
}

export function toolDisplayName (name: string): string {
  return name.startsWith(AUTONOMY_TOOL_NAME_PREFIX) ? name.slice(AUTONOMY_TOOL_NAME_PREFIX.length) : name
}
