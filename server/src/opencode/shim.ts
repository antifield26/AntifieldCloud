/**
 * OpenCode Web 兼容垫片：为移动端补齐“新建会话”入口，并接管桌面端失效的新建按钮。
 *
 * 背景：opencode v2.0.32 在窄屏布局中不渲染新建会话按钮，桌面按钮在部分浏览器点击后不创建；
 * 垫片只调用 opencode 自身的 `POST /api/session`，随后跳到其标准 session 路由，不修改 opencode 数据。
 * 脚本以同源外部资源加载，避免 opencode 的 CSP（script-src 'self'）拦截内联脚本。
 */

export const OPENCODE_SHIM_PATH = '/__af/oc-help.js'

export const OPENCODE_SHIM_SCRIPT = String.raw`(() => {
  const FLOATING_LABEL = '＋ 新会话'
  const SESSION_BUTTON_SELECTOR = 'button[aria-label="新建会话"],button[aria-label="New session"]'
  const encodeOrigin = () =>
    btoa(location.origin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  const isNarrow = () =>
    window.matchMedia('(max-width: 900px)').matches ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)

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

  const ensureFloatingButton = () => {
    if (!isNarrow() || !document.body) return
    if (document.querySelector('[data-af-new-session]')) return
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.afNewSession = 'true'
    button.textContent = FLOATING_LABEL
    button.setAttribute('aria-label', '新建 opencode 会话')
    button.style.cssText =
      'position:fixed;right:16px;bottom:calc(env(safe-area-inset-bottom, 0px) + 16px);' +
      'z-index:2147483646;padding:11px 16px;border-radius:999px;border:1px solid rgba(255,255,255,.2);' +
      'background:#0a84ff;color:#fff;font:600 14px system-ui,sans-serif;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.35);cursor:pointer'
    button.addEventListener('click', createSession)
    document.body.appendChild(button)
  }

  // capture 阶段接管 opencode 自带的“新建会话”按钮：桌面端点击无效时仍能创建。
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target instanceof Element ? event.target.closest(SESSION_BUTTON_SELECTOR) : null
      if (!target) return
      event.preventDefault()
      event.stopPropagation()
      void createSession()
    },
    true,
  )

  const start = () => {
    ensureFloatingButton()
    setTimeout(ensureFloatingButton, 1200)
    setTimeout(ensureFloatingButton, 3000)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
  window.addEventListener('resize', ensureFloatingButton)
})()
`

/** 将外部垫片脚本插入 opencode HTML；同源路径在 CSP script-src 'self' 下允许加载。 */
export function injectOpenCodeShim(html: string): string {
  if (html.includes(OPENCODE_SHIM_PATH)) return html
  // Cloudflare Rocket Loader 会改写 type="module" 并延迟执行，导致 opencode 的
  // agent/model 选择器不渲染、新建按钮失效。给已有脚本加 data-cfasync="false" 跳过它。
  const optedOut = html.replace(/<script(?![^>]*\bdata-cfasync=)/gi, '<script data-cfasync="false"')
  const tag = `<script data-cfasync="false" src="${OPENCODE_SHIM_PATH}" defer></script>`
  const index = optedOut.toLowerCase().lastIndexOf('</body>')
  if (index >= 0) return `${optedOut.slice(0, index)}${tag}${optedOut.slice(index)}`
  return `${optedOut}${tag}`
}
