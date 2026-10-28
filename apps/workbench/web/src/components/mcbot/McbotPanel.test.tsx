import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  McbotHistory,
  McbotHistoryAlert,
  McbotHistoryQuery,
  McbotHistorySample,
  McbotSnapshot,
  McbotStatus,
  McbotTask,
  McbotTaskProgress,
} from '../../api/types'
import { ToastProvider } from '../Toast'
import { McbotPanel } from './McbotPanel'

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  history: vi.fn(),
  startTask: vi.fn(),
  stopTask: vi.fn(),
  resumeTask: vi.fn(),
  move: vi.fn(),
  say: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: {
    mcbot: {
      status: mocks.status,
      history: mocks.history,
      startTask: mocks.startTask,
      stopTask: mocks.stopTask,
      resumeTask: mocks.resumeTask,
      move: mocks.move,
      say: mocks.say,
    },
  },
  // 测试只需按 code 判断降级；非 ApiError 返回 false。
  isApiError: (error: unknown, code?: string) => {
    const record = error as { code?: unknown } | null
    return Boolean(
      record &&
        typeof record.code === 'string' &&
        (code === undefined || record.code === code),
    )
  },
  toErrorMessage: (error: unknown, fallback = '') =>
    error instanceof Error && error.message ? error.message : fallback,
  isAbortError: (error: unknown) =>
    Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError'),
}))

function progress(overrides: Partial<McbotTaskProgress> = {}): McbotTaskProgress {
  return {
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
    ...overrides,
  }
}

function idleTask(overrides: Partial<McbotTask> = {}): McbotTask {
  return {
    enabled: true,
    active: false,
    name: null,
    state: 'idle',
    startedAt: null,
    elapsedSec: 0,
    progress: progress(),
    failures: 0,
    lastError: null,
    pendingResume: null,
    queue: [],
    ...overrides,
  }
}

function activeTask(overrides: Partial<McbotTask> = {}): McbotTask {
  return idleTask({
    active: true,
    name: 'fishing',
    state: 'running',
    startedAt: '2026-10-27T07:00:00.000Z',
    elapsedSec: 170,
    progress: progress({ fishCaught: 5 }),
    ...overrides,
  })
}

function mcbotStatus(overrides: Partial<McbotStatus> = {}): McbotStatus {
  return {
    version: '0.6.0',
    uptimeSec: 3600,
    state: 'connected',
    minecraft: {
      connected: true,
      username: 'mcbot',
      host: '127.0.0.1',
      port: 25565,
      version: '26.1',
      reconnects: 0,
      lastDisconnect: null,
    },
    player: { dimension: '主世界', position: { x: 204.5, y: 63, z: 469.5 }, health: 20, food: 19 },
    server: {
      reachable: true,
      online: 2,
      max: 6,
      versionName: 'Paper 26.1.2',
      motd: 'Raspberry Pi 5 | Minecraft LAN',
      latencyMs: 5,
      lastPingAt: '2026-10-27T07:59:00.000Z',
    },
    presence: {
      enabled: true,
      pollMs: 15000,
      graceMs: 60000,
      checkMs: 5000,
      otherPlayers: 1,
      lastDecision: 'connected',
    },
    ai: {
      enabled: true,
      provider: 'opencode-go',
      model: 'deepseek-v4.1-flash',
      inFlight: 0,
      queued: 1,
      failures: 2,
      lastLatencyMs: 2359,
      lastError: null,
    },
    memory: { players: 1, turns: 4 },
    task: idleTask(),
    admin: {
      enabled: true,
      rcon: true,
      updatedAt: '2026-10-27T07:59:00.000Z',
      lastError: null,
      tps: { one: 19.6, five: 19.8, fifteen: 19.9 },
      online: { count: 2, max: 6, players: ['Antifield', 'mcbot'] },
      whitelist: { count: 6, names: ['mcbot', 'Antifield'] },
      time: { ticks: 21461, label: '03:27' },
      backup: { status: 'unknown' },
    },
    ...overrides,
  }
}

function snapshot(overrides: Partial<McbotSnapshot> = {}): McbotSnapshot {
  return {
    enabled: true,
    reachable: true,
    stale: false,
    controlEnabled: true,
    alertsEnabled: true,
    version: '0.6.0',
    contractVersion: 1,
    eventsSupported: true,
    lastPollAt: '2026-10-27T08:00:00.000Z',
    error: null,
    status: mcbotStatus(),
    events: [],
    ...overrides,
  }
}

