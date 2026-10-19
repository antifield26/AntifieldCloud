/** 文件名清洗、MIME 推断与预览分类。预览安全边界集中在这里。 */
import { extname } from 'node:path'

export type PreviewKind = 'image' | 'pdf' | 'text' | 'markdown' | 'none'

const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
}

const TEXT_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/plain',
  '.ini': 'text/plain',
  '.cfg': 'text/plain',
  '.conf': 'text/plain',
  '.env': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.xml': 'application/xml',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.js': 'text/plain',
  '.jsx': 'text/plain',
  '.mjs': 'text/plain',
  '.cjs': 'text/plain',
  '.css': 'text/css',
  '.scss': 'text/plain',
  '.less': 'text/plain',
  '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.ps1': 'text/plain',
  '.py': 'text/plain',
  '.rs': 'text/plain',
  '.go': 'text/plain',
  '.java': 'text/plain',
  '.kt': 'text/plain',
  '.c': 'text/plain',
  '.h': 'text/plain',
  '.cpp': 'text/plain',
  '.hpp': 'text/plain',
  '.sql': 'text/plain',
  '.graphql': 'text/plain',
  '.tf': 'text/plain',
  '.diff': 'text/plain',
  '.patch': 'text/plain',
  '.gitignore': 'text/plain',
  '.editorconfig': 'text/plain',
  '.dockerignore': 'text/plain',
}

const NON_EXTENSION_NAMES: Record<string, string> = {
  dockerfile: 'text/plain',
  makefile: 'text/plain',
  license: 'text/plain',
  readme: 'text/plain',
  '.gitignore': 'text/plain',
}

const DOWNLOAD_ONLY = new Set(['.svg', '.html', '.htm', '.xhtml', '.jsx', '.vue', '.wasm'])

export function detectMime(name: string): string {
  const lower = name.toLowerCase()
  const ext = extname(lower)
  if (IMAGE_TYPES[ext]) return IMAGE_TYPES[ext]
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (TEXT_TYPES[ext]) return TEXT_TYPES[ext]
  if (NON_EXTENSION_NAMES[lower]) return NON_EXTENSION_NAMES[lower]
  return 'application/octet-stream'
}

export function isDownloadOnly(name: string): boolean {
  return DOWNLOAD_ONLY.has(extname(name.toLowerCase()))
}

export function previewKindFor(name: string, mime: string): PreviewKind {
  if (isDownloadOnly(name)) return 'none'
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'image'
  if (mime === 'application/pdf') return 'pdf'
  const ext = extname(name.toLowerCase())
  if (ext === '.md' || ext === '.markdown') return 'markdown'
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') return 'text'
  return 'none'
}

/** 仅栅格图片 / PDF 允许 inline；文本走 /text JSON，其它一律附件。 */
export function canInline(preview: PreviewKind): boolean {
  return preview === 'image' || preview === 'pdf'
}

const MAX_NAME_LENGTH = 200

/** 清洗用户提供的文件名：NFC、去掉控制字符与路径分隔符、限制长度。 */
export function sanitizeName(input: string): string {
  let name = input.normalize('NFC')
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f]/g, '')
  name = name.replace(/[\\/:*?"<>|]/g, '_')
  name = name.replace(/\s+/g, ' ').trim()
  name = name.replace(/^\.+$/, '')
  name = name.replace(/^\.+/, '')
  name = name.replace(/[. ]+$/, '')
  if (name.length > MAX_NAME_LENGTH) name = name.slice(0, MAX_NAME_LENGTH)
  if (!name) name = '未命名'
  return name
}

/** 在已有名称集合中生成不冲突的名字（大小写不敏感）：a.txt → a (2).txt。 */
export function withSuffix(name: string, index: number): string {
  if (index <= 1) return name
  const dot = name.lastIndexOf('.')
  if (dot > 0) return `${name.slice(0, dot)} (${index})${name.slice(dot)}`
  return `${name} (${index})`
}
