// 角色与记忆分区：展示并管理私聊角色卡与长期记忆的元数据。
// 安全边界：服务端只返回元数据，本组件绝不渲染角色设定或记忆摘要正文，也不提供正文查看/编辑入口；
// 停用与删除只提交 userId，删除前必须二次确认。

import { useCallback, useEffect, useState } from 'react'
import { Brain, IdCard, ShieldCheck, Trash2 } from 'lucide-react'
import { api, toErrorMessage } from '../../api/client'
import type { BotMemorySummary, BotRoleSummary, BotSummary } from '../../api/types'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Card } from '../Card'
import { ConfirmDialog } from '../ConfirmDialog'
import { EmptyState } from '../EmptyState'
import { Table } from '../Table'
import type { Column } from '../Table'
import { useToast } from '../Toast'
import { formatDateTime, truncateText } from '../../lib/format'

/** 每页固定 20 条，与服务端 limit/offset 分页配合。 */
const PAGE_SIZE = 20

interface BotUserDataPanelProps {
  bot: BotSummary | null
  /** 页面级刷新令牌变化时重新拉取角色卡与记忆。 */
  refreshToken: number
}

interface ConfirmTarget {
  kind: 'role' | 'memory'
  userId: string
  label: string
}

/** 用户展示名：优先平台用户名，否则截断 userId；完整 userId 放在 title。 */
function userLabel(userId: string, userName: string | null): string {
  if (userName && userName.trim()) return userName
  return truncateText(userId, 14)
}

function UserCell({ userId, userName }: { userId: string; userName: string | null }) {
  return (
    <span className="bot-userdata-user" title={userId}>
      {userLabel(userId, userName)}
    </span>
  )
}

function pagerInfo(page: number, total: number): string {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  return `第 ${page} / ${totalPages} 页 · 共 ${total} 条`
}

