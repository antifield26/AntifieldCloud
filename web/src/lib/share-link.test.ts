import { describe, expect, it } from 'vitest'
import { absoluteShareUrl, shouldProtectShareLinkClose } from './share-link'

describe('分享链接展示', () => {
  it('相对 URL 用 appOrigin 补全，绝对 URL 保持不变', () => {
    expect(absoluteShareUrl('/s/TOKEN', 'https://app.example.com')).toBe('https://app.example.com/s/TOKEN')
    expect(absoluteShareUrl('s/TOKEN', 'https://app.example.com/')).toBe('https://app.example.com/s/TOKEN')
    expect(absoluteShareUrl('https://app.example.com/s/TOKEN', 'https://other.test')).toBe(
      'https://app.example.com/s/TOKEN',
    )
    expect(absoluteShareUrl('/s/TOKEN', '')).toBe('/s/TOKEN')
  })

  it('一次性链接未保存时关闭需二次确认', () => {
    expect(shouldProtectShareLinkClose(false, false)).toBe(false)
    expect(shouldProtectShareLinkClose(true, true)).toBe(false)
    expect(shouldProtectShareLinkClose(true, false)).toBe(true)
  })
})
