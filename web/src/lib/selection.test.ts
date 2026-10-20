import { describe, expect, it } from 'vitest'
import type { FileItem } from '../api/types'
import {
  areAllSelected,
  pruneSelection,
  selectableFileIds,
  selectedFiles,
  setAllSelected,
  toggleSelection,
} from './selection'

function file(id: string, kind: FileItem['kind'] = 'file'): FileItem {
  return {
    id,
    parentId: null,
    name: `${id}.bin`,
    kind,
    size: 1,
    mime: null,
    sha256: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    previewKind: 'none',
  }
}

const files = [file('a'), file('b'), file('dir-1', 'dir'), file('c')]

describe('多选分享状态', () => {
  it('只把普通文件视为可分享', () => {
    expect(selectableFileIds(files)).toEqual(['a', 'b', 'c'])
  })

  it('切换选择与去重', () => {
    expect(toggleSelection([], 'a')).toEqual(['a'])
    expect(toggleSelection(['a'], 'a')).toEqual([])
    expect(toggleSelection(['a'], 'b')).toEqual(['a', 'b'])
  })

  it('全选与取消全选只影响可分享文件', () => {
    expect(setAllSelected([], files, true)).toEqual(['a', 'b', 'c'])
    expect(setAllSelected(['a'], files, true)).toEqual(['a', 'b', 'c'])
    expect(setAllSelected(['a', 'b', 'dir-1'], files, false)).toEqual(['dir-1'])
    expect(areAllSelected(['a', 'b', 'c'], files)).toBe(true)
    expect(areAllSelected(['a'], files)).toBe(false)
    expect(areAllSelected([], [file('dir-1', 'dir')])).toBe(false)
  })

  it('按列表顺序返回已选文件并剔除残留 id', () => {
    expect(selectedFiles(['c', 'a'], files).map((item) => item.id)).toEqual(['a', 'c'])
    expect(selectedFiles(['a', 'gone'], files).map((item) => item.id)).toEqual(['a'])
    expect(pruneSelection(['a', 'gone', 'dir-1'], files)).toEqual(['a'])
    expect(pruneSelection(['a'], files)).toEqual(['a'])
  })
})
