import { describe, expect, it } from 'vitest'
import { buildAiTicketUrl, externalLoginRedirect, isAiWorkspaceUrl, sanitizeNext } from './next-url'

const appCurrent = { origin: 'https://app.example.com', hostname: 'app.example.com', protocol: 'https:' }
const aiCurrent = { origin: 'https://ai.example.com', hostname: 'ai.example.com', protocol: 'https:' }
const loopbackCurrent = { origin: 'http://127.0.0.1:5173', hostname: '127.0.0.1', protocol: 'http:' }

describe('sanitizeNext', () => {
  it('允许站内相对路径', () => {
    expect(sanitizeNext('/files?parent=abc', appCurrent)).toBe('/files?parent=abc')
    expect(sanitizeNext('/activity', appCurrent)).toBe('/activity')
  })

  it('拒绝协议相对地址与登录页循环', () => {
    expect(sanitizeNext('//evil.example.com', appCurrent)).toBeNull()
    expect(sanitizeNext('/\\evil.example.com', appCurrent)).toBeNull()
    expect(sanitizeNext('/login', appCurrent)).toBeNull()
    expect(sanitizeNext('/login?next=/files', appCurrent)).toBeNull()
  })

  it('允许同源与 app↔ai 兄弟域', () => {
    expect(sanitizeNext('https://app.example.com/files', appCurrent)).toBe('https://app.example.com/files')
    expect(sanitizeNext('https://ai.example.com/', appCurrent)).toBe('https://ai.example.com/')
    expect(sanitizeNext('https://app.example.com/files', aiCurrent)).toBe('https://app.example.com/files')
  })

  it('拒绝非 https 兄弟域、任意第三方域与 userinfo 绕过', () => {
    expect(sanitizeNext('http://ai.example.com/', appCurrent)).toBeNull()
    expect(sanitizeNext('https://evil.example.com/', appCurrent)).toBeNull()
    expect(sanitizeNext('https://app.example.com@evil.example.com/', appCurrent)).toBeNull()
    expect(sanitizeNext('https://evil.example.com/?next=app', appCurrent)).toBeNull()
    expect(sanitizeNext('javascript:alert(1)', appCurrent)).toBeNull()
  })

  it('loopback 仅在当前页面为 loopback 且 hostname 一致时允许', () => {
    expect(sanitizeNext('http://127.0.0.1:3000/files', loopbackCurrent)).toBe('http://127.0.0.1:3000/files')
    expect(sanitizeNext('http://localhost:3000/files', loopbackCurrent)).toBeNull()
    expect(sanitizeNext('http://127.0.0.1:3000/files', appCurrent)).toBeNull()
    expect(sanitizeNext('https://app.example.com/files', loopbackCurrent)).toBeNull()
  })

  it('缺少原始输入时返回 null', () => {
    expect(sanitizeNext(null, appCurrent)).toBeNull()
    expect(sanitizeNext('   ', appCurrent)).toBeNull()
  })
})

describe('AI SSO 票据跳转', () => {
  it('外部 ai 兄弟域构造 ai-ticket URL 并编码完整 next', () => {
    expect(buildAiTicketUrl('https://ai.example.com/session/abc?x=1')).toBe(
      '/api/auth/ai-ticket?next=https%3A%2F%2Fai.example.com%2Fsession%2Fabc%3Fx%3D1',
    )
    expect(externalLoginRedirect('https://ai.example.com/', appCurrent)).toBe(
      '/api/auth/ai-ticket?next=https%3A%2F%2Fai.example.com%2F',
    )
    // app→ai 兄弟域识别为 AI 工作区；ai→app 方向不再经 ai-ticket
    expect(isAiWorkspaceUrl('https://ai.example.com/session', appCurrent)).toBe(true)
    expect(isAiWorkspaceUrl('https://app.example.com/files', aiCurrent)).toBe(false)
  })

  it('站内相对路径交给 SPA navigate，同源绝对 URL 原样跳转', () => {
    expect(externalLoginRedirect('/files?parent=abc', appCurrent)).toBeNull()
    expect(externalLoginRedirect(null, appCurrent)).toBeNull()
    expect(externalLoginRedirect('https://app.example.com/files', appCurrent)).toBe('https://app.example.com/files')
    expect(isAiWorkspaceUrl('https://app.example.com/files', appCurrent)).toBe(false)
  })

  it('非兄弟域与 loopback 不误判为 AI 工作区', () => {
    expect(isAiWorkspaceUrl('https://evil.example.com/x', appCurrent)).toBe(false)
    expect(isAiWorkspaceUrl('javascript:alert(1)', appCurrent)).toBe(false)
    expect(isAiWorkspaceUrl('https://app.example.com@evil.example.com/', appCurrent)).toBe(false)
    expect(isAiWorkspaceUrl('http://127.0.0.1:3000/files', loopbackCurrent)).toBe(false)
    expect(externalLoginRedirect('http://127.0.0.1:3000/files', loopbackCurrent)).toBe(
      'http://127.0.0.1:3000/files',
    )
  })
})
