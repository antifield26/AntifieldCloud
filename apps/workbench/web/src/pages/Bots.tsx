// 机器人管理页：概览、配置、目标、投递与发布、角色与记忆、诊断六个分区（当前仅 QQ 官方 Bot）。
// 安全边界：只展示 BotSummary 的公开字段；密钥只提交不回显，不写入 DOM value/本地存储。
// 功能未启用（botsEnabled=false 或 503 bot_disabled/bot_key_missing）时展示服务端配置指引，不发起列表请求。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Bot as BotIcon, KeyRound, Plus, RefreshCw } from 'lucide-react'
import { api, isApiError, toErrorMessage } from '../api/client'
import type { BotStatus, BotSummary } from '../api/types'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { InlineError } from '../components/InlineError'
import { PageHeader } from '../components/PageHeader'
import { SkeletonText } from '../components/Skeleton'
import { BotConfigPanel } from '../components/bots/BotConfigPanel'
import { BotConnectivityCard } from '../components/bots/BotConnectivityCard'
import { BotDeliveryPanel } from '../components/bots/BotDeliveryPanel'
import { BotDiagnosticsPanel } from '../components/bots/BotDiagnosticsPanel'
import { BotOverview } from '../components/bots/BotOverview'
import type { BotSelectTab } from '../components/bots/BotOverview'
import { BotTargetsPanel } from '../components/bots/BotTargetsPanel'
import { BotUserDataPanel } from '../components/bots/BotUserDataPanel'

type BotsTab = 'overview' | 'config' | 'targets' | 'queue' | 'userdata' | 'diagnostics'

const TABS: readonly { id: BotsTab; label: string }[] = [
  { id: 'overview', label: '概览' },
  { id: 'config', label: '配置' },
  { id: 'targets', label: '目标' },
  { id: 'queue', label: '投递与发布' },
  { id: 'userdata', label: '角色与记忆' },
  { id: 'diagnostics', label: '诊断' },
]

const DISABLED_CODES = new Set(['bot_disabled', 'bot_key_missing', 'bot_key_invalid'])

interface DisabledInfo {
  code: string
  title: string
  description: string
}

function disabledFromStatus(status: BotStatus): DisabledInfo {
  if (!status.keyConfigured) {
    return {
      code: 'bot_key_missing',
      title: '缺少 BOT_SECRET_KEY',
      description: '服务端已启用 Bot 功能，但没有可用的加密密钥，无法保存或读取 Bot 配置。',
    }
  }
  return {
    code: 'bot_disabled',
    title: 'Bot 功能未启用',
    description: '服务端未启用 Bot 功能（BOT_ENABLED=false），当前不会处理 Webhook、投递或发布任务。',
  }
}

function disabledFromCode(code: string): DisabledInfo {
  if (code === 'bot_key_missing') {
    return {
      code,
      title: '缺少 BOT_SECRET_KEY',
      description: '服务端未配置 32 字节 base64 密钥，Bot 配置无法加密保存。',
    }
  }
  if (code === 'bot_key_invalid') {
    return {
      code,
      title: 'BOT_SECRET_KEY 配置无效',
      description: '服务端 BOT_SECRET_KEY 不是 base64 编码的 32 字节密钥，请修正后重启应用。',
    }
  }
  return {
    code: 'bot_disabled',
    title: 'Bot 功能未启用',
    description: '服务端返回 bot_disabled：当前不会处理 Webhook、投递或发布任务。',
  }
}

function errorCode(error: unknown): string | null {
  return isApiError(error) ? error.code : null
}

