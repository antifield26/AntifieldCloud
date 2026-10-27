// 角色与记忆分区：展示并管理私聊角色卡与结构化长期记忆的元数据。
// 安全边界：服务端只返回元数据，本组件绝不渲染角色设定或记忆 key/value 正文，也不提供正文查看/编辑入口；
// 停用与删除只提交 userId / itemId，删除前必须二次确认。

import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, Brain, IdCard, ListTree, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { api, toErrorMessage } from '../../api/client'
import type {
  ChatbotGroupRoleSummary,
  ChatbotMemoryGroupSummary,
  ChatbotMemoryItemSummary,
  ChatbotMemoryUserSummary,
  ChatbotRoleSummary,
  ChatbotSummary,
} from '../../api/types'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Card } from '../Card'
import { ConfirmDialog } from '../ConfirmDialog'
import { EmptyState } from '../EmptyState'
import { FormField } from '../FormField'
import { InlineError } from '../InlineError'
import { Modal } from '../Modal'
import { Table } from '../Table'
import type { Column } from '../Table'
import { useToast } from '../Toast'
import { CHATBOT_MEMORY_KINDS, CHATBOT_MEMORY_KIND_LABELS } from '../../lib/chatbots'
import { formatDateTime, truncateText } from '../../lib/format'

/** 每页固定 20 条，与服务端 limit/offset 分页配合。 */
const PAGE_SIZE = 20

interface ChatbotUserDataPanelProps {
  chatbot: ChatbotSummary | null
  /** 页面级刷新令牌变化时重新拉取角色卡与记忆。 */
  refreshToken: number
}

interface ConfirmTarget {
  kind: 'role' | 'memory'
  /** 用户记忆为 userId，群聊记忆为内部 group scope。 */
  userId: string
  label: string
  memoryKind?: 'user' | 'group'
}

/** 用户展示名：优先平台用户名，否则截断 userId；完整 userId 放在 title。 */
function userLabel(userId: string, userName: string | null): string {
  if (userName && userName.trim()) return userName
  return truncateText(userId, 14)
}

function UserCell({ userId, userName }: { userId: string; userName: string | null }) {
  return (
    <span className="chatbot-userdata-user" title={userId}>
      {userLabel(userId, userName)}
    </span>
  )
}

/** 分数展示：重要度按原值（1–5），置信度按 0–1 百分比（UI-SPEC §12）。 */
function formatScore(value: number): string {
  return Number.isFinite(value) ? String(value) : '—'
}

function formatConfidence(value: number): string {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—'
}

function pagerInfo(page: number, total: number): string {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  return `第 ${page} / ${totalPages} 页 · 共 ${total} 条`
}

/** 类型分布只展示类型名与计数，不涉及任何 key/value 正文。 */
function KindDistribution({ kinds }: { kinds: ChatbotMemoryUserSummary['kinds'] }) {
  const entries = CHATBOT_MEMORY_KINDS.filter((kind) => (kinds[kind] ?? 0) > 0)
  if (entries.length === 0) return <span className="cell-detail">—</span>
  return (
    <span className="chatbot-memory-kinds">
      {entries.map((kind) => (
        <span className="chatbot-memory-kind" key={kind}>
          {CHATBOT_MEMORY_KIND_LABELS[kind]}
          <span className="chatbot-memory-kind-count">{kinds[kind] ?? 0}</span>
        </span>
      ))}
    </span>
  )
}

