// 机器人概览：运行状态卡（队列/密钥/目标计数）与 Chatbot 列表。
// 列表只使用 ChatbotSummary 的公开字段，不读取或展示任何密钥。

import { useEffect, useState } from 'react'
import { Bot as ChatbotIcon, Cable, Plus, RefreshCw } from 'lucide-react'
import { api } from '../../api/client'
import type { ChatbotStatus, ChatbotSummary } from '../../api/types'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Card } from '../Card'
import { EmptyState } from '../EmptyState'
import { RelativeTime } from '../RelativeTime'
import { chatbotPlatformLabel } from '../../lib/chatbots'

export type ChatbotSelectTab = 'config' | 'targets' | 'queue'

interface ChatbotOverviewProps {
  status: ChatbotStatus
  chatbots: ChatbotSummary[]
  loading: boolean
  error: string | null
  selectedId: string | null
  onRetry: () => void
  onCreate: () => void
  onSelect: (id: string, tab: ChatbotSelectTab) => void
}

/** 概览分区：状态计数 + Chatbot 列表，空态直接引导创建。 */
export function ChatbotOverview({
  status,
  chatbots,
  loading,
  error,
  selectedId,
  onRetry,
  onCreate,
  onSelect,
}: ChatbotOverviewProps) {
  // 概览状态只有原始 lastError；中文 hint 在 /metrics 中，故仅在存在最近错误时补查一次（失败静默）。
  const [lastErrorHint, setLastErrorHint] = useState<string | null>(null)
  useEffect(() => {
    if (!status.lastError || !selectedId) {
      setLastErrorHint(null)
      return
    }
    let active = true
    api.chatbots
      .metrics(selectedId, 24)
      .then((metrics) => {
        if (active) setLastErrorHint(metrics.lastErrorHint ?? null)
      })
      .catch(() => {
        if (active) setLastErrorHint(null)
      })
    return () => {
      active = false
    }
  }, [status.lastError, selectedId])

  const outbound = status.outbound
  const outboundTone = outbound?.degraded === true ? 'danger' : outbound?.active ? 'success' : 'muted'
  const outboundLabel = outbound?.degraded === true ? '异常' : outbound?.active ? '正常' : '未启用'

  return (
    <div className="chatbots-overview">
      <Card
        title="运行状态"
        description="Chatbot 队列由服务端定时处理；状态接口不返回任何凭据。"
        actions={
          <Badge tone={status.enabled ? 'success' : 'warning'} dot>
            {status.enabled ? '已启用' : '未启用'}
          </Badge>
        }
      >
        <div className="chatbot-status-grid">
          <div className="chatbot-status-item">
            <span className="chatbot-status-label">Chatbot 总数</span>
            <span className="chatbot-status-value">{status.chatbots}</span>
          </div>
          <div className="chatbot-status-item">
            <span className="chatbot-status-label">已启用</span>
            <span className="chatbot-status-value">{status.enabledBots}</span>
          </div>
          <div className="chatbot-status-item">
            <span className="chatbot-status-label">目标</span>
            <span className="chatbot-status-value">{status.targets}</span>
          </div>
          <div className="chatbot-status-item">
            <span className="chatbot-status-label">待投递</span>
            <span className="chatbot-status-value">{status.queuedDeliveries}</span>
          </div>
          <div className="chatbot-status-item">
            <span className="chatbot-status-label">待发布</span>
            <span className="chatbot-status-value">{status.queuedPublishes}</span>
          </div>
          <div className="chatbot-status-item">
            <span className="chatbot-status-label">出站可用性</span>
            <span className="chatbot-status-value">
              <Badge tone={outboundTone} dot>
                {outboundLabel}
              </Badge>
            </span>
          </div>
          <div className="chatbot-status-item">
            <span className="chatbot-status-label">最近成功发送</span>
            <span className="chatbot-status-value">
              {outbound?.lastSuccessAt ? <RelativeTime ts={outbound.lastSuccessAt} /> : '—'}
            </span>
          </div>
          <div className="chatbot-status-item">
            <span className="chatbot-status-label">加密密钥</span>
            <span className="chatbot-status-value">
              <Badge tone={status.keyConfigured ? 'success' : 'warning'}>
                {status.keyConfigured ? '已配置' : '未配置'}
              </Badge>
            </span>
          </div>
        </div>
        {outbound?.degraded === true ? (
          <div className="notice notice-danger" role="alert">
            Bot 出站异常：近 {outbound.windowMinutes} 分钟有 {outbound.recentFailures} 条失败/死信
            （历史失败 {outbound.failedDeliveries}、死信 {outbound.deadDeliveries}）。
            {outbound.lastErrorHint ? ` ${outbound.lastErrorHint}。` : ''}
            {selectedId ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onSelect(selectedId, 'queue')}
              >
                查看投递与发布
              </Button>
            ) : null}
          </div>
        ) : null}
        {status.lastError ? (
          <div className="notice notice-danger" role="alert">
            最近一次 Chatbot 错误：{status.lastError}
            {lastErrorHint ? `（${lastErrorHint}）` : ''}
          </div>
        ) : null}
        {status.aiToolIsolation && !status.aiToolIsolation.supported ? (
          <div className="notice notice-warning" role="status">
            AI 工具隔离已降级：OpenCode 拒绝 deny-all permissions，Chat 会话未启用工具隔离（降级{' '}
            {status.aiToolIsolation.fallbackCount} 次
            {status.aiToolIsolation.fallbackAt ? `，首次 ${status.aiToolIsolation.fallbackAt}` : ''}）。
          </div>
        ) : null}
        <p className="field-hint">
          Chatbot 命令为只读（/help、/status、/backup、/world、/mc、/files；AI 对话由普通消息 Chat 承担），本页不提供命令执行入口；发布任务由管理员手动创建并需 TOTP + PUBLISH 双确认。
        </p>
      </Card>

      <Card
        title="Chatbot 列表"
        description="选择 Chatbot 后进入配置、目标或投递与发布分区。"
        actions={
          <Badge tone="muted">
            <Cable size={13} aria-hidden="true" /> {chatbots.length} 个
          </Badge>
        }
        loading={loading}
        error={error}
        onRetry={onRetry}
        skeleton={<ChatbotListSkeleton />}
      >
        {chatbots.length === 0 ? (
          <EmptyState
            icon={<ChatbotIcon size={24} />}
            title="还没有配置 Chatbot"
            description="创建 QQ 官方 Chatbot 后，可登记目标、接收告警通知并发布消息。"
            action={
              <Button variant="primary" icon={<Plus size={16} aria-hidden="true" />} onClick={onCreate}>
                创建第一个 Chatbot
              </Button>
            }
          />
        ) : (
          <ul className="chatbot-list">
            {chatbots.map((chatbot) => (
              <li key={chatbot.id} className={selectedId === chatbot.id ? 'chatbot-list-item chatbot-list-item-active' : 'chatbot-list-item'}>
                <div className="chatbot-list-main">
                  <div className="chatbot-list-heading">
                    <span className="chatbot-list-icon" aria-hidden="true">
                      <ChatbotIcon size={18} />
                    </span>
                    <div className="chatbot-list-title-wrap">
                      <h3 className="chatbot-list-title">{chatbot.name}</h3>
                      <p className="chatbot-list-meta">
                        {chatbotPlatformLabel(chatbot.platform)} · {chatbot.targetsCount} 个目标 · 密钥版本 v{chatbot.keyVersion}
                      </p>
                    </div>
                    <Badge tone={chatbot.enabled ? 'success' : 'muted'} dot>
                      {chatbot.enabled ? '已启用' : '已停用'}
                    </Badge>
                  </div>
                  {chatbot.lastError ? (
                    <p className="chatbot-list-error" role="alert">最近错误：{chatbot.lastError}</p>
                  ) : (
                    <p className="chatbot-list-meta">
                      更新于 <RelativeTime ts={chatbot.updatedAt} />
                      {chatbot.lastCheckedAt ? (
                        <>
                          {' '}· 最近检查 <RelativeTime ts={chatbot.lastCheckedAt} />
                        </>
                      ) : null}
                    </p>
                  )}
                </div>
                <div className="chatbot-list-actions">
                  <Button
                    size="sm"
                    variant={selectedId === chatbot.id ? 'secondary' : 'ghost'}
                    aria-label={`配置 Chatbot ${chatbot.name}`}
                    onClick={() => onSelect(chatbot.id, 'config')}
                  >
                    配置
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`管理 Chatbot ${chatbot.name} 的目标`}
                    onClick={() => onSelect(chatbot.id, 'targets')}
                  >
                    目标
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`查看 Chatbot ${chatbot.name} 的投递与发布`}
                    onClick={() => onSelect(chatbot.id, 'queue')}
                  >
                    投递与发布
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="chatbot-page-footnote">
        <RefreshCw size={13} aria-hidden="true" /> 状态与计数在每次操作后自动刷新；遇到失败可重试对应队列任务。
      </p>
    </div>
  )
}

function ChatbotListSkeleton() {
  return (
    <div className="chatbot-list-skeleton" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <span key={index} className="skeleton chatbot-list-skeleton-row" />
      ))}
    </div>
  )
}
