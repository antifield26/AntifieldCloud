/**
 * 导航诊断环形缓冲：只保存最近失败摘要，不落盘、不包含聊天/坐标以外的敏感内容。
 * 用于 /status.navigation 与日志关联；最多保留 8 条。
 */
import type { RouteFailureKind } from './types.ts'

export interface NavigationTraceEntry {
  at: string
  source: 'pathfinder' | 'planner' | 'ai' | 'teleport' | 'stopped'
  failure: RouteFailureKind | null
  reason: string | null
  nodes: number | null
}

export class NavigationTrace {
  private readonly entries: NavigationTraceEntry[] = []

  record (entry: NavigationTraceEntry): void {
    this.entries.push(entry)
    while (this.entries.length > 8) this.entries.shift()
  }

  recent (): NavigationTraceEntry[] {
    return [...this.entries]
  }
}
