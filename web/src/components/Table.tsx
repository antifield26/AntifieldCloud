import type { ReactNode } from 'react'
import { SkeletonRows } from './Skeleton'
import { cx } from '../lib/classnames'

export interface Column<T> {
  key: string
  header: ReactNode
  /** 移动端卡片模式下的字段名，默认复用 header */
  mobileHeader?: ReactNode
  render: (row: T) => ReactNode
  align?: 'left' | 'center' | 'right'
  className?: string
  primary?: boolean
  hideOnMobile?: boolean
}

export interface TableProps<T> {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T, index: number) => string
  loading?: boolean
  skeletonRows?: number
  empty?: ReactNode
  caption?: string
  className?: string
}

/**
 * 数据表格：桌面端为标准表格，< 900px 时切换为卡片列表。
 * 两种结构同时渲染，由 CSS 控制显示，避免 JS 监听窗口尺寸。
 */
export function Table<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  skeletonRows = 5,
  empty,
  caption,
  className,
}: TableProps<T>) {
  const hasRows = rows.length > 0
  return (
    <div className={cx('table-wrap', className)}>
      {loading || hasRows ? (
        <>
          <table className="table">
            {caption ? <caption className="sr-only">{caption}</caption> : null}
            <thead>
              <tr>
                {columns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={cx(column.align && `align-${column.align}`, column.className, column.hideOnMobile && 'hide-mobile')}
                  >
                    {column.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={columns.length} className="table-loading-cell">
                    <SkeletonRows rows={skeletonRows} columns={Math.min(columns.length, 4)} />
                  </td>
                </tr>
              ) : (
                rows.map((row, index) => (
                  <tr key={rowKey(row, index)}>
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={cx(
                          column.align && `align-${column.align}`,
                          column.className,
                          column.primary && 'cell-primary',
                          column.hideOnMobile && 'hide-mobile',
                        )}
                      >
                        {column.render(row)}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>

          <div className="table-cards">
            {loading ? (
              <SkeletonRows rows={skeletonRows} columns={2} />
            ) : (
              rows.map((row, index) => (
                <div className="table-card" key={rowKey(row, index)}>
                  {columns
                    .filter((column) => !column.hideOnMobile)
                    .map((column) => (
                      <div className="table-card-row" key={column.key}>
                        {column.primary ? null : (
                          <span className="table-card-label">{column.mobileHeader ?? column.header}</span>
                        )}
                        <span
                          className={cx(
                            'table-card-value',
                            column.primary && 'cell-primary',
                            column.primary && 'table-card-value-primary',
                          )}
                        >
                          {column.render(row)}
                        </span>
                      </div>
                    ))}
                </div>
              ))
            )}
          </div>
        </>
      ) : null}

      {!loading && !hasRows ? (
        <div className="table-empty">{empty ?? <p className="muted">暂无数据</p>}</div>
      ) : null}
    </div>
  )
}
