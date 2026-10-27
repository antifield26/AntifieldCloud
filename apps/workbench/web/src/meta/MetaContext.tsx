// 站点元数据上下文：/api/version 下发的 appOrigin/aiOrigin、回收站保留天数、上传上限与功能开关。
// 安全边界：服务端下发的 origin 必须通过 http(s) 校验；缺失时根据当前页面域名安全回退。
// 公开页（登录/分享）不依赖登录态，未登录时不请求该接口。

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api/client'
import type { AppMeta, VersionResult } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { currentSiteLocation, deriveSiblingOrigin, safeOrigin } from '../lib/origin'

/** /api/version 失败后的自动重试间隔（毫秒）；最多 3 次，避免长期停留在安全回退值。 */
const META_RETRY_DELAYS_MS = [3000, 10_000, 30_000] as const

const DEFAULT_TRASH_RETENTION_DAYS = 30
// 与 docs/app/API.md 的单请求上限一致：Cloudflare 代理下最大 100 MiB
const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024
const DEFAULT_NOTE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024
const DEFAULT_NOTE_MAX_ATTACHMENTS = 100
const DEFAULT_NOTE_VERSIONS_KEEP = 20
const DEFAULT_SHARE_MAX_ITEMS = 50
const DEFAULT_METRICS_SAMPLE_SECONDS = 60
const DEFAULT_METRICS_RETENTION_DAYS = 30
const DEFAULT_BACKUP_IMPORT_MAX_BYTES = 100 * 1024 * 1024
const DEFAULT_BACKUP_RESTORE_MAX_ENTRIES = 5000

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

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
    backupRestoreEnabled: false,
    chunkedUploadEnabled: false,
    chunkSizeBytes: 0,
    chunkMaxFileBytes: 0,
    noteAttachmentMaxBytes: DEFAULT_NOTE_ATTACHMENT_MAX_BYTES,
    noteMaxAttachments: DEFAULT_NOTE_MAX_ATTACHMENTS,
    noteVersionsKeep: DEFAULT_NOTE_VERSIONS_KEEP,
    shareMaxItems: DEFAULT_SHARE_MAX_ITEMS,
    metricsEnabled: true,
    metricsSampleSeconds: DEFAULT_METRICS_SAMPLE_SECONDS,
    metricsRetentionDays: DEFAULT_METRICS_RETENTION_DAYS,
    backupImportMaxBytes: DEFAULT_BACKUP_IMPORT_MAX_BYTES,
    backupRestoreMaxEntries: DEFAULT_BACKUP_RESTORE_MAX_ENTRIES,
    schemaVersion: null,
    backupArchiveEncryption: false,
    backupAgeRecipientConfigured: false,
    backupOffsiteStatusConfigured: false,
    audit: null,
    mcbotEnabled: false,
    mcbotControlEnabled: false,
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
    backupRestoreEnabled: version.backupRestoreEnabled === true,
    chunkedUploadEnabled: version.chunkedUploadEnabled === true,
    chunkSizeBytes:
      typeof version.chunkSizeBytes === 'number' && version.chunkSizeBytes > 0 ? version.chunkSizeBytes : 0,
    chunkMaxFileBytes:
      typeof version.chunkMaxFileBytes === 'number' && version.chunkMaxFileBytes > 0 ? version.chunkMaxFileBytes : 0,
    noteAttachmentMaxBytes: positiveNumber(version.noteAttachmentMaxBytes, DEFAULT_NOTE_ATTACHMENT_MAX_BYTES),
    noteMaxAttachments: Math.floor(positiveNumber(version.noteMaxAttachments, DEFAULT_NOTE_MAX_ATTACHMENTS)),
    noteVersionsKeep: Math.floor(positiveNumber(version.noteVersionsKeep, DEFAULT_NOTE_VERSIONS_KEEP)),
    shareMaxItems: Math.floor(positiveNumber(version.shareMaxItems, DEFAULT_SHARE_MAX_ITEMS)),
    metricsEnabled: version.metricsEnabled !== false,
    metricsSampleSeconds: Math.floor(
      positiveNumber(version.metricsSampleSeconds, DEFAULT_METRICS_SAMPLE_SECONDS),
    ),
    metricsRetentionDays: Math.floor(positiveNumber(version.metricsRetentionDays, DEFAULT_METRICS_RETENTION_DAYS)),
    backupImportMaxBytes: Math.floor(
      positiveNumber(version.backupImportMaxBytes, DEFAULT_BACKUP_IMPORT_MAX_BYTES),
    ),
    backupRestoreMaxEntries: Math.floor(
      positiveNumber(version.backupRestoreMaxEntries, DEFAULT_BACKUP_RESTORE_MAX_ENTRIES),
    ),
    schemaVersion:
      typeof version.schemaVersion === 'number' && Number.isFinite(version.schemaVersion)
        ? version.schemaVersion
        : null,
    backupArchiveEncryption: version.backupArchiveEncryption === true,
    backupAgeRecipientConfigured: version.backupAgeRecipientConfigured === true,
    backupOffsiteStatusConfigured: version.backupOffsiteStatusConfigured === true,
    audit: version.audit ?? null,
    mcbotEnabled: version.mcbotEnabled === true,
    mcbotControlEnabled: version.mcbotControlEnabled === true,
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
  const [retryTick, setRetryTick] = useState(0)
  const retryAttemptRef = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const version = await api.getVersion()
      setMeta(buildMeta(version))
      retryAttemptRef.current = 0
    } catch {
      // 元数据接口失败时保留安全回退值，不阻塞页面；由下方重试 effect 限次补拉。
      setMeta((previous) => (previous.version ? previous : fallbackMeta()))
      setRetryTick((value) => value + 1)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (status !== 'authenticated') {
      retryAttemptRef.current = 0
      setMeta(fallbackMeta())
      setLoading(status === 'loading')
      return
    }
    setLoading(true)
    void refresh()
  }, [status, refresh])

  // 元数据接口偶发失败时按退避重试（最多 3 次），避免分片上传/恢复入口长期被回退值关闭。
  useEffect(() => {
    if (status !== 'authenticated' || meta.version) return
    const attempt = retryAttemptRef.current
    if (attempt >= META_RETRY_DELAYS_MS.length) return
    const delay = META_RETRY_DELAYS_MS[attempt] ?? 30_000
    const timer = window.setTimeout(() => {
      retryAttemptRef.current = attempt + 1
      void refresh()
    }, delay)
    return () => window.clearTimeout(timer)
  }, [status, meta.version, retryTick, refresh])

  const value = useMemo<AppMetaContextValue>(() => ({ meta, loading, refresh }), [meta, loading, refresh])

  return <AppMetaContext.Provider value={value}>{children}</AppMetaContext.Provider>
}
