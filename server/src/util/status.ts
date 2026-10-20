/**
 * 只读状态文件解析：世界备份/拉取/演练脚本写入的 JSON 状态。
 *
 * 约束：
 * - 应用只读，从不写这些文件；文件缺失、不可读或不是 JSON 对象时返回 null，不抛错。
 * - 返回原始对象（字段由脚本定义），前端按约定字段渲染，服务端不解释业务含义。
 */
import { readFileSync } from 'node:fs'

export type StatusFileRecord = Record<string, unknown>

/** 读取状态 JSON；任何异常都降级为 null，避免脚本状态缺失影响主服务。 */
export function readStatusFile(path: string): StatusFileRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as StatusFileRecord
  } catch {
    return null
  }
}
