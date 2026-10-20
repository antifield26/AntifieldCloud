/** 分片上传纯函数：阈值决策、分片计数与断点存储键（不涉及网络/存储副作用）。 */

export const DEFAULT_CHUNK_THRESHOLD_BYTES = 32 * 1024 * 1024
export const DEFAULT_CHUNK_SIZE_BYTES = 8 * 1024 * 1024
export const DEFAULT_CHUNK_MAX_BYTES = 5 * 1024 * 1024 * 1024

/** 小文件继续走单请求 multipart；大文件才启用分片，避免改变现有路径。 */
export function shouldUseChunked(
  size: number,
  options: { enabled: boolean; thresholdBytes?: number; maxBytes?: number },
): boolean {
  if (!options.enabled) return false
  if (!Number.isSafeInteger(size) || size <= 0) return false
  const threshold = options.thresholdBytes ?? DEFAULT_CHUNK_THRESHOLD_BYTES
  const max = options.maxBytes ?? DEFAULT_CHUNK_MAX_BYTES
  return size > threshold && size <= max
}

export function chunkCount(size: number, chunkSize: number): number {
  if (!Number.isSafeInteger(size) || size <= 0 || !Number.isSafeInteger(chunkSize) || chunkSize <= 0) return 0
  return Math.ceil(size / chunkSize)
}

export function chunkLength(size: number, chunkSize: number, index: number): number {
  const total = chunkCount(size, chunkSize)
  if (index < 0 || index >= total) return 0
  if (index === total - 1) return size - chunkSize * index
  return chunkSize
}

/** 断点续传指纹：文件身份 + 目标目录；不使用文件名之外的隐私信息。 */
export function uploadFingerprint(file: { name: string; size: number; lastModified: number }, parentId: string | null): string {
  return `${parentId ?? 'root'}:${file.name}:${file.size}:${file.lastModified}`
}

export function resumeStorageKey(fingerprint: string): string {
  return `af_chunk_upload:${fingerprint}`
}

export interface ResumeRecord {
  uploadId: string
  parentId: string | null
  name: string
  size: number
  received: number[]
  expiresAt: string
}

export function isValidResumeRecord(value: unknown): value is ResumeRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.uploadId === 'string' &&
    record.uploadId.length > 0 &&
    (typeof record.parentId === 'string' || record.parentId === null) &&
    typeof record.name === 'string' &&
    typeof record.size === 'number' &&
    Array.isArray(record.received) &&
    record.received.every((index) => typeof index === 'number') &&
    typeof record.expiresAt === 'string'
  )
}
