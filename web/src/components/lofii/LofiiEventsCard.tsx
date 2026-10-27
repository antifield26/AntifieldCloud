// Lofii 事件流：只读展示 Lofii 内存事件环（newest first，最多 100 条）。
// 安全边界：事件 data 视为不可信 unknown，聊天正文与结构化摘要都以纯文本渲染，
// 不使用 dangerouslySetInnerHTML，也不展示 Token/URL/内部路径。

import { useState } from 'react'
import { Activity } from 'lucide-react'
import type { LofiiEvent, LofiiSnapshot } from '../../api/types'
import { Badge } from '../Badge'
import type { BadgeTone } from '../Badge'
import { Card } from '../Card'
import { EmptyState } from '../EmptyState'
import { RelativeTime } from '../RelativeTime'
import { SkeletonText } from '../Skeleton'
import { cx } from '../../lib/classnames'
import {
  LOFII_EVENT_FILTERS,
  describeLofiiEvent,
  lofiiEventsSupported,
  lofiiEventTypeLabel,
} from '../../lib/lofii'

/** 最多展示的事件条数：与服务端 /api/lofii/status 的事件上限一致。 */
const MAX_DISPLAYED_EVENTS = 100

const EVENT_TONES: Record<string, BadgeTone> = {
  chat: 'accent',
  task: 'info',
  presence: 'muted',
  movement: 'info',
  alert: 'warning',
}

function EventRow({ event }: { event: LofiiEvent }) {
  const view = describeLofiiEvent(event)
  const tone = EVENT_TONES[event.type] ?? 'muted'
  return (
    <li className={cx('lofii-event', `lofii-event-${event.type}`)}>
      <div className="lofii-event-head">
        <Badge tone={tone}>{view.typeLabel || lofiiEventTypeLabel(event.type)}</Badge>
        <RelativeTime ts={event.ts} className="lofii-event-time" />
      </div>
      {view.chatText ? (
        <p className="lofii-event-chat">{view.chatText}</p>
      ) : (
        <p className="lofii-event-summary">{view.summary}</p>
      )}
    </li>
  )
}

interface LofiiEventsCardProps {
  snapshot: LofiiSnapshot | null
}

/** 事件流卡片：类型筛选 + 倒序列表；旧版 Lofii 显示升级提示。 */
export function LofiiEventsCard({ snapshot }: LofiiEventsCardProps) {
  const [filter, setFilter] = useState('all')
  const supported = lofiiEventsSupported(snapshot)
  const events = Array.isArray(snapshot?.events) ? snapshot.events : []
  const visible = events
    .filter((event) => filter === 'all' || event.type === filter)
    .slice(0, MAX_DISPLAYED_EVENTS)
  const filterLabel = LOFII_EVENT_FILTERS.find((option) => option.id === filter)?.label ?? '全部'

  return (
    <Card
      title="事件流"
      description="Lofii 内存事件环的最近事件（按时间倒序，最多显示 100 条）。"
      actions={<Badge tone="muted">{events.length} 条</Badge>}
      loading={!snapshot}
      skeleton={<SkeletonText lines={4} />}
    >
      {!supported ? (
        <div className="notice notice-warning">
          Lofii 需升级到 v0.6.0 才能显示事件流（当前 Lofii 未提供 /events/recent 或事件契约）。
        </div>
      ) : (
        <>
          <div className="lofii-event-filters" role="group" aria-label="事件类型筛选">
            {LOFII_EVENT_FILTERS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={cx('lofii-filter-button', filter === option.id && 'lofii-filter-button-active')}
                aria-pressed={filter === option.id}
                onClick={() => setFilter(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {visible.length > 0 ? (
            <ul className="lofii-event-list">
              {visible.map((event, index) => (
                <EventRow key={`${event.id}-${index}`} event={event} />
              ))}
            </ul>
          ) : (
            <EmptyState
              compact
              icon={<Activity size={22} />}
              title={filter === 'all' ? '暂无事件' : `暂无「${filterLabel}」事件`}
              description={
                filter === 'all'
                  ? 'Lofii 产生状态、任务、聊天或移动事件后会在这里显示。'
                  : '切换筛选或等待 Lofii 产生新事件。'
              }
            />
          )}

          <p className="card-footnote">
            事件来自 Lofii 进程内内存环，Lofii 重启后清空；本页不保存事件历史。
          </p>
        </>
      )}
    </Card>
  )
}
