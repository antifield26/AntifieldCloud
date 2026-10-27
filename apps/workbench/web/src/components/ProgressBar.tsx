import { cx } from '../lib/classnames'

export type ProgressTone = 'accent' | 'success' | 'warning' | 'danger' | 'auto'

export interface ProgressBarProps {
  value: number
  tone?: ProgressTone
  size?: 'sm' | 'md'
  ariaLabel?: string
  className?: string
}

function resolveTone(value: number, tone: ProgressTone): Exclude<ProgressTone, 'auto'> {
  if (tone !== 'auto') return tone
  if (value >= 90) return 'danger'
  if (value >= 75) return 'warning'
  return 'accent'
}

/** 进度条：用于配额、内存与上传进度；自动模式在接近上限时变黄/红。 */
export function ProgressBar({ value, tone = 'auto', size = 'md', ariaLabel, className }: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0))
  const resolved = resolveTone(clamped, tone)
  return (
    <div
      className={cx('progress', `progress-${size}`, className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      aria-label={ariaLabel}
    >
      <div className={cx('progress-fill', `progress-tone-${resolved}`)} style={{ width: `${clamped}%` }} />
    </div>
  )
}
