import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { CircleAlert, KeyRound, ShieldCheck } from 'lucide-react'
import { ApiError, toErrorMessage } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { usePageTitle } from '../hooks/usePageTitle'
import { Logo } from '../components/Logo'
import { Button } from '../components/Button'
import { FormField } from '../components/FormField'
import { formatRetryAfter } from '../lib/format'
import { isExternalUrl } from '../lib/next-url'

type LoginStep = 'password' | 'totp' | 'recovery'

export interface LoginPageProps {
  next: string | null
}

function authErrorMessage(error: unknown, step: LoginStep): string {
  if (error instanceof ApiError) {
    if (error.code === 'rate_limited') return `尝试过多，请 ${formatRetryAfter(error.retryAfterSec)}后再试`
    if (error.code === 'challenge_expired') return '验证已过期，请重新输入密码'
    if (error.code === 'invalid_credentials') return '用户名或密码错误'
    if (error.code === 'invalid_code') return step === 'recovery' ? '恢复码无效，请检查后重试' : '验证码无效，请检查后重试'
    if (error.code === 'network_error') return '无法连接服务器，请检查网络或稍后重试'
    return error.message
  }
  return toErrorMessage(error)
}

/** 两步登录：密码 → TOTP / 恢复码。成功后可跳转 next 指向的本站地址。 */
export function Login({ next }: LoginPageProps) {
  const navigate = useNavigate()
  const { status, bootstrapError, requestPassword, completeTotp, completeRecovery } = useAuth()
  usePageTitle('登录')

  const [step, setStep] = useState<LoginStep>('password')
  const [username, setUsername] = useState('antifield')
  const [password, setPassword] = useState('')
  const [challenge, setChallenge] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [recoveryCode, setRecoveryCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const totpRef = useRef<HTMLInputElement>(null)
  const recoveryRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (step === 'totp') totpRef.current?.focus()
    if (step === 'recovery') recoveryRef.current?.focus()
  }, [step])

  // 已登录时直接离开登录页（外部 next 用整页跳转）
  useEffect(() => {
    if (status !== 'authenticated') return
    if (next && isExternalUrl(next)) {
      window.location.assign(next)
      return
    }
    navigate(next ?? '/', { replace: true })
  }, [status, next, navigate])

  const goAfterLogin = (): void => {
    if (next && isExternalUrl(next)) {
      window.location.assign(next)
      return
    }
    navigate(next ?? '/', { replace: true })
  }

  const resetToPassword = (): void => {
    setStep('password')
    setChallenge(null)
    setCode('')
    setRecoveryCode('')
    setError(null)
  }

  const handlePasswordSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy) return
    const trimmedUsername = username.trim()
    if (!trimmedUsername) {
      setError('请输入用户名')
      return
    }
    if (!password) {
      setError('请输入密码')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await requestPassword(trimmedUsername, password)
      setChallenge(result.challenge)
      setPassword('')
      setStep('totp')
    } catch (submitError) {
      setError(authErrorMessage(submitError, 'password'))
    } finally {
      setBusy(false)
    }
  }

  const handleTotpSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy || !challenge) return
    if (!/^\d{6}$/.test(code.trim())) {
      setError('请输入 6 位数字验证码')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await completeTotp(challenge, code.trim())
      goAfterLogin()
    } catch (submitError) {
      if (submitError instanceof ApiError && submitError.code === 'challenge_expired') {
        resetToPassword()
        setError('验证已过期，请重新输入密码')
      } else {
        setError(authErrorMessage(submitError, 'totp'))
      }
    } finally {
      setBusy(false)
    }
  }

  const handleRecoverySubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy || !challenge) return
    const trimmed = recoveryCode.trim()
    if (!trimmed) {
      setError('请输入恢复码')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await completeRecovery(challenge, trimmed)
      goAfterLogin()
    } catch (submitError) {
      if (submitError instanceof ApiError && submitError.code === 'challenge_expired') {
        resetToPassword()
        setError('验证已过期，请重新输入密码')
      } else {
        setError(authErrorMessage(submitError, 'recovery'))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <Logo size={48} />
          <h1 className="login-title">AntifieldCloud</h1>
          <p className="login-subtitle">个人工作台</p>
        </div>

        {bootstrapError ? (
          <div className="notice notice-warning" role="status">
            {bootstrapError}
          </div>
        ) : null}

        <ol className="login-steps" aria-label="登录步骤">
          <li className={step === 'password' ? 'login-step active' : 'login-step done'}>
            <span className="login-step-index">1</span>
            验证密码
          </li>
          <li className={step === 'password' ? 'login-step' : 'login-step active'}>
            <span className="login-step-index">2</span>
            二次验证
          </li>
        </ol>

        {step === 'password' ? (
          <form className="login-form" onSubmit={(event) => void handlePasswordSubmit(event)}>
            <FormField label="用户名" htmlFor="login-username">
              <input
                id="login-username"
                className="input"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                autoCapitalize="off"
                spellCheck={false}
                disabled={busy}
              />
            </FormField>
            <FormField label="密码" htmlFor="login-password">
              <input
                id="login-password"
                className="input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                disabled={busy}
              />
            </FormField>
            {error ? (
              <div className="login-error" role="alert">
                <CircleAlert size={16} aria-hidden="true" />
                <span>{error}</span>
              </div>
            ) : null}
            <Button type="submit" variant="primary" size="md" loading={busy} className="login-submit">
              下一步
            </Button>
          </form>
        ) : null}

        {step === 'totp' ? (
          <form className="login-form" onSubmit={(event) => void handleTotpSubmit(event)}>
            <p className="login-hint">
              <ShieldCheck size={15} aria-hidden="true" />
              请输入身份验证器中的 6 位动态验证码
            </p>
            <FormField label="6 位验证码" htmlFor="login-code">
              <input
                id="login-code"
                ref={totpRef}
                className="input login-code-input"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                aria-describedby={undefined}
                disabled={busy}
                autoFocus
              />
            </FormField>
            {error ? (
              <div className="login-error" role="alert">
                <CircleAlert size={16} aria-hidden="true" />
                <span>{error}</span>
              </div>
            ) : null}
            <Button type="submit" variant="primary" size="md" loading={busy} className="login-submit">
              登录
            </Button>
            <div className="login-links">
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setStep('recovery')
                  setError(null)
                }}
              >
                使用恢复码
              </button>
              <button type="button" className="link-button muted-link" onClick={resetToPassword}>
                返回上一步
              </button>
            </div>
          </form>
        ) : null}

        {step === 'recovery' ? (
          <form className="login-form" onSubmit={(event) => void handleRecoverySubmit(event)}>
            <p className="login-hint">
              <KeyRound size={15} aria-hidden="true" />
              输入一次性恢复码（例如 ABCDE-12345），使用后该恢复码失效
            </p>
            <FormField label="恢复码" htmlFor="login-recovery">
              <input
                id="login-recovery"
                ref={recoveryRef}
                className="input login-code-input"
                value={recoveryCode}
                onChange={(event) => setRecoveryCode(event.target.value.toUpperCase())}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="ABCDE-12345"
                disabled={busy}
                autoFocus
              />
            </FormField>
            {error ? (
              <div className="login-error" role="alert">
                <CircleAlert size={16} aria-hidden="true" />
                <span>{error}</span>
              </div>
            ) : null}
            <Button type="submit" variant="primary" size="md" loading={busy} className="login-submit">
              登录
            </Button>
            <div className="login-links">
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setStep('totp')
                  setError(null)
                }}
              >
                返回验证码
              </button>
              <button type="button" className="link-button muted-link" onClick={resetToPassword}>
                返回上一步
              </button>
            </div>
          </form>
        ) : null}

        <p className="login-footnote">仅限本人使用 · 所有操作均记录审计</p>
      </div>
    </main>
  )
}
