import {
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileMusic,
  FilePlay,
  FileSpreadsheet,
  FileText,
  FileType,
  Folder,
} from 'lucide-react'
import type { FileKind } from '../api/types'
import { cx } from '../lib/classnames'

const CODE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg',
  'sh', 'bash', 'ps1', 'bat', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'css',
  'scss', 'html', 'htm', 'xml', 'sql', 'lua', 'kt', 'swift', 'php',
])

const ARCHIVE_EXTENSIONS = new Set(['zip', 'gz', 'tgz', 'tar', '7z', 'rar', 'xz', 'bz2', 'zst'])
const SPREADSHEET_EXTENSIONS = new Set(['xls', 'xlsx', 'csv', 'ods', 'tsv'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico', 'svg', 'heic'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v'])
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])

export interface FileIconProps {
  name?: string
  /** 目录的 MIME 为 null */
  mime?: string | null
  kind?: FileKind
  size?: number
  className?: string
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index + 1).toLowerCase() : ''
}

/** 按目录/扩展名/MIME 选择文件图标与色调。 */
export function FileIcon({ name = '', mime, kind = 'file', size = 20, className }: FileIconProps) {
  const ext = extensionOf(name)
  const mimeType = mime ?? ''
  const base = cx('file-icon', className)

  if (kind === 'dir') {
    return <Folder size={size} className={cx(base, 'file-icon-dir')} aria-hidden="true" />
  }
  if (mimeType.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) {
    return <FileImage size={size} className={cx(base, 'file-icon-image')} aria-hidden="true" />
  }
  if (mimeType === 'application/pdf' || ext === 'pdf') {
    return <FileType size={size} className={cx(base, 'file-icon-pdf')} aria-hidden="true" />
  }
  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return <FileText size={size} className={cx(base, 'file-icon-markdown')} aria-hidden="true" />
  }
  if (mimeType.startsWith('audio/') || AUDIO_EXTENSIONS.has(ext)) {
    return <FileMusic size={size} className={cx(base, 'file-icon-audio')} aria-hidden="true" />
  }
  if (mimeType.startsWith('video/') || VIDEO_EXTENSIONS.has(ext)) {
    return <FilePlay size={size} className={cx(base, 'file-icon-video')} aria-hidden="true" />
  }
  if (SPREADSHEET_EXTENSIONS.has(ext)) {
    return <FileSpreadsheet size={size} className={cx(base, 'file-icon-sheet')} aria-hidden="true" />
  }
  if (ARCHIVE_EXTENSIONS.has(ext)) {
    return <FileArchive size={size} className={cx(base, 'file-icon-archive')} aria-hidden="true" />
  }
  if (CODE_EXTENSIONS.has(ext) || mimeType.startsWith('text/x-')) {
    return <FileCode size={size} className={cx(base, 'file-icon-code')} aria-hidden="true" />
  }
  if (mimeType.startsWith('text/') || ext === 'txt' || ext === 'log') {
    return <FileText size={size} className={cx(base, 'file-icon-text')} aria-hidden="true" />
  }
  return <File size={size} className={base} aria-hidden="true" />
}
