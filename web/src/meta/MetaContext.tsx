// 站点元数据上下文：/api/version 下发的 appOrigin/aiOrigin、回收站保留天数、上传上限与功能开关。
// 安全边界：服务端下发的 origin 必须通过 http(s) 校验；缺失时根据当前页面域名安全回退。
// 公开页（登录/分享）不依赖登录态，未登录时不请求该接口。

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api/client'
import type { AppMeta, VersionResult } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { currentSiteLocation, deriveSiblingOrigin, safeOrigin } from '../lib/origin'

const DEFAULT_TRASH_RETENTION_DAYS = 30
const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024

function fallbackMeta(): AppMeta {
  const location = currentSiteLocation()
  const appOrigin = safeOrigin(location?.origin ?? null) ?? ''
  const aiOrigin = appOrigin ? deriveSiblingOrigin(appOrigin) : null
  return {
    version: null,
    appOrigin,
    aiOrigin,
    trashRetentionDays: DEFAULT_TRASH_RETENTION_DAYS,
    trashRetentionFromServer: false,
    maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
    sharesEnabled: true,
    alertsEnabled: true,
  }
}

function buildMeta(version: VersionResult): AppMeta {
  const fallback = fallbackMeta()
  const appOrigin = safeOrigin(version.appOrigin) ?? fallback.appOrigin
  const aiOrigin = safeOrigin(version.aiOrigin) ?? (appOrigin ? deriveSiblingOrigin(appOrigin) : null)
  const trashRetentionDays =
    typeof version.trashRetentionDays === 'number' && version.trashRetentionDays > 0
      ? version.trashRetentionDays
      : DEFAULT_TRASH_RETENTION_DAYS
  const maxUploadBytes =
    typeof version.maxUploadBytes === 'number' && version.maxUploadBytes > 0
      ? version.maxUploadBytes
      : DEFAULT_MAX_UPLOAD_BYTES
  return {
    version: version.version || null,
    appOrigin,
    aiOrigin,
    trashRetentionDays,
    trashRetentionFromServer: typeof version.trashRetentionDays === 'number' && version.trashRetentionDays > 0,
    maxUploadBytes,
    sharesEnabled: version.sharesEnabled !== false,
    alertsEnabled: version.alertsEnabled !== false,
  }
}

interface AppMetaContextValue {
  meta: AppMeta
  loading: boolean
  refresh: () => Promise<void>
}

const AppMetaContext = createContext<AppMetaContextValue | null>(null)

export function useAppMeta(): AppMetaContextValue {
  const context = useContext(AppMetaContext)
  if (!context) throw new Error('useAppMeta 必须在 AppMetaProvider 内使用')
  return context
}

export function AppMetaProvider({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  const [meta, setMeta] = useState<AppMeta>(() => fallbackMeta())
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const version = await api.getVersion()
      setMeta(buildMeta(version))
    } catch {
      // 元数据接口失败时保留安全回退值，不阻塞页面
      setMeta((previous) => (previous.version ? previous : fallbackMeta()))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (status !== 'authenticated') {
      setMeta(fallbackMeta())
      setLoading(status === 'loading')
      return
    }
    setLoading(true)
    void refresh()
  }, [status, refresh])

  const value = useMemo<AppMetaContextValue>(() => ({ meta, loading, refresh }), [meta, loading, refresh])

  return <AppMetaContext.Provider value={value}>{children}</AppMetaContext.Provider>
}
