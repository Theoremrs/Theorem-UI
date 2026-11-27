// SOURCING: none: a unified diff read line by line for the code block's gutter (each row's new-file number, whether the diff added or removed it). jsdiff's parsePatch, which the terminal's transcript uses (terminal-code.ts), refuses a hunk whose line counts disagree with its header, and the diffs a model writes in a reply often miscount, so this reads the header's starting line and the markers alone.

/** How a diff touched a line: added, removed, or a hunk's `@@` header. Absent for an unchanged line. */
export type LineChange = 'add' | 'remove' | 'hunk'

/** What the gutter shows beside one line. */
export interface GutterLine {
  /** The line's number in the file; absent for a removed line and a hunk header. */
  number?: number
  change?: LineChange
}

/** Code as the block shows it: the text it highlights and what the gutter shows beside each line. */
export interface CodeLines {
  text: string
  lines: GutterLine[]
  /** The file a diff changes, without git's `a/` and `b/`. */
  path?: string
  /** The language of that file, by its extension or whole name (as `Dockerfile`), for Shiki to resolve. */
  language?: string
}

/** Plain code: every line numbered from one. */
export function plainLines(code: string): CodeLines {
  const text = code.replace(/\n+$/, '')
  return {
    text,
    lines: text.split('\n').map((_, index) => ({ number: index + 1 })),
  }
}

const languageOfPath = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name).toLowerCase()
}

const cleanPath = (name: string) => {
  const path = name.split('\t')[0]!.trim()
  return path === '/dev/null' ? undefined : path.replace(/^[ab]\//, '')
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/
const FILE_HEADER = /^(diff |index |new file mode|deleted file mode|similarity |rename |old mode|new mode)/

/**
 * A single code pane cannot name or tokenize several files as one file. Git
 * preambles identify the boundary directly. Without them, a second header
 * pair followed by a hunk is a new file (or ambiguous hunk content): keep
 * the original diff in either case, rather than discarding or mislabelling it.
 */
function needsRawDiff(source: readonly string[]) {
  let gitFiles = 0
  let named = false
  let inHunk = false
  for (let index = 0; index < source.length; index++) {
    const row = source[index]!
    if (row.startsWith('diff --git ') && ++gitFiles > 1) return true
    if (HUNK.test(row)) inHunk = true
    if (!row.startsWith('--- ') || !source[index + 1]?.startsWith('+++ ')) continue
    if (inHunk) {
      if (HUNK.test(source[index + 2] ?? '')) return true
    } else {
      if (named) return true
      named = true
    }
  }
  return false
}

/**
 * A unified diff as the block shows it: each row without its `+`, `-` or
 * space, numbered as the new file numbers it, in the changed file's
 * language. The file headers become the block's path; each hunk keeps its
 * `@@` row as written. Rows before any hunk number from one. Multiple files
 * retain the original diff, with patch-line numbers and the diff grammar.
 */
export function diffLines(code: string): CodeLines {
  const source = code.replace(/\n+$/, '').split('\n')
  if (needsRawDiff(source)) {
    return {
      text: code,
      lines: code.split('\n').map((_, index) => ({ number: index + 1 })),
      language: 'diff',
    }
  }
  const text: string[] = []
  const lines: GutterLine[] = []
  let path: string | undefined
  let at = 1
  let inHunk = false
  source.forEach((row, index) => {
    const hunk = HUNK.exec(row)
    if (hunk) {
      text.push(row)
      lines.push({ change: 'hunk' })
      at = Number(hunk[1])
      inHunk = true
      return
    }
    const next = source[index + 1] ?? ''
    const previous = source[index - 1] ?? ''
    if (!inHunk && row.startsWith('--- ') && next.startsWith('+++ ')) {
      path ??= cleanPath(row.slice(4))
      return
    }
    if (!inHunk && row.startsWith('+++ ') && previous.startsWith('--- ')) {
      path = cleanPath(row.slice(4)) ?? path
      return
    }
    if (FILE_HEADER.test(row) || row.startsWith('\\')) return
    const marker = row[0]
    text.push(marker === '+' || marker === '-' || marker === ' ' ? row.slice(1) : row)
    if (marker === '-') {
      lines.push({ change: 'remove' })
      return
    }
    lines.push(marker === '+' ? { number: at, change: 'add' } : { number: at })
    at += 1
  })
  return {
    text: text.join('\n'),
    lines,
    ...(path && { path, language: languageOfPath(path) }),
  }
}

/**
 * The file a fence's info string names after its language, as `ts title="src/a.ts"`
 * or `ts src/a.ts` write it.
 */
export function fenceTitle(meta: string | undefined): string | undefined {
  if (!meta) return undefined
  const named = /\b(?:title|file|filename|path)=(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(meta)
  if (named) return named[1] ?? named[2] ?? named[3]
  return meta.split(/\s+/).find((word) => /[./]/.test(word) && !/[{}=]/.test(word))
}
