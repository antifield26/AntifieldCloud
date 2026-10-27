// 机器人管理展示层常量：平台、目标类型、投递/发布状态的中文文案与配色。
// 仅做展示映射，不包含任何密钥；状态值以 api/types.ts 的联合类型为准。

import type {
  ChatbotDeliveryKind,
  ChatbotDeliveryStatus,
  ChatbotMemoryKind,
  ChatbotPlatform,
  ChatbotPublishStatus,
  ChatbotTarget,
  ChatbotTargetKind,
} from '../api/types'
import type { BadgeTone } from '../components/Badge'

export const CHATBOT_PLATFORMS: readonly ChatbotPlatform[] = ['qq']

export const CHATBOT_PLATFORM_LABELS: Record<ChatbotPlatform, string> = {
  qq: 'QQ 官方',
}

export const CHATBOT_TARGET_KIND_LABELS: Record<ChatbotTargetKind, string> = {
  channel: '频道',
  user: '用户',
  group: '群组',
}

/** 结构化记忆类型展示顺序与中文标签（只展示类型名，不含 key/value）。 */
export const CHATBOT_MEMORY_KINDS: readonly ChatbotMemoryKind[] = [
  'profile',
  'preference',
  'fact',
  'project',
  'task',
  'relationship',
  'episode',
]

export const CHATBOT_MEMORY_KIND_LABELS: Record<ChatbotMemoryKind, string> = {
  profile: '资料',
  preference: '偏好',
  fact: '事实',
  project: '项目',
  task: '任务',
  relationship: '关系',
  episode: '事件',
}

export const CHATBOT_DELIVERY_KIND_LABELS: Record<ChatbotDeliveryKind, string> = {
  notification: '通知',
  command_reply: '命令回复',
  publish: '发布',
  test: '测试',
}

interface StatusMeta {
  label: string
  tone: BadgeTone
}

export const CHATBOT_DELIVERY_STATUS_META: Record<ChatbotDeliveryStatus, StatusMeta> = {
  queued: { label: '排队中', tone: 'info' },
  sending: { label: '发送中', tone: 'accent' },
  sent: { label: '已发送', tone: 'success' },
  failed: { label: '待重试', tone: 'warning' },
  dead: { label: '死信', tone: 'danger' },
}

export const CHATBOT_PUBLISH_STATUS_META: Record<ChatbotPublishStatus, StatusMeta> = {
  draft: { label: '草稿', tone: 'muted' },
  queued: { label: '排队中', tone: 'info' },
  sending: { label: '发送中', tone: 'accent' },
  sent: { label: '已发送', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  canceled: { label: '已取消', tone: 'muted' },
}

/** QQ 单条消息的文本上限（与服务端适配器一致）。 */
export const CHATBOT_TEXT_LIMITS: Record<ChatbotPlatform, number> = {
  qq: 2000,
}

export function chatbotPlatformLabel(platform: ChatbotPlatform): string {
  return CHATBOT_PLATFORM_LABELS[platform] ?? platform
}

export function targetKindLabel(kind: ChatbotTargetKind): string {
  return CHATBOT_TARGET_KIND_LABELS[kind] ?? kind
}

/** 目标名称：目标被删除后仍能展示稳定占位，避免出现 undefined。 */
export function targetLabel(targets: readonly ChatbotTarget[], targetId: string | null): string {
  if (!targetId) return '未指定目标'
  return targets.find((target) => target.id === targetId)?.label ?? '已删除的目标'
}

/** 发布表单只允许频道/群组；用户目标仅用于命令回复与通知。 */
export function publishableTargets(targets: readonly ChatbotTarget[]): ChatbotTarget[] {
  return targets.filter((target) => target.kind !== 'user')
}

/* ---------- 诊断：入站事件结果 ---------- */

export interface ChatbotOutcomeMeta {
  label: string
  tone: BadgeTone
}

/** 事件结果类型的中文文案与徽章配色（服务端返回字符串，未知值按原样展示）。 */
export const CHATBOT_EVENT_OUTCOME_META: Record<string, ChatbotOutcomeMeta> = {
  received: { label: '已接收', tone: 'info' },
  ok: { label: '成功', tone: 'success' },
  denied: { label: '拒绝', tone: 'warning' },
  rate_limited: { label: '限流', tone: 'warning' },
  ignored: { label: '忽略', tone: 'muted' },
  error: { label: '错误', tone: 'danger' },
  rejected: { label: '签名拒绝', tone: 'danger' },
}

export function chatbotOutcomeMeta(outcome: string | null): ChatbotOutcomeMeta {
  if (!outcome) return { label: '未知', tone: 'muted' }
  return CHATBOT_EVENT_OUTCOME_META[outcome] ?? { label: outcome, tone: 'muted' }
}

/** 平台外部 ID 的短展示：只截断显示，完整值放 title。 */
export function shortenId(value: string | null | undefined, max = 12): string {
  if (!value) return '—'
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}
