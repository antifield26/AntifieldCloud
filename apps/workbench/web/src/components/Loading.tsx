import { LoaderCircle } from 'lucide-react'
import { Logo } from './Logo'

/** 区块内加载指示。 */
export function LoadingBlock({ text = '加载中…' }: { text?: string }) {
  return (
    <div className="loading-block" role="status">
      <LoaderCircle className="spin" size={18} aria-hidden="true" />
      <span>{text}</span>
    </div>
  )
}

/** 应用启动时恢复会话的全屏占位。 */
export function AppLoading({ text = '正在恢复会话…' }: { text?: string }) {
  return (
    <div className="app-loading" role="status">
      <Logo size={48} />
      <LoadingBlock text={text} />
    </div>
  )
}
