// SOURCING: lib/code-classes (Shiki over its JavaScript regex engine) for class-based code tokens, with the languages a coding agent writes, and Shiki's splitTokens for the words a diff line changed; mdast-util-from-markdown for where fenced code sits in the agent's markdown; jsdiff's parsePatch for a diff's files and hunks and diffWordsWithSpace for what changed within a line; jsdiff's createPatch for the code a write or an edit carries in its arguments while it streams; colours are the terminal crate's (terminal/src/lib.rs)
//
// Code the agent writes, highlighted for the terminal. The terminal draws
// markdown itself (tui-markdown, highlighting off); fenced code is lifted out
// here and handed over as lines of classed tokens, which the crate colours in
// Stone dark's code theme.
import { createPatch, diffWordsWithSpace, parsePatch } from 'diff'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { classedLines, languageOf as grammarOf } from '@/lib/code-classes'

/**
 * One run of code text; `c` is its highlight class, absent for plain text.
 * In a diff, `e` marks words the line changed.
 */
export type Token = { t: string; c?: string; e?: true }

/**
 * A diff's line: the file it changes, a hunk's header, or a line kept,
 * removed or added. A code line carries no marker; the crate draws that.
 */
export type DiffLine = {
  k: 'file' | 'hunk' | 'ctx' | 'del' | 'add'
  t: Token[]
}

export type CodePart = {
  type: 'code'
  /** The fence's language as written; empty for none. */
  lang: string
  lines: Token[][]
  /** A fenced diff, drawn line by line instead of `lines`. */
  diff?: DiffLine[]
}

export type ProsePart = { type: 'text'; text: string }

/** Code as lines of classed tokens; an unknown language comes back plain. */
export function highlightLines(code: string, lang = ''): Token[][] {
  return classedLines(code, lang).map((line) =>
    line.map((token) =>
      token.class ? { t: token.text, c: token.class } : { t: token.text },
    ),
  )
}

/** Lines of output a tool row carries for ctrl+o; the rest is counted. */
export const OUTPUT_LINES = 40

export type Output = {
  lang: string
  lines: Token[][]
  /** An edit's diff, drawn line by line instead of `lines`. */
  diff?: DiffLine[]
  more: number
}

const DIFF = /^(diff --git |@@ -\d|--- \S|\+\+\+ \S)/m

/** The language a file path's extension names, if one is registered. */
function languageOf(path: string | undefined) {
  const ext = path?.match(/\.([\w-]+)$/)?.[1]
  return (ext && grammarOf(ext)) ?? ''
}

type Row = { k: 'ctx' | 'del' | 'add'; text: string }
type Hunk = { header: string; rows: Row[] }
type FilePatch = { name?: string; hunks: Hunk[] }

/** A patch's file without git's a/ and b/; a file created or deleted names the other side. */
function fileName(before?: string, after?: string) {
  const name = after && after !== '/dev/null' ? after : before
  return name && name !== '/dev/null' ? name.replace(/^[ab]\//, '') : undefined
}

/** A hunk line as kept, removed or added; "\ No newline" notes are not code. */
function rowOf(line: string): Row[] {
  if (line.startsWith('\\')) return []
  const k = line[0] === '-' ? 'del' : line[0] === '+' ? 'add' : 'ctx'
  return [{ k, text: line.slice(1) }]
}

/** A well-formed diff, read by its counts: a removed "-- comment" stays code. */
function parsed(text: string): FilePatch[] {
  const headers = text.match(/^@@.*$/gm) ?? []
  let at = 0
  return parsePatch(text).map((patch) => ({
    name: fileName(patch.oldFileName, patch.newFileName),
    hunks: patch.hunks.map((hunk) => ({
      header:
        headers[at++] ??
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      rows: hunk.lines.flatMap(rowOf),
    })),
  }))
}

/** A diff's header lines: its file names, a hunk's header, and git's own. */
const HEADER = /^(?:@@|diff |index |--- |\+\+\+ )/

/**
 * A diff jsdiff refuses (counts that disagree with its lines, as a model
 * writes them, or a hunk still arriving), read line by line instead.
 */
function classified(text: string): FilePatch[] {
  const files: FilePatch[] = []
  let before: string | undefined
  let file: FilePatch | undefined
  let hunk: Hunk | undefined
  for (const line of text.split('\n')) {
    if (HEADER.test(line)) {
      const name = line.slice(4).split('\t')[0]
      if (line.startsWith('--- ')) before = name
      if (line.startsWith('+++ ')) {
        file = { name: fileName(before, name), hunks: [] }
        files.push(file)
        hunk = undefined
      } else if (line.startsWith('@@')) {
        if (!file) files.push((file = { hunks: [] }))
        hunk = { header: line, rows: [] }
        file.hunks.push(hunk)
      }
      continue
    }
    if (hunk) hunk.rows.push(...rowOf(line))
  }
  return files
}

/** git-delta's default: lines further apart than this are not paired word by word. */
const MAX_LINE_DISTANCE = 0.6

type Span = [start: number, end: number]

/** The words a removed line lost and its added counterpart gained, unless they differ throughout. */
function changedWords(before: string, after: string) {
  const changes = diffWordsWithSpace(before, after)
  const changed = changes
    .filter((change) => change.added || change.removed)
    .reduce((sum, change) => sum + change.value.length, 0)
  if (!changed || changed / (before.length + after.length) > MAX_LINE_DISTANCE)
    return
  const removed: Span[] = []
  const added: Span[] = []
  let old = 0
  let now = 0
  for (const { value, added: gained, removed: lost } of changes) {
    if (lost) removed.push([old, (old += value.length)])
    else if (gained) added.push([now, (now += value.length)])
    else {
      old += value.length
      now += value.length
    }
  }
  return { removed, added }
}

/**
 * One side of a hunk highlighted as one piece of code, so a string or
 * comment spanning lines keeps its colour, with its changed words marked.
 */
function sideLines(
  lines: string[],
  lang: string,
  changed: Map<number, Span[]>,
): Token[][] {
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }
  const ranges = [...changed].flatMap(([line, spans]) =>
    spans.map(([start, end]): Span => [
      starts[line]! + start,
      starts[line]! + end,
    ]),
  )
  const marked = (at: number) =>
    ranges.some(([start, end]) => start <= at && at < end)
  return classedLines(lines.join('\n'), lang, ranges.flat()).map((line) =>
    line.map(({ text, offset: at, class: c }) => ({
      t: text,
      ...(c && { c }),
      ...(marked(at) && { e: true as const }),
    })),
  )
}

