// Minecraft 页：服务器只读状态/白名单管理与 mcbot 面板两个标签页。
// 标签状态写入 ?tab=mcbot（保留其他查询参数），首次加载支持 ?tab=mcbot 或 #mcbot 深链。
// mcbot 集成未启用（meta.mcbotEnabled=false）时不展示 mcbot 标签页，页面行为与旧版一致。

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAppMeta } from '../meta/MetaContext'
import { PageHeader } from '../components/PageHeader'
import { MinecraftServerPanel } from '../components/minecraft/MinecraftServerPanel'
import { McbotPanel } from '../components/mcbot/McbotPanel'
import { cx } from '../lib/classnames'

type MinecraftTab = 'server' | 'mcbot'

const TABS: readonly { id: MinecraftTab; label: string }[] = [
  { id: 'server', label: '服务器' },
  { id: 'mcbot', label: 'mcbot' },
]

/** 深链初始化：?tab=mcbot 或 #mcbot 均进入 mcbot 标签页。 */
function initialTabFromUrl(search: string, hash: string): MinecraftTab {
  const params = new URLSearchParams(search)
  return params.get('tab') === 'mcbot' || hash === '#mcbot' ? 'mcbot' : 'server'
}

/** 页面标题与描述按当前标签切换。 */
const TAB_COPY: Record<MinecraftTab, { title: string; description: string }> = {
  server: {
    title: 'Minecraft',
    description: '服务器只读状态与白名单管理',
  },
  mcbot: {
    title: 'mcbot',
    description: 'mcbot Bot 运行状态、任务控制、事件流与历史（数据来自本机 mcbot 接口）',
  },
}

/** Minecraft 页：可键盘操作的“服务器 / mcbot”标签页外壳。 */
export function Minecraft() {
  const { meta } = useAppMeta()
  const location = useLocation()
  const navigate = useNavigate()
  const [tab, setTab] = useState<MinecraftTab>(() => initialTabFromUrl(location.search, location.hash))
  const tabButtons = useRef<Array<HTMLButtonElement | null>>([])

  // 服务端未启用 mcbot 时回退到服务器标签，避免渲染不可用面板。
  const showLofii = meta.mcbotEnabled
  const activeTab: MinecraftTab = tab === 'mcbot' && !showLofii ? 'server' : tab
  const copy = TAB_COPY[activeTab]

  // 浏览器前进/后退或外部跳转改变 URL 时同步标签状态（组件保持挂载时 state 不会自动更新）。
  useEffect(() => {
    const desired = initialTabFromUrl(location.search, location.hash)
    setTab((previous) => (previous === desired ? previous : desired))
  }, [location.search, location.hash])

  const selectTab = (next: MinecraftTab): void => {
    setTab(next)
    const params = new URLSearchParams(location.search)
    if (next === 'mcbot') params.set('tab', 'mcbot')
    else params.delete('tab')
    const search = params.toString()
    // 服务器标签清理 #mcbot 深链；mcbot 标签保留其他锚点不动。
    const hash = next === 'mcbot' ? location.hash : location.hash === '#mcbot' ? '' : location.hash
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '', hash }, { replace: true })
  }

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (!showLofii) return
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % TABS.length
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = TABS.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const next = TABS[nextIndex]
    if (!next) return
    selectTab(next.id)
    window.requestAnimationFrame(() => tabButtons.current[nextIndex ?? 0]?.focus())
  }

  return (
    <div className="minecraft-page">
      <PageHeader title={copy.title} description={copy.description} />

      {showLofii ? (
        <div className="segmented minecraft-tabs" role="tablist" aria-label="Minecraft 页面分区">
          {TABS.map((item, index) => (
            <button
              key={item.id}
              ref={(element) => {
                tabButtons.current[index] = element
              }}
              type="button"
              role="tab"
              id={`minecraft-tab-${item.id}`}
              className={cx('segmented-button', activeTab === item.id && 'segmented-button-active')}
              aria-selected={activeTab === item.id}
              aria-controls="minecraft-tabpanel"
              tabIndex={activeTab === item.id ? 0 : -1}
              onClick={() => selectTab(item.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}

      {showLofii ? (
        <div
          className="minecraft-tabpanel"
          id="minecraft-tabpanel"
          role="tabpanel"
          aria-labelledby={`minecraft-tab-${activeTab}`}
          tabIndex={0}
        >
          {activeTab === 'mcbot' ? <McbotPanel /> : <MinecraftServerPanel />}
        </div>
      ) : (
        <MinecraftServerPanel />
      )}
    </div>
  )
}
