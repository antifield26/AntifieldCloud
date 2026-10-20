/**
 * OpenCode Web 兼容垫片（无自定义按钮）：
 * - 不添加任何可见 UI；只在捕获阶段接管 opencode 原生“新建会话”按钮/链接的点击。
 * - 点击时调用 opencode 自身 `POST /api/session`，再跳转其标准 session 路由。
 * - 以同源外部脚本加载，避免 opencode CSP（script-src 'self'）拦截内联脚本。
 *
 * 背景：opencode v2.0.32 在部分 Android 浏览器/宽高比下，原生新建按钮没有响应；
 * 其按钮的 aria-label 为“新建会话/New session”。垫片只补这一个交互，不修改 opencode 服务或数据。
 */

export const OPENCODE_SHIM_PATH = '/__af/oc-help.js'

export const OPENCODE_SHIM_SCRIPT = String.raw`(() => {
  const NEW_SESSION_LABEL = /^(新建会话|New session|新会话)$/i

  const encodeOrigin = () =>
    btoa(location.origin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')

  const showError = (message) => {
    const node = document.createElement('div')
    node.textContent = message
    node.setAttribute('role', 'alert')
    node.style.cssText =
      'position:fixed;left:16px;right:16px;bottom:calc(env(safe-area-inset-bottom, 0px) + 84px);' +
      'z-index:2147483647;padding:10px 14px;border-radius:10px;background:#3a1d1d;color:#ffd7d7;' +
      'font:13px/1.4 system-ui,sans-serif;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.35)'
    document.body.appendChild(node)
    setTimeout(() => node.remove(), 4500)
  }

  const createSession = async () => {
    if (window.__afCreatingSession) return
    window.__afCreatingSession = true
    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const payload = await response.json()
      const id = payload && payload.data && payload.data.id
      if (!id) throw new Error('missing session id')
      location.assign('/server/' + encodeOrigin() + '/session/' + encodeURIComponent(id))
    } catch (error) {
      console.error('[AntifieldCloud] opencode new session failed', error)
      showError('创建会话失败，请刷新页面后重试')
    } finally {
      window.__afCreatingSession = false
    }
  }

  const sessionButton = (event) => {
    const target = event.target instanceof Element ? event.target.closest('button,[role="button"],a') : null
    if (!target) return null
    const aria = (target.getAttribute('aria-label') || '').trim()
    const title = (target.getAttribute('title') || '').trim()
    const text = (target.textContent || '').trim()
    return NEW_SESSION_LABEL.test(aria) || NEW_SESSION_LABEL.test(title) || NEW_SESSION_LABEL.test(text)
      ? target
      : null
  }

  const handle = (event) => {
    const button = sessionButton(event)
    if (!button) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    void createSession()
  }

  // 同时捕获 click 与 pointerup：部分 Android WebView/浏览器在触摸布局下不派发 click。
  document.addEventListener('click', handle, true)
  document.addEventListener('pointerup', handle, true)
})()
`

/** 只给已有脚本加 data-cfasync="false"，不注入任何 JS。 */
export function injectOpenCodeScriptOptOut(html: string): string {
  return html.replace(/<script(?![^>]*\bdata-cfasync=)/gi, '<script data-cfasync="false"')
}

/** 将外部垫片脚本插入 opencode HTML；同源路径在 CSP script-src 'self' 下允许加载。 */
export function injectOpenCodeShim(html: string): string {
  if (html.includes(OPENCODE_SHIM_PATH)) return html
  // Cloudflare Rocket Loader 会改写 type="module" 并延迟执行，导致 opencode 的
  // agent/model 选择器不渲染、新建按钮失效。给已有脚本加 data-cfasync="false" 跳过它。
  const optedOut = injectOpenCodeScriptOptOut(html)
  const tag = `<script data-cfasync="false" src="${OPENCODE_SHIM_PATH}" defer></script>`
  const index = optedOut.toLowerCase().lastIndexOf('</body>')
  if (index >= 0) return `${optedOut.slice(0, index)}${tag}${optedOut.slice(index)}`
  return `${optedOut}${tag}`
}
