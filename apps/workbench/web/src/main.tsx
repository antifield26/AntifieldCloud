import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App'
import { buildPwaVersion, serviceWorkerUrl } from './lib/pwa'
import './styles/tokens.css'
import './styles/global.css'
import './styles/components.css'
import './styles/layout.css'
import './styles/pages.css'
import './styles/v02.css'
import './styles/v03.css'
import './styles/v04.css'
import './styles/v05.css'
import './styles/v06.css'
import './styles/v07.css'
import './styles/v08.css'

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 挂载节点')

// PWA：仅生产构建注册 Service Worker；开发环境不注册，避免缓存干扰 Vite HMR。
// 注册 URL 携带构建入口 hash，SW 用它隔离/清理旧版本静态缓存。
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const buildVersion = buildPwaVersion(import.meta.url)
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(serviceWorkerUrl(buildVersion), { scope: '/' }).catch((error: unknown) => {
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
