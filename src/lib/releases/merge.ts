// SOURCING: hand-rolled three-way line merge (the diff3 idea: change hunks of
// each side against the common base, merged where they do not overlap) over
// a longest-common-subsequence diff. No library is used because the owner's
// editor diff (CodeMirror merge) is a two-way view, not a merge. A conflict
// keeps the base, your side and the update's side; nothing is dropped.

interface Hunk {
  /** Base lines [start, end) replaced by `lines`. */
  start: number
  end: number
  lines: string[]
}

export type MergeSegment =
  | { kind: 'text'; lines: string[] }
  | {
      kind: 'conflict'
      base: string[]
      mine: string[]
      theirs: string[]
    }

export interface MergeResult {
  segments: MergeSegment[]
  conflicts: number
  /** The merged text when there are no conflicts. */
  text: string | undefined
}

const MAX_CELLS = 4_000_000

/** Splits keeping the line structure, so a merge puts back the same newlines. */
export const linesOf = (text: string): string[] =>
  text === '' ? [] : text.split('\n')

/** Changed ranges of `other` against `base`. */
function hunksOf(base: string[], other: string[]): Hunk[] {
  const n = base.length
  const m = other.length
  if ((n + 1) * (m + 1) > MAX_CELLS) {
    // Too large to diff exactly: one hunk for the whole difference is safe, never lossy.
    let head = 0
    while (head < n && head < m && base[head] === other[head]) head++
    let tail = 0
    while (
      tail < n - head &&
      tail < m - head &&
      base[n - 1 - tail] === other[m - 1 - tail]
    )
      tail++
    return head === n && head === m
      ? []
      : [{ start: head, end: n - tail, lines: other.slice(head, m - tail) }]
  }
  const width = m + 1
  const table = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i * width + j] =
        base[i] === other[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
  const hunks: Hunk[] = []
  let i = 0
  let j = 0
  let open: Hunk | undefined
  const close = () => {
    if (open) hunks.push(open)
    open = undefined
  }
  while (i < n || j < m) {
    if (i < n && j < m && base[i] === other[j]) {
      close()
      i++
      j++
    } else if (
      j < m &&
      (i === n || table[i * width + j + 1]! >= table[(i + 1) * width + j]!)
    ) {
      open ??= { start: i, end: i, lines: [] }
      open.lines.push(other[j]!)
      j++
    } else {
      open ??= { start: i, end: i, lines: [] }
      i++
      open.end = i
    }
  }
  close()
  return hunks
}

/** The side's text over base[start, end), applying its hunks that fall inside. */
function render(
  base: string[],
  hunks: Hunk[],
  start: number,
  end: number,
): string[] {
  const out: string[] = []
  let at = start
  for (const hunk of hunks) {
    out.push(...base.slice(at, hunk.start), ...hunk.lines)
    at = hunk.end
  }
  out.push(...base.slice(at, end))
  return out
}

const sameLines = (a: string[], b: string[]) =>
  a.length === b.length && a.every((line, i) => line === b[i])

/**
 * Merges your edit and the update's, both made from `base`. Where both
 * changed the same lines differently the result holds a conflict with all
 * three versions; the caller shows it and the person chooses.
 */
export function merge3(
  base: string,
  mine: string,
  theirs: string,
): MergeResult {
  const b = linesOf(base)
  const a = hunksOf(b, linesOf(mine))
  const t = hunksOf(b, linesOf(theirs))
  const segments: MergeSegment[] = []
  let at = 0
  let ia = 0
  let it = 0
  const push = (lines: string[]) => {
    if (!lines.length) return
    const last = segments[segments.length - 1]
    if (last?.kind === 'text') last.lines.push(...lines)
    else segments.push({ kind: 'text', lines: [...lines] })
  }
  while (ia < a.length || it < t.length) {
    const ha = a[ia]
    const ht = t[it]
    const first = !ht || (ha && ha.start <= ht.start) ? ha! : ht
    // Gather every hunk of both sides that overlaps or touches the group.
    let start = first.start
    let end = first.end
    const groupA: Hunk[] = []
    const groupT: Hunk[] = []
    for (let moved = true; moved;) {
      moved = false
      const nextA = a[ia + groupA.length]
      const nextT = t[it + groupT.length]
      if (
        nextA &&
        (nextA.start < end ||
          (nextA.start === end && (nextA.start === nextA.end || end === start)))
      ) {
        groupA.push(nextA)
        end = Math.max(end, nextA.end)
        start = Math.min(start, nextA.start)
        moved = true
      } else if (
        nextT &&
        (nextT.start < end ||
          (nextT.start === end && (nextT.start === nextT.end || end === start)))
      ) {
        groupT.push(nextT)
        end = Math.max(end, nextT.end)
        start = Math.min(start, nextT.start)
        moved = true
      }
    }
    push(b.slice(at, start))
    ia += groupA.length
    it += groupT.length
    if (!groupT.length) push(render(b, groupA, start, end))
    else if (!groupA.length) push(render(b, groupT, start, end))
    else {
      const mineLines = render(b, groupA, start, end)
      const theirLines = render(b, groupT, start, end)
      if (sameLines(mineLines, theirLines)) push(mineLines)
      else
        segments.push({
          kind: 'conflict',
          base: b.slice(start, end),
          mine: mineLines,
          theirs: theirLines,
        })
    }
    at = end
  }
  push(b.slice(at))
  const conflicts = segments.filter((s) => s.kind === 'conflict').length
  return {
    segments,
    conflicts,
    text: conflicts ? undefined : joinSegments(segments, []),
  }
}

