import { cx } from '../lib/classnames'

export interface LogoProps {
  size?: number
  withText?: boolean
  className?: string
}

/** 方形渐变 Logo（cyan → blue）+ AC 字母；登录页与侧栏共用。 */
export function Logo({ size = 36, withText = false, className }: LogoProps) {
  return (
    <span className={cx('logo', className)}>
      <span
        className="logo-mark"
        style={{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.36)}px` }}
        aria-hidden="true"
      >
        AC
      </span>
      {withText ? (
        <span className="logo-text">
          <strong className="logo-name">AntifieldComplexx</strong>
          <span className="logo-subtitle">个人工作台</span>
        </span>
      ) : null}
    </span>
  )
}
