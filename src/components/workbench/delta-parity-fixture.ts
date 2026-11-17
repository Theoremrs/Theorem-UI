// SOURCING: none: committed constants in the owners' own types (the threads listing, the conversation snapshot, the SCM changes and diff). Invented, neutral content; no name, project or text of the reference it is held against.
import type { ConversationSnapshot } from '@/lib/workbench/conversation/conversation'
import type { ScmChange, ScmDiffResult } from '@/lib/workbench/wire'
import { seedThread } from './threads-fixture'
import type { ThreadsSeed } from './threads-fixture'

/** The fixed size of the parity story: the reference frame's. */
export const PARITY_VIEWPORT = { width: 1568, height: 914 } as const

const PROJECTS = [
  { id: 'p-meridian', name: 'Meridian' },
  { id: 'p-quarry', name: 'Quarry' },
  { id: 'p-lantern', name: 'Lantern' },
]

/**
 * The account: six pinned threads (one open, one working, one waiting on the person, one unread) and three
 * projects with threads under them, some working, some waiting, some unread.
 */
export const PARITY_THREADS: ThreadsSeed = {
  projects: PROJECTS,
  open: { projectId: 'p-meridian', threadId: 't-sync' },
  threads: [
    seedThread('t-plan', 'Plan the storage migration', ['p-meridian'], 180, {
      pinned: true,
    }),
    seedThread('t-sync', 'Design the sync protocol', ['p-meridian'], 4, {
      pinned: true,
    }),
    seedThread('t-cache', 'Set up the build cache', ['p-quarry'], 1, {
      pinned: true,
      running: true,
    }),
    seedThread('t-notes', 'Review the release notes', ['p-quarry'], 25, {
      pinned: true,
      needsYou: 'Approve',
    }),
    seedThread('t-parser', 'Continue the parser rewrite', ['p-meridian'], 90, {
      pinned: true,
      unread: true,
    }),
    seedThread('t-kb', 'Hand off the knowledge base', ['p-lantern'], 600, {
      pinned: true,
    }),
    seedThread('t-flaky', 'Fix the flaky retry test', ['p-meridian'], 12),
    seedThread('t-new', 'New thread', ['p-meridian'], 0),
    seedThread('t-pr', 'Review pull request 112', ['p-meridian'], 8, {
      needsYou: 'Approve',
    }),
    seedThread('t-compiler', 'Upgrade the compiler', ['p-meridian'], 240, {
      unread: true,
    }),
    seedThread('t-guide', 'Draft the onboarding guide', ['p-meridian'], 360),
    seedThread('t-query', 'Profile the slow query', ['p-quarry'], 2, {
      running: true,
    }),
    seedThread('t-deps', 'Audit the dependency list', ['p-quarry'], 70),
    seedThread('t-log', 'Write the changelog', ['p-quarry'], 20, {
      needsYou: 'Approve',
    }),
    seedThread('t-index', 'Rebuild the search index', ['p-quarry'], 300, {
      running: true,
    }),
    seedThread('t-icons', 'Sort out the icon set', ['p-lantern'], 500),
    seedThread('t-audit', 'Check the license headers', ['p-lantern'], 800),
  ],
}

type Kind = 'file' | 'hunk' | 'ctx' | 'add' | 'del'
const lines = (rows: Array<[Kind, string]>) =>
  rows.map(([k, t]) => ({ k, t: [{ t }] }))

/**
 * The transcript: a request, prose, a short thought, two finished calls, a patch with its diff, a running
 * command, prose, and a write waiting for the person's yes.
 */
