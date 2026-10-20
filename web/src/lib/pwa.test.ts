import { describe, expect, it } from 'vitest'
import { buildPwaVersion, serviceWorkerUrl } from './pwa'

describe('PWA 缓存版本', () => {
  it('从构建入口 hash 生成版本（允许下划线开头）', () => {
    expect(buildPwaVersion('http://127.0.0.1:4199/assets/index-_E7svcQK.js')).toBe('_E7svcQK')
    expect(buildPwaVersion('http://example.com/assets/index-Czdpw080.js')).toBe('Czdpw080')
    expect(buildPwaVersion('https://app.example.com/assets/index-abcdef12.js?v=1')).toBe('abcdef12')
  })

  it('开发环境或不可解析 URL 回退 dev', () => {
    expect(buildPwaVersion('/src/main.tsx')).toBe('dev')
    expect(buildPwaVersion('/assets/index-abc.js')).toBe('dev')
    expect(buildPwaVersion('not a url')).toBe('dev')
  })

  it('注册 URL 携带版本参数', () => {
    expect(serviceWorkerUrl('_E7svcQK')).toBe('/sw.js?v=_E7svcQK')
  })
})
