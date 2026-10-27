import { describe, expect, it } from 'vitest'
import { mediaErrorMessage, mediaInlineAllowed, mediaKindOf, mediaMimeHint } from './media'

describe('media helpers', () => {
  it('识别音视频 previewKind', () => {
    expect(mediaKindOf('video')).toBe('video')
    expect(mediaKindOf('audio')).toBe('audio')
    expect(mediaKindOf('image')).toBeNull()
    expect(mediaKindOf(undefined)).toBeNull()
  })

  it('HTTP 415/416/401 映射为明确文案', () => {
    expect(mediaErrorMessage(null, 415).title).toContain('格式')
    expect(mediaErrorMessage(null, 416).title).toContain('定位')
    expect(mediaErrorMessage(null, 401).title).toContain('权限')
  })

  it('MediaError code 映射网络/解码/不支持', () => {
    expect(mediaErrorMessage(2, null).title).toContain('加载失败')
    expect(mediaErrorMessage(3, null).title).toContain('解码失败')
    expect(mediaErrorMessage(4, null).title).toContain('不支持')
    expect(mediaErrorMessage(undefined, undefined).title).toContain('无法播放')
  })

  it('格式提示与 inlineAllowed 默认值', () => {
    expect(mediaMimeHint('video/mp4')).toContain('MP4')
    expect(mediaMimeHint(null)).toContain('浏览器')
    expect(mediaInlineAllowed(undefined)).toBe(true)
    expect(mediaInlineAllowed(false)).toBe(false)
  })
})