export const PARITY_CONVERSATION: ConversationSnapshot = {
  conversationId: 'parity-thread',
  revision: 1,
  loading: false,
  queued: [],
  messages: [
    {
      id: 'm1',
      role: 'user',
      clientMessageId: 'parity-1',
      status: 'complete',
      attachments: [],
      parts: [
        {
          type: 'text',
          text: 'Compare the two sync approaches and tell me which one to build first. Run the merge tests when you have a candidate.',
        },
      ],
    },
    {
      id: 'm2',
      role: 'assistant',
      runId: 'run-1',
      status: 'requires-action',
      attachments: [],
      parts: [
        {
          type: 'text',
          text: 'I will read the design notes and the current merge code, then try the smaller approach and run the tests against it.',
        },
        {
          type: 'reasoning',
          text: 'Weighing the two against the constraint that every device must converge without a shared clock.',
        },
        {
          type: 'tool',
          id: 'call-1',
          name: 'read_file',
          args: '{"path":"docs/sync-notes.md"}',
          status: 'complete',
          result: '# Sync notes\n\nTwo approaches: a log of changes, or a state merge.',
        },
        {
          type: 'tool',
          id: 'call-2',
          name: 'grep',
          args: '{"pattern":"merge_state","path":"src"}',
          status: 'complete',
          result: 'src/sync/merge.rs:41: pub fn merge_state(a: &State, b: &State) -> State {',
        },
        {
          type: 'text',
          text: 'The state merge is the smaller change: it keeps one function and drops the replay log. The patch below makes it order-independent:',
        },
        {
          type: 'tool',
          id: 'call-3',
          name: 'apply_patch',
          args: '{"path":"src/sync/merge.rs"}',
          status: 'complete',
          result: 'Patched src/sync/merge.rs',
          diff: [
            ...lines([
              ['file', 'src/sync/merge.rs'],
              ['hunk', '@@ -38,8 +38,10 @@'],
              ['ctx', 'pub fn merge_state(a: &State, b: &State) -> State {'],
              ['ctx', '    let mut out = a.clone();'],
              ['del', '    for (key, entry) in b.entries() {'],
              ['del', '        out.insert(key, entry);'],
              ['add', '    for (key, entry) in b.entries() {'],
              ['add', '        let newer = out.get(key).map_or(true, |own| entry.stamp > own.stamp);'],
              ['add', '        if newer { out.insert(key, entry); }'],
              ['ctx', '    }'],
              ['ctx', '    out'],
            ]),
          ],
          open: { path: 'src/sync/merge.rs', start: 38, end: 47 },
        },
        {
          type: 'tool',
          id: 'call-4',
          name: 'run_command',
          args: '{"command":"cargo test -p sync --lib merge"}',
          status: 'running',
        },
        {
          type: 'text',
          text: 'While that runs: the change also needs the stamp field written to the clock module, so I am asking before I touch it.',
        },
        {
          type: 'tool',
          id: 'call-5',
          name: 'edit_file',
          args: '{"path":"src/sync/clock.rs"}',
          status: 'approval',
          approvalId: 'approval-1',
        },
      ],
    },
  ],
  run: { state: 'waiting_approval', runId: 'run-1' },
  approval: {
    runId: 'run-1',
    approvalId: 'approval-1',
    toolCallId: 'call-5',
    toolName: 'edit_file',
    summary: 'Write src/sync/clock.rs',
    risk: 'low',
    options: [],
  },
}

export const PARITY_CHANGES: ScmChange[] = [
  { path: 'src/sync/merge.rs', index: ' ', worktree: 'M', conflict: false },
  { path: 'src/sync/clock.rs', index: ' ', worktree: 'M', conflict: false },
  { path: 'src/sync/mod.rs', index: 'M', worktree: ' ', conflict: false },
  { path: 'src/sync/stamp.rs', index: 'A', worktree: ' ', conflict: false },
  { path: 'docs/sync-notes.md', index: 'A', worktree: ' ', conflict: false },
  { path: 'tests/merge_cases.rs', index: 'A', worktree: ' ', conflict: false },
  { path: 'docs/overview.md', index: 'M', worktree: ' ', conflict: false },
  { path: 'scratch/bench.txt', index: '?', worktree: '?', conflict: false },
]

const HUNKS: Array<{ header: string; old: [number, number]; neu: [number, number]; rows: string[] }> = [
  {
    header: '@@ -38,8 +38,10 @@ impl State',
    old: [38, 8],
    neu: [38, 10],
    rows: [
      ' pub fn merge_state(a: &State, b: &State) -> State {',
      '     let mut out = a.clone();',
      '-    for (key, entry) in b.entries() {',
      '-        out.insert(key, entry);',
      '+    for (key, entry) in b.entries() {',
      '+        let newer = out.get(key).map_or(true, |own| entry.stamp > own.stamp);',
      '+        if newer { out.insert(key, entry); }',
      '     }',
      '     out',
      ' }',
    ],
  },
  {
    header: '@@ -71,6 +73,9 @@ impl State',
    old: [71, 6],
    neu: [73, 9],
    rows: [
      ' fn settle(&mut self) {',
      '     self.entries.retain(|_, e| !e.dropped);',
      '+    for entry in self.entries.values_mut() {',
      '+        entry.stamp = entry.stamp.max(self.floor);',
      '+    }',
      '+    self.floor = self.floor.saturating_add(1);',
      ' }',
      ' ',
      ' #[cfg(test)]',
    ],
  },
]

/** A file's diff: two hunks, the same shape for every file, so the panel has a continuous diff to draw. */
export function parityDiff(path: string, staged: boolean): ScmDiffResult {
  const patch = HUNKS.map((hunk) => `${hunk.header}\n${hunk.rows.join('\n')}`).join('\n')
  return {
    path,
    staged,
    text: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${patch}\n`,
    hunks: HUNKS.map((hunk) => ({
      path,
      oldStart: hunk.old[0],
      oldCount: hunk.old[1],
      newStart: hunk.neu[0],
      newCount: hunk.neu[1],
      header: hunk.header,
      patch: hunk.rows.join('\n'),
    })),
  }
}
