// Minecraft 服务器分区：只读状态 + 白名单增删；不提供启停与任意命令。
// 从 /minecraft 页拆出，供“服务器”标签页复用；Lofii 标签页在 LofiiPanel 中实现。

import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Gamepad2, RefreshCw, Trash, UserPlus, Users } from 'lucide-react'
import { api, ApiError, toErrorMessage } from '../../api/client'
import type { MinecraftStatus, WhitelistResult } from '../../api/types'
import { Card } from '../Card'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Table } from '../Table'
import type { Column } from '../Table'
import { EmptyState } from '../EmptyState'
import { InlineError } from '../InlineError'
import { CopyButton } from '../CopyButton'
import { RelativeTime } from '../RelativeTime'
import { Avatar } from '../Avatar'
import { ConfirmDialog } from '../ConfirmDialog'
import { useToast } from '../Toast'
import type { ServiceState } from '../../api/types'

const PLAYER_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/

const SERVICE_STATE_LABELS: Record<ServiceState, string> = {
  active: '运行中',
  inactive: '已停止',
  unknown: '未知',
}

const SERVICE_TONES: Record<ServiceState, 'success' | 'danger' | 'muted'> = {
  active: 'success',
  inactive: 'danger',
  unknown: 'muted',
}

/** Minecraft 服务器分区：只读状态与白名单管理。 */
export function MinecraftServerPanel() {
  const toast = useToast()
  const [status, setStatus] = useState<MinecraftStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [whitelist, setWhitelist] = useState<WhitelistResult | null>(null)
  const [whitelistLoading, setWhitelistLoading] = useState(true)
  const [whitelistError, setWhitelistError] = useState<string | null>(null)
  const [playerName, setPlayerName] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [addBusy, setAddBusy] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const loadStatus = useCallback(async (force = false): Promise<void> => {
    setStatusLoading(true)
    setStatusError(null)
    try {
      setStatus(await api.mc.status(force))
    } catch (loadError) {
      setStatusError(toErrorMessage(loadError, '读取 Minecraft 状态失败'))
    } finally {
      setStatusLoading(false)
    }
  }, [])

  const loadWhitelist = useCallback(async (): Promise<void> => {
    setWhitelistLoading(true)
    setWhitelistError(null)
    try {
      setWhitelist(await api.mc.whitelist())
    } catch (loadError) {
      setWhitelistError(toErrorMessage(loadError, '读取白名单失败'))
    } finally {
      setWhitelistLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
    void loadWhitelist()
  }, [loadStatus, loadWhitelist])

  // 手动刷新跳过服务端 10 秒缓存
  const refreshAll = async (): Promise<void> => {
    setRefreshing(true)
    await Promise.allSettled([loadStatus(true), loadWhitelist()])
    setRefreshing(false)
  }

  const applyNames = (names: string[], checkedAt?: string, error?: string | null): void => {
    setWhitelist((previous) =>
      previous
        ? { ...previous, names, checkedAt: checkedAt ?? previous.checkedAt, error: error ?? null }
        : { names, checkedAt: checkedAt ?? new Date().toISOString(), error: error ?? null },
    )
    setStatus((previous) => (previous ? { ...previous, whitelistCount: names.length } : previous))
  }

  const handleAdd = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const trimmed = playerName.trim()
    if (!PLAYER_NAME_PATTERN.test(trimmed)) {
      setNameError('玩家名需为 3–16 位字母、数字或下划线')
      return
    }
    setAddBusy(true)
    setNameError(null)
    try {
      const result = await api.mc.addWhitelist(trimmed)
      applyNames(result.names, result.checkedAt, result.error)
      setPlayerName('')
      toast.success(`已将 ${result.name} 加入白名单`)
    } catch (addError) {
      if (addError instanceof ApiError && addError.code === 'already_whitelisted') {
        setNameError('该玩家已在白名单中')
      } else {
        toast.error(toErrorMessage(addError, '添加白名单失败，请重试'))
      }
    } finally {
      setAddBusy(false)
    }
  }

  const handleRemove = async (): Promise<void> => {
    if (!removeTarget) return
    setRemoveBusy(true)
    try {
      const result = await api.mc.removeWhitelist(removeTarget)
      applyNames(result.names, result.checkedAt, result.error)
      toast.success(`已将 ${result.name} 移出白名单`)
      setRemoveTarget(null)
    } catch (removeError) {
      toast.error(toErrorMessage(removeError, '移除白名单失败，请重试'))
    } finally {
      setRemoveBusy(false)
    }
  }

  const whitelistColumns: Column<string>[] = [
    {
      key: 'name',
      header: '玩家名',
      primary: true,
      render: (name) => (
        <div className="player-cell">
          <Avatar name={name} size={26} />
          <span className="mono">{name}</span>
        </div>
      ),
    },
    {
      key: 'status',
      header: '状态',
      render: () => <Badge tone="success">已加入白名单</Badge>,
    },
    {
      key: 'actions',
      header: <span className="sr-only">操作</span>,
      align: 'right',
      render: (name) => (
        <Button
          size="sm"
          variant="ghost"
          className="text-danger"
          icon={<Trash size={15} aria-hidden="true" />}
          aria-label={`移除白名单玩家 ${name}`}
          onClick={() => setRemoveTarget(name)}
        >
          移除
        </Button>
      ),
    },
  ]

  const names = whitelist?.names ?? []
  const tps = status?.tps ?? null
  const publicAddress = status?.publicAddress || null

  return (
    <div className="minecraft-server-panel">
      <div className="notice notice-muted">
        本页只提供状态查看与白名单增删，不提供服务器启停、控制台或任意 RCON 命令。
      </div>

      {statusError && !status ? (
        <Card title="服务器状态" error={statusError} onRetry={() => void loadStatus()} />
      ) : (
        <Card
          title="服务器状态"
          loading={statusLoading && !status}
          actions={
            <div className="card-actions-inline">
              {status ? (
                <Badge tone={status.online ? 'success' : 'danger'} dot>
                  {status.online ? '在线' : '离线'}
                </Badge>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                aria-label="刷新 Minecraft 状态与白名单"
                title="刷新"
                loading={refreshing}
                onClick={() => void refreshAll()}
                icon={<RefreshCw size={16} aria-hidden="true" />}
              />
            </div>
          }
        >
          {status ? (
            <>
              <div className="mc-status-grid">
                <div className="mc-fact">
                  <span className="mc-fact-label">版本</span>
                  <span className="mc-fact-value">{status.version || '未知'}</span>
                </div>
                <div className="mc-fact">
                  <span className="mc-fact-label">在线玩家</span>
                  <span className="mc-fact-value">{status.players.online} / {status.players.max}</span>
                </div>
                <div className="mc-fact">
                  <span className="mc-fact-label">TPS（1m / 5m / 15m）</span>
                  <span className="mc-fact-value">
                    {tps ? `${tps.m1.toFixed(1)} / ${tps.m5.toFixed(1)} / ${tps.m15.toFixed(1)}` : '—'}
                  </span>
                </div>
                <div className="mc-fact">
                  <span className="mc-fact-label">白名单数量</span>
                  <span className="mc-fact-value">{status.whitelistCount ?? '—'}</span>
                </div>
                <div className="mc-fact">
                  <span className="mc-fact-label">服务状态</span>
                  <span className="mc-fact-value">
                    <Badge tone={SERVICE_TONES[status.serviceActive]}>{SERVICE_STATE_LABELS[status.serviceActive]}</Badge>
                  </span>
                </div>
                <div className="mc-fact">
                  <span className="mc-fact-label">公共地址</span>
                  <span className="mc-fact-value mc-address-value">
                    <span className="mono">{publicAddress || '—'}</span>
                    <CopyButton
                      value={publicAddress ?? ''}
                      label="复制"
                      iconOnly
                      ariaLabel="复制 Minecraft 公共地址"
                      disabled={!publicAddress}
                    />
                  </span>
                </div>
              </div>

              {status.motd ? <p className="mc-motd">{status.motd}</p> : null}
              {status.error ? <div className="notice notice-warning">{status.error}</div> : null}
              {!status.error && tps === null ? (
                <div className="notice notice-warning">RCON 不可用，TPS 与白名单数据暂时无法读取。</div>
              ) : null}
              <p className="card-footnote">状态检查于 <RelativeTime ts={status.checkedAt} /></p>
            </>
          ) : null}
        </Card>
      )}

      <div className="mc-columns">
        <Card
          title="在线玩家"
          actions={<Badge tone={status && status.players.online > 0 ? 'success' : 'muted'}>{status?.players.online ?? 0} 人在线</Badge>}
        >
          {status && status.players.names.length > 0 ? (
            <ul className="player-chips">
              {status.players.names.map((name) => (
                <li key={name} className="player-chip">
                  <Avatar name={name} size={24} />
                  <span>{name}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState compact icon={<Gamepad2 size={22} />} title="暂无玩家在线" description="服务器在线时，这里会显示当前玩家列表。" />
          )}
        </Card>

        <Card
          title="白名单管理"
          description="玩家名规则：3–16 位字母、数字或下划线；修改立即生效。"
          actions={<Badge tone="muted"><Users size={13} aria-hidden="true" /> {names.length} 位玩家</Badge>}
        >
          <form className="whitelist-form" onSubmit={(event) => void handleAdd(event)}>
            <div className="whitelist-input-row">
              <input
                className="input"
                value={playerName}
                onChange={(event) => {
                  setPlayerName(event.target.value)
                  setNameError(null)
                }}
                placeholder="输入玩家名，例如 Steve"
                aria-label="要添加的玩家名"
                maxLength={16}
                autoComplete="off"
                spellCheck={false}
                disabled={addBusy}
              />
              <Button type="submit" variant="primary" icon={<UserPlus size={16} aria-hidden="true" />} loading={addBusy}>
                添加
              </Button>
            </div>
            {nameError ? <p className="field-error" role="alert">{nameError}</p> : null}
          </form>

          {whitelistError ? (
            <InlineError message={whitelistError} onRetry={() => void loadWhitelist()} />
          ) : (
            <Table
              columns={whitelistColumns}
              rows={names}
              rowKey={(name) => name}
              loading={whitelistLoading && !whitelist}
              skeletonRows={3}
              caption="白名单玩家列表"
              empty={
                <EmptyState
                  compact
                  icon={<Users size={22} />}
                  title="白名单为空"
                  description="在上方输入玩家名，添加第一位成员。"
                />
              }
            />
          )}

          <p className="field-hint">白名单接口仅返回名称列表，暂不提供添加时间；修改会写入审计日志。</p>
          <div className="notice notice-info">白名单修改立即生效；本页不提供服务器启停、控制台或任意命令。</div>
        </Card>
      </div>

      <ConfirmDialog
        open={removeTarget !== null}
        title="移除白名单"
        message={removeTarget ? `确定将「${removeTarget}」移出白名单？` : ''}
        details="移除后该玩家需要重新加入白名单才能进入服务器。"
        confirmText="移除"
        loading={removeBusy}
        onConfirm={() => void handleRemove()}
        onClose={() => {
          if (!removeBusy) setRemoveTarget(null)
        }}
      />
    </div>
  )
}
