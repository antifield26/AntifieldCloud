import { Download, Eye, FolderInput, Pencil, Share2, Trash } from 'lucide-react'
import type { FileItem } from '../../api/types'
import { Button } from '../Button'
import { Dropdown } from '../Dropdown'
import type { DropdownItem } from '../Dropdown'

export interface FileRowActionsProps {
  file: FileItem
  onPreview: () => void
  onDownload: () => void
  onRename: () => void
  onMove: () => void
  onDelete: () => void
  /** 分享入口；服务端未启用分享时为 undefined */
  onShare?: () => void
}

/** 文件行/卡片操作：桌面端快捷图标 + 更多菜单；移动端只保留更多菜单。 */
export function FileRowActions({
  file,
  onPreview,
  onDownload,
  onRename,
  onMove,
  onDelete,
  onShare,
}: FileRowActionsProps) {
  const canPreview = file.kind === 'file' && file.previewKind !== 'none'
  const canShare = file.kind === 'file' && typeof onShare === 'function'
  const items: DropdownItem[] = []
  if (canPreview) {
    items.push({ key: 'preview', label: '预览', icon: <Eye size={15} />, onSelect: onPreview })
  }
  if (file.kind === 'file') {
    items.push({ key: 'download', label: '下载', icon: <Download size={15} />, onSelect: onDownload })
  }
  if (canShare) {
    items.push({ key: 'share', label: '分享', icon: <Share2 size={15} />, onSelect: onShare })
  }
  items.push(
    { key: 'rename', label: '重命名', icon: <Pencil size={15} />, onSelect: onRename },
    { key: 'move', label: '移动', icon: <FolderInput size={15} />, onSelect: onMove },
    { key: 'delete', label: '删除', icon: <Trash size={15} />, danger: true, onSelect: onDelete },
  )

  return (
    <div className="row-actions">
      {canPreview ? (
        <Button
          variant="ghost"
          size="icon"
          className="row-action-quick"
          aria-label={`预览 ${file.name}`}
          title="预览"
          onClick={onPreview}
          icon={<Eye size={17} aria-hidden="true" />}
        />
      ) : null}
      {file.kind === 'file' ? (
        <Button
          variant="ghost"
          size="icon"
          className="row-action-quick"
          aria-label={`下载 ${file.name}`}
          title="下载"
          onClick={onDownload}
          icon={<Download size={17} aria-hidden="true" />}
        />
      ) : null}
      {canShare ? (
        <Button
          variant="ghost"
          size="icon"
          className="row-action-quick"
          aria-label={`分享 ${file.name}`}
          title="分享"
          onClick={onShare}
          icon={<Share2 size={17} aria-hidden="true" />}
        />
      ) : null}
      <Dropdown items={items} ariaLabel={`${file.name} 的更多操作`} />
    </div>
  )
}
