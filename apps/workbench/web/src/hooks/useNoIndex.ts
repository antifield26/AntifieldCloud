// 公开分享页禁止搜索引擎索引：挂载时插入 robots meta，卸载时移除。

import { useEffect } from 'react'

export function useNoIndex(): void {
  useEffect(() => {
    const meta = document.createElement('meta')
    meta.name = 'robots'
    meta.content = 'noindex, nofollow, noarchive'
    document.head.appendChild(meta)
    return () => {
      meta.remove()
    }
  }, [])
}