/** A hunk: its header, then each line in its side's colours. */
function hunkLines({ header, rows }: Hunk, lang: string): DiffLine[] {
  const before: string[] = []
  const after: string[] = []
  const at = rows.map((row) => ({
    old: row.k === 'add' ? -1 : before.push(row.text) - 1,
    new: row.k === 'del' ? -1 : after.push(row.text) - 1,
  }))
  // A run of removed lines then added ones pairs off, line by line.
  const lost = new Map<number, Span[]>()
  const gained = new Map<number, Span[]>()
  for (let i = 0; i < rows.length;) {
    if (rows[i]!.k !== 'del') {
      i++
      continue
    }
    let added = i
    while (rows[added]?.k === 'del') added++
    let end = added
    while (rows[end]?.k === 'add') end++
    for (let pair = 0; pair < Math.min(added - i, end - added); pair++) {
      const words = changedWords(rows[i + pair]!.text, rows[added + pair]!.text)
      if (!words) continue
      lost.set(at[i + pair]!.old, words.removed)
      gained.set(at[added + pair]!.new, words.added)
    }
    i = end
  }
  const old = sideLines(before, lang, lost)
  const now = sideLines(after, lang, gained)
  return [
    { k: 'hunk', t: [{ t: header }] },
    ...rows.map((row, i) => ({
      k: row.k,
      t: (row.k === 'del' ? old[at[i]!.old] : now[at[i]!.new]) ?? [],
    })),
  ]
}

/**
 * A unified diff as the terminal draws it: each line in the colours of the
 * language its file names (else `path`'s), kept, removed or added, with the
 * words a changed line swapped marked. A tool's own file goes unnamed, as
 * its row already names it.
 */
export function diffLines(text: string, path?: string): DiffLine[] {
  const body = text.replace(/\n$/, '')
  let files: FilePatch[]
  try {
    files = parsed(body)
  } catch {
    files = classified(body)
  }
  const named = !(path && files.length === 1)
  return files.flatMap((file) => [
    ...(named && file.name
      ? [{ k: 'file' as const, t: [{ t: file.name }] }]
      : []),
    ...file.hunks.flatMap((hunk) =>
      hunkLines(hunk, languageOf(file.name ?? path)),
    ),
  ])
}

/** A tool's result as text: as returned, its text content, else JSON. */
function resultText(result: unknown) {
  if (typeof result === 'string') return { text: result, structured: false }
  const content =
    typeof result === 'object' && result !== null && 'content' in result
      ? result.content
      : undefined
  const texts = Array.isArray(content)
    ? content.flatMap((item: unknown) =>
        item &&
        typeof item === 'object' &&
        'text' in item &&
        typeof item.text === 'string'
          ? [item.text]
          : [],
      )
    : []
  return texts.length
    ? { text: texts.join('\n'), structured: false }
    : { text: JSON.stringify(result, null, 2), structured: true }
}

/**
 * A tool's result as the terminal shows it under its row: text as returned,
 * a unified diff as a diff, file content in its path's language, structured
 * results as JSON. Long output keeps its first lines and counts the rest.
 */
