import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  Activity,
  BookOpen,
  FolderOpen,
  Gamepad2,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  Share2,
  Trash,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { usePageTitle } from '../hooks/usePageTitle'
import { useAppMeta } from '../meta/MetaContext'
import { useToast } from './Toast'
import { Avatar } from './Avatar'
import { Logo } from './Logo'
import { PwaInstallPrompt } from './PwaInstallPrompt'
import { cx } from '../lib/classnames'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
  requiresShares?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: '工作台', icon: LayoutDashboard, end: true },
  { to: '/files', label: '文件', icon: FolderOpen },
  { to: '/knowledge', label: '知识库', icon: BookOpen },
  { to: '/shares', label: '分享', icon: Share2, requiresShares: true },
  { to: '/trash', label: '回收站', icon: Trash },
  { to: '/minecraft', label: 'Minecraft', icon: Gamepad2 },
  { to: '/activity', label: '活动', icon: Activity },
]

const PAGE_TITLES: Record<string, string> = {
  '/': '工作台',
  '/files': '文件',
  '/knowledge': '知识库',
  '/shares': '分享管理',
  '/trash': '回收站',
  '/minecraft': 'Minecraft',
  '/activity': '活动',
  '/settings': '设置',
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface SidebarContentProps {
  username: string
  onNavigate?: () => void
}

function SidebarContent({ username, onNavigate }: SidebarContentProps) {
  const { logout } = useAuth()
  const { meta } = useAppMeta()
  const navigate = useNavigate()
  const toast = useToast()
  const [loggingOut, setLoggingOut] = useState(false)

  const handleLogout = async (): Promise<void> => {
    if (loggingOut) return
    setLoggingOut(true)
    try {
      await logout()
      toast.success('已退出登录')
      navigate('/login', { replace: true })
    } finally {
      setLoggingOut(false)
    }
  }

  const items = NAV_ITEMS.filter((item) => !item.requiresShares || meta.sharesEnabled)

  return (
    <div className="sidebar-inner">
      <div className="sidebar-brand">
        <Logo size={34} withText />
      </div>

      <nav className="sidebar-nav" aria-label="主导航">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) => cx('nav-link', isActive && 'nav-link-active')}
          >
            <item.icon size={18} className="nav-icon" aria-hidden="true" />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-user">
        <div className="sidebar-user-info">
          <Avatar name={username || 'A'} size={30} />
          <span className="sidebar-username" title={username}>{username || 'antifield'}</span>
        </div>
        <div className="sidebar-user-actions">
          <NavLink
            to="/settings"
            onClick={onNavigate}
            className={({ isActive }) => cx('icon-btn', isActive && 'icon-btn-active')}
            aria-label="设置"
            title="设置"
          >
            <Settings size={17} aria-hidden="true" />
          </NavLink>
          <button
            type="button"
            className="icon-btn"
            onClick={() => void handleLogout()}
            aria-label="退出登录"
            title="退出登录"
            disabled={loggingOut}
          >
            <LogOut size={17} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}

const BOTTOM_TABS: NavItem[] = [
  { to: '/', label: '工作台', icon: LayoutDashboard, end: true },
  { to: '/files', label: '文件', icon: FolderOpen },
  { to: '/knowledge', label: '知识库', icon: BookOpen },
  { to: '/minecraft', label: 'Minecraft', icon: Gamepad2 },
]

/** 应用外壳：桌面固定侧栏；移动端顶部栏 + 抽屉导航（含焦点陷阱）+ 底部 Tab。 */
export function Layout() {
  const { user } = useAuth()
  const location = useLocation()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerRef = useRef<HTMLDivElement>(null)
  const pageTitle = PAGE_TITLES[location.pathname] ?? '工作台'
  usePageTitle(pageTitle)

  useEffect(() => {
    setDrawerOpen(false)
    window.scrollTo({ top: 0, behavior: 'auto' })
  }, [location.pathname])

  // 移动端抽屉：滚动锁、Esc 关闭、Tab 焦点陷阱与焦点恢复
  useEffect(() => {
    if (!drawerOpen) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusTimer = window.setTimeout(() => {
      drawerRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus()
    }, 20)

    const getFocusable = (): HTMLElement[] => {
      const drawer = drawerRef.current
      if (!drawer) return []
      return Array.from(drawer.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => element.tabIndex >= 0 && element.getClientRects().length > 0,
      )
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setDrawerOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const focusable = getFocusable()
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return
      const active = document.activeElement
      if (event.shiftKey) {
        if (active === first || !drawerRef.current?.contains(active)) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last || !drawerRef.current?.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      previouslyFocused?.focus()
    }
  }, [drawerOpen])

  const username = user?.username ?? ''

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <SidebarContent username={username} />
      </aside>

      <header className="topbar">
        <button
          type="button"
          className="icon-btn"
          onClick={() => setDrawerOpen(true)}
          aria-label="打开导航菜单"
          aria-expanded={drawerOpen}
          aria-controls="mobile-drawer"
        >
          <Menu size={20} aria-hidden="true" />
        </button>
        <span className="topbar-title">{pageTitle}</span>
        <NavLink to="/settings" className="topbar-user" aria-label="打开设置">
          <Avatar name={username || 'A'} size={26} />
        </NavLink>
      </header>

      <main className="app-main">
        <div className="app-content">
          <Outlet />
        </div>
      </main>

      <nav className="bottom-nav" aria-label="底部导航">
        {BOTTOM_TABS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => cx('bottom-tab', isActive && 'bottom-tab-active')}
          >
            <item.icon size={20} aria-hidden="true" />
            <span>{item.label}</span>
          </NavLink>
        ))}
        <button
          type="button"
          className={cx('bottom-tab', drawerOpen && 'bottom-tab-active')}
          onClick={() => setDrawerOpen(true)}
          aria-label="打开更多导航"
        >
          <Menu size={20} aria-hidden="true" />
          <span>更多</span>
        </button>
      </nav>

      {drawerOpen ? (
        <div className="drawer-overlay" onMouseDown={() => setDrawerOpen(false)}>
          <aside
            id="mobile-drawer"
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-label="导航菜单"
            ref={drawerRef}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="icon-btn drawer-close"
              onClick={() => setDrawerOpen(false)}
              aria-label="关闭导航菜单"
            >
              <X size={18} aria-hidden="true" />
            </button>
            <SidebarContent username={username} onNavigate={() => setDrawerOpen(false)} />
          </aside>
        </div>
      ) : null}

      <PwaInstallPrompt />
    </div>
  )
}