function sample(): McbotHistorySample {
  return {
    ts: '2026-10-27T07:59:00.000Z',
    connected: true,
    state: 'connected',
    taskName: 'fishing',
    taskState: 'running',
    health: 20,
    food: 18,
    memoryMb: 45,
    tps: 19.7,
    queueLen: 0,
    rssMb: 120,
  }
}

function alert(): McbotHistoryAlert {
  return {
    id: 1,
    ts: '2026-10-27T07:30:00.000Z',
    type: 'low_health',
    severity: 'warning',
    message: 'mcbot 血量偏低：8/20',
    details: {},
  }
}

function alertsResult(): McbotHistory {
  return { kind: 'alerts', from: null, to: null, count: 1, alerts: [alert()] }
}

function samplesResult(): McbotHistory {
  return { kind: 'samples', from: null, to: null, count: 1, samples: [sample()] }
}

function renderPanel() {
  return render(
    <ToastProvider>
      <McbotPanel />
    </ToastProvider>,
  )
}

beforeEach(() => {
  mocks.status.mockResolvedValue(snapshot())
  mocks.history.mockImplementation(async (query: McbotHistoryQuery) =>
    query.kind === 'samples' ? samplesResult() : alertsResult(),
  )
  mocks.startTask.mockResolvedValue({ ok: true })
  mocks.stopTask.mockResolvedValue({ ok: true })
  mocks.resumeTask.mockResolvedValue({ ok: true })
  mocks.move.mockResolvedValue({ ok: true })
  mocks.say.mockResolvedValue({ ok: true })
})

afterEach(cleanup)

describe('McbotPanel 状态与降级', () => {
  it('mcbot 集成未启用时只显示说明，不渲染控制与历史', async () => {
    mocks.status.mockResolvedValue(
      snapshot({ enabled: false, reachable: false, status: null, events: [] }),
    )
    renderPanel()
    expect(await screen.findByText(/mcbot 集成未启用/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '开始任务' })).toBeNull()
    expect(mocks.history).not.toHaveBeenCalled()
  })

  it('不可达且数据过期时显示中文警告并保留缓存状态', async () => {
    mocks.status.mockResolvedValue(
      snapshot({ reachable: false, stale: true, error: 'mcbot_unavailable' }),
    )
    renderPanel()
    expect(await screen.findByText(/无法连接 mcbot：mcbot 服务不可达/)).toBeTruthy()
    expect(screen.getByText(/mcbot 数据已过期/)).toBeTruthy()
    // 缓存的状态数据仍然展示
    expect(screen.getByText('已连接（mcbot）')).toBeTruthy()
    expect(screen.getByText('2 / 6')).toBeTruthy()
  })

  it('首次轮询完成前只提示等待，不误报不可达', async () => {
    mocks.status.mockResolvedValue(
      snapshot({ reachable: false, status: null, events: [], lastPollAt: null, error: null }),
    )
    renderPanel()
    expect(await screen.findByText(/正在等待 mcbot 首次轮询结果/)).toBeTruthy()
    expect(screen.queryByText(/无法连接 mcbot/)).toBeNull()
  })

  it('上游 status 缺嵌套段时容忍缺失，不让整个面板崩溃', async () => {
    mocks.status.mockResolvedValue(snapshot({ status: {} as McbotStatus }))
    renderPanel()
    expect(await screen.findByText('mcbot 状态')).toBeTruthy()
    expect(screen.getAllByText('事件流').length).toBeGreaterThan(0)
  })

  it('status 可达但事件轮询/游标失败时显示可见警告', async () => {
    mocks.status.mockResolvedValue(
      snapshot({ reachable: true, error: 'mcbot_upstream_error', eventsSupported: true }),
    )
    renderPanel()
    expect(await screen.findByText(/事件流\/告警游标异常/)).toBeTruthy()
    expect(screen.getByText(/事件流可能停止更新/)).toBeTruthy()
  })

  it('刷新失败时保留上次成功的数据并提示', async () => {
    mocks.status
      .mockResolvedValueOnce(snapshot())
      .mockRejectedValueOnce(new Error('mcbot 不可达'))
    renderPanel()
    expect(await screen.findByText('已连接（mcbot）')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '刷新 mcbot 状态' }))
    expect(await screen.findByText(/显示上次成功获取的数据/)).toBeTruthy()
    expect(screen.getByText('已连接（mcbot）')).toBeTruthy()
  })

  it('控制未启用时禁用任务/移动/聊天操作并显示说明', async () => {
    mocks.status.mockResolvedValue(
      snapshot({ controlEnabled: false, status: mcbotStatus({ task: activeTask() }) }),
    )
    renderPanel()
    expect(await screen.findByText(/任务\/移动\/聊天操作已禁用/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '开始任务' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '停止任务' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '回家' })).toBeDisabled()
    expect(screen.getByLabelText('游戏内聊天内容')).toBeDisabled()
    expect(mocks.move).not.toHaveBeenCalled()
  })
})

