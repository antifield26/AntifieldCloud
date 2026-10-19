// 上传队列：并发 2、逐文件进度、失败重试。
// 每个文件单独一次请求，上传目标目录在入队时固定，避免用户切换目录后文件落错位置。

import { useCallback, useRef, useState } from 'react'
import { toErrorMessage, uploadFiles } from '../api/client'
import type { FileItem } from '../api/types'

export type UploadTaskStatus = 'waiting' | 'uploading' | 'success' | 'error'

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
}

interface UseUploadQueueOptions {
  onFinished?: (summary: UploadSummary) => void
  onUploaded?: (item: FileItem) => void
}

const MAX_CONCURRENCY = 2
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024

export interface UploadQueueApi {
  tasks: UploadTask[]
  busy: boolean
  enqueue: (files: File[], parentId: string | null) => void
  retry: (id: number) => void
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
    })
  }

  function runTask(task: UploadTask): void {
    activeRef.current += 1
    void (async () => {
      patchTask(task.id, { status: 'uploading', progress: 0, error: null })
      try {
        const result = await uploadFiles([task.file], task.parentId, {
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
        patchTask(task.id, { status: 'error', error: toErrorMessage(error, '上传失败，请重试') })
      } finally {
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
    const created: UploadTask[] = files.map((file) => {
      const oversized = file.size > MAX_FILE_BYTES
      return {
        id: nextIdRef.current++,
        file,
        parentId,
        status: oversized ? 'error' : 'waiting',
        progress: 0,
        error: oversized ? '文件超过单文件 2 GiB 限制' : null,
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

  const clear = useCallback((): void => {
    if (tasksRef.current.some((task) => task.status === 'waiting' || task.status === 'uploading')) return
    syncTasks([])
    reportedRef.current = true
  }, [])

  return {
    tasks,
    busy: tasks.some((task) => task.status === 'waiting' || task.status === 'uploading'),
    enqueue,
    retry,
    clear,
  }
}
