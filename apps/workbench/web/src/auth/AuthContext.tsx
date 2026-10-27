// 登录态上下文。
// 启动时调用 /api/auth/me 恢复会话；登录成功后保存 csrfToken 供后续写请求使用。
// 收到会话级 401 时清空本地状态，由受保护路由统一跳转登录页。

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError, setCsrfToken, setUnauthorizedHandler, toErrorMessage } from '../api/client'
import type { LoginResult, PasswordChallenge, SessionInfo, User } from '../api/types'

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous'

export interface AuthContextValue {
  status: AuthStatus
  user: User | null
  session: SessionInfo | null
  /** 启动时无法连接服务器等非 401 错误 */
  bootstrapError: string | null
  requestPassword: (username: string, password: string) => Promise<PasswordChallenge>
  completeTotp: (challenge: string, code: string) => Promise<LoginResult>
  completeRecovery: (challenge: string, recoveryCode: string) => Promise<LoginResult>
  logout: () => Promise<void>
  logoutAll: () => Promise<void>
  clearSession: () => void
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return context
}

/** 登录成功后立刻以 me 结果刷新会话详情（失败也不阻断登录）。 */
async function fetchCurrentSession(
  setUser: (user: User | null) => void,
  setSession: (session: SessionInfo | null) => void,
): Promise<void> {
  try {
    const me = await api.auth.me()
    setCsrfToken(me.csrfToken)
    setUser(me.user)
    setSession(me.session)
  } catch {
    setSession(null)
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [bootstrapError, setBootstrapError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  const clearSession = useCallback(() => {
    setCsrfToken(null)
    setUser(null)
    setSession(null)
    setStatus('anonymous')
  }, [])

  // 恢复会话：只在挂载时执行一次
  useEffect(() => {
    mountedRef.current = true
    const restore = async (): Promise<void> => {
      try {
        const me = await api.auth.me()
        if (!mountedRef.current) return
        setCsrfToken(me.csrfToken)
        setUser(me.user)
        setSession(me.session)
        setStatus('authenticated')
        setBootstrapError(null)
      } catch (error) {
        if (!mountedRef.current) return
        setStatus('anonymous')
        if (error instanceof ApiError && error.status === 401) {
          setBootstrapError(null)
        } else {
          setBootstrapError(toErrorMessage(error, '无法连接服务器，请确认服务已启动'))
        }
      }
    }
    void restore()
    return () => {
      mountedRef.current = false
    }
  }, [])

  // 任意业务接口返回会话失效时，清空本地登录态
  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearSession()
    })
    return () => setUnauthorizedHandler(null)
  }, [clearSession])

  const requestPassword = useCallback(async (username: string, password: string): Promise<PasswordChallenge> => {
    return api.auth.password(username, password)
  }, [])

  const completeTotp = useCallback(async (challenge: string, code: string): Promise<LoginResult> => {
    const result = await api.auth.totp(challenge, code)
    setCsrfToken(result.csrfToken)
    setUser(result.user)
    setStatus('authenticated')
    await fetchCurrentSession(setUser, setSession)
    return result
  }, [])

  const completeRecovery = useCallback(async (challenge: string, recoveryCode: string): Promise<LoginResult> => {
    const result = await api.auth.recovery(challenge, recoveryCode)
    setCsrfToken(result.csrfToken)
    setUser(result.user)
    setStatus('authenticated')
    await fetchCurrentSession(setUser, setSession)
    return result
  }, [])

  const logout = useCallback(async (): Promise<void> => {
    try {
      await api.auth.logout()
    } catch {
      // 即使会话已失效或网络中断，本地也按退出处理
    } finally {
      clearSession()
    }
  }, [clearSession])

  const logoutAll = useCallback(async (): Promise<void> => {
    await api.account.logoutAll()
    clearSession()
  }, [clearSession])

  const refresh = useCallback(async (): Promise<void> => {
    const me = await api.auth.me()
    setCsrfToken(me.csrfToken)
    setUser(me.user)
    setSession(me.session)
    setStatus('authenticated')
    setBootstrapError(null)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      session,
      bootstrapError,
      requestPassword,
      completeTotp,
      completeRecovery,
      logout,
      logoutAll,
      clearSession,
      refresh,
    }),
    [
      status,
      user,
      session,
      bootstrapError,
      requestPassword,
      completeTotp,
      completeRecovery,
      logout,
      logoutAll,
      clearSession,
      refresh,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
