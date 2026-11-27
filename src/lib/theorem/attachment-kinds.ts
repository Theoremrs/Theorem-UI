// SOURCING: Theorem's chat upload intake (rustyred-thg-server theorem_chat_upload: the declared types it takes and the file names it refuses) and the browser's File. What an attached file is, and the type it goes up as.

export type FileKind =
  | 'text'
  | 'markdown'
  | 'html'
  | 'table'
  | 'code'
  | 'pdf'
  | 'docx'
  | 'image'
  | 'video'
  | 'audio'
  | 'other'

export const DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** Source files a browser types oddly or not at all; they go up as plain text. */
const CODE = [
  'ts',
  'tsx',
  'jsx',
  'py',
  'rs',
  'go',
  'rb',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sh',
  'sql',
  'css',
  'scss',
  'yaml',
  'yml',
  'toml',
  'xml',
  'ini',
  'log',
]

export const extension = (name: string) =>
  name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''

export function fileKind(name: string, type = ''): FileKind {
  const ext = extension(name)
  const base = type.split(';', 1)[0]!.trim()
  // A source file's name outranks the browser's guess (a .ts as video/mp2t).
  if (CODE.includes(ext)) return 'code'
  if (base.startsWith('image/') && base !== 'image/svg+xml') return 'image'
  if (base.startsWith('video/')) return 'video'
  if (base.startsWith('audio/')) return 'audio'
  if (base === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (base === DOCX || ext === 'docx') return 'docx'
  if (base === 'text/markdown' || ext === 'md' || ext === 'markdown')
    return 'markdown'
  if (base === 'text/html' || ext === 'html' || ext === 'htm') return 'html'
  if (base === 'text/csv' || ext === 'csv') return 'table'
  if (base === 'application/json' || ext === 'json') return 'code'
  if (base.startsWith('text/') || ext === 'txt') return 'text'
  return 'other'
}

/** Whether the file is read as words: a text dialog shows it whole. */
export const isTextual = (kind: FileKind) =>
  kind === 'text' ||
  kind === 'markdown' ||
  kind === 'html' ||
  kind === 'table' ||
  kind === 'code'

/** What the composer's file picker offers; Theorem's intake takes each. */
export const ATTACHMENT_ACCEPT = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  DOCX,
  'audio/*',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'text/plain',
  'text/markdown',
  'text/html',
  'text/csv',
  'application/json',
  ...[
    'txt',
    'md',
    'markdown',
    'csv',
    'json',
    'html',
    'pdf',
    'docx',
    ...CODE,
  ].map((ext) => `.${ext}`),
].join(',')

/**
 * The type a file goes up as. Theorem takes text by a few declared types, so
 * a source file the browser typed oddly (a .ts as a video stream) or not at
 * all is declared as what it is.
 */
export function uploadType(name: string, type: string): string {
  switch (fileKind(name, type)) {
    case 'markdown':
      return 'text/markdown'
    case 'html':
      return 'text/html'
    case 'table':
      return 'text/csv'
    case 'code':
      return extension(name) === 'json' || type === 'application/json'
        ? 'application/json'
        : 'text/plain'
    case 'text':
      return 'text/plain'
    case 'pdf':
      return 'application/pdf'
    case 'docx':
      return DOCX
    default:
      return type
  }
}

/** A file whose declared type Theorem would not take, retyped; else itself. */
export function asUpload(file: File): File {
  const type = uploadType(file.name, file.type)
  return type === file.type ? file : new File([file], file.name, { type })
}

/** The format as a short label: the extension, or the type's subtype. */
export function formatLabel(name: string, type = ''): string {
  const ext = extension(name)
  if (ext && ext.length <= 5) return ext.toUpperCase()
  const sub = type.split(';', 1)[0]!.split('/')[1]
  return sub ? sub.replace(/^x-/, '').toUpperCase() : 'FILE'
}
