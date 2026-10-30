import { describe, expect, it } from 'vitest'
import type { McbotSnapshot, McbotStatus } from '../api/types'
import {
  MCBOT_AUTONOMY_STATE_LABELS,
  MCBOT_EVENT_FILTERS,
  MCBOT_EVENT_TYPE_LABELS,
  MCBOT_TASK_NAME_LABELS,
  MCBOT_TASK_NAMES,
  describeLofiiEvent,
  mcbotAutonomyStateLabel,
  mcbotErrorLabel,
  mcbotTaskNameLabel,
  mcbotTaskProgressRows,
  safeLofiiStatus,
  safeMcbotAutonomy,
} from './mcbot'

const autonomy = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  enabled: true,
  active: true,
  state: 'running',
  goal: '收集小麦并存入箱子',
  startedAt: '2026-10-28T00:00:00.000Z',
  elapsedSec: 42,
  remainingSec: 600,
  toolCalls: 3,
  maxToolCalls: 12,
  lastAction: 'gather_wheat',
  lastReason: '需要食物',
  lastError: null,
  lastDecisionAt: '2026-10-28T00:00:00.000Z',
  ...overrides,
})

const emptySnapshot = (overrides: Partial<McbotSnapshot> = {}): McbotSnapshot => ({
  enabled: true,
  reachable: true,
  stale: false,
  controlEnabled: true,
  alertsEnabled: true,
  eventsSupported: true,
  version: '1.0.2',
  contractVersion: 1,
  lastPollAt: null,
  error: null,
  status: null,
  events: [],
  ...overrides,
})

