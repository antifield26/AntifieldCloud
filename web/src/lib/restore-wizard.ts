// 恢复向导的纯状态机：选择归档/文件 → 校验摘要 → TOTP + typed confirmation → 执行/结果。
// 组件只负责 API 调用与渲染；本模块不联网、不读取 DOM，便于单元测试。
// 安全约束：执行中锁定状态；TOTP 不落入 localStorage/URL，执行结束后清空。
// 后端契约（task-7）：restore-plan 只需单个归档，服务端按 manifest 解析 full+inc 链。

import type {
  BackupArchive,
  BackupArchiveEntry,
  BackupManifest,
  RestoreExecuteResult,
  RestorePlan,
  RestorePlanResult,
  RestoreResult,
} from '../api/types'
import { isArchiveRestorable, manifestSummary } from './backups'

export type RestoreStep = 'select' | 'verify' | 'confirm' | 'executing' | 'done'

export interface RestoreVerification {
  ok: boolean
  archiveName: string
  summary: string
  entryCount: number
}

export interface RestoreWizardState {
  step: RestoreStep
  archiveName: string | null
  entries: BackupArchiveEntry[]
  selectedPaths: string[]
  verification: RestoreVerification | null
  totpCode: string
  confirmationText: string
  plan: RestorePlan | null
  result: RestoreResult | null
  error: string | null
  busy: boolean
}

export type RestoreWizardAction =
  | { type: 'select-archive'; name: string }
  | { type: 'set-entries'; entries: BackupArchiveEntry[] }
  | { type: 'toggle-path'; path: string }
  | { type: 'clear-paths' }
  | { type: 'go-verify' }
  | { type: 'go-confirm' }
  | { type: 'verify-start' }
  | { type: 'verify-success'; verification: RestoreVerification }
  | { type: 'verify-failure'; error: string }
  | { type: 'set-totp'; value: string }
  | { type: 'set-confirmation'; value: string }
  | { type: 'execute-start' }
  | { type: 'execute-success'; plan: RestorePlan; result: RestoreResult }
  | { type: 'execute-failure'; error: string }
  | { type: 'set-error'; error: string | null }
  | { type: 'back-to-select' }
  | { type: 'reset' }

const CONFIRMATION_PHRASE = 'RESTORE'
const TOTP_PATTERN = /^\d{6}$/

export function createRestoreState(): RestoreWizardState {
  return {
    step: 'select',
    archiveName: null,
    entries: [],
    selectedPaths: [],
    verification: null,
    totpCode: '',
    confirmationText: '',
    plan: null,
    result: null,
    error: null,
    busy: false,
  }
}

/** 校验执行恢复的完整条件：TOTP 与 typed confirmation。 */
export function validateRestoreConfirmation(state: RestoreWizardState): string | null {
  if (!state.archiveName) return '请先选择归档'
  if (!TOTP_PATTERN.test(state.totpCode.trim())) return '请输入 6 位 TOTP 验证码'
  if (state.confirmationText.trim().toUpperCase() !== CONFIRMATION_PHRASE) {
    return `请输入 ${CONFIRMATION_PHRASE} 以确认恢复`
  }
  return null
}

/** 选中的文件/目录路径；空数组表示恢复该归档时点全部活动文件。 */
export function selectedRestorePaths(state: RestoreWizardState): string[] {
  return [...new Set(state.selectedPaths)].sort()
}

export function buildRestoreVerification(
  archive: BackupArchive,
  manifest: BackupManifest | null,
  entryCount: number,
): RestoreVerification {
  return {
    ok: true,
    archiveName: archive.name,
    summary: manifestSummary(manifest),
    entryCount,
  }
}

/** 组件调用 restore-plan 时的入参（TOTP 来自确认步骤）。 */
export function buildRestorePlanInput(
  state: RestoreWizardState,
): { archive: string; paths?: string[]; totpCode: string } | null {
  if (!state.archiveName) return null
  const paths = selectedRestorePaths(state)
  return {
    archive: state.archiveName,
    ...(paths.length > 0 ? { paths } : {}),
    totpCode: state.totpCode.trim(),
  }
}

