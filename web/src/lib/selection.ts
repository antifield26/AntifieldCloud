// 文件多选状态纯函数：Files 页多选分享使用。
// 约定：只有普通文件参与分享；目录不进入选择集。选择集是 id 数组，渲染时按当前列表顺序过滤。

import type { FileItem } from '../api/types'

/** 可分享的普通文件 id（目录、非 file 类型全部排除）。 */
export function selectableFileIds(files: FileItem[]): string[] {
  return files.filter((file) => file.kind === 'file').map((file) => file.id)
}

/** 切换单个文件的选择状态；已选则移除。 */
export function toggleSelection(selected: string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]
}

/** 全选/取消全选可分享文件；已有选择会合并去重。 */
export function setAllSelected(selected: string[], files: FileItem[], select: boolean): string[] {
  const ids = selectableFileIds(files)
  if (!select) return selected.filter((id) => !ids.includes(id))
  const merged = new Set([...selected, ...ids])
  return [...merged]
}

/** 判断当前列表中的可分享文件是否已全部选中（没有可分享文件时为 false）。 */
export function areAllSelected(selected: string[], files: FileItem[]): boolean {
  const ids = selectableFileIds(files)
  return ids.length > 0 && ids.every((id) => selected.includes(id))
}

/** 按当前列表顺序返回已选文件，并剔除已不在列表中的残留 id。 */
export function selectedFiles(selected: string[], files: FileItem[]): FileItem[] {
  if (selected.length === 0) return []
  const lookup = new Set(selected)
  return files.filter((file) => file.kind === 'file' && lookup.has(file.id))
}

/** 列表/目录/搜索变化后清理不可见的选择，避免分享到已离开当前视图的文件。 */
export function pruneSelection(selected: string[], files: FileItem[]): string[] {
  if (selected.length === 0) return selected
  const ids = new Set(selectableFileIds(files))
  const next = selected.filter((id) => ids.has(id))
  return next.length === selected.length ? selected : next
}