/** 角色与记忆分区：角色卡管理 + 结构化记忆用户列表与条目对话框。 */
export function ChatbotUserDataPanel({ chatbot, refreshToken }: ChatbotUserDataPanelProps) {
  const toast = useToast()
  const chatbotId = chatbot?.id ?? ''

  const [roles, setRoles] = useState<ChatbotRoleSummary[]>([])
  const [rolesTotal, setRolesTotal] = useState(0)
  const [rolesPage, setRolesPage] = useState(1)
  const [rolesLoading, setRolesLoading] = useState(true)
  const [rolesError, setRolesError] = useState<string | null>(null)
  const [rolesReloadKey, setRolesReloadKey] = useState(0)

  const [groupRoles, setGroupRoles] = useState<ChatbotGroupRoleSummary[]>([])
  const [groupRolesLoading, setGroupRolesLoading] = useState(true)
  const [groupRolesError, setGroupRolesError] = useState<string | null>(null)
  const [groupRolesReloadKey, setGroupRolesReloadKey] = useState(0)
  const [groupEditor, setGroupEditor] = useState<{ targetId: string; targetLabel: string } | null>(null)
  const [groupDraft, setGroupDraft] = useState<{ name: string; prompt: string; enabled: boolean } | null>(null)
  const [groupEditorLoading, setGroupEditorLoading] = useState(false)
  const [groupSaving, setGroupSaving] = useState(false)
  const [groupConfirm, setGroupConfirm] = useState<{ targetId: string; targetLabel: string } | null>(null)

  const [memories, setMemories] = useState<ChatbotMemoryUserSummary[]>([])
  const [memoriesTotal, setMemoriesTotal] = useState(0)
  const [memoriesPage, setMemoriesPage] = useState(1)
  const [memoriesLoading, setMemoriesLoading] = useState(true)
  const [memoriesError, setMemoriesError] = useState<string | null>(null)
  const [memoriesReloadKey, setMemoriesReloadKey] = useState(0)

  const [groupMemories, setGroupMemories] = useState<ChatbotMemoryGroupSummary[]>([])
  const [groupMemoriesTotal, setGroupMemoriesTotal] = useState(0)
  const [groupMemoriesPage, setGroupMemoriesPage] = useState(1)
  const [groupMemoriesLoading, setGroupMemoriesLoading] = useState(true)
  const [groupMemoriesError, setGroupMemoriesError] = useState<string | null>(null)
  const [groupMemoriesReloadKey, setGroupMemoriesReloadKey] = useState(0)

  const [itemsTarget, setItemsTarget] = useState<{ scope: string; label: string } | null>(null)
  const [items, setItems] = useState<ChatbotMemoryItemSummary[]>([])
  const [itemsTotal, setItemsTotal] = useState(0)
  const [itemsPage, setItemsPage] = useState(1)
  const [itemsLoading, setItemsLoading] = useState(false)
  const [itemsError, setItemsError] = useState<string | null>(null)
  const [itemsReloadKey, setItemsReloadKey] = useState(0)
  const [removeItemTarget, setRemoveItemTarget] = useState<ChatbotMemoryItemSummary | null>(null)
  const [removingItem, setRemovingItem] = useState(false)

  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null)
  const [confirming, setConfirming] = useState(false)
  /** 群角色卡编辑器请求序号：快速切换目标时丢弃旧响应。 */
  const groupEditorSeqRef = useRef(0)

  const loadRoles = useCallback(async (): Promise<void> => {
    if (!chatbotId) {
      setRoles([])
      setRolesTotal(0)
      setRolesLoading(false)
      return
    }
    setRolesLoading(true)
    setRolesError(null)
    try {
      const result = await api.chatbots.roles.list(chatbotId, {
        limit: PAGE_SIZE,
        offset: (rolesPage - 1) * PAGE_SIZE,
      })
      setRoles(result.items)
      setRolesTotal(result.total)
    } catch (loadError) {
      setRolesError(toErrorMessage(loadError, '读取角色卡失败'))
    } finally {
      setRolesLoading(false)
    }
  }, [chatbotId, rolesPage])

  const loadGroupRoles = useCallback(async (): Promise<void> => {
    if (!chatbotId) {
      setGroupRoles([])
      setGroupRolesLoading(false)
      return
    }
    setGroupRolesLoading(true)
    setGroupRolesError(null)
    try {
      const result = await api.chatbots.groupRoles.list(chatbotId)
      setGroupRoles(result.items)
    } catch (loadError) {
      setGroupRolesError(toErrorMessage(loadError, '读取群聊角色卡失败'))
    } finally {
      setGroupRolesLoading(false)
    }
  }, [chatbotId])

  const loadMemories = useCallback(async (): Promise<void> => {
    if (!chatbotId) {
      setMemories([])
      setMemoriesTotal(0)
      setMemoriesLoading(false)
      return
    }
    setMemoriesLoading(true)
    setMemoriesError(null)
    try {
      const result = await api.chatbots.memories.list(chatbotId, {
        limit: PAGE_SIZE,
        offset: (memoriesPage - 1) * PAGE_SIZE,
      })
      setMemories(result.items)
      setMemoriesTotal(result.total)
    } catch (loadError) {
      setMemoriesError(toErrorMessage(loadError, '读取长期记忆失败'))
    } finally {
      setMemoriesLoading(false)
    }
  }, [chatbotId, memoriesPage])

  const itemsUserId = itemsTarget?.scope ?? ''
  const loadGroupMemories = useCallback(async (): Promise<void> => {
    if (!chatbotId) {
      setGroupMemories([])
      setGroupMemoriesTotal(0)
      setGroupMemoriesLoading(false)
      return
    }
    setGroupMemoriesLoading(true)
    setGroupMemoriesError(null)
    try {
      const result = await api.chatbots.groupMemories.list(chatbotId, {
        limit: PAGE_SIZE,
        offset: (groupMemoriesPage - 1) * PAGE_SIZE,
      })
      setGroupMemories(result.items)
      setGroupMemoriesTotal(result.total)
    } catch (loadError) {
      setGroupMemoriesError(toErrorMessage(loadError, '读取群聊记忆失败'))
    } finally {
      setGroupMemoriesLoading(false)
    }
  }, [chatbotId, groupMemoriesPage])

  const loadItems = useCallback(async (): Promise<void> => {
    if (!chatbotId || !itemsUserId) {
      setItems([])
      setItemsTotal(0)
      setItemsLoading(false)
      return
    }
    setItemsLoading(true)
    setItemsError(null)
    try {
      const result = await api.chatbots.memories.items(chatbotId, itemsUserId, {
        limit: PAGE_SIZE,
        offset: (itemsPage - 1) * PAGE_SIZE,
      })
      setItems(result.items)
      setItemsTotal(result.total)
    } catch (loadError) {
      setItemsError(toErrorMessage(loadError, '读取记忆条目失败'))
    } finally {
      setItemsLoading(false)
    }
  }, [chatbotId, itemsUserId, itemsPage])

  useEffect(() => {
    void loadRoles()
  }, [loadRoles, refreshToken, rolesReloadKey])

  useEffect(() => {
    void loadGroupRoles()
  }, [loadGroupRoles, refreshToken, groupRolesReloadKey])

  useEffect(() => {
    void loadMemories()
  }, [loadMemories, refreshToken, memoriesReloadKey])

  useEffect(() => {
    void loadGroupMemories()
  }, [loadGroupMemories, refreshToken, groupMemoriesReloadKey])

  useEffect(() => {
    void loadItems()
  }, [loadItems, itemsReloadKey])

  // 删除/数据收缩后回收越界页码，避免停留在空白页。
  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(rolesTotal / PAGE_SIZE))
    if (rolesPage > totalPages) setRolesPage(totalPages)
  }, [rolesPage, rolesTotal])
  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(memoriesTotal / PAGE_SIZE))
    if (memoriesPage > totalPages) setMemoriesPage(totalPages)
  }, [memoriesPage, memoriesTotal])
  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(groupMemoriesTotal / PAGE_SIZE))
    if (groupMemoriesPage > totalPages) setGroupMemoriesPage(totalPages)
  }, [groupMemoriesPage, groupMemoriesTotal])
  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(itemsTotal / PAGE_SIZE))
    if (itemsPage > totalPages) setItemsPage(totalPages)
  }, [itemsPage, itemsTotal])

  const handleToggleRole = async (role: ChatbotRoleSummary): Promise<void> => {
    if (!chatbot || busyKey) return
    setBusyKey(`role:${role.userId}`)
    try {
      await api.chatbots.roles.setEnabled(chatbot.id, role.userId, !role.enabled)
      setRoles((previous) =>
        previous.map((item) => (item.userId === role.userId ? { ...item, enabled: !role.enabled } : item)),
      )
      toast.success(role.enabled ? '角色卡已停用' : '角色卡已启用')
    } catch (updateError) {
      toast.error(toErrorMessage(updateError, '更新角色卡状态失败，请重试'))
    } finally {
      setBusyKey(null)
    }
  }

  const openGroupEditor = async (item: ChatbotGroupRoleSummary): Promise<void> => {
    if (!chatbot) return
    const seq = groupEditorSeqRef.current + 1
    groupEditorSeqRef.current = seq
    setGroupEditor({ targetId: item.targetId, targetLabel: item.targetLabel })
    setGroupEditorLoading(true)
    setGroupDraft(null)
    try {
      const result = await api.chatbots.groupRoles.get(chatbot.id, item.targetId)
      if (seq !== groupEditorSeqRef.current) return
      setGroupDraft(
        result.groupRole
          ? {
              name: result.groupRole.name,
              prompt: result.groupRole.prompt,
              enabled: result.groupRole.enabled,
            }
          : { name: '', prompt: '', enabled: true },
      )
    } catch (loadError) {
      if (seq === groupEditorSeqRef.current) toast.error(toErrorMessage(loadError, '读取群聊角色卡失败'))
    } finally {
      if (seq === groupEditorSeqRef.current) setGroupEditorLoading(false)
    }
  }

  const handleSaveGroupRole = async (): Promise<void> => {
    if (!chatbot || !groupEditor || !groupDraft || groupSaving) return
    const name = groupDraft.name.trim()
    const prompt = groupDraft.prompt.trim()
    if (!name) {
      toast.error('请输入角色名字')
      return
    }
    if (!prompt) {
      toast.error('请输入角色设定')
      return
    }
    setGroupSaving(true)
    try {
      await api.chatbots.groupRoles.save(chatbot.id, groupEditor.targetId, { name, prompt })
      toast.success('群聊角色卡已保存')
      setGroupEditor(null)
      setGroupDraft(null)
      setGroupRolesReloadKey((value) => value + 1)
    } catch (saveError) {
      toast.error(toErrorMessage(saveError, '保存群聊角色卡失败，请重试'))
    } finally {
      setGroupSaving(false)
    }
  }

  const handleToggleGroupRole = async (item: ChatbotGroupRoleSummary): Promise<void> => {
    if (!chatbot || busyKey || !item.name) return
    setBusyKey(`group-role:${item.targetId}`)
    try {
      await api.chatbots.groupRoles.setEnabled(chatbot.id, item.targetId, !item.enabled)
      setGroupRoles((previous) =>
        previous.map((candidate) =>
          candidate.targetId === item.targetId ? { ...candidate, enabled: !item.enabled } : candidate,
        ),
      )
      toast.success(item.enabled ? '群聊角色卡已停用' : '群聊角色卡已启用')
    } catch (updateError) {
      toast.error(toErrorMessage(updateError, '更新群聊角色卡状态失败，请重试'))
    } finally {
      setBusyKey(null)
    }
  }

  const handleDeleteGroupRole = async (): Promise<void> => {
    if (!chatbot || !groupConfirm) return
    setBusyKey(`group-role:${groupConfirm.targetId}`)
    try {
      await api.chatbots.groupRoles.remove(chatbot.id, groupConfirm.targetId)
      toast.success(`已删除「${groupConfirm.targetLabel}」的群聊角色卡`)
      setGroupConfirm(null)
      setGroupRolesReloadKey((value) => value + 1)
    } catch (deleteError) {
      toast.error(toErrorMessage(deleteError, '删除群聊角色卡失败，请重试'))
    } finally {
      setBusyKey(null)
    }
  }

  const handleConfirmDelete = async (): Promise<void> => {
    if (!chatbot || !confirmTarget) return
    setConfirming(true)
    try {
      if (confirmTarget.kind === 'role') {
        await api.chatbots.roles.remove(chatbot.id, confirmTarget.userId)
        toast.success(`已删除「${confirmTarget.label}」的角色卡`)
        await loadRoles()
      } else if (confirmTarget.memoryKind === 'group') {
        await api.chatbots.groupMemories.remove(chatbot.id, confirmTarget.userId)
        toast.success(`已删除群聊「${confirmTarget.label}」的全部共享记忆`)
        if (itemsTarget?.scope === confirmTarget.userId) setItemsTarget(null)
        await Promise.all([loadMemories(), loadGroupMemories()])
      } else {
        await api.chatbots.memories.remove(chatbot.id, confirmTarget.userId)
        toast.success(`已删除「${confirmTarget.label}」的全部记忆`)
        if (itemsTarget?.scope === confirmTarget.userId) setItemsTarget(null)
        await loadMemories()
      }
      setConfirmTarget(null)
    } catch (deleteError) {
      toast.error(
        toErrorMessage(
          deleteError,
          confirmTarget.kind === 'role' ? '删除角色卡失败，请重试' : '删除全部记忆失败，请重试',
        ),
      )
    } finally {
      setConfirming(false)
    }
  }

  const openItems = (scope: string, label: string): void => {
    setItemsTarget({ scope, label })
    setItemsPage(1)
    setItems([])
    setItemsTotal(0)
    setItemsError(null)
  }

  const closeItems = (): void => {
    if (removingItem) return
    setItemsTarget(null)
    setRemoveItemTarget(null)
  }

  const handleRemoveItem = async (): Promise<void> => {
    if (!chatbot || !itemsTarget || !removeItemTarget) return
    setRemovingItem(true)
    try {
      await api.chatbots.memories.removeItem(chatbot.id, itemsTarget.scope, removeItemTarget.id)
      toast.success('记忆条目已删除')
      setRemoveItemTarget(null)
      if (items.length <= 1 && itemsPage > 1) setItemsPage((value) => value - 1)
      else await loadItems()
      await Promise.all([loadMemories(), loadGroupMemories()])
    } catch (deleteError) {
      toast.error(toErrorMessage(deleteError, '删除记忆条目失败，请重试'))
    } finally {
      setRemovingItem(false)
    }
  }

  const roleColumns: Column<ChatbotRoleSummary>[] = [
    {
      key: 'user',
      header: '用户',
      primary: true,
      render: (role) => <UserCell userId={role.userId} userName={role.userName} />,
    },
    {
      key: 'name',
      header: '角色名',
      render: (role) => (
        <span className="chatbot-userdata-name" title={role.name}>
          {truncateText(role.name, 24)}
        </span>
      ),
    },
    {
      key: 'status',
      header: '状态',
      render: (role) =>
        role.enabled ? (
          <Badge tone="success" dot>
            已启用
          </Badge>
        ) : (
          <Badge tone="muted">已停用</Badge>
        ),
    },
    {
      key: 'updatedAt',
      header: '更新时间',
      render: (role) => <span className="cell-time">{formatDateTime(role.updatedAt)}</span>,
    },
    {
      key: 'actions',
      header: '操作',
      className: 'cell-actions',
      render: (role) => {
        const label = userLabel(role.userId, role.userName)
        const rowBusy = busyKey === `role:${role.userId}`
        return (
          <div className="chatbot-userdata-actions">
            <Button
              size="sm"
              variant="secondary"
              loading={rowBusy}
              disabled={busyKey !== null && !rowBusy}
              aria-label={`${role.enabled ? '停用' : '启用'}角色卡 ${label}`}
              onClick={() => void handleToggleRole(role)}
            >
              {role.enabled ? '停用' : '启用'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-danger"
              icon={<Trash2 size={14} aria-hidden="true" />}
              aria-label={`删除角色卡 ${label}`}
              disabled={busyKey !== null}
              onClick={() => setConfirmTarget({ kind: 'role', userId: role.userId, label })}
            >
              删除
            </Button>
          </div>
        )
      },
    },
  ]

  const groupRoleColumns: Column<ChatbotGroupRoleSummary>[] = [
    {
      key: 'target',
      header: '群聊目标',
      primary: true,
      render: (item) => (
        <span className="chatbot-userdata-name" title={item.targetExternalId}>
          {item.targetLabel}
        </span>
      ),
    },
    {
      key: 'name',
      header: '角色名',
      render: (item) =>
        item.name ? (
          <span className="chatbot-userdata-name" title={item.name}>
            {truncateText(item.name, 24)}
          </span>
        ) : (
          <span className="cell-detail">未配置</span>
        ),
    },
    {
      key: 'status',
      header: '状态',
      render: (item) =>
        !item.name ? (
          <Badge tone="muted">未配置</Badge>
        ) : item.enabled ? (
          <Badge tone="success" dot>
            已启用
          </Badge>
        ) : (
          <Badge tone="muted">已停用</Badge>
        ),
    },
    {
      key: 'updatedAt',
      header: '更新时间',
      render: (item) => (
        <span className="cell-time">{item.updatedAt ? formatDateTime(item.updatedAt) : '—'}</span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      className: 'cell-actions',
      render: (item) => {
        const rowBusy = busyKey === `group-role:${item.targetId}`
        return (
          <div className="chatbot-userdata-actions">
            <Button
              size="sm"
              variant="secondary"
              icon={item.name ? <Pencil size={13} aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />}
              disabled={busyKey !== null && !rowBusy}
              aria-label={`${item.name ? '编辑' : '新建'}群聊角色卡 ${item.targetLabel}`}
              onClick={() => void openGroupEditor(item)}
            >
              {item.name ? '编辑' : '新建'}
            </Button>
            {item.name ? (
              <Button
                size="sm"
                variant="secondary"
                loading={rowBusy}
                disabled={busyKey !== null && !rowBusy}
                aria-label={`${item.enabled ? '停用' : '启用'}群聊角色卡 ${item.targetLabel}`}
                onClick={() => void handleToggleGroupRole(item)}
              >
                {item.enabled ? '停用' : '启用'}
              </Button>
            ) : null}
            {item.name ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-danger"
                icon={<Trash2 size={14} aria-hidden="true" />}
                disabled={busyKey !== null}
                aria-label={`删除群聊角色卡 ${item.targetLabel}`}
                onClick={() => setGroupConfirm({ targetId: item.targetId, targetLabel: item.targetLabel })}
              >
                删除
              </Button>
            ) : null}
          </div>
        )
      },
    },
  ]

  const memoryColumns: Column<ChatbotMemoryUserSummary>[] = [
    {
      key: 'user',
      header: '用户',
      primary: true,
      render: (memory) => <UserCell userId={memory.userId} userName={memory.userName} />,
    },
    {
      key: 'itemCount',
      header: '条目数',
      render: (memory) => (
        <span className="chatbot-userdata-length">{memory.itemCount} 条</span>
      ),
    },
    {
      key: 'kinds',
      header: '类型分布',
      render: (memory) => <KindDistribution kinds={memory.kinds} />,
    },
    {
      key: 'status',
      header: '状态',
      render: (memory) =>
        memory.memoryEnabled ? (
          <Badge tone="success" dot>
            记忆启用
          </Badge>
        ) : (
          <Badge tone="muted">已暂停</Badge>
        ),
    },
    {
      key: 'updatedAt',
      header: '更新时间',
      render: (memory) => <span className="cell-time">{formatDateTime(memory.updatedAt)}</span>,
    },
    {
      key: 'actions',
      header: '操作',
      className: 'cell-actions',
      render: (memory) => {
        const label = userLabel(memory.userId, memory.userName)
        return (
          <div className="chatbot-userdata-actions">
            <Button
              size="sm"
              variant="secondary"
              aria-label={`查看记忆条目 ${label}`}
              onClick={() => openItems(memory.userId, label)}
            >
              查看条目
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-danger"
              icon={<Trash2 size={14} aria-hidden="true" />}
              aria-label={`删除全部记忆 ${label}`}
              disabled={busyKey !== null}
              onClick={() =>
                setConfirmTarget({ kind: 'memory', memoryKind: 'user', userId: memory.userId, label })
              }
            >
              删除全部
            </Button>
          </div>
        )
      },
    },
  ]

  const groupMemoryColumns: Column<ChatbotMemoryGroupSummary>[] = [
    {
      key: 'target',
      header: '群聊',
      primary: true,
      render: (memory) => (
        <span className="chatbot-userdata-user" title={memory.targetExternalId}>
          {truncateText(memory.targetName, 24)}
        </span>
      ),
    },
    {
      key: 'itemCount',
      header: '条目数',
      render: (memory) => <span className="chatbot-userdata-length">{memory.itemCount} 条</span>,
    },
    {
      key: 'kinds',
      header: '类型分布',
      render: (memory) => <KindDistribution kinds={memory.kinds} />,
    },
    {
      key: 'updatedAt',
      header: '更新时间',
      render: (memory) => <span className="cell-time">{formatDateTime(memory.updatedAt)}</span>,
    },
    {
      key: 'actions',
      header: '操作',
      className: 'cell-actions',
      render: (memory) => (
        <div className="chatbot-userdata-actions">
          <Button
            size="sm"
            variant="secondary"
            aria-label={`查看群聊记忆条目 ${memory.targetName}`}
            onClick={() => openItems(memory.scope, memory.targetName)}
          >
            查看条目
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            icon={<Trash2 size={14} aria-hidden="true" />}
            aria-label={`删除群聊记忆 ${memory.targetName}`}
            disabled={busyKey !== null}
            onClick={() =>
              setConfirmTarget({
                kind: 'memory',
                memoryKind: 'group',
                userId: memory.scope,
                label: memory.targetName,
              })
            }
          >
            删除全部
          </Button>
        </div>
      ),
    },
  ]

  const itemColumns: Column<ChatbotMemoryItemSummary>[] = [    {
      key: 'kind',
      header: '类型',
      primary: true,
      render: (item) => <Badge tone="muted">{CHATBOT_MEMORY_KIND_LABELS[item.kind]}</Badge>,
    },
    {
      key: 'importance',
      header: '重要度',
      render: (item) => <span className="chatbot-memory-score">{formatScore(item.importance)}</span>,
    },    {
      key: 'confidence',
      header: '置信度',
      render: (item) => <span className="chatbot-memory-score">{formatConfidence(item.confidence)}</span>,
    },
    {
      key: 'updatedAt',
      header: '更新时间',
      render: (item) => <span className="cell-time">{formatDateTime(item.updatedAt)}</span>,
    },
    {
      key: 'expiresAt',
      header: '过期时间',
      render: (item) =>
        item.expiresAt ? (
          <span className="cell-time">{formatDateTime(item.expiresAt)}</span>
        ) : (
          <span className="cell-time">永不过期</span>
        ),
    },
    {
      key: 'actions',
      header: '操作',
      className: 'cell-actions',
      render: (item) => (
        <Button
          size="sm"
          variant="ghost"
          className="text-danger"
          icon={<Trash2 size={14} aria-hidden="true" />}
          aria-label={`删除记忆条目 ${CHATBOT_MEMORY_KIND_LABELS[item.kind]} ${item.id}`}
          onClick={() => setRemoveItemTarget(item)}
        >
          删除
        </Button>
      ),
    },
  ]

  if (!chatbot) {
    return (
      <Card title="角色与记忆">
        <EmptyState
          icon={<Brain size={24} />}
          title="请选择一个 Chatbot"
          description="在顶部选择 Chatbot 后，可查看该 Chatbot 的用户角色卡与结构化记忆元数据。"
        />
      </Card>
    )
  }

  const confirmIsRole = confirmTarget?.kind === 'role'
  const itemsTotalPages = Math.max(1, Math.ceil(itemsTotal / PAGE_SIZE))

  return (
    <div className="chatbot-userdata">
      <div className="notice notice-muted chatbot-privacy-note" role="note">
        <ShieldCheck size={16} aria-hidden="true" />
        私聊角色卡正文不通过 Web 暴露，用户可用 /role 自助管理；群聊角色卡由管理员在本页编辑，只在对应群聊的对话提示词中使用。
      </div>

      <Card
        title="群聊角色卡"
        description="每个群聊目标一张共享角色卡，用于该群所有成员；停止/删除后回退到内置角色。群聊独立模式与全量消息在“目标”分区配置。"
        actions={
          <Badge tone="muted">
            <BookOpen size={13} aria-hidden="true" /> {groupRoles.filter((item) => item.name).length} / {groupRoles.length} 已配置
          </Badge>
        }
        loading={groupRolesLoading}
        error={groupRolesError}
        onRetry={() => setGroupRolesReloadKey((value) => value + 1)}
      >
        <Table
          className="chatbots-table-scroll"
          columns={groupRoleColumns}
          rows={groupRoles}
          rowKey={(item) => item.targetId}
          caption="群聊目标角色卡管理"
          empty={
            <EmptyState
              compact
              icon={<BookOpen size={22} />}
              title="暂无群聊目标"
              description="在“目标”分区添加群聊目标后，可在这里为每个群配置独立角色卡。"
            />
          }
        />
      </Card>

      <Card
        title="角色卡"
        description="私聊用户通过 /role 设置的个人角色；一只 Chatbot 内每位用户一张，停用后回退到内置角色。"
        actions={<Badge tone="muted"><IdCard size={13} aria-hidden="true" /> {rolesTotal} 位</Badge>}
        loading={rolesLoading}
        error={rolesError}
        onRetry={() => setRolesReloadKey((value) => value + 1)}
      >
        <Table
          className="chatbots-table-scroll"
          columns={roleColumns}
          rows={roles}
          rowKey={(role) => role.userId}
          caption="私聊角色卡元数据"
          empty={
            <EmptyState
              compact
              icon={<IdCard size={22} />}
              title="暂无角色卡"
              description="用户在私聊发送 /role 设置角色后，这里会显示其元数据。"
            />
          }
        />
        {rolesTotal > PAGE_SIZE ? (
          <div className="pager chatbot-userdata-pager">
            <Button
              size="sm"
              variant="secondary"
              aria-label="上一页角色卡"
              disabled={rolesPage <= 1 || rolesLoading}
              onClick={() => setRolesPage((value) => Math.max(1, value - 1))}
            >
              上一页
            </Button>
            <span className="pager-info">{pagerInfo(rolesPage, rolesTotal)}</span>
            <Button
              size="sm"
              variant="secondary"
              aria-label="下一页角色卡"
              disabled={rolesPage >= Math.ceil(rolesTotal / PAGE_SIZE) || rolesLoading}
              onClick={() => setRolesPage((value) => value + 1)}
            >
              下一页
            </Button>
          </div>
        ) : null}
      </Card>

      <Card
        title="长期记忆"
        description="用户记忆用于私聊；群聊记忆按群目标共享，只包含“用户名：记忆”结构。两侧都只展示元数据，正文不通过 Web 暴露。"
        actions={
          <Badge tone="muted">
            <Brain size={13} aria-hidden="true" /> {memoriesTotal} 位用户 / {groupMemoriesTotal} 个群
          </Badge>
        }
        loading={memoriesLoading || groupMemoriesLoading}
        error={memoriesError ?? groupMemoriesError}
        onRetry={() => {
          setMemoriesReloadKey((value) => value + 1)
          setGroupMemoriesReloadKey((value) => value + 1)
        }}
      >
        <div className="chatbot-memory-columns">
          <section className="chatbot-memory-column" aria-label="用户记忆">
            <div className="chatbot-memory-column-head">
              <h3>用户记忆</h3>
              <span className="cell-detail">私聊与用户级条目</span>
            </div>
            <Table
              className="chatbots-table-scroll"
              columns={memoryColumns}
              rows={memories}
              rowKey={(memory) => memory.userId}
              caption="结构化长期记忆用户级元数据"
              empty={
                <EmptyState
                  compact
                  icon={<Brain size={22} />}
                  title="暂无用户记忆"
                  description="用户在私聊与 AI 对话产生结构化记忆后，这里会显示条目数与类型分布。"
                />
              }
            />
            {memoriesTotal > PAGE_SIZE ? (
              <div className="pager chatbot-userdata-pager">
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label="上一页记忆"
                  disabled={memoriesPage <= 1 || memoriesLoading}
                  onClick={() => setMemoriesPage((value) => Math.max(1, value - 1))}
                >
                  上一页
                </Button>
                <span className="pager-info">{pagerInfo(memoriesPage, memoriesTotal)}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label="下一页记忆"
                  disabled={memoriesPage >= Math.ceil(memoriesTotal / PAGE_SIZE) || memoriesLoading}
                  onClick={() => setMemoriesPage((value) => value + 1)}
                >
                  下一页
                </Button>
              </div>
            ) : null}
          </section>

          <section className="chatbot-memory-column" aria-label="群聊记忆">
            <div className="chatbot-memory-column-head">
              <h3>群聊记忆</h3>
              <span className="cell-detail">按群目标共享</span>
            </div>
            <Table
              className="chatbots-table-scroll"
              columns={groupMemoryColumns}
              rows={groupMemories}
              rowKey={(memory) => memory.scope}
              caption="结构化群聊共享记忆元数据"
              empty={
                <EmptyState
                  compact
                  icon={<Brain size={22} />}
                  title="暂无群聊记忆"
                  description="群聊产生结构化记忆后，这里会按群目标显示条目数与类型分布。"
                />
              }
            />
            {groupMemoriesTotal > PAGE_SIZE ? (
              <div className="pager chatbot-userdata-pager">
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label="上一页群聊记忆"
                  disabled={groupMemoriesPage <= 1 || groupMemoriesLoading}
                  onClick={() => setGroupMemoriesPage((value) => Math.max(1, value - 1))}
                >
                  上一页
                </Button>
                <span className="pager-info">{pagerInfo(groupMemoriesPage, groupMemoriesTotal)}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label="下一页群聊记忆"
                  disabled={
                    groupMemoriesPage >= Math.ceil(groupMemoriesTotal / PAGE_SIZE) || groupMemoriesLoading
                  }
                  onClick={() => setGroupMemoriesPage((value) => value + 1)}
                >
                  下一页
                </Button>
              </div>
            ) : null}
          </section>
        </div>
      </Card>

      <Modal
        open={groupEditor !== null}
        size="lg"
        title={groupEditor ? `群聊角色卡 · ${groupEditor.targetLabel}` : '群聊角色卡'}
        description="该角色卡只用于对应群聊的 AI 对话，覆盖群成员的个人私聊角色卡；正文不会展示给普通用户。"
        onClose={() => {
          if (!groupSaving) {
            setGroupEditor(null)
            setGroupDraft(null)
          }
        }}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setGroupEditor(null)
                setGroupDraft(null)
              }}
              disabled={groupSaving}
            >
              取消
            </Button>
            <Button
              variant="primary"
              loading={groupSaving}
              disabled={groupEditorLoading || !groupDraft}
              onClick={() => void handleSaveGroupRole()}
            >
              保存角色卡
            </Button>
          </>
        }
      >
        {groupEditorLoading ? (
          <p className="field-hint">正在读取角色卡…</p>
        ) : groupDraft ? (
          <div className="chatbot-group-role-editor">
            <FormField
              label="角色名字"
              htmlFor="chatbot-group-role-name"
              required
              hint="1–32 个字符，不能包含空格、方括号或换行。"
            >
              <input
                id="chatbot-group-role-name"
                className="input"
                value={groupDraft.name}
                onChange={(event) =>
                  setGroupDraft((previous) => (previous ? { ...previous, name: event.target.value } : previous))
                }
                maxLength={32}
                disabled={groupSaving}
                placeholder="例如：运维助手"
              />
            </FormField>
            <FormField
              label="角色设定"
              htmlFor="chatbot-group-role-prompt"
              required
              hint={`${groupDraft.prompt.length} / 1000 字符；只改变人设/语气，固定安全边界仍会追加。`}
            >
              <textarea
                id="chatbot-group-role-prompt"
                className="input chatbot-textarea"
                value={groupDraft.prompt}
                onChange={(event) =>
                  setGroupDraft((previous) => (previous ? { ...previous, prompt: event.target.value } : previous))
                }
                maxLength={1000}
                rows={7}
                disabled={groupSaving}
                placeholder="例如：你是本群的运维助手，回答简洁、先给结论。"
              />
            </FormField>
          </div>
        ) : (
          <p className="field-hint">未能读取角色卡，请关闭后重试。</p>
        )}
      </Modal>

      <ConfirmDialog
        open={groupConfirm !== null}
        title="删除群聊角色卡"
        message={groupConfirm ? `确定删除「${groupConfirm.targetLabel}」的群聊角色卡？` : ''}
        details="删除后该群聊回退到内置角色；不影响群目标、权限或历史消息。此操作不可撤销。"
        confirmText="删除角色卡"
        loading={busyKey === `group-role:${groupConfirm?.targetId ?? ''}`}
        onConfirm={() => void handleDeleteGroupRole()}
        onClose={() => {
          if (busyKey === null) setGroupConfirm(null)
        }}
      />

      <Modal
        open={itemsTarget !== null}
        size="lg"
        title={itemsTarget ? `记忆条目 · ${itemsTarget.label}` : '记忆条目'}
        description="仅展示条目元数据：类型、重要度、置信度与时间；key 与 value 正文不通过 Web 暴露。"
        onClose={closeItems}
        footer={
          <Button variant="secondary" onClick={closeItems} disabled={removingItem}>
            关闭
          </Button>
        }
      >
        {itemsError ? (
          <InlineError message={itemsError} onRetry={() => setItemsReloadKey((value) => value + 1)} />
        ) : (
          <div className="chatbot-memory-items">
            <div className="chatbot-memory-items-meta">
              <ListTree size={14} aria-hidden="true" />
              <span>共 {itemsTotal} 条元数据</span>
            </div>
            <Table
              className="chatbots-table-scroll"
              columns={itemColumns}
              rows={items}
              rowKey={(item) => item.id}
              loading={itemsLoading}
              skeletonRows={3}
              caption="记忆条目元数据"
              empty={
                <EmptyState
                  compact
                  icon={<Brain size={22} />}
                  title="暂无记忆条目"
                  description="用户产生结构化记忆后，条目元数据会在这里展示。"
                />
              }
            />
            {itemsTotal > PAGE_SIZE ? (
              <div className="pager chatbot-userdata-pager">
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label="上一页记忆条目"
                  disabled={itemsPage <= 1 || itemsLoading}
                  onClick={() => setItemsPage((value) => Math.max(1, value - 1))}
                >
                  上一页
                </Button>
                <span className="pager-info">{pagerInfo(itemsPage, itemsTotal)}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label="下一页记忆条目"
                  disabled={itemsPage >= itemsTotalPages || itemsLoading}
                  onClick={() => setItemsPage((value) => value + 1)}
                >
                  下一页
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmTarget !== null}
        title={confirmIsRole ? '删除角色卡' : confirmTarget?.memoryKind === 'group' ? '删除群聊记忆' : '删除全部记忆'}
        message={
          confirmTarget
            ? confirmIsRole
              ? `确定删除用户「${confirmTarget.label}」的角色卡？`
              : confirmTarget.memoryKind === 'group'
                ? `确定删除群聊「${confirmTarget.label}」的全部共享记忆条目？`
                : `确定删除用户「${confirmTarget.label}」的全部记忆条目？`
            : ''
        }
        details={
          confirmIsRole
            ? '删除后该用户将回退到内置角色，且其私聊会话会被清理；此操作不可撤销。'
            : confirmTarget?.memoryKind === 'group'
              ? '删除后该群聊的共享记忆会被清空，不影响群目标、角色卡或用户自己的私聊记忆；此操作不可撤销。'
              : '删除后该用户与本 Chatbot 的全部结构化记忆条目会被清除，已有对话会话保留；此操作不可撤销。'
        }
        confirmText={
          confirmIsRole ? '删除角色卡' : confirmTarget?.memoryKind === 'group' ? '删除群聊记忆' : '删除全部记忆'
        }
        loading={confirming}
        onConfirm={() => void handleConfirmDelete()}
        onClose={() => {
          if (!confirming) setConfirmTarget(null)
        }}
      />

      <ConfirmDialog
        open={removeItemTarget !== null}
        title="删除记忆条目"
        message={
          removeItemTarget
            ? `确定删除这条「${CHATBOT_MEMORY_KIND_LABELS[removeItemTarget.kind]}」记忆条目？`
            : ''
        }
        details="只会删除该条结构化记忆，不影响其他条目；此操作不可撤销。"
        confirmText="删除条目"
        loading={removingItem}
        onConfirm={() => void handleRemoveItem()}
        onClose={() => {
          if (!removingItem) setRemoveItemTarget(null)
        }}
      />
    </div>
  )
}
