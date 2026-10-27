import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CHUNK_MAX_BYTES,
  chunkCount,
  chunkLength,
  isValidResumeRecord,
  resumeStorageKey,
  shouldUseChunked,
  uploadFingerprint,
} from './chunked'

describe('chunked upload helpers', () => {
  it('只对启用且超过阈值、不超上限的文件分片', () => {
    expect(shouldUseChunked(10, { enabled: false, thresholdBytes: 5 })).toBe(false)
    expect(shouldUseChunked(5, { enabled: true, thresholdBytes: 5 })).toBe(false)
    expect(shouldUseChunked(6, { enabled: true, thresholdBytes: 5 })).toBe(true)
    expect(shouldUseChunked(DEFAULT_CHUNK_MAX_BYTES + 1, { enabled: true, thresholdBytes: 5 })).toBe(false)
    expect(shouldUseChunked(0, { enabled: true, thresholdBytes: 0 })).toBe(false)
  })

  it('计算分片总数与尾片长度', () => {
    expect(chunkCount(10, 4)).toBe(3)
    expect(chunkLength(10, 4, 0)).toBe(4)
    expect(chunkLength(10, 4, 1)).toBe(4)
    expect(chunkLength(10, 4, 2)).toBe(2)
    expect(chunkLength(10, 4, 3)).toBe(0)
    expect(chunkCount(0, 4)).toBe(0)
  })

  it('指纹包含目录与文件身份，存储键稳定', () => {
    const file = { name: 'big.bin', size: 100, lastModified: 42 }
    expect(uploadFingerprint(file, null)).toBe('root:big.bin:100:42')
    expect(uploadFingerprint(file, 'folder-1')).toBe('folder-1:big.bin:100:42')
    expect(resumeStorageKey('abc')).toBe('af_chunk_upload:abc')
  })

  it('校验断点记录形状，拒绝路径/坏数据', () => {
    const valid = {
      uploadId: '00000000-0000-4000-8000-000000000000',
      parentId: null,
      name: 'a.bin',
      size: 10,
      received: [0, 1],
      expiresAt: '2026-10-21T00:00:00.000Z',
    }
    expect(isValidResumeRecord(valid)).toBe(true)
    expect(isValidResumeRecord({ ...valid, uploadId: '' })).toBe(false)
    expect(isValidResumeRecord({ ...valid, received: [0, '1'] })).toBe(false)
    expect(isValidResumeRecord(null)).toBe(false)
  })
})
