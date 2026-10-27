// 恢复计划本地持久化（v0.7.0）：执行/刷新中断后仍能通过 planId 查询服务端计划状态。
// 只保存 planId 与展示所需的非敏感元数据；不保存 TOTP、路径清单或文件内容。
// 设计：sessionStorage 优先（关闭标签即清），不可用时静默降级为不持久化。

export interface StoredRestorePlan {
  planId: string
  archive: string
  /** planned|executing|completed|failed|expired|unknown（本地最后的已知值） */
  status: string
  savedAt: string
  targetName?: string | null
  completedAt?: string | null
  error?: string | null
  steps?: number | null
  bytes?: number | null
}

const STORAGE_KEY = 'af_restore_plan'

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.sessionStorage
  } catch {
    return null
  }
}

export function loadStoredRestorePlan(): StoredRestorePlan | null {
  const store = storage()
  if (!store) return null
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const value = parsed as Record<string, unknown>
    if (typeof value.planId !== 'string' || !value.planId) return null
    if (typeof value.archive !== 'string') return null
    return {
      planId: value.planId,
      archive: value.archive,
      status: typeof value.status === 'string' ? value.status : 'unknown',
      savedAt: typeof value.savedAt === 'string' ? value.savedAt : new Date().toISOString(),
      targetName: typeof value.targetName === 'string' ? value.targetName : null,
      completedAt: typeof value.completedAt === 'string' ? value.completedAt : null,
      error: typeof value.error === 'string' ? value.error : null,
      steps: typeof value.steps === 'number' ? value.steps : null,
      bytes: typeof value.bytes === 'number' ? value.bytes : null,
    }
  } catch {
    return null
  }
}

export function saveStoredRestorePlan(plan: StoredRestorePlan): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(plan))
  } catch {
    // 隐私模式/配额不足：放弃持久化，不影响恢复流程。
  }
}

export function clearStoredRestorePlan(): void {
  const store = storage()
  if (!store) return
  try {
    store.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

/** 计划是否仍值得展示（终态保留，便于刷新后看到结果；过期计划提示重新创建）。 */
export function isFinishedRestoreStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'expired'
}
