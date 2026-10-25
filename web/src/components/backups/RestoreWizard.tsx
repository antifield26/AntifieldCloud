// 恢复向导：选择归档/文件 → 校验摘要 → TOTP + typed confirmation → 执行/结果。
// 危险操作：默认焦点取消、执行中锁定 Esc/遮罩；整库恢复不在 Web 端开放。
// 后端契约：restore-plan 单归档由服务端解析 full+inc 链；执行返回新目录 targetFolderId。

import { useCallback, useEffect, useId, useReducer, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, FolderOpen, RefreshCw, ShieldAlert } from 'lucide-react'
import { api, toErrorMessage } from '../../api/client'
import type { BackupArchive, BackupArchiveEntry, RestorePlan, RestoreResult } from '../../api/types'
import { useAppMeta } from '../../meta/MetaContext'
import {
  buildRestorePlanInput,
  buildRestoreVerification,
  collectSkippedMissing,
  createRestoreState,
  restoreWizardReducer,
  summarizeSkippedMissing,
  validateRestoreConfirmation,
  validateSelectStep,
} from '../../lib/restore-wizard'
import {
  archiveStatusLabel,
  backupModeLabel,
  isArchiveEncrypted,
  isArchiveWebRestorable,
  isArchiveWebVerifiable,
} from '../../lib/backups'
import {
  clearStoredRestorePlan,
  loadStoredRestorePlan,
  saveStoredRestorePlan,
  type StoredRestorePlan,
} from '../../lib/restore-plan-store'
import { formatBytes, formatDateTime } from '../../lib/format'
import { Modal } from '../Modal'
import { Button } from '../Button'
import { Badge } from '../Badge'
import { FormField } from '../FormField'
import { InlineError } from '../InlineError'
import { LoadingBlock } from '../Loading'
import { ProgressBar } from '../ProgressBar'
import { cx } from '../../lib/classnames'

export interface RestoreWizardProps {
  open: boolean
  archive: BackupArchive | null
  onClose: () => void
  onCompleted?: () => void
}

const STEP_LABELS = ['选择范围', '校验摘要', '确认执行'] as const

/** 执行中断/超时后的统一提示：不要直接重试（服务端可能仍在执行，重试会得到 409/410）。 */
const INTERRUPTED_EXECUTE_MESSAGE =
  '执行请求超时或中断，但服务端可能仍在恢复；请勿重复执行。本页会尝试查询计划状态，也可稍后刷新设置页查看最近恢复计划。'

function stepIndex(step: string): number {
  if (step === 'select') return 0
  if (step === 'verify') return 1
  if (step === 'confirm' || step === 'executing') return 2
  return 3
}

