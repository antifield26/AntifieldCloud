import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { FileItem } from '../../api/types'
import { FileIcon } from '../FileIcon'

export interface FileThumbProps {
  file: FileItem
  size?: number
}

/** 网格视图缩略图：图片走 /content，其余回退为类型图标。 */
export function FileThumb({ file, size = 24 }: FileThumbProps) {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [file.id])

  // inlineAllowed=false 时服务端不会内联返回内容，直接回退图标
  if (file.kind === 'dir' || file.previewKind !== 'image' || file.inlineAllowed === false || failed) {
    return (
      <span className="file-thumb file-thumb-placeholder">
        <FileIcon name={file.name} mime={file.mime} kind={file.kind} size={size + 10} />
      </span>
    )
  }

  return (
    <span className="file-thumb">
      <img
        className="file-thumb-image"
        src={api.files.contentUrl(file.id, { inline: true })}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    </span>
  )
}