export function toolOutput(
  result: unknown,
  path: string | undefined,
): Output | undefined {
  if (result === undefined || result === null || result === '') return
  const { text, structured } = resultText(result)
  if (!structured && DIFF.test(text)) {
    const rows = diffLines(text, path)
    return {
      lang: 'diff',
      lines: [],
      diff: rows.slice(0, OUTPUT_LINES),
      more: Math.max(0, rows.length - OUTPUT_LINES),
    }
  }
  const lang = structured ? 'json' : languageOf(path)
  const rows = text.replace(/\n$/, '').split('\n')
  return {
    lang,
    lines: highlightLines(rows.slice(0, OUTPUT_LINES).join('\n'), lang),
    more: Math.max(0, rows.length - OUTPUT_LINES),
  }
}

/** The names tools give a write's whole new text, and an edit's text before and after. */
const WRITTEN = ['content', 'contents', 'file_text', 'text'] as const
const EDITED = [
  ['old_string', 'new_string'],
  ['old_str', 'new_str'],
  ['oldText', 'newText'],
] as const

/**
 * The code a write or an edit carries in its arguments, as a diff, so it can be drawn while
 * the call streams and before it returns. A write is every line added; an edit is its text
 * before and after. Hunk headers are left out: an edit's snippet does not say where in the
 * file it lands, so its line numbers would mislead. Absent when the arguments carry neither.
 */
export function argsDiff(
  args: Record<string, unknown>,
  path: string | undefined,
): { diff: DiffLine[]; write: boolean } | undefined {
  const pair = EDITED.map(
    ([before, after]) =>
      [stringArg(args[before]), stringArg(args[after])] as const,
  ).find(([, after]) => after !== undefined)
  const written = WRITTEN.map((key) => stringArg(args[key])).find(
    (value) => value !== undefined,
  )
  const [before, after, write] = pair
    ? [pair[0] ?? '', pair[1] ?? '', false]
    : written !== undefined
      ? ['', written, true]
      : [undefined, undefined, false]
  if (after === undefined || before === after) return
  const name = path ?? 'file'
  const lines = diffLines(
    createPatch(name, before, after, '', ''),
    path,
  ).filter((line) => line.k !== 'hunk')
  return lines.length > 0 ? { diff: lines, write } : undefined
}

/** Where a tool's file opens in the editor: one-based lines, both ends included. */
export type Open = { path: string; start?: number; end?: number }

const stringArg = (value: unknown) =>
  typeof value === 'string' ? value : undefined

/** The file a tool's arguments name, under any of the names tools give it. */
export function pathOf(args: Record<string, unknown>) {
  return (
    stringArg(args.path) ?? stringArg(args.file_path) ?? stringArg(args.file)
  )
}

const lineArg = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined

/** An edit's first hunk; a diff whose counts disagree with its lines has none. */
function firstHunk(text: string) {
  try {
    return parsePatch(text)
      .flatMap((patch) => patch.hunks)
      .at(0)
  } catch {
    return undefined
  }
}

/**
 * The file a tool worked on and the lines it touched: the first hunk an edit
 * returned as a diff, else the lines it was asked to read.
 */
export function openOf(
  path: string | undefined,
  args: Record<string, unknown>,
  result: unknown,
): Open | undefined {
  if (!path) return
  if (result !== undefined && result !== null && result !== '') {
    const { text } = resultText(result)
    if (DIFF.test(text)) {
      const hunk = firstHunk(text)
      if (hunk)
        return {
          path,
          start: hunk.newStart,
          end: hunk.newStart + Math.max(hunk.newLines, 1) - 1,
        }
    }
  }
  const start =
    lineArg(args.start_line) ?? lineArg(args.line) ?? lineArg(args.offset)
  const limit = lineArg(args.limit)
  const end =
    lineArg(args.end_line) ??
    (start !== undefined && limit !== undefined ? start + limit - 1 : undefined)
  return { path, start, end: end ?? start }
}

/**
 * The agent's markdown with its top-level code blocks lifted out and
 * highlighted, in order. Code nested in a list or quote stays in the prose
 * and draws in the terminal's plain code style. A fence still streaming has
 * no closing line yet and runs to the end, as markdown reads it.
 */
export function proseAndCode(text: string): (ProsePart | CodePart)[] {
  if (!text.includes('```') && !text.includes('~~~') && !/^ {4}/m.test(text))
    return [{ type: 'text', text }]
  const parts: (ProsePart | CodePart)[] = []
  let from = 0
  const prose = (to: number) => {
    const slice = text.slice(from, to)
    if (slice.trim()) parts.push({ type: 'text', text: slice })
  }
  for (const node of fromMarkdown(text).children) {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (node.type !== 'code' || start === undefined || end === undefined)
      continue
    prose(start)
    const lang = node.lang ?? ''
    parts.push(
      grammarOf(lang) === 'diff'
        ? { type: 'code', lang, lines: [], diff: diffLines(node.value) }
        : { type: 'code', lang, lines: highlightLines(node.value, lang) },
    )
    from = end
  }
  prose(text.length)
  return parts
}