/** 不依赖 client mock 的 ApiError 形态读取错误码（测试常部分 mock client）。 */
function errorCodeOf(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function storedStatusLabel(status: string): string {
  switch (status) {
    case 'planned':
      return '已创建，等待执行'
    case 'executing':
      return '执行中'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'expired':
      return '已过期'
    default:
      return '状态未知（可能仍在执行）'
  }
}

export function RestoreWizard({ open, archive, onClose, onCompleted }: RestoreWizardProps) {
  const { meta } = useAppMeta()
  const [state, dispatch] = useReducer(restoreWizardReducer, undefined, createRestoreState)
  const [entriesLoading, setEntriesLoading] = useState(false)
  const [entriesError, setEntriesError] = useState<string | null>(null)
  const [entriesTruncated, setEntriesTruncated] = useState(false)
  const [completedNotified, setCompletedNotified] = useState(false)
  const [storedPlan, setStoredPlan] = useState<StoredRestorePlan | null>(null)
  const [storedPlanError, setStoredPlanError] = useState<string | null>(null)
  const [storedPlanLoading, setStoredPlanLoading] = useState(false)
  const triedVerifyRef = useRef(false)
  const planIdRef = useRef<string | null>(null)
  const pollTimerRef = useRef<number | undefined>(undefined)
  const totpId = useId()
  const confirmId = useId()

  const stopStoredPlanPolling = useCallback((): void => {
    if (pollTimerRef.current !== undefined) {
      window.clearTimeout(pollTimerRef.current)
      pollTimerRef.current = undefined
    }
  }, [])

  /**
   * 查询已持久化计划的状态；planned/executing/unknown 时继续轮询（最多 20 分钟）。
   * 只更新“最近恢复计划”提示，不修改向导步骤，避免与用户当前操作冲突。
   */
  const refreshStoredPlan = useCallback(
    async (planId: string, attempt = 0): Promise<void> => {
      if (!open) return
      setStoredPlanLoading(true)
      try {
        const result = await api.backups.getRestore(planId)
        const plan: RestorePlan = result.plan
        setStoredPlan((previous) => {
          const next: StoredRestorePlan = {
            planId,
            archive: previous?.archive ?? plan.archive ?? archive?.name ?? '',
            status: plan.status,
            savedAt: previous?.savedAt ?? new Date().toISOString(),
            targetName: plan.targetName,
            completedAt: plan.completedAt ?? null,
            error: plan.error ?? null,
            steps: typeof plan.fileCount === 'number' ? plan.fileCount : previous?.steps ?? null,
            bytes: typeof plan.totalBytes === 'number' ? plan.totalBytes : previous?.bytes ?? null,
          }
          saveStoredRestorePlan(next)
          return next
        })
        setStoredPlanError(null)
        stopStoredPlanPolling()
        if ((plan.status === 'planned' || plan.status === 'executing') && attempt < 400) {
          pollTimerRef.current = window.setTimeout(() => {
            void refreshStoredPlan(planId, attempt + 1)
          }, 3000)
        }
      } catch (loadError) {
        if (errorCodeOf(loadError) === null) setStoredPlanError(toErrorMessage(loadError, '查询恢复计划失败'))
        // 查询失败不无限重试；保留本地最后状态，用户可手动刷新。
      } finally {
        setStoredPlanLoading(false)
      }
    },
    [archive?.name, open, stopStoredPlanPolling],
  )

  const checkStoredPlan = useCallback((): void => {
    const stored = loadStoredRestorePlan()
    setStoredPlan(stored)
    setStoredPlanError(null)
    if (stored) void refreshStoredPlan(stored.planId)
  }, [refreshStoredPlan])

  const dismissStoredPlan = (): void => {
    stopStoredPlanPolling()
    clearStoredRestorePlan()
    setStoredPlan(null)
    setStoredPlanError(null)
  }

  const resetWizard = (): void => {
    dispatch({ type: 'reset' })
    if (archive) dispatch({ type: 'select-archive', name: archive.name })
    setEntriesError(null)
    setEntriesTruncated(false)
    setCompletedNotified(false)
    triedVerifyRef.current = false
    planIdRef.current = null
  }

  useEffect(() => {
    if (!open) {
      stopStoredPlanPolling()
      return
    }
    resetWizard()
    checkStoredPlan()
  }, [open, archive?.name])

  useEffect(() => {
    return () => stopStoredPlanPolling()
  }, [stopStoredPlanPolling])

  // 只读归档内容（最多 500 条），用于文件级选择；加密归档 Web 不可读，不请求 entries。
  useEffect(() => {
    if (!open || !archive) return
    if (isArchiveEncrypted(archive)) {
      setEntriesLoading(false)
      return
    }
    let active = true
    setEntriesLoading(true)
    setEntriesError(null)
    setEntriesTruncated(false)
    api.backups
      .entries(archive.name)
      .then((result) => {
        if (!active) return
        dispatch({ type: 'set-entries', entries: result.items })
        setEntriesTruncated(result.truncated === true)
      })
      .catch((loadError) => {
        if (active) setEntriesError(toErrorMessage(loadError, '读取归档内容失败'))
      })
      .finally(() => {
        if (active) setEntriesLoading(false)
      })
    return () => {
      active = false
    }
  }, [open, archive?.name])

  const runVerify = async (): Promise<void> => {
    if (!archive) return
    triedVerifyRef.current = true
    dispatch({ type: 'verify-start' })
    try {
      const result = await api.backups.verify(archive.name)
      dispatch({
        type: 'verify-success',
        verification: buildRestoreVerification(result.archive, result.archive.manifest, state.entries.length),
      })
    } catch (verifyError) {
      const timedOut = errorCodeOf(verifyError) === 'timeout' || errorCodeOf(verifyError) === 'network_error'
      dispatch({
        type: 'verify-failure',
        error: timedOut
          ? '校验请求超时/中断：服务端可能仍在校验，请勿重复触发；稍后刷新归档列表查看校验状态。'
          : toErrorMessage(verifyError, '校验归档失败，请重试'),
      })
    }
  }

  // 进入校验步骤后自动执行一次 SHA-256/tar 校验；失败后需手动重试
  useEffect(() => {
    if (!open || state.step !== 'verify' || state.busy || state.verification) return
    if (triedVerifyRef.current) return
    void runVerify()
  }, [open, state.step, state.busy, state.verification])

  // 进入危险确认步骤时默认聚焦“返回修改”，避免误触执行
  useEffect(() => {
    if (!open || state.step !== 'confirm') return
    const timer = window.setTimeout(() => {
      document.querySelector<HTMLElement>('.modal-panel button[data-action="cancel"]')?.focus()
    }, 30)
    return () => window.clearTimeout(timer)
  }, [open, state.step])

  useEffect(() => {
    if (state.step !== 'done' || completedNotified) return
    setCompletedNotified(true)
    onCompleted?.()
  }, [state.step, completedNotified, onCompleted])

  const handleClose = (): void => {
    if (state.busy) return
    onClose()
  }

  const handleGoVerify = (): void => {
    const selectionError = validateSelectStep(state, archive)
    if (selectionError) {
      dispatch({ type: 'set-error', error: selectionError })
      return
    }
    triedVerifyRef.current = false
    dispatch({ type: 'go-verify' })
  }

  const retryVerify = (): void => {
    triedVerifyRef.current = false
    void runVerify()
  }

  const handleExecute = async (): Promise<void> => {
    if (!archive) return
    const validation = validateRestoreConfirmation(state)
    dispatch({ type: 'execute-start' })
    if (validation) return
    const input = buildRestorePlanInput(state)
    if (!input) return
    let planId: string | null = null
    try {
      const planResult = await api.backups.restorePlan(input)
      planId = planResult.plan.id
      planIdRef.current = planId
      const planned: StoredRestorePlan = {
        planId,
        archive: archive.name,
        status: planResult.plan.status,
        savedAt: new Date().toISOString(),
        targetName: planResult.plan.targetName,
        completedAt: planResult.plan.completedAt ?? null,
        error: planResult.plan.error ?? null,
        steps: planResult.plan.fileCount,
        bytes: planResult.plan.totalBytes,
      }
      saveStoredRestorePlan(planned)
      setStoredPlan(planned)
      const executed = await api.backups.executeRestore(planId, input.totpCode)
      const completed: StoredRestorePlan = {
        ...planned,
        status: executed.plan.status,
        completedAt: executed.plan.completedAt ?? new Date().toISOString(),
        error: executed.plan.error ?? null,
      }
      saveStoredRestorePlan(completed)
      setStoredPlan(completed)
      dispatch({
        type: 'execute-success',
        plan: executed.plan,
        result: executed.result,
      })
    } catch (executeError) {
      if (planId) {
        // 计划已创建：服务端可能仍在执行（超时/断网）。记录 planId 并询问状态，绝不提示直接重试。
        const code = errorCodeOf(executeError)
        const interrupted = code === 'timeout' || code === 'network_error'
        const updated: StoredRestorePlan = {
          planId,
          archive: archive.name,
          status: interrupted ? 'unknown' : 'planned',
          savedAt: new Date().toISOString(),
        }
        saveStoredRestorePlan(updated)
        setStoredPlan(updated)
        if (interrupted) {
          dispatch({ type: 'execute-failure', error: INTERRUPTED_EXECUTE_MESSAGE })
          void refreshStoredPlan(planId)
        } else {
          dispatch({
            type: 'execute-failure',
            error: `${toErrorMessage(executeError, '恢复失败，请重试')}（恢复计划 ${planId} 已保存，可在本页查询状态）`,
          })
          void refreshStoredPlan(planId)
        }
      } else {
        dispatch({ type: 'execute-failure', error: toErrorMessage(executeError, '恢复失败，请重试') })
      }
    }
  }

  const selectedPathSet = new Set(state.selectedPaths)
  const isSelected = (entry: BackupArchiveEntry): boolean => selectedPathSet.has(entry.path)
  const selectedCount = state.selectedPaths.length
  const encryptedArchive = archive ? isArchiveEncrypted(archive) : false
  const webVerifiable = archive ? !encryptedArchive && isArchiveWebVerifiable(archive) : true
  const webRestorable = archive ? !encryptedArchive && isArchiveWebRestorable(archive) : true
  const blocked = encryptedArchive || !webVerifiable || !webRestorable

  const storedPlanBanner =
    storedPlan && state.step !== 'done' ? (
      <div className="notice notice-info" role="status">
        <div>
          <strong>最近恢复计划</strong>
          <p>
            状态：{storedStatusLabel(storedPlan.status)} · 计划 {storedPlan.planId.slice(0, 8)}… · 保存于{' '}
            {formatDateTime(storedPlan.savedAt)}
            {storedPlan.targetName ? ` · 目标 ${storedPlan.targetName}` : ''}
            {storedPlan.steps !== null && storedPlan.steps !== undefined ? ` · ${storedPlan.steps} 个文件` : ''}
          </p>
          {storedPlan.status === 'planned' ? (
            <p className="field-hint">计划 30 分钟后过期；如需继续执行请重新走本向导（会创建新计划）。</p>
          ) : null}
          {storedPlan.error ? <p className="field-hint">{storedPlan.error}</p> : null}
          {storedPlanError ? <p className="field-hint">{storedPlanError}</p> : null}
          <div className="form-actions">
            <Button
              size="sm"
              variant="secondary"
              loading={storedPlanLoading}
              onClick={() => {
                if (storedPlan) void refreshStoredPlan(storedPlan.planId)
              }}
            >
              刷新状态
            </Button>
            <Button size="sm" variant="ghost" onClick={dismissStoredPlan}>
              清除记录
            </Button>
          </div>
        </div>
      </div>
    ) : null

  const renderEntries = () => {
    if (entriesLoading) return <LoadingBlock text="正在读取归档内容…" />
    if (entriesError) return <InlineError message={entriesError} />
    if (state.entries.length === 0) {
      return <p className="field-hint">该归档没有可列出的文件条目；默认恢复该时点全部活动文件。</p>
    }
    return (
      <>
        <div className="restore-entry-toolbar">
          <span className="field-hint">
            共 {state.entries.length} 条（最多展示 500 条），留空表示全部活动文件；单次恢复上限 {meta.backupRestoreMaxEntries} 个文件。
          </span>
          <div>
            <Button variant="ghost" size="sm" onClick={() => dispatch({ type: 'clear-paths' })}>
              清除选择
            </Button>
          </div>
        </div>
        {entriesTruncated ? (
          <div className="notice notice-warning" role="alert">
            归档条目超过 500 条，列表不完整；未列出的文件无法逐项选择，留空表示恢复全部活动文件。
          </div>
        ) : null}
        <ul className="restore-entry-list" aria-label="归档内文件">
          {state.entries.map((entry) => (
            <li key={entry.path}>
              <label className={cx('restore-entry', isSelected(entry) && 'restore-entry-selected')}>
                <input
                  type="checkbox"
                  checked={isSelected(entry)}
                  onChange={() => dispatch({ type: 'toggle-path', path: entry.path })}
                />
                <span className={`restore-entry-kind restore-entry-${entry.kind}`} aria-hidden="true">
                  {entry.kind === 'dir' ? 'DIR' : 'FILE'}
                </span>
                <span className="restore-entry-path mono" title={entry.path}>{entry.path}</span>
                <span className="restore-entry-size">{entry.kind === 'dir' ? '—' : formatBytes(entry.size)}</span>
              </label>
            </li>
          ))}
        </ul>
      </>
    )
  }

  const footer = (() => {
    if (state.step === 'select') {
      return (
        <>
          <button type="button" className="btn btn-ghost btn-md" onClick={handleClose}>取消</button>
          <Button
            variant="primary"
            onClick={handleGoVerify}
            disabled={blocked}
            title={encryptedArchive ? '加密归档（.tar.gz.age）只能在 PC 上用 age 私钥解密后恢复' : undefined}
          >
            校验并继续
          </Button>
        </>
      )
    }
    if (state.step === 'verify') {
      return (
        <>
          <Button variant="ghost" onClick={() => dispatch({ type: 'back-to-select' })} disabled={state.busy}>
            上一步
          </Button>
          {state.error ? (
            <Button variant="secondary" icon={<RefreshCw size={16} aria-hidden="true" />} onClick={retryVerify} disabled={state.busy}>
              重试校验
            </Button>
          ) : null}
          <Button
            variant="primary"
            onClick={() => dispatch({ type: 'go-confirm' })}
            disabled={!state.verification?.ok || state.busy}
          >
            继续
          </Button>
        </>
      )
    }
    if (state.step === 'confirm') {
      return (
        <>
          <button
            type="button"
            className="btn btn-ghost btn-md"
            data-action="cancel"
            onClick={() => dispatch({ type: 'back-to-select' })}
            disabled={state.busy}
          >
            返回修改
          </button>
          <Button variant="danger" loading={state.busy} onClick={() => void handleExecute()}>
            执行恢复
          </Button>
        </>
      )
    }
    if (state.step === 'executing') {
      return (
        <>
          <span className="restore-executing-text" role="status">正在准备并执行恢复，切勿关闭页面…</span>
          <Button variant="danger" loading disabled>执行中</Button>
        </>
      )
    }
    return (
      <>
        {state.result?.targetFolderId ? (
          <Link className="btn btn-secondary btn-md" to={`/files?parent=${encodeURIComponent(state.result.targetFolderId)}`}>
            <FolderOpen size={16} aria-hidden="true" />
            <span className="btn-label">打开恢复目录</span>
          </Link>
        ) : null}
        <Button variant="primary" onClick={handleClose}>关闭</Button>
      </>
    )
  })()

  const result: RestoreResult | null = state.result
  const skippedMissing = collectSkippedMissing(state.plan, result)
  const skippedSummary = summarizeSkippedMissing(skippedMissing)
  const activeStep = stepIndex(state.step)

  return (
    <Modal
      open={open}
      title="恢复备份"
      description={archive ? `归档：${archive.name}（${backupModeLabel(archive.mode)} · ${formatDateTime(archive.createdAt)}）` : undefined}
      size="xl"
      onClose={handleClose}
      busy={state.busy}
      initialFocus={state.step === 'confirm' ? 'button[data-action="cancel"]' : undefined}
      footer={footer}
    >
      <ol className="restore-steps" aria-label="恢复步骤">
        {STEP_LABELS.map((label, index) => (
          <li
            key={label}
            className={cx(
              'restore-step',
              index === activeStep && 'restore-step-active',
              index < activeStep && 'restore-step-done',
            )}
            aria-current={index === activeStep ? 'step' : undefined}
          >
            <span className="restore-step-index">{index < activeStep ? <Check size={12} aria-hidden="true" /> : index + 1}</span>
            <span>{label}</span>
          </li>
        ))}
      </ol>

      {!meta.backupRestoreEnabled ? (
        <div className="notice notice-warning">
          服务端尚未启用恢复向导（/api/version backupRestoreEnabled=false）；可先导入/校验归档。
        </div>
      ) : null}

      <div className="restore-body" aria-live="polite">
        {storedPlanBanner}
        {encryptedArchive || !webVerifiable || !webRestorable ? (
          <div className="notice notice-warning" role="alert">
            <ShieldAlert size={16} aria-hidden="true" />
            {encryptedArchive
              ? '该归档已加密（.tar.gz.age）：Web 不持有私钥，不能校验或恢复；请在 PC 上用 age 私钥解密后按 docs/BACKUP.md 处理。'
              : !webVerifiable
                ? '服务端标记该归档不可在 Web 校验，请按服务端提示处理。'
                : '服务端标记该归档不可在 Web 恢复，请按服务端提示处理。'}
          </div>
        ) : null}
        {state.step === 'select' ? (
          <>
            {archive ? (
              <div className="restore-archive-summary">
                <div>
                  <strong>{archive.name}</strong>
                  <p className="field-hint">
                    {backupModeLabel(archive.mode)} · {formatDateTime(archive.createdAt)} · {formatBytes(archive.sizeBytes)} · {archiveStatusLabel(archive)}
                  </p>
                </div>
                <Badge tone={archive.verifiedAt ? 'success' : 'warning'}>
                  {archive.verifiedAt ? '已校验' : '待校验'}
                </Badge>
              </div>
            ) : null}
            <div className="notice notice-info">
              恢复只会在文件区创建<b>新目录</b>，不会覆盖现有文件；服务端自动解析该归档的 full+inc 链。
              {archive?.verifiedAt ? '' : ' 继续后会自动执行 SHA-256 与 tar 安全校验。'}
            </div>
            {renderEntries()}
            {state.error ? <InlineError message={state.error} /> : null}
          </>
        ) : null}

        {state.step === 'verify' ? (
          <>
            {state.busy ? (
              <LoadingBlock text="正在校验归档 SHA-256 与 tar 清单…" />
            ) : state.error ? (
              <InlineError message={state.error} />
            ) : state.verification ? (
              <dl className="settings-list">
                <div className="settings-list-row">
                  <dt>归档</dt>
                  <dd className="mono">{state.verification.archiveName}</dd>
                </div>
                <div className="settings-list-row">
                  <dt>清单摘要</dt>
                  <dd>{state.verification.summary}</dd>
                </div>
                <div className="settings-list-row">
                  <dt>恢复范围</dt>
                  <dd>{selectedCount > 0 ? `选定 ${selectedCount} 项` : '该归档时点全部活动文件'}</dd>
                </div>
                <div className="settings-list-row">
                  <dt>目标目录</dt>
                  <dd>执行时由服务端新建（restore-*）</dd>
                </div>
              </dl>
            ) : (
              <ProgressBar value={45} tone="accent" ariaLabel="正在校验归档" />
            )}
          </>
        ) : null}

        {(state.step === 'confirm' || state.step === 'executing') ? (
          <>
            <div className="notice notice-danger">
              <ShieldAlert size={16} aria-hidden="true" />
              恢复会在文件区新建目录并写入文件，属于不可撤销的运维操作；请确认归档与范围无误，并确保已有可用备份。
            </div>
            <dl className="settings-list">
              <div className="settings-list-row">
                <dt>归档</dt>
                <dd className="mono">{archive?.name ?? '—'}</dd>
              </div>
              <div className="settings-list-row">
                <dt>恢复范围</dt>
                <dd>{selectedCount > 0 ? `选定 ${selectedCount} 项` : '该归档时点全部活动文件'}</dd>
              </div>
              <div className="settings-list-row">
                <dt>目标目录</dt>
                <dd>服务端自动生成新目录</dd>
              </div>
            </dl>
            <FormField label="TOTP 验证码" htmlFor={totpId} hint="危险操作需要二次验证；验证码不会保存。" required>
              <input
                id={totpId}
                className="input settings-totp-input"
                value={state.totpCode}
                onChange={(event) => dispatch({ type: 'set-totp', value: event.target.value })}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                disabled={state.busy}
              />
            </FormField>
            <FormField label="确认文本" htmlFor={confirmId} hint="输入 RESTORE 以确认执行恢复。" required>
              <input
                id={confirmId}
                className="input"
                value={state.confirmationText}
                onChange={(event) => dispatch({ type: 'set-confirmation', value: event.target.value })}
                autoComplete="off"
                spellCheck={false}
                placeholder="RESTORE"
                disabled={state.busy}
              />
            </FormField>
            {state.error ? <InlineError message={state.error} /> : null}
          </>
        ) : null}

        {state.step === 'done' && result ? (
          <div className="restore-result">
            {skippedSummary.message ? (
              <div className="notice notice-warning" role="alert">
                <ShieldAlert size={16} aria-hidden="true" />
                <div>
                  <strong>恢复未包含全部文件</strong>
                  <p>{skippedSummary.message}</p>
                  {skippedSummary.preview.length > 0 ? (
                    <p className="field-hint" title={skippedMissing.join('\n')}>
                      缺失文件 ID：{skippedSummary.preview.join('、')}
                      {skippedMissing.length > skippedSummary.preview.length
                        ? ` 等 ${skippedMissing.length} 个`
                        : ''}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
            <div className="notice notice-success">
              <Check size={16} aria-hidden="true" />
              恢复完成，已写入新目录「{result.targetName}」
              {skippedSummary.count > 0 ? `（${skippedSummary.count} 个缺失文件被跳过）` : ''}。
            </div>
            <dl className="settings-list">
              <div className="settings-list-row">
                <dt>目标目录</dt>
                <dd className="mono">{result.targetName}</dd>
              </div>
              <div className="settings-list-row">
                <dt>恢复文件</dt>
                <dd>{result.filesRestored} 个 · {formatBytes(result.bytesRestored)}</dd>
              </div>
              {skippedSummary.count > 0 ? (
                <div className="settings-list-row">
                  <dt>跳过缺失文件</dt>
                  <dd className="text-warning">{skippedSummary.count} 个（未写入新目录）</dd>
                </div>
              ) : null}
              <div className="settings-list-row">
                <dt>耗时</dt>
                <dd>{Math.max(1, Math.round(result.durationMs / 1000))} 秒</dd>
              </div>
              {state.plan?.archives?.length ? (
                <div className="settings-list-row">
                  <dt>归档链</dt>
                  <dd className="mono">{state.plan.archives.join(' → ')}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
