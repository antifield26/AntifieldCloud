import type { CSSProperties } from 'react'
import { cx } from '../lib/classnames'

export interface SkeletonProps {
  width?: string | number
  height?: string | number
  radius?: string
  className?: string
}

/** 骨架占位块，避免加载时布局跳动。 */
export function Skeleton({ width, height = '1em', radius, className }: SkeletonProps) {
  const style: CSSProperties = {
    width: typeof width === 'number' ? `${width}px` : width,
    height: typeof height === 'number' ? `${height}px` : height,
    borderRadius: radius,
  }
  return <span className={cx('skeleton', className)} style={style} aria-hidden="true" />
}

export interface SkeletonTextProps {
  lines?: number
  className?: string
}

export function SkeletonText({ lines = 3, className }: SkeletonTextProps) {
  return (
    <div className={cx('skeleton-text', className)} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} height={12} width={index === lines - 1 ? '62%' : '100%'} />
      ))}
    </div>
  )
}

export interface SkeletonRowsProps {
  rows?: number
  columns?: number
}

/** 表格加载态占位。 */
export function SkeletonRows({ rows = 5, columns = 4 }: SkeletonRowsProps) {
  return (
    <div className="skeleton-rows" aria-hidden="true">
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div className="skeleton-row" key={rowIndex}>
          {Array.from({ length: columns }, (_, columnIndex) => (
            <Skeleton key={columnIndex} height={13} width={columnIndex === 0 ? '58%' : '38%'} />
          ))}
        </div>
      ))}
    </div>
  )
}
