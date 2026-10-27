import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Table } from './Table'
import type { Column } from './Table'

afterEach(cleanup)

interface Row {
  id: string
}

const columns: Column<Row>[] = [
  {
    key: 'select',
    header: <input type="checkbox" aria-label="全选当前列表文件" />,
    cardLabelHidden: true,
    render: (row) => <input type="checkbox" aria-label={`选择 ${row.id}`} />,
  },
  { key: 'name', header: '名称', primary: true, render: (row) => row.id },
]

describe('Table 卡片模式', () => {
  it('多选列在卡片模式只渲染行复选框，不重复“全选”表头', () => {
    const { container } = render(
      <Table columns={columns} rows={[{ id: 'a' }, { id: 'b' }]} rowKey={(row) => row.id} caption="测试列表" />,
    )
    const cards = container.querySelectorAll('.table-card')
    expect(cards).toHaveLength(2)
    for (const card of cards) {
      expect(card.querySelectorAll('input[type="checkbox"]')).toHaveLength(1)
      expect(card.textContent).not.toContain('全选当前列表文件')
    }
    // 桌面表头仍保留唯一的全选框。
    expect(screen.getAllByLabelText('全选当前列表文件')).toHaveLength(1)
  })

  it('primary 列与 cardLabelHidden 列不渲染标签', () => {
    const { container } = render(
      <Table columns={columns} rows={[{ id: 'a' }]} rowKey={(row) => row.id} />,
    )
    const labels = Array.from(container.querySelectorAll('.table-card-label')).map((node) => node.textContent)
    expect(labels).not.toContain('名称')
    expect(labels.length).toBe(0)
  })
})