describe('McbotPanel 任务控制', () => {
  it('开始任务需要二次确认，并按所选任务调用接口', async () => {
    renderPanel()
    expect(await screen.findByRole('button', { name: '开始任务' })).toBeEnabled()
    await userEvent.selectOptions(screen.getByLabelText('任务'), 'patrol')
    await userEvent.click(screen.getByRole('button', { name: '开始任务' }))

    const dialog = await screen.findByRole('dialog', { name: '开始任务' })
    expect(within(dialog).getByText(/确定让 mcbot 开始「巡逻」任务/)).toBeTruthy()
    await userEvent.click(within(dialog).getByRole('button', { name: '开始' }))

    await waitFor(() => expect(mocks.startTask).toHaveBeenCalledWith('patrol'))
    expect(await screen.findByText(/已请求 mcbot 开始「巡逻」任务/)).toBeTruthy()
  })

  it('停止任务确认文案说明会清空队列', async () => {
    mocks.status.mockResolvedValue(snapshot({ status: mcbotStatus({ task: activeTask() }) }))
    renderPanel()
    await userEvent.click(await screen.findByRole('button', { name: '停止任务' }))
    const dialog = await screen.findByRole('dialog', { name: '停止任务' })
    expect(within(dialog).getByText(/确定停止当前任务并清空队列/)).toBeTruthy()
    await userEvent.click(within(dialog).getByRole('button', { name: '停止' }))
    await waitFor(() => expect(mocks.stopTask).toHaveBeenCalledTimes(1))
  })

  it('待恢复任务显示横幅并可确认恢复', async () => {
    mocks.status.mockResolvedValue(
      snapshot({
        status: mcbotStatus({
          task: idleTask({
            state: 'pending_resume',
            name: 'fishing',
            pendingResume: {
              taskId: 'task-pending-1',
              name: 'fishing',
              startedAt: '2026-10-27T07:00:00.000Z',
              elapsedSec: 137,
              progress: progress({ fishCaught: 4 }),
              expiresAt: '2026-10-27T08:10:00.000Z',
            },
          }),
        }),
      }),
    )
    renderPanel()
    expect(await screen.findByText(/有待恢复任务「钓鱼」/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '恢复任务' }))
    const dialog = await screen.findByRole('dialog', { name: '恢复任务' })
    await userEvent.click(within(dialog).getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(mocks.resumeTask).toHaveBeenCalledWith('task-pending-1'))
  })

  it('移动目标排除 mcbot 自己，过来使用所选玩家', async () => {
    renderPanel()
    const select = (await screen.findByLabelText('选择移动目标玩家')) as HTMLSelectElement
    expect(within(select).getByRole('option', { name: 'Antifield' })).toBeTruthy()
    expect(within(select).queryByRole('option', { name: 'mcbot' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: '过来' }))
    await waitFor(() => expect(mocks.move).toHaveBeenCalledWith('come', 'Antifield'))
    expect(await screen.findByText(/已请求 mcbot 过来/)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '回家' }))
    await waitFor(() => expect(mocks.move).toHaveBeenLastCalledWith('home', undefined))
  })
})