/** 机器人管理页：加载运行状态与 Bot 列表，并把六个分区组合为可键盘操作的标签页。 */
export function Bots() {
  const [status, setStatus] = useState<BotStatus | null>(null)
  const [bots, setBots] = useState<BotSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<BotsTab>('overview')
  const [configMode, setConfigMode] = useState<'create' | 'edit'>('create')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [disabled, setDisabled] = useState<DisabledInfo | null>(null)
  const tabButtons = useRef<Array<HTMLButtonElement | null>>([])

  const loadCore = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const nextStatus = await api.bots.status()
      setStatus(nextStatus)
      if (!nextStatus.enabled || !nextStatus.keyConfigured) {
        setBots([])
        setSelectedId(null)
        setDisabled(disabledFromStatus(nextStatus))
        return
      }
      setDisabled(null)
      try {
        const items = await api.bots.list()
        setBots(items)
        setSelectedId((previous) => {
          if (previous && items.some((item) => item.id === previous)) return previous
          return items[0]?.id ?? null
        })
        setConfigMode(items.length > 0 ? 'edit' : 'create')
      } catch (listError) {
        const code = errorCode(listError)
        if (code && DISABLED_CODES.has(code)) {
          setBots([])
          setSelectedId(null)
          setDisabled(disabledFromCode(code))
          return
        }
        throw listError
      }
    } catch (loadError) {
      const code = errorCode(loadError)
      if (code && DISABLED_CODES.has(code)) {
        setBots([])
        setSelectedId(null)
        setDisabled(disabledFromCode(code))
      } else {
        setError(toErrorMessage(loadError, '读取机器人状态失败'))
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadCore()
  }, [loadCore])

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      setStatus(await api.bots.status())
    } catch {
      // 状态计数刷新失败不影响已完成的配置修改；下一次手动刷新会重新读取。
    }
  }, [])

  const handleRefresh = async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    await loadCore()
    setRefreshToken((value) => value + 1)
    setRefreshing(false)
  }

  const selectedBot = useMemo(
    () => bots.find((bot) => bot.id === selectedId) ?? null,
    [bots, selectedId],
  )

  const selectBot = (id: string, nextTab?: BotSelectTab): void => {
    setSelectedId(id)
    setConfigMode('edit')
    if (nextTab) setTab(nextTab)
  }

  const openCreate = (): void => {
    setConfigMode('create')
    setTab('config')
  }

  const handleSaved = (saved: BotSummary): void => {
    setBots((previous) =>
      previous.some((item) => item.id === saved.id)
        ? previous.map((item) => (item.id === saved.id ? saved : item))
        : [...previous, saved],
    )
    setSelectedId(saved.id)
    setConfigMode('edit')
    void refreshStatus()
  }

  const handleDeleted = (id: string): void => {
    const remaining = bots.filter((bot) => bot.id !== id)
    setBots(remaining)
    setSelectedId((previous) => (previous === id ? remaining[0]?.id ?? null : previous))
    setConfigMode(remaining.length > 0 ? 'edit' : 'create')
    if (remaining.length === 0) setTab('overview')
    void refreshStatus()
  }

  const handleTargetsChanged = (targetCount: number): void => {
    if (!selectedId) return
    setBots((previous) =>
      previous.map((bot) => (bot.id === selectedId ? { ...bot, targetsCount: targetCount } : bot)),
    )
    void refreshStatus()
  }

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % TABS.length
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = TABS.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const next = TABS[nextIndex]
    if (!next) return
    setTab(next.id)
    window.requestAnimationFrame(() => tabButtons.current[nextIndex ?? 0]?.focus())
  }

  return (
    <div className="bots-page">
      <PageHeader
        title="机器人"
        description="QQ 官方 Bot 通知、Chat 与只读命令、角色与记忆、诊断"
        actions={
          <Button
            variant="secondary"
            icon={<RefreshCw size={16} aria-hidden="true" />}
            loading={refreshing}
            onClick={() => void handleRefresh()}
          >
            刷新
          </Button>
        }
      />

      {loading && !status ? (
        <Card title="机器人状态">
          <SkeletonText lines={5} />
        </Card>
      ) : null}

      {error ? (
        <InlineError
          message={error}
          onRetry={() => void loadCore()}
          className="page-inline-error"
        />
      ) : null}

      {disabled ? (
        <BotDisabledGuide info={disabled} refreshing={refreshing} onRetry={() => void handleRefresh()} />
      ) : null}

      {!disabled && status && status.enabled ? (
        <>
          <div className="bots-toolbar">
            <div className="bot-picker">
              <label className="field-label" htmlFor="bots-selected-bot">当前 Bot</label>
              <div className="select-field">
                <select
                  id="bots-selected-bot"
                  className="select"
                  value={selectedId ?? ''}
                  onChange={(event) => {
                    if (!event.target.value) return
                    selectBot(event.target.value)
                  }}
                  disabled={bots.length === 0}
                >
                  {bots.length === 0 ? <option value="">暂无 Bot</option> : null}
                  {bots.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="bots-toolbar-actions">
              <Button
                variant="primary"
                icon={<Plus size={16} aria-hidden="true" />}
                onClick={openCreate}
              >
                新建 Bot
              </Button>
            </div>
          </div>

          <div className="segmented bots-tabs" role="tablist" aria-label="机器人管理分区">
            {TABS.map((item, index) => (
              <button
                key={item.id}
                ref={(element) => {
                  tabButtons.current[index] = element
                }}
                type="button"
                role="tab"
                id={`bots-tab-${item.id}`}
                className={tab === item.id ? 'segmented-button segmented-button-active' : 'segmented-button'}
                aria-selected={tab === item.id}
                aria-controls="bots-panel"
                tabIndex={tab === item.id ? 0 : -1}
                onClick={() => setTab(item.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div
            className="bots-panel"
            id="bots-panel"
            role="tabpanel"
            aria-labelledby={`bots-tab-${tab}`}
            tabIndex={0}
          >
            {tab === 'overview' ? (
              <>
                <BotConnectivityCard />
                <BotOverview
                  status={status}
                  bots={bots}
                  loading={loading && bots.length === 0}
                  error={error}
                  selectedId={selectedId}
                  onRetry={() => void loadCore()}
                  onCreate={openCreate}
                  onSelect={selectBot}
                />
              </>
            ) : null}

            {tab === 'config' ? (
              <BotConfigPanel
                key={`${configMode}:${selectedBot?.id ?? 'new'}`}
                bot={selectedBot}
                mode={configMode}
                onModeChange={setConfigMode}
                onSaved={handleSaved}
                onDeleted={handleDeleted}
              />
            ) : null}

            {tab === 'targets' ? (
              <BotTargetsPanel
                key={selectedBot?.id ?? 'none'}
                bot={selectedBot}
                refreshToken={refreshToken}
                onChanged={handleTargetsChanged}
              />
            ) : null}

            {tab === 'queue' ? (
              <BotDeliveryPanel
                key={selectedBot?.id ?? 'none'}
                bot={selectedBot}
                refreshToken={refreshToken}
                onChanged={() => void refreshStatus()}
              />
            ) : null}

            {tab === 'userdata' ? (
              <BotUserDataPanel
                key={selectedBot?.id ?? 'none'}
                bot={selectedBot}
                refreshToken={refreshToken}
              />
            ) : null}

            {tab === 'diagnostics' ? (
              <BotDiagnosticsPanel
                key={selectedBot?.id ?? 'none'}
                bot={selectedBot}
                refreshToken={refreshToken}
              />
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}

function BotDisabledGuide({
  info,
  refreshing,
  onRetry,
}: {
  info: DisabledInfo
  refreshing: boolean
  onRetry: () => void
}) {
  return (
    <Card
      title={info.title}
      description="Bot 功能由服务端环境变量控制；前端在未启用时不会请求 Bot 列表。"
      actions={<Badge tone="warning" dot>需要配置</Badge>}
    >
      <div className="notice notice-warning" role="status">
        <KeyRound size={16} aria-hidden="true" />
        {info.description}
      </div>
      <p className="bot-guide-intro">按以下步骤在服务端启用后，再点击“重新检测”：</p>
      <ol className="bot-setup-steps">
        <li>
          在服务端环境变量设置 <code className="bot-code">BOT_ENABLED=true</code>。
        </li>
        <li>
          生成 32 字节 base64 密钥并设置 <code className="bot-code">BOT_SECRET_KEY</code>，例如
          {' '}<code className="bot-code">openssl rand -base64 32</code>。
        </li>
        <li>重启 AntifieldComplexx 服务，使环境变量生效。</li>
        <li>返回本页点击“重新检测”；Bot 列表与配置分区使用的是同一套服务端开关。</li>
      </ol>
      <div className="notice notice-muted">
        <BotIcon size={16} aria-hidden="true" />
        当前 <code className="bot-code">/api/version</code> 的 botsEnabled 同样为 false；密钥只保存在服务端，不会下发到浏览器。
      </div>
      <div className="form-actions">
        <Button
          variant="secondary"
          icon={<RefreshCw size={16} aria-hidden="true" />}
          loading={refreshing}
          onClick={onRetry}
        >
          重新检测
        </Button>
      </div>
    </Card>
  )
}
