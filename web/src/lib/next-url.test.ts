import { describe, expect, it } from 'vitest'
import { sanitizeNext } from './next-url'

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
