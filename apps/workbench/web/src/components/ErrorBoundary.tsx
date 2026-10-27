import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { CircleAlert } from 'lucide-react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
}

/** 顶层错误边界：渲染异常时提供重新加载入口，避免白屏。 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('界面渲染异常', error, info.componentStack)
  }

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children
    return (
      <div className="fatal-error" role="alert">
        <div className="fatal-error-card">
          <CircleAlert size={32} aria-hidden="true" />
          <h1>界面出现异常</h1>
          <p>刷新页面通常可以恢复；若持续出现，请检查浏览器控制台中的错误信息。</p>
          <button type="button" className="btn btn-primary btn-md" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      </div>
    )
  }
}