export function restorePlanResult(result: RestorePlanResult): RestorePlan {
  return result.plan
}

export function restoreExecuteResult(result: RestoreExecuteResult): { plan: RestorePlan; result: RestoreResult } {
  return { plan: result.plan, result: result.result }
}

/**
 * 状态机 reducer。
 * busy（校验/执行中）时拒绝除结果类动作外的输入，避免重复提交或篡改确认内容。
 */
export function restoreWizardReducer(
  state: RestoreWizardState,
  action: RestoreWizardAction,
): RestoreWizardState {
  if (state.busy) {
    if (action.type === 'verify-success') {
      return { ...state, step: 'confirm', busy: false, verification: action.verification, error: null }
    }
    if (action.type === 'verify-failure') {
      return { ...state, step: 'verify', busy: false, error: action.error }
    }
    if (action.type === 'execute-success') {
      return {
        ...state,
        step: 'done',
        busy: false,
        plan: action.plan,
        result: action.result,
        totpCode: '',
        error: null,
      }
    }
    if (action.type === 'execute-failure') {
      return { ...state, step: 'confirm', busy: false, error: action.error, totpCode: '' }
    }
    return state
  }

  switch (action.type) {
    case 'select-archive':
      if (state.step !== 'select') return state
      return {
        ...state,
        archiveName: action.name,
        entries: [],
        selectedPaths: [],
        verification: null,
        error: null,
      }
    case 'set-entries':
      if (state.step !== 'select') return state
      return { ...state, entries: action.entries }
    case 'toggle-path': {
      if (state.step !== 'select') return state
      const selected = state.selectedPaths.includes(action.path)
        ? state.selectedPaths.filter((path) => path !== action.path)
        : [...state.selectedPaths, action.path]
      return { ...state, selectedPaths: selected }
    }
    case 'clear-paths':
      if (state.step !== 'select') return state
      return { ...state, selectedPaths: [] }
    case 'go-verify': {
      if (state.step !== 'select') return state
      if (!state.archiveName) return { ...state, error: '请先选择归档' }
      return { ...state, step: 'verify', verification: null, error: null }
    }
    case 'go-confirm': {
      if (state.step !== 'verify' || !state.verification?.ok) return state
      return { ...state, step: 'confirm', error: null }
    }
    case 'verify-start':
      if (state.step !== 'verify') return state
      return { ...state, busy: true, error: null }
    case 'set-totp':
      if (state.step !== 'confirm') return state
      return { ...state, totpCode: action.value.replace(/\D/g, '').slice(0, 6), error: null }
    case 'set-confirmation':
      if (state.step !== 'confirm') return state
      return { ...state, confirmationText: action.value, error: null }
    case 'execute-start': {
      if (state.step !== 'verify' && state.step !== 'confirm') return state
      const error = validateRestoreConfirmation(state)
      if (error) return { ...state, error }
      return { ...state, step: 'executing', busy: true, error: null }
    }
    case 'set-error':
      return { ...state, error: action.error }
    case 'back-to-select':
      return {
        ...state,
        step: 'select',
        verification: null,
        plan: null,
        result: null,
        totpCode: '',
        confirmationText: '',
        error: null,
        busy: false,
      }
    case 'reset':
      return createRestoreState()
    default:
      return state
  }
}

/** 选择步骤可进入校验的条件。 */
export function validateSelectStep(state: RestoreWizardState, archive: BackupArchive | null): string | null {
  if (!state.archiveName) return '请先选择归档'
  if (!archive) return '所选归档不存在，请刷新列表'
  if (!isArchiveRestorable(archive)) {
    return archive.verifiedAt ? '该归档文件缺失，无法恢复' : '请先校验归档通过后再恢复'
  }
  return null
}