export type ConflictChoice = 'mine' | 'theirs' | 'both'

function joinSegments(
  segments: MergeSegment[],
  choices: ConflictChoice[],
): string {
  let conflict = 0
  const lines: string[] = []
  for (const segment of segments) {
    if (segment.kind === 'text') lines.push(...segment.lines)
    else {
      const choice = choices[conflict++] ?? 'mine'
      if (choice === 'mine') lines.push(...segment.mine)
      else if (choice === 'theirs') lines.push(...segment.theirs)
      else lines.push(...segment.mine, ...segment.theirs)
    }
  }
  return lines.join('\n')
}

/** The merged text once each conflict has a choice; an unchosen one keeps your side. */
export const resolveMerge = (
  result: MergeResult,
  choices: ConflictChoice[],
): string => joinSegments(result.segments, choices)

/** The text with both versions of each conflict marked, for a person to edit by hand. */
export function withMarkers(result: MergeResult): string {
  const lines: string[] = []
  for (const segment of result.segments) {
    if (segment.kind === 'text') lines.push(...segment.lines)
    else
      lines.push(
        '<<<<<<< your version',
        ...segment.mine,
        '||||||| the version you started from',
        ...segment.base,
        '=======',
        ...segment.theirs,
        '>>>>>>> product update',
      )
  }
  return lines.join('\n')
}

/** Whether any file's merge needs a person. */
export interface FileMerge {
  path: string
  /** `merged` means the text is the clean result; `conflict` keeps the segments. */
  status:
    | 'unchanged'
    | 'took-update'
    | 'kept-yours'
    | 'merged'
    | 'conflict'
    | 'added'
    | 'removed-conflict'
  result?: MergeResult
  text?: string
}

/**
 * Merges every file of a fork with a new product release over the revision the
 * fork started from. A file only one side changed takes that change; a file
 * both changed is merged by line; a file one side deleted and the other
 * edited is a conflict, never a silent delete.
 */
export function mergeFiles(
  base: Record<string, string>,
  mine: Record<string, string>,
  theirs: Record<string, string>,
): FileMerge[] {
  const paths = [
    ...new Set([
      ...Object.keys(base),
      ...Object.keys(mine),
      ...Object.keys(theirs),
    ]),
  ].sort()
  return paths.map((path): FileMerge => {
    const b = base[path]
    const m = mine[path]
    const t = theirs[path]
    if (m === t) return { path, status: 'unchanged', text: m }
    if (m === b)
      return {
        path,
        status: t === undefined ? 'took-update' : 'took-update',
        text: t,
      }
    if (t === b) return { path, status: 'kept-yours', text: m }
    if (b === undefined && m !== undefined && t !== undefined) {
      // Both added the same path with different content: merge against nothing.
      const result = merge3('', m, t)
      return result.conflicts
        ? { path, status: 'conflict', result }
        : { path, status: 'merged', result, text: result.text }
    }
    if (m === undefined || t === undefined)
      return {
        path,
        status: 'removed-conflict',
        result: {
          segments: [
            {
              kind: 'conflict',
              base: linesOf(b ?? ''),
              mine: linesOf(m ?? ''),
              theirs: linesOf(t ?? ''),
            },
          ],
          conflicts: 1,
          text: undefined,
        },
      }
    const result = merge3(b ?? '', m, t)
    return result.conflicts
      ? { path, status: 'conflict', result }
      : { path, status: 'merged', result, text: result.text }
  })
}
