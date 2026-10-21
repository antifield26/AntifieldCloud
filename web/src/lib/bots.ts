// 机器人管理展示层常量：平台、目标类型、投递/发布状态的中文文案与配色。
// 仅做展示映射，不包含任何密钥；状态值以 api/types.ts 的联合类型为准。

import type {
  BotDeliveryKind,
  BotDeliveryStatus,
  BotPlatform,
  BotPublishStatus,
  BotTarget,
  BotTargetKind,
} from '../api/types'
import type { BadgeTone } from '../components/Badge'

export const BOT_PLATFORMS: readonly BotPlatform[] = ['telegram', 'discord', 'slack', 'qq']

export const BOT_PLATFORM_LABELS: Record<BotPlatform, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  qq: 'QQ 官方',
}

export const BOT_TARGET_KIND_LABELS: Record<BotTargetKind, string> = {
  channel: '频道',
  user: '用户',
  group: '群组',
}

export const BOT_DELIVERY_KIND_LABELS: Record<BotDeliveryKind, string> = {
  notification: '通知',
  command_reply: '命令回复',
  publish: '发布',
  test: '测试',
}

interface StatusMeta {
  label: string
  tone: BadgeTone
}

export const BOT_DELIVERY_STATUS_META: Record<BotDeliveryStatus, StatusMeta> = {
  queued: { label: '排队中', tone: 'info' },
  sending: { label: '发送中', tone: 'accent' },
  sent: { label: '已发送', tone: 'success' },
  failed: { label: '待重试', tone: 'warning' },
  dead: { label: '死信', tone: 'danger' },
}

export const BOT_PUBLISH_STATUS_META: Record<BotPublishStatus, StatusMeta> = {
  draft: { label: '草稿', tone: 'muted' },
  queued: { label: '排队中', tone: 'info' },
  sending: { label: '发送中', tone: 'accent' },
  sent: { label: '已发送', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  canceled: { label: '已取消', tone: 'muted' },
}

/** 各平台单条消息的文本上限（与服务端适配器一致）。 */
export const BOT_TEXT_LIMITS: Record<BotPlatform, number> = {
  telegram: 4096,
  discord: 2000,
  slack: 4000,
  qq: 2000,
}

export function botPlatformLabel(platform: BotPlatform): string {
  return BOT_PLATFORM_LABELS[platform] ?? platform
}

export function targetKindLabel(kind: BotTargetKind): string {
  return BOT_TARGET_KIND_LABELS[kind] ?? kind
}

/** 目标名称：目标被删除后仍能展示稳定占位，避免出现 undefined。 */
export function targetLabel(targets: readonly BotTarget[], targetId: string | null): string {
  if (!targetId) return '未指定目标'
  return targets.find((target) => target.id === targetId)?.label ?? '已删除的目标'
}

/** 发布表单只允许频道/群组；用户目标仅用于命令回复与通知。 */
export function publishableTargets(targets: readonly BotTarget[]): BotTarget[] {
  return targets.filter((target) => target.kind !== 'user')
}
