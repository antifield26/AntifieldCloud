import { Activity, Archive, Bell, BookOpen, Bot as Chatbot, FileText, LogIn, Share2, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AuditItem } from '../api/types'
import { auditActionMeta } from '../lib/audit'
import type { AuditCategory } from '../lib/audit'
import { RelativeTime } from './RelativeTime'
import { cx } from '../lib/classnames'

const CATEGORY_ICONS: Record<AuditCategory, LucideIcon> = {
  auth: LogIn,
  file: FileText,
  share: Share2,
  whitelist: Users,
  knowledge: BookOpen,
  alert: Bell,
  backup: Archive,
  chatbot: Chatbot,
  other: Activity,
}

export interface AuditEntryProps {
  item: AuditItem
}

/** 最近活动条目：图标 + 中文动作 + 目标 + 相对时间。 */
export function AuditEntry({ item }: AuditEntryProps) {
  const meta = auditActionMeta(item.action)
  const Icon = CATEGORY_ICONS[meta.category]
  return (
    <li className="audit-entry">
      <span className={cx('audit-icon', `audit-icon-${meta.category}`)} aria-hidden="true">
        <Icon size={16} />
      </span>
      <div className="audit-main">
        <span className="audit-label">{meta.label}</span>
        {item.target ? (
          <span className="audit-target" title={item.target}>{item.target}</span>
        ) : null}
      </div>
      <RelativeTime ts={item.ts} className="audit-time" />
    </li>
  )
}
