import { useEffect } from 'react'

const APP_NAME = 'AntifieldComplexx · 个人综合交互平台'

/** 设置浏览器标签页标题。 */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · ${APP_NAME}` : APP_NAME
  }, [title])
}
