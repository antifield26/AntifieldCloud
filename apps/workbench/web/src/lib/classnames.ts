// 轻量 className 拼接工具：过滤 false/null/undefined，保持调用处可读。

export type ClassValue = string | false | null | undefined | ClassValue[]

export function cx(...values: ClassValue[]): string {
  const result: string[] = []
  for (const value of values) {
    if (!value) continue
    if (Array.isArray(value)) {
      const nested = cx(...value)
      if (nested) result.push(nested)
    } else {
      result.push(value)
    }
  }
  return result.join(' ')
}