/** 角色与记忆分区：两个卡片分别管理角色卡启停/删除与记忆删除。 */
export function BotUserDataPanel({ bot, refreshToken }: BotUserDataPanelProps) {
  const toast = useToast()
  const botId = bot?.id ?? ''

  const [roles, setRoles] = useState<BotRoleSummary[]>([])
  const [rolesTotal, setRolesTotal] = useState(0)
  const [rolesPage, setRolesPage] = useState(1)
  const [rolesLoading, setRolesLoading] = useState(true)
  const [rolesError, setRolesError] = useState<string | null>(null)
  const [rolesReloadKey, setRolesReloadKey] = useState(0)

  const [memories, setMemories] = useState<BotMemorySummary[]>([])
  const [memoriesTotal, setMemoriesTotal] = useState(0)
  const [memoriesPage, setMemoriesPage] = useState(1)
  const [memoriesLoading, setMemoriesLoading] = useState(true)
  const [memoriesError, setMemoriesError] = useState<string | null>(null)
  const [memoriesReloadKey, setMemoriesReloadKey] = useState(0)

  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null)
  const [confirming, setConfirming] = useState(false)

  const loadRoles = useCallback(async (): Promise<void> => {
    if (!botId) {
      setRoles([])
      setRolesTotal(0)
      setRolesLoading(false)
      return
    }
    setRolesLoading(true)
    setRolesError(null)
    try {
      const result = await api.bots.roles.list(botId, {
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
  }, [botId, rolesPage])

  const loadMemories = useCallback(async (): Promise<void> => {
    if (!botId) {
      setMemories([])
      setMemoriesTotal(0)
      setMemoriesLoading(false)
      return
    }
    setMemoriesLoading(true)
    setMemoriesError(null)
    try {
      const result = await api.bots.memories.list(botId, {
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
  }, [botId, memoriesPage])

  useEffect(() => {
    void loadRoles()
  }, [loadRoles, refreshToken, rolesReloadKey])

  useEffect(() => {
    void loadMemories()
  }, [loadMemories, refreshToken, memoriesReloadKey])

  const handleToggleRole = async (role: BotRoleSummary): Promise<void> => {
    if (!bot || busyKey) return
    setBusyKey(`role:${role.userId}`)
    try {
      await api.bots.roles.setEnabled(bot.id, role.userId, !role.enabled)
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

  const handleConfirmDelete = async (): Promise<void> => {
    if (!bot || !confirmTarget) return
    setConfirming(true)
    try {
      if (confirmTarget.kind === 'role') {
        await api.bots.roles.remove(bot.id, confirmTarget.userId)
        toast.success(`已删除「${confirmTarget.label}」的角色卡`)
        await loadRoles()
      } else {
        await api.bots.memories.remove(bot.id, confirmTarget.userId)
        toast.success(`已清除「${confirmTarget.label}」的长期记忆`)
        await loadMemories()
      }
      setConfirmTarget(null)
    } catch (deleteError) {
      toast.error(
        toErrorMessage(
          deleteError,
          confirmTarget.kind === 'role' ? '删除角色卡失败，请重试' : '清除长期记忆失败，请重试',
        ),
      )
    } finally {
      setConfirming(false)
    }
  }

  const roleColumns: Column<BotRoleSummary>[] = [
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
        <span className="bot-userdata-name" title={role.name}>
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
          <div className="bot-userdata-actions">
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

  const memoryColumns: Column<BotMemorySummary>[] = [
    {
      key: 'user',
      header: '用户',
      primary: true,
      render: (memory) => <UserCell userId={memory.userId} userName={memory.userName} />,
    },
    {
      key: 'length',
      header: '记忆长度',
      render: (memory) => <span className="bot-userdata-length">摘要 {memory.summaryLength} 字</span>,
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
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            icon={<Trash2 size={14} aria-hidden="true" />}
            aria-label={`删除长期记忆 ${label}`}
            disabled={busyKey !== null}
            onClick={() => setConfirmTarget({ kind: 'memory', userId: memory.userId, label })}
          >
            删除
          </Button>
        )
      },
    },
  ]

  if (!bot) {
    return (
      <Card title="角色与记忆">
        <EmptyState
          icon={<Brain size={24} />}
          title="请选择一个 Bot"
          description="在顶部选择 Bot 后，可查看该 Bot 的用户角色卡与长期记忆元数据。"
        />
      </Card>
    )
  }

  const confirmIsRole = confirmTarget?.kind === 'role'

  return (
    <div className="bot-userdata">
      <div className="notice notice-muted bot-privacy-note" role="note">
        <ShieldCheck size={16} aria-hidden="true" />
        仅显示元数据，正文不通过 Web 暴露：角色设定与记忆摘要只在服务端对话中使用，本页不提供查看或编辑入口。
      </div>

      <Card
        title="角色卡"
        description="私聊用户通过 /role 设置的个人角色；一只 Bot 内每位用户一张，停用后回退到内置角色。"
        actions={<Badge tone="muted"><IdCard size={13} aria-hidden="true" /> {rolesTotal} 位</Badge>}
        loading={rolesLoading}
        error={rolesError}
        onRetry={() => setRolesReloadKey((value) => value + 1)}
      >
        <Table
          className="bots-table-scroll"
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
          <div className="pager bot-userdata-pager">
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
        description="AI 对话滚动摘要的元数据；用户可通过 /forget confirm 清除，管理员也可在此删除。"
        actions={<Badge tone="muted"><Brain size={13} aria-hidden="true" /> {memoriesTotal} 位</Badge>}
        loading={memoriesLoading}
        error={memoriesError}
        onRetry={() => setMemoriesReloadKey((value) => value + 1)}
      >
        <Table
          className="bots-table-scroll"
          columns={memoryColumns}
          rows={memories}
          rowKey={(memory) => memory.userId}
          caption="长期记忆元数据"
          empty={
            <EmptyState
              compact
              icon={<Brain size={22} />}
              title="暂无长期记忆"
              description="用户与 AI 对话产生摘要后，这里会显示长度与更新时间。"
            />
          }
        />
        {memoriesTotal > PAGE_SIZE ? (
          <div className="pager bot-userdata-pager">
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
      </Card>

      <ConfirmDialog
        open={confirmTarget !== null}
        title={confirmIsRole ? '删除角色卡' : '清除长期记忆'}
        message={confirmTarget ? `确定删除用户「${confirmTarget.label}」的${confirmIsRole ? '角色卡' : '长期记忆摘要'}？` : ''}
        details={
          confirmIsRole
            ? '删除后该用户将回退到内置角色，且其私聊会话会被清理；此操作不可撤销。'
            : '删除后该用户与本 Bot 的长期记忆摘要会被清除，已有对话会话保留；此操作不可撤销。'
        }
        confirmText={confirmIsRole ? '删除角色卡' : '清除记忆'}
        loading={confirming}
        onConfirm={() => void handleConfirmDelete()}
        onClose={() => {
          if (!confirming) setConfirmTarget(null)
        }}
      />
    </div>
  )
}
