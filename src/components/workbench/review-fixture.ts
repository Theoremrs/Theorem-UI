// SOURCING: none: committed constants in the owners' own types (the SCM changes and diff). Invented, neutral content; no name, project or text of the reference the Review is held against.
import type { ScmChange, ScmDiffResult } from '@/lib/workbench/wire'

/** The fixed size of the Review story: the reference frame's. */
export const REVIEW_VIEWPORT = { width: 1568, height: 914 } as const

type Plan = {
  change: ScmChange
  /** Lines the diff adds and removes, spread over `hunks` hunks. */
  add: number
  del: number
  hunks: number
  binary?: boolean
  /** The file is new (everything added) or gone (everything removed). */
  whole?: 'added' | 'removed'
}

const change = (
  path: string,
  index: string,
  worktree: string,
  originalPath?: string,
): ScmChange => ({
  path,
  index,
  worktree,
  conflict: false,
  ...(originalPath ? { originalPath } : {}),
})

/**
 * Twelve invented files in five folders: modified ones, an added file, a deleted one, a rename, an untracked
 * file, a binary image and `queue.rs`, whose diff is long enough that the Review must read it lazily.
 */
const PLANS: Plan[] = [
  { change: change('README.md', ' ', 'M'), add: 4, del: 2, hunks: 1 },
  {
    change: change('crates/engine/src/planner.rs', ' ', 'M'),
    add: 14,
    del: 6,
    hunks: 2,
  },
  {
    change: change('crates/engine/src/queue.rs', ' ', 'M'),
    add: 240,
    del: 96,
    hunks: 8,
  },
  {
    change: change('crates/engine/src/router.rs', 'A', ' '),
    add: 52,
    del: 0,
    hunks: 1,
    whole: 'added',
  },
  {
    change: change('crates/engine/src/legacy.rs', ' ', 'D'),
    add: 0,
    del: 38,
    hunks: 1,
    whole: 'removed',
  },
  {
    change: change('crates/engine/tests/queue_cases.rs', ' ', 'M'),
    add: 18,
    del: 3,
    hunks: 2,
  },
  {
    change: change(
      'crates/store/src/index.rs',
      'R',
      ' ',
      'crates/store/src/lookup.rs',
    ),
    add: 5,
    del: 5,
    hunks: 1,
  },
  { change: change('crates/store/src/page.rs', ' ', 'M'), add: 9, del: 4, hunks: 2 },
  { change: change('docs/design/overview.md', ' ', 'M'), add: 11, del: 7, hunks: 2 },
  {
    change: change('docs/design/queue-notes.md', 'A', ' '),
    add: 27,
    del: 0,
    hunks: 1,
    whole: 'added',
  },
  {
    change: change('assets/logo-mark.png', ' ', 'M'),
    add: 0,
    del: 0,
    hunks: 0,
    binary: true,
  },
  {
    change: change('scripts/bench.sh', '?', '?'),
    add: 21,
    del: 0,
    hunks: 1,
    whole: 'added',
  },
]

export const REVIEW_CHANGES: ScmChange[] = PLANS.map((p) => p.change)

/** The lines each file adds and removes, which is what the Review's counts must add up to. */
export const REVIEW_COUNTS: Record<string, { add: number; del: number }> =
  Object.fromEntries(
    PLANS.map((p) => [p.change.path, { add: p.add, del: p.del }]),
  )

const word = (n: number) =>
  ['slot', 'ring', 'head', 'tail', 'lane', 'batch', 'epoch', 'stamp'][n % 8]

/** One invented source line, the same for the same number. */
const code = (n: number, tag: string) =>
  `    let ${word(n)}_${n} = ${tag}(${word(n + 3)}, ${n});`

/** A hunk's rows: two context lines, `del` removals, `add` additions, two context lines. */
function hunk(
  start: number,
  add: number,
  del: number,
  whole?: 'added' | 'removed',
) {
  const rows: string[] = []
  const lead = whole ? 0 : 2
  for (let i = 0; i < lead; i++) rows.push(` ${code(start + i, 'keep')}`)
  for (let i = 0; i < del; i++) rows.push(`-${code(start + i, 'old')}`)
  for (let i = 0; i < add; i++) rows.push(`+${code(start + i, 'next')}`)
  for (let i = 0; i < lead; i++) rows.push(` ${code(start + add + i, 'keep')}`)
  const oldCount = del + lead * 2
  const newCount = add + lead * 2
  const oldStart = whole === 'added' ? 0 : start
  const newStart = whole === 'removed' ? 0 : start
  return {
    header: `@@ -${oldStart},${whole === 'added' ? 0 : oldCount} +${newStart},${whole === 'removed' ? 0 : newCount} @@`,
    old: [oldStart, whole === 'added' ? 0 : oldCount] as const,
    neu: [newStart, whole === 'removed' ? 0 : newCount] as const,
    rows,
  }
}

/** A file's diff: its planned hunks, far enough apart that the panel draws a separator between them. */
export function reviewDiff(path: string, staged: boolean): ScmDiffResult {
  const plan = PLANS.find((p) => p.change.path === path)
  if (!plan) return { path, staged, text: '', hunks: [] }
  if (plan.binary) {
    return {
      path,
      staged,
      text: `diff --git a/${path} b/${path}\nBinary files a/${path} and b/${path} differ\n`,
      hunks: [],
    }
  }
  const parts = Array.from({ length: plan.hunks }, (_, k) => {
    const share = (total: number) =>
      Math.floor(total / plan.hunks) +
      (k < total % plan.hunks ? 1 : 0)
    return hunk(10 + k * 90, share(plan.add), share(plan.del), plan.whole)
  })
  const patch = parts.map((h) => `${h.header}\n${h.rows.join('\n')}`).join('\n')
  const from = plan.whole === 'added' ? '/dev/null' : `a/${path}`
  const to = plan.whole === 'removed' ? '/dev/null' : `b/${path}`
  return {
    path,
    staged,
    text: `diff --git a/${path} b/${path}\n--- ${from}\n+++ ${to}\n${patch}\n`,
    hunks: parts.map((h) => ({
      path,
      oldStart: h.old[0],
      oldCount: h.old[1],
      newStart: h.neu[0],
      newCount: h.neu[1],
      header: h.header,
      patch: h.rows.join('\n'),
    })),
  }
}
