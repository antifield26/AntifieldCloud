// 备份列表数据源：Dashboard 汇总与 Settings 管理共用。
// 60s 轮询（页面隐藏时暂停）；失败保留上次数据，不阻塞页面其它内容。

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, isAbortError, toErrorMessage } from '../api/client'
import type { BackupListResult } from '../api/types'
import { usePolling } from './usePolling'

export interface BackupDataState {
  data: BackupListResult | null
  loading: boolean
  error: string | null
  /** 错误 HTTP 状态，用于区分 404（接口未启用）与普通失败 */
  errorStatus: number | null
  refresh: () => Promise<void>
}

export function useBackups(pollMs = 60_000): BackupDataState {
  const [data, setData] = useState<BackupListResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [errorStatus, setErrorStatus] = useState<number | null>(null)
  const dataRef = useRef<BackupListResult | null>(null)
  const requestIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async (): Promise<void> => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    try {
      const result = await api.backups.list(controller.signal)
      if (requestId !== requestIdRef.current) return
      dataRef.current = result
      setData(result)
      setError(null)
      setErrorStatus(null)
    } catch (loadError) {
      if (isAbortError(loadError) || requestId !== requestIdRef.current) return
      const message = toErrorMessage(loadError, '加载备份列表失败')
      setErrorStatus(loadError instanceof ApiError ? loadError.status : null)
      if (!dataRef.current) setError(message)
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    return () => abortRef.current?.abort()
  }, [load])

  usePolling(() => load(), pollMs)

  return { data, loading, error, errorStatus, refresh: load }
}
