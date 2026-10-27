import type { ReactNode } from 'react'
import { Skeleton } from './Skeleton'
import { cx } from '../lib/classnames'

export type StatTone = 'default' | 'accent' | 'success' | 'warning' | 'danger'

export interface StatProps {
  label: ReactNode
  value: ReactNode
  unit?: ReactNode
  hint?: ReactNode
  footer?: ReactNode
  icon?: ReactNode
  tone?: StatTone
  badge?: ReactNode
  loading?: boolean
  className?: string
}

/** 指标卡：一个数字 + 单位 + 说明，可附带进度条等 footer 内容。 */
export function Stat({ label, value, unit, hint, footer, icon, tone = 'default', badge, loading = false, className }: StatProps) {
  return (
    <section className={cx('stat-card', className)}>
      <header className="stat-header">
        <span className="stat-label">
          {icon ? <span className="stat-icon" aria-hidden="true">{icon}</span> : null}
          {label}
        </span>
        {badge}
      </header>
      {loading ? (
        <div className="stat-loading">
          <Skeleton height={30} width="52%" />
          <Skeleton height={12} width="78%" />
          <Skeleton height={8} width="100%" radius="99px" />
        </div>
      ) : (
        <>
          <div className={cx('stat-value', `stat-tone-${tone}`)}>
            <span className="stat-value-number">{value}</span>
            {unit ? <span className="stat-unit">{unit}</span> : null}
          </div>
          {hint ? <div className="stat-hint">{hint}</div> : null}
          {footer ? <div className="stat-footer">{footer}</div> : null}
        </>
      )}
    </section>
  )
}