describe('McbotPanel 游戏内聊天', () => {
  it('拒绝以 / 开头的内容，不打开确认、不调用接口', async () => {
    renderPanel()
    const input = await screen.findByLabelText('游戏内聊天内容')
    await userEvent.type(input, '/tp Antifield')
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText(/聊天内容不能包含 \//)).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mocks.say).not.toHaveBeenCalled()
  })

  it('拒绝切分边界后的 / 命令行（上游按 240 字符切行）', async () => {
    renderPanel()
    const input = await screen.findByLabelText('游戏内聊天内容')
    // 250+ 字符逐字输入在 jsdom/覆盖率插桩下偶发超过 5s 用例超时；用 change 直接构造边界值。
    fireEvent.change(input, { target: { value: `${'a'.repeat(240)}/op mcbot` } })
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText(/聊天内容不能包含 \//)).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mocks.say).not.toHaveBeenCalled()
  })

  it('合法内容二次确认后发送并清空输入', async () => {
    renderPanel()
    const input = (await screen.findByLabelText('游戏内聊天内容')) as HTMLTextAreaElement
    await userEvent.type(input, '晚上好')
    await waitFor(() => expect(input.value).toBe('晚上好'))
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    const dialog = await screen.findByRole('dialog', { name: '发送游戏内聊天' })
    // 覆盖率插桩会拉长渲染时序：用 findByText 等待确认弹窗内容落定，避免偶发空文本。
    expect(await within(dialog).findByText('晚上好')).toBeTruthy()
    await userEvent.click(within(dialog).getByRole('button', { name: '发送' }))
    await waitFor(() => expect(mocks.say).toHaveBeenCalledWith('晚上好'))
    expect(await screen.findByText('已发送游戏内聊天')).toBeTruthy()
    await waitFor(() => expect(input.value).toBe(''))
  })
})

describe('McbotPanel 事件流', () => {
  it('聊天事件以纯文本展示，其余事件显示结构化摘要并支持筛选', async () => {
    mocks.status.mockResolvedValue(
      snapshot({
        events: [
          {
            id: 'boot-1',
            type: 'chat',
            ts: '2026-10-27T07:59:00.000Z',
            data: { direction: 'out', text: '好，我去钓鱼啦。', source: 'ai' },
          },
          {
            id: 'boot-2',
            type: 'task',
            ts: '2026-10-27T07:58:00.000Z',
            data: { action: 'started', task: { name: 'fishing', state: 'running' } },
          },
        ],
      }),
    )
    renderPanel()
    expect(await screen.findByText('mcbot：好，我去钓鱼啦。')).toBeTruthy()
    expect(screen.getByText(/任务已开始 · 钓鱼 · 进行中/)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '聊天' }))
    expect(screen.getByText('mcbot：好，我去钓鱼啦。')).toBeTruthy()
    expect(screen.queryByText(/任务已开始 · 钓鱼 · 进行中/)).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: '全部' }))
    expect(screen.getByText(/任务已开始 · 钓鱼 · 进行中/)).toBeTruthy()
  })

  it('旧版 mcbot 不支持事件时显示升级提示', async () => {
    mocks.status.mockResolvedValue(
      snapshot({ contractVersion: null, eventsSupported: false, events: [] }),
    )
    renderPanel()
    expect(await screen.findByText(/需升级到 v0.6.0 才能显示事件流/)).toBeTruthy()
  })
})

describe('McbotPanel 历史记录', () => {
  it('默认加载最近 24 小时告警，切换采样后表格更新', async () => {
    renderPanel()
    // Table 同时渲染桌面表格与移动端卡片，文本会出现两次。
    expect((await screen.findAllByText('mcbot 血量偏低：8/20')).length).toBeGreaterThan(0)

    const firstQuery = mocks.history.mock.calls[0]?.[0] as McbotHistoryQuery
    expect(firstQuery.kind).toBe('alerts')
    expect(firstQuery.limit).toBe(100)
    const windowMs = Date.parse(firstQuery.to ?? '') - Date.parse(firstQuery.from ?? '')
    expect(windowMs).toBe(24 * 60 * 60 * 1000)

    await userEvent.click(screen.getByRole('button', { name: '采样' }))
    await waitFor(() => {
      const lastQuery = mocks.history.mock.calls[mocks.history.mock.calls.length - 1]?.[0] as McbotHistoryQuery
      expect(lastQuery.kind).toBe('samples')
    })
    expect((await screen.findAllByText('钓鱼 · 进行中')).length).toBeGreaterThan(0)
  })
})
