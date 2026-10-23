import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Login } from './Login'

type AuthStatus = 'loading' | 'authenticated' | 'anonymous'

const auth = vi.hoisted(() => ({
  status: 'anonymous' as AuthStatus,
  requestPassword: vi.fn(),
  completeTotp: vi.fn(),
  completeRecovery: vi.fn(),
}))

const navigation = vi.hoisted(() => ({
  externalLoginRedirect: vi.fn(),
  assign: vi.fn(),
}))

// 只替换登录态来源、整页跳转出口与外部跳转解析（解析规则在 lib/next-url.test.ts 单独覆盖），
// 以便在 jsdom（hostname=localhost）下断言 Login 的调用与 SPA navigate 行为。
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    status: auth.status,
    bootstrapError: null,
    requestPassword: auth.requestPassword,
    completeTotp: auth.completeTotp,
    completeRecovery: auth.completeRecovery,
  }),
}))

vi.mock('../lib/next-url', async () => {
  const actual = await vi.importActual<typeof import('../lib/next-url')>('../lib/next-url')
  return {
    ...actual,
    assignExternalUrl: navigation.assign,
    externalLoginRedirect: (next: string | null | undefined) => {
      navigation.externalLoginRedirect(next)
      if (!next) return null
      // 与生产一致：外部地址先换票；站内相对路径交给 SPA navigate。
      return /^https?:\/\//i.test(next) ? `/api/auth/ai-ticket?next=${encodeURIComponent(next)}` : null
    },
  }
})

const AI_EXTERNAL = 'https://ai.example.com/session/abc?x=1'
const AI_TICKET = '/api/auth/ai-ticket?next=https%3A%2F%2Fai.example.com%2Fsession%2Fabc%3Fx%3D1'

function renderLogin(next: string | null): void {
  render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<Login next={next} />} />
        <Route path="/files" element={<div>FILES PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  auth.status = 'anonymous'
  auth.requestPassword.mockReset()
  auth.completeTotp.mockReset()
  auth.completeRecovery.mockReset()
  navigation.externalLoginRedirect.mockReset()
  navigation.assign.mockReset()
  auth.requestPassword.mockResolvedValue({ challenge: 'challenge-1', expiresIn: 300 })
  auth.completeTotp.mockResolvedValue({ user: { username: 'antifield' }, csrfToken: null })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Login 跳转', () => {
  it('已登录时外部 ai next 改走服务端 ai-ticket，而不是直接跳 ai', async () => {
    auth.status = 'authenticated'
    renderLogin(AI_EXTERNAL)
    await waitFor(() => expect(navigation.assign).toHaveBeenCalledWith(AI_TICKET))
    expect(navigation.assign).not.toHaveBeenCalledWith(AI_EXTERNAL)
    expect(navigation.externalLoginRedirect).toHaveBeenCalledWith(AI_EXTERNAL)
  })

  it('站内相对 next 保持 SPA navigate（不触发整页跳转）', async () => {
    auth.status = 'authenticated'
    renderLogin('/files?parent=abc')
    expect(await screen.findByText('FILES PAGE')).toBeTruthy()
    expect(navigation.assign).not.toHaveBeenCalled()
  })

  it('登录成功后外部 ai next 同样改走 ai-ticket', async () => {
    renderLogin(AI_EXTERNAL)
    await userEvent.type(await screen.findByLabelText('密码'), 'correct-password')
    await userEvent.click(screen.getByRole('button', { name: '下一步' }))
    await userEvent.type(await screen.findByLabelText('6 位验证码'), '123456')
    await userEvent.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => expect(auth.completeTotp).toHaveBeenCalledWith('challenge-1', '123456'))
    await waitFor(() => expect(navigation.assign).toHaveBeenCalledWith(AI_TICKET))
    expect(navigation.assign).not.toHaveBeenCalledWith(AI_EXTERNAL)
  })

  it('登录成功后站内 next 仍走 SPA navigate', async () => {
    renderLogin('/files?parent=abc')
    await userEvent.type(await screen.findByLabelText('密码'), 'correct-password')
    await userEvent.click(screen.getByRole('button', { name: '下一步' }))
    await userEvent.type(await screen.findByLabelText('6 位验证码'), '123456')
    await userEvent.click(screen.getByRole('button', { name: '登录' }))

    expect(await screen.findByText('FILES PAGE')).toBeTruthy()
    expect(navigation.assign).not.toHaveBeenCalled()
  })
})
