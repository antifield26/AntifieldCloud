import { formatDateTime, formatRelative } from '../lib/format'
import { useNow } from '../hooks/useNow'
import { cx } from '../lib/classnames'

export interface RelativeTimeProps {
  ts: string | null | undefined
  fallback?: string
  className?: string
}

/** 相对时间（如「3 分钟前」），title 展示 Asia/Shanghai 绝对时间。 */
export function RelativeTime({ ts, fallback = '—', className }: RelativeTimeProps) {
  const now = useNow(30_000)
  if (!ts) return <span className={className}>{fallback}</span>
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return <span className={className}>{fallback}</span>
  return (
    <time className={cx('relative-time', className)} dateTime={date.toISOString()} title={formatDateTime(ts)}>
      {formatRelative(ts, now)}
    </time>
  )
}
