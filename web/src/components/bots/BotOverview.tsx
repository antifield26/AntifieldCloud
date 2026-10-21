// 机器人概览：运行状态卡（队列/密钥/目标计数）与 Bot 列表。
// 列表只使用 BotSummary 的公开字段，不读取或展示任何密钥。

import { Bot as BotIcon, Cable, Plus, RefreshCw } from 'lucide-react'
import type { BotStatus, BotSummary } from '../../api/types'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Card } from '../Card'
import { EmptyState } from '../EmptyState'
import { RelativeTime } from '../RelativeTime'
import { botPlatformLabel } from '../../lib/bots'

export type BotSelectTab = 'config' | 'targets' | 'queue'

function gatewayStateLabel(state: BotSummary['gateway']['state']): string {
  switch (state) {
    case 'connected':
      return '已连接'
    case 'connecting':
      return '连接中'
    case 'reconnecting':
      return '重连中'
    case 'error':
      return '错误'
    default:
      return '未启用'
  }
}

interface BotOverviewProps {
  status: BotStatus
  bots: BotSummary[]
  loading: boolean
  error: string | null
  selectedId: string | null
  onRetry: () => void
  onCreate: () => void
  onSelect: (id: string, tab: BotSelectTab) => void
}

/** 概览分区：状态计数 + Bot 列表，空态直接引导创建。 */
export function BotOverview({
  status,
  bots,
  loading,
  error,
  selectedId,
  onRetry,
  onCreate,
  onSelect,
}: BotOverviewProps) {
  return (
    <div className="bots-overview">
      <Card
        title="运行状态"
        description="Bot 队列由服务端定时处理；状态接口不返回任何凭据。"
        actions={
          <Badge tone={status.enabled ? 'success' : 'warning'} dot>
            {status.enabled ? '已启用' : '未启用'}
          </Badge>
        }
      >
        <div className="bot-status-grid">
          <div className="bot-status-item">
            <span className="bot-status-label">Bot 总数</span>
            <span className="bot-status-value">{status.bots}</span>
          </div>
          <div className="bot-status-item">
            <span className="bot-status-label">已启用</span>
            <span className="bot-status-value">{status.enabledBots}</span>
          </div>
          <div className="bot-status-item">
            <span className="bot-status-label">目标</span>
            <span className="bot-status-value">{status.targets}</span>
          </div>
          <div className="bot-status-item">
            <span className="bot-status-label">待投递</span>
            <span className="bot-status-value">{status.queuedDeliveries}</span>
          </div>
          <div className="bot-status-item">
            <span className="bot-status-label">待发布</span>
            <span className="bot-status-value">{status.queuedPublishes}</span>
          </div>
          <div className="bot-status-item">
            <span className="bot-status-label">加密密钥</span>
            <span className="bot-status-value">
              <Badge tone={status.keyConfigured ? 'success' : 'warning'}>
                {status.keyConfigured ? '已配置' : '未配置'}
              </Badge>
            </span>
          </div>
        </div>
        {status.lastError ? (
          <div className="notice notice-danger" role="alert">
            最近一次 Bot 错误：{status.lastError}
          </div>
        ) : null}
        <p className="field-hint">
          Bot 命令为只读（/help、/status、/backup、/world、/mc、/files、/ask），本页不提供命令执行入口；发布任务由管理员手动创建并需 TOTP + PUBLISH 双确认。
        </p>
      </Card>

      <Card
        title="Bot 列表"
        description="选择 Bot 后进入配置、目标或投递与发布分区。"
        actions={
          <Badge tone="muted">
            <Cable size={13} aria-hidden="true" /> {bots.length} 个
          </Badge>
        }
        loading={loading}
        error={error}
        onRetry={onRetry}
        skeleton={<BotListSkeleton />}
      >
        {bots.length === 0 ? (
          <EmptyState
            icon={<BotIcon size={24} />}
            title="还没有配置 Bot"
            description="创建 Telegram、Discord、Slack 或 QQ 官方 Bot 后，可登记目标、接收告警通知并发布消息。"
            action={
              <Button variant="primary" icon={<Plus size={16} aria-hidden="true" />} onClick={onCreate}>
                创建第一个 Bot
              </Button>
            }
          />
        ) : (
          <ul className="bot-list">
            {bots.map((bot) => (
              <li key={bot.id} className={selectedId === bot.id ? 'bot-list-item bot-list-item-active' : 'bot-list-item'}>
                <div className="bot-list-main">
                  <div className="bot-list-heading">
                    <span className="bot-list-icon" aria-hidden="true">
                      <BotIcon size={18} />
                    </span>
                    <div className="bot-list-title-wrap">
                      <h3 className="bot-list-title">{bot.name}</h3>
                      <p className="bot-list-meta">
                        {botPlatformLabel(bot.platform)} · {bot.targetsCount} 个目标 · 密钥版本 v{bot.keyVersion}
                        {bot.platform === 'discord' ? ` · Gateway ${gatewayStateLabel(bot.gateway.state)}` : ''}
                      </p>
                    </div>
                    <Badge tone={bot.enabled ? 'success' : 'muted'} dot>
                      {bot.enabled ? '已启用' : '已停用'}
                    </Badge>
                  </div>
                  {bot.lastError ? (
                    <p className="bot-list-error" role="alert">最近错误：{bot.lastError}</p>
                  ) : (
                    <p className="bot-list-meta">
                      更新于 <RelativeTime ts={bot.updatedAt} />
                      {bot.lastCheckedAt ? (
                        <>
                          {' '}· 最近检查 <RelativeTime ts={bot.lastCheckedAt} />
                        </>
                      ) : null}
                    </p>
                  )}
                </div>
                <div className="bot-list-actions">
                  <Button
                    size="sm"
                    variant={selectedId === bot.id ? 'secondary' : 'ghost'}
                    aria-label={`配置 Bot ${bot.name}`}
                    onClick={() => onSelect(bot.id, 'config')}
                  >
                    配置
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`管理 Bot ${bot.name} 的目标`}
                    onClick={() => onSelect(bot.id, 'targets')}
                  >
                    目标
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`查看 Bot ${bot.name} 的投递与发布`}
                    onClick={() => onSelect(bot.id, 'queue')}
                  >
                    投递与发布
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="bot-page-footnote">
        <RefreshCw size={13} aria-hidden="true" /> 状态与计数在每次操作后自动刷新；遇到失败可重试对应队列任务。
      </p>
    </div>
  )
}

function BotListSkeleton() {
  return (
    <div className="bot-list-skeleton" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <span key={index} className="skeleton bot-list-skeleton-row" />
      ))}
    </div>
  )
}
