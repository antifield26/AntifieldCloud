import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App'
import './styles/tokens.css'
import './styles/global.css'
import './styles/components.css'
import './styles/layout.css'
import './styles/pages.css'
import './styles/v02.css'

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 挂载节点')

// PWA：仅生产构建注册 Service Worker；开发环境不注册，避免缓存干扰 Vite HMR。
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.error('Service Worker 注册失败', error)
    })
  })
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
