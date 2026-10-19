// 上传队列：并发 2、逐文件进度、取消、失败重试与卸载中止。
// 每个文件单独一次请求，上传目标目录在入队时固定，避免用户切换目录后文件落错位置。
// 安全边界：单文件大小上限由调用方传入（来自 /api/version 的 maxUploadBytes），前端只做预检。

import { useCallback, useEffect, useRef, useState } from 'react'
import { isApiError, toErrorMessage, uploadFiles } from '../api/client'
import type { FileItem } from '../api/types'

export type UploadTaskStatus = 'waiting' | 'uploading' | 'success' | 'error' | 'cancelled'

export interface UploadTask {
  id: number
  file: File
  parentId: string | null
  status: UploadTaskStatus
  progress: number
  error: string | null
  item: FileItem | null
}

export interface UploadSummary {
  total: number
  succeeded: number
  failed: number
  cancelled: number
}

interface UseUploadQueueOptions {
  onFinished?: (summary: UploadSummary) => void
  onUploaded?: (item: FileItem) => void
  maxFileBytes?: number
  timeoutMs?: number
}

const MAX_CONCURRENCY = 2
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024

export interface UploadQueueApi {
  tasks: UploadTask[]
  busy: boolean
  enqueue: (files: File[], parentId: string | null) => void
  retry: (id: number) => void
  cancel: (id: number) => void
  clear: () => void
}

export function useUploadQueue(options: UseUploadQueueOptions = {}): UploadQueueApi {
  const [tasks, setTasks] = useState<UploadTask[]>([])
  const tasksRef = useRef<UploadTask[]>([])
  const optionsRef = useRef(options)
  optionsRef.current = options
  const activeRef = useRef(0)
  const nextIdRef = useRef(1)
  const reportedRef = useRef(true)
  const controllersRef = useRef(new Map<number, AbortController>())

  const syncTasks = (next: UploadTask[]): void => {
    tasksRef.current = next
    setTasks(next)
  }

  const patchTask = (id: number, patch: Partial<UploadTask>): void => {
    syncTasks(tasksRef.current.map((task) => (task.id === id ? { ...task, ...patch } : task)))
  }

  const finishIfIdle = (): void => {
    if (activeRef.current > 0) return
    const current = tasksRef.current
    if (current.some((task) => task.status === 'waiting' || task.status === 'uploading')) return
    if (current.length === 0 || reportedRef.current) return
    reportedRef.current = true
    optionsRef.current.onFinished?.({
      total: current.length,
      succeeded: current.filter((task) => task.status === 'success').length,
      failed: current.filter((task) => task.status === 'error').length,
      cancelled: current.filter((task) => task.status === 'cancelled').length,
    })
  }

  function runTask(task: UploadTask): void {
    activeRef.current += 1
    const controller = new AbortController()
    controllersRef.current.set(task.id, controller)
    void (async () => {
      patchTask(task.id, { status: 'uploading', progress: 0, error: null })
      try {
        const result = await uploadFiles([task.file], task.parentId, {
          signal: controller.signal,
          timeoutMs: optionsRef.current.timeoutMs,
          onProgress: (loaded, total) => {
            const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0
            patchTask(task.id, { progress: percent })
          },
        })
        const failure = result.errors[0]
        if (failure) {
          patchTask(task.id, { status: 'error', error: failure.message || '上传失败' })
        } else {
          const item = result.items[0] ?? null
          patchTask(task.id, { status: 'success', progress: 100, item })
          if (item) optionsRef.current.onUploaded?.(item)
        }
      } catch (error) {
        if (isApiError(error) && error.code === 'aborted') {
          patchTask(task.id, { status: 'cancelled', error: '已取消上传' })
        } else {
          patchTask(task.id, { status: 'error', error: toErrorMessage(error, '上传失败，请重试') })
        }
      } finally {
        controllersRef.current.delete(task.id)
        activeRef.current = Math.max(0, activeRef.current - 1)
        pump()
        finishIfIdle()
      }
    })()
  }

  function pump(): void {
    while (activeRef.current < MAX_CONCURRENCY) {
      const nextTask = tasksRef.current.find((task) => task.status === 'waiting')
      if (!nextTask) return
      runTask(nextTask)
    }
  }

  const enqueue = useCallback((files: File[], parentId: string | null): void => {
    if (files.length === 0) return
    const maxFileBytes = optionsRef.current.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    const created: UploadTask[] = files.map((file) => {
      const oversized = file.size > maxFileBytes
      return {
        id: nextIdRef.current++,
        file,
        parentId,
        status: oversized ? 'error' : 'waiting',
        progress: 0,
        error: oversized ? '文件超过大小限制' : null,
        item: null,
      }
    })
    reportedRef.current = false
    syncTasks([...tasksRef.current, ...created])
    pump()
    finishIfIdle()
  }, [])

  const retry = useCallback((id: number): void => {
    const target = tasksRef.current.find((task) => task.id === id)
    if (!target) return
    reportedRef.current = false
    patchTask(id, { status: 'waiting', progress: 0, error: null })
    pump()
  }, [])

  const cancel = useCallback((id: number): void => {
    const task = tasksRef.current.find((item) => item.id === id)
    if (!task) return
    if (task.status === 'waiting') {
      patchTask(id, { status: 'cancelled', error: '已取消上传' })
      finishIfIdle()
      return
    }
    if (task.status === 'uploading') {
      controllersRef.current.get(id)?.abort()
    }
  }, [])

  const clear = useCallback((): void => {
    const hasActive = tasksRef.current.some(
      (task) => task.status === 'waiting' || task.status === 'uploading',
    )
    if (hasActive) return
    syncTasks([])
    reportedRef.current = true
  }, [])

  // 页面卸载时中止所有上传，避免请求泄漏
  useEffect(() => {
    const controllers = controllersRef.current
    return () => {
      for (const controller of controllers.values()) controller.abort()
      controllers.clear()
    }
  }, [])

  return {
    tasks,
    busy: tasks.some((task) => task.status === 'waiting' || task.status === 'uploading'),
    enqueue,
    retry,
    cancel,
    clear,
  }
}
