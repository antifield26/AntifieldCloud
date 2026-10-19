import { cx } from '../lib/classnames'

export interface AvatarProps {
  name: string
  size?: number
  className?: string
}

/** 用首字母表示的圆形头像（玩家/用户），不依赖外部图片。 */
export function Avatar({ name, size = 28, className }: AvatarProps) {
  const initial = name.trim().charAt(0).toUpperCase() || '?'
  return (
    <span
      className={cx('avatar', className)}
      style={{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.max(11, Math.round(size * 0.42))}px` }}
      aria-hidden="true"
    >
      {initial}
    </span>
  )
}