describe('mcbot v1.0.2 任务与自主模式展示', () => {
  it('11 种任务全部有中文标签且顺序稳定', () => {
    expect(MCBOT_TASK_NAMES).toHaveLength(11)
    expect(MCBOT_TASK_NAMES).toEqual([
      'fishing',
      'farming',
      'woodcutting',
      'mining',
      'forest',
      'sleep',
      'patrol',
      'guard',
      'escort',
      'explore',
      'clearing',
    ])
    expect(mcbotTaskNameLabel('guard')).toBe('守卫')
    expect(mcbotTaskNameLabel('escort')).toBe('护送')
    expect(mcbotTaskNameLabel('explore')).toBe('探索')
    expect(Object.keys(MCBOT_TASK_NAME_LABELS)).toHaveLength(11)
  })

  it('新任务的进度计数可渲染，旧服务端缺字段不伪造非零进度', () => {
    const progress = {
      fishCaught: 0,
      wheatHarvested: 0,
      planted: 0,
      deposited: 0,
      treesChopped: 0,
      logsChopped: 0,
      saplingsPlanted: 0,
      mobsKilled: 0,
      oresMined: 0,
      coalMined: 0,
      ironMined: 0,
      copperMined: 0,
      forestTreesChopped: 0,
      naturalLogsChopped: 0,
      naturalSaplingsPlanted: 0,
      sleepVotes: 0,
      nightSkipped: 0,
      patrolWaypoints: 0,
      patrolDistance: 0,
    }
    expect(
      mcbotTaskProgressRows({ name: 'guard', progress: { ...progress, guardKills: 4 } } as never),
    ).toEqual([{ label: '击杀怪物', value: '4' }])
    expect(
      mcbotTaskProgressRows({ name: 'escort', progress: { ...progress, escortDistance: 128 } } as never),
    ).toEqual([{ label: '护送距离', value: '128 格' }])
    expect(
      mcbotTaskProgressRows({ name: 'explore', progress: { ...progress, exploreWaypoints: 6 } } as never),
    ).toEqual([{ label: '探索点', value: '6' }])
    expect(mcbotTaskProgressRows({ name: 'guard', progress } as never)).toEqual([])
  })

  it('safeLofiiStatus 读取新任务进度字段', () => {
    const normalized = safeLofiiStatus({
      task: { name: 'guard', progress: { guardKills: 3, escortDistance: 9, exploreWaypoints: 2 } },
    } as unknown as McbotStatus)
    expect(normalized?.task.progress.guardKills).toBe(3)
    expect(normalized?.task.progress.escortDistance).toBe(9)
    expect(normalized?.task.progress.exploreWaypoints).toBe(2)
  })

  it('自主模式状态标签覆盖 6 态并对未知值兜底原字符串', () => {
    expect(MCBOT_AUTONOMY_STATE_LABELS.running).toBe('运行中')
    expect(mcbotAutonomyStateLabel('idle')).toBe('空闲')
    expect(mcbotAutonomyStateLabel('starting')).toBe('启动中')
    expect(mcbotAutonomyStateLabel('running')).toBe('运行中')
    expect(mcbotAutonomyStateLabel('stopping')).toBe('停止中')
    expect(mcbotAutonomyStateLabel('finished')).toBe('已结束')
    expect(mcbotAutonomyStateLabel('failed')).toBe('失败')
    expect(mcbotAutonomyStateLabel('paused_new')).toBe('paused_new')
    expect(mcbotAutonomyStateLabel(null)).toBe('—')
    expect(mcbotAutonomyStateLabel('__proto__')).toBe('__proto__')
  })

  it('safeMcbotAutonomy：旧版缺失返回 null，类型漂移补默认值，未知状态保留', () => {
    expect(safeMcbotAutonomy(null)).toBeNull()
    expect(safeMcbotAutonomy(undefined)).toBeNull()
    expect(safeMcbotAutonomy([])).toBeNull()
    expect(safeMcbotAutonomy('running')).toBeNull()

    const fallback = safeMcbotAutonomy({ enabled: 'yes', active: 1, state: 'paused_new', elapsedSec: -5 })
    expect(fallback?.enabled).toBe(false)
    expect(fallback?.active).toBe(false)
    expect(fallback?.state).toBe('paused_new')
    expect(fallback?.elapsedSec).toBe(0)
    expect(fallback?.toolCalls).toBe(0)
    expect(fallback?.goal).toBeNull()

    const long = safeMcbotAutonomy({ goal: 'x'.repeat(500), lastAction: 'y'.repeat(500) })
    expect(long?.goal?.length).toBe(200)
    expect(long?.lastAction?.length).toBe(300)
  })

  it('事件流支持 autonomy 类型与筛选，摘要为纯文本', () => {
    expect(MCBOT_EVENT_TYPE_LABELS.autonomy).toBe('自主')
    expect(MCBOT_EVENT_FILTERS).toContainEqual({ id: 'autonomy', label: '自主' })

    const view = describeLofiiEvent({
      id: 'boot-1',
      type: 'autonomy',
      ts: '2026-10-28T00:00:00.000Z',
      data: { state: 'running', action: 'gather_wheat', reason: '需要食物' },
    })
    expect(view.typeLabel).toBe('自主')
    expect(view.chatText).toBeNull()
    expect(view.summary).toBe('自主模式 · 运行中 · gather_wheat · 需要食物')

    const unknown = describeLofiiEvent({ id: 'boot-2', type: 'autonomy', ts: 'x', data: null })
    expect(unknown.summary).toBe('自主模式')
  })

  it('自主模式错误码有中文兜底，未知码原样展示', () => {
    expect(mcbotErrorLabel('mcbot_autonomy_disabled')).toContain('自主模式未启用')
    expect(mcbotErrorLabel('mcbot_autonomy_busy')).toContain('正在运行')
    expect(mcbotErrorLabel('mcbot_autonomy_unavailable')).toContain('自主模式不可用')
    expect(mcbotErrorLabel('mcbot_cursor_failed')).toContain('告警游标')
  })

  it('旧服务端快照无 autonomy 字段时不崩溃（保持 undefined）', () => {
    const legacy = emptySnapshot()
    expect(legacy.autonomy).toBeUndefined()
    expect(safeMcbotAutonomy(legacy.autonomy)).toBeNull()
    expect(safeMcbotAutonomy(autonomy())?.state).toBe('running')
  })
})
