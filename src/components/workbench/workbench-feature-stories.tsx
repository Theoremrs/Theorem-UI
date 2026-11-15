// SOURCING: none — the stories for features that existed in Rust with unit tests and had never been driven in a browser: the real wasm workbench over the fixture host (FixtureStory), driven by real key presses from the scenario; the stories add only committed texts, the host messages a controls button sends, and read-only hooks on `window` for the oracle (the semantic tree off the mounted handle, the whole effects). Nothing here is part of the product.
import { useEffect } from 'react'
import { useWorkbenchAgent } from '@/lib/workbench/agent/store'
import type { Effect } from '@/lib/workbench/wire'
import type { FixtureHost } from './fixture-host'
import { TREE } from './fixtures'
import { EVERY_TOOL, FixtureStory, open } from './workbench-story'

interface StoryNode {
  id: string
  role: string
  name: string
  actions: Array<{ id: string; enabled: boolean; reason?: string }>
  state: Record<string, unknown>
  text?: string
}

interface CatalogItem {
  action: string
  panel?: string | null
  title?: string
  intent?: string
  availability?: { type: string }
  humanOnly?: boolean
  [key: string]: unknown
}

declare global {
  interface Window {
    /** The core's semantic tree as the mounted handle gives it (what `workbench.read` returns). */
    __workbenchTree?: () => { nodes: StoryNode[] }
    /** Every effect the core asked the host for, whole, in order. */
    __workbenchEffectLog?: Effect[]
    /** The agent entry of the mounted core for one run, as the page's request path ends in: JSON of the receipt. */
    __workbenchAgentAct?: (
      action: string,
      runId: string,
      panel?: string,
    ) => string
    /** Every registered action as the agent's catalogue lists it (what `workbench.read` returns for `part: "catalog"`). */
    __workbenchCatalog?: () => CatalogItem[]
  }
}

const log: Effect[] = []
const record = (effect: Effect) => {
  log.push(effect)
}

/** The read-only hooks the oracle reads, for as long as a story is up. */
function Hooks() {
  useEffect(() => {
    log.length = 0
    window.__workbenchEffectLog = log
    window.__workbenchTree = () =>
      JSON.parse(
        useWorkbenchAgent.getState().handle?.semantics() ?? '{"nodes":[]}',
      )
    window.__workbenchAgentAct = (action, runId, panel) =>
      useWorkbenchAgent.getState().handle?.agent_act?.(action, runId, panel) ??
      ''
    window.__workbenchCatalog = () =>
      JSON.parse(useWorkbenchAgent.getState().handle?.agent_catalog?.() ?? '[]')
    return () => {
      window.__workbenchCatalog = undefined
      window.__workbenchTree = undefined
      window.__workbenchEffectLog = undefined
      window.__workbenchAgentAct = undefined
    }
  }, [])
  return null
}

type Props = Omit<
  Parameters<typeof FixtureStory>[0],
  'onEffect' | 'extra' | 'width' | 'height'
>

/** A fixture story at the size every workbench story is shown at, with the hooks. */
function FeatureStory(props: Props) {
  return (
    <FixtureStory
      {...props}
      width={1280}
      height={640}
      onEffect={record}
      extra={<Hooks />}
    />
  )
}

/** The person's key overrides (the core's `Overrides`, JSON): chords for actions that have none by default. */
export const bindings = (actions: Record<string, string>) =>
  JSON.stringify({
    version: 1,
    bind: Object.entries(actions).map(([chord, action]) => ({
      chord,
      context: { type: 'global' },
      action,
    })),
  })

// ---- Add Selection to chat (R43, AC-54, parity P12) ---------------------------------------

/** Twelve short numbered lines (one row each in the tools pane): a selection by keyboard has a start line to show. */
const LINES_TEXT =
  Array.from({ length: 12 }, (_, i) => `Line ${i + 1}: a fixture line.`).join(
    '\n',
  ) + '\n'

/** Three lines of about 2000 characters each: a whole-file selection is over the 4096-character excerpt limit. */
const LONG_TEXT =
  Array.from({ length: 3 }, (_, i) =>
    `${i + 1} ${'word '.repeat(400)}`.trimEnd(),
  ).join('\n') + '\n'

/** A control character, a right-to-left override, and isolates: nothing the grid may draw raw. */
export const HOSTILE_TEXT = [
  'plain first line',
  'esc \u001b[31m red ‮ gnp.txt ⁦ isolate ⁩ end',
  'bell \u0007 and a last line',
  '',
].join('\n')

/** A file name with a right-to-left override: it reads as `tricky` + `doc.txt` reversed. */
const TRICKY_PATH = 'docs/tricky\u202Etxt.cod'

const SELECTION_DOCUMENTS: Record<string, string> = {
  'docs/lines.txt': LINES_TEXT,
  'docs/long.txt': LONG_TEXT,
  'docs/hostile.txt': HOSTILE_TEXT,
  [TRICKY_PATH]:
    'a line in a file whose name hides its ending\nand a second line\n',
}

const SELECTION_TREE = {
  ...TREE,
  docs: {
    entries: [
      { name: 'guide.md', kind: 'file' as const },
      { name: 'hostile.txt', kind: 'file' as const },
      { name: 'lines.txt', kind: 'file' as const },
      { name: 'long.txt', kind: 'file' as const },
      { name: 'tricky\u202Etxt.cod', kind: 'file' as const },
    ],
  },
}

/**
 * `workbench-add-selection`: three text files and the guide, with the conversation beside them. The scenario
 * opens each from Files by key, selects with the keyboard and presses Alt+Q (`document.addSelection`, and
 * `markdown.addSelection` in the Markdown panel); the composer shows the reference and the send carries it.
 */
export function WorkbenchAddSelectionStory() {
  return (
    <FeatureStory
      id="workbench-add-selection"
      options={{
        granted: EVERY_TOOL,
        transcript: true,
        idle: true,
        tree: SELECTION_TREE,
        documents: SELECTION_DOCUMENTS,
      }}
      script={[]}
      wait={['README.md']}
    />
  )
}

// ---- Follow the agent (R34, R43, AC-54, parity P12) ---------------------------------------

/** Sixty numbered lines: an edit near the end is far below the first screen of the editor that shows it. */
const numbered = (name: string) =>
  Array.from(
    { length: 60 },
    (_, i) => `${name} ${i + 1}: a line of the work.`,
  ).join('\n') + '\n'

const TRACE_TEXT = numbered('Trace')
const OTHER_TEXT = numbered('Other')
const EXTRA_TEXT = numbered('Extra')

const FOLLOW_DOCUMENTS: Record<string, string> = {
  'docs/lines.txt': LINES_TEXT,
  'docs/trace.txt': TRACE_TEXT,
  'docs/other.txt': OTHER_TEXT,
  'docs/extra.txt': EXTRA_TEXT,
}

const FOLLOW_TREE = {
  ...TREE,
  docs: {
    entries: [
      { name: 'extra.txt', kind: 'file' as const },
      { name: 'guide.md', kind: 'file' as const },
      { name: 'lines.txt', kind: 'file' as const },
      { name: 'other.txt', kind: 'file' as const },
      { name: 'trace.txt', kind: 'file' as const },
    ],
  },
}

/** The person's chords for the two actions that have none by default. */
const FOLLOW_KEYS = bindings({
  'Mod+Alt+F5': 'follow.pause',
  'Mod+Alt+F6': 'follow.resume',
})

/** A run's edit: one insert at the start of a line. */
const edit = (path: string, line: number, run: string) => (host: FixtureHost) =>
  host.runEdits(path, run, line, 'AGENT ')

/**
 * `workbench-follow`: a run's edits to documents the person has not got focus in. The controls stand in for the
 * conversation owner naming the followed runs and for the document owner reporting a run's edit; the person's
 * keys do the rest (opening files, moving between panels, the two chords that pause and resume).
 */
export function WorkbenchFollowStory() {
  return (
    <FeatureStory
      id="workbench-follow"
      options={{
        granted: EVERY_TOOL,
        transcript: true,
        idle: true,
        tree: FOLLOW_TREE,
        documents: FOLLOW_DOCUMENTS,
      }}
      script={[{ host: (_, surface) => surface.setKeys(FOLLOW_KEYS) }]}
      wait={['README.md']}
      controls={{
        'follow-r1': (host) => host.followRuns(['r1']),
        'follow-none': (host) => host.followRuns([]),
        'r1-edits-trace': edit('docs/trace.txt', 45, 'r1'),
        'r1-edits-other': edit('docs/other.txt', 52, 'r1'),
        'r1-edits-extra': edit('docs/extra.txt', 48, 'r1'),
        'r1-edits-trace-end': edit('docs/trace.txt', 52, 'r1'),
        'r2-edits-trace-top': edit('docs/trace.txt', 3, 'r2'),
      }}
    />
  )
}

// ---- Document history and restore (R19, AC-22, parity P08) -------------------------------

/**
 * `workbench-document-history`: one text file, whose history the story's documents owner lists (a later and an
 * earlier draft) and restores. Everything is by key: Alt+V, the list, the preview, Enter asks, Enter restores.
 */
export function WorkbenchDocumentHistoryStory() {
  return (
    <FeatureStory
      id="workbench-document-history"
      options={{
        granted: EVERY_TOOL,
        transcript: true,
        idle: true,
        holdEdits: true,
        tree: FOLLOW_TREE,
        documents: FOLLOW_DOCUMENTS,
      }}
      script={[]}
      wait={['README.md']}
    />
  )
}

// ---- Registered alternate presentations (R48, AC-59) -------------------------------------

/** The person's chords for the two presentation actions, which have none by default. */
const PRESENTATION_KEYS = bindings({
  'Mod+Alt+F7': 'panel.presentation',
  'Mod+Alt+F8': 'panel.presentation.next',
})

/**
 * `workbench-presentation`: a document shown as the editor and as the Markdown panel, swapped in place by the
 * chooser ("Show as") and by the next presentation. A text file can only be shown by the editor.
 */
export function WorkbenchPresentationStory() {
  return (
    <FeatureStory
      id="workbench-presentation"
      options={{
        granted: EVERY_TOOL,
        transcript: true,
        idle: true,
        tree: FOLLOW_TREE,
        documents: FOLLOW_DOCUMENTS,
      }}
      script={[{ host: (_, surface) => surface.setKeys(PRESENTATION_KEYS) }]}
      wait={['README.md']}
    />
  )
}

// ---- Delegation changes panel (R17) -------------------------------------------------------

/**
 * The layout a person saved with the delegation's changes panel in the tools group: the three ids a delegation
 * panel is bound by. This is the way a delegation panel comes back after a reload; `workbench-delegation-from-chat`
 * is the way it is first opened.
 */
const DELEGATION_LAYOUT = JSON.stringify({
  dock: {
    groups: {
      '1': {
        active: 'p3',
        hidden: false,
        pinned_px: 224.0,
        role: 'files',
        tabs: [
          {
            kind: { name: 'files', version: 1 },
            panel: 'p3',
            title: 'Files',
            view_state: { expanded: [], scroll: 0, selected: null },
          },
        ],
      },
      '2': {
        active: 'p1',
        hidden: false,
        pinned_px: null,
        role: 'main',
        tabs: [
          {
            kind: { name: 'theo', version: 1 },
            panel: 'p1',
            title: 'Theo',
            view_state: {
              allOutput: false,
              anchor: null,
              conversation: 'story-thread',
              draft: { anchor: 0, caret: 0, references: [], text: '' },
              expanded: [],
              project: 'story-project',
            },
          },
        ],
      },
      '3': {
        active: 'p2',
        hidden: false,
        pinned_px: null,
        role: 'tools',
        tabs: [
          {
            kind: { name: 'delegation', version: 1 },
            panel: 'p2',
            title: 'Changes by delegation',
            view_state: { runId: 'run-1', delegationId: 'd1', path: '' },
          },
        ],
      },
    },
    layout: {
      focus: 3,
      next_id: 4,
      prev_focus: 2,
      root: {
        Split: {
          direction: 'Horizontal',
          first: { Pane: 1 },
          ratio: 0.2,
          second: {
            Split: {
              direction: 'Horizontal',
              first: { Pane: 2 },
              ratio: 0.5,
              second: { Pane: 3 },
            },
          },
        },
      },
    },
    maximized: null,
    schema: 'theorem.workbench.dock',
    version: 1,
  },
  pinned: [],
  schema: 'theorem.workbench',
  version: 1,
})

/**
 * `workbench-delegation`: a saved layout brings back the read-only changes panel bound to one delegation. The
 * fixture's delegation owner lists the changed files (with a hostile path and a long one) and gives the text on
 * each side where there is one.
 */
export function WorkbenchDelegationStory() {
  return (
    <FeatureStory
      id="workbench-delegation"
      options={{
        granted: EVERY_TOOL,
        transcript: true,
        idle: true,
        delegationHostile: true,
        layout: DELEGATION_LAYOUT,
      }}
      arrangements
      script={[]}
      wait={['README.md']}
    />
  )
}

/**
 * `workbench-delegation-from-chat`: the conversation's last answer made two delegations, and Theo lists them
 * under the transcript. Alt+D takes the keys into that list and Enter opens the chosen one's changes panel.
 */
export function WorkbenchDelegationFromChatStory() {
  return (
    <FeatureStory
      id="workbench-delegation-from-chat"
      options={{
        granted: EVERY_TOOL,
        transcript: true,
        idle: true,
        delegations: [
          {
            delegationId: 'd1',
            runId: 'run-1',
            label: 'Panel build',
            objective: 'Find why the panel build fails and fix it.',
            state: 'completed',
            verdict: 'accepted',
          },
          {
            delegationId: 'd2',
            runId: 'run-1',
            label: 'Docs',
            objective: 'Bring the guide in line with the new panel.',
            state: 'running',
          },
        ],
      }}
      script={[]}
      wait={['Delegations (2)']}
    />
  )
}

// ---- Replace across the workspace (R19 search, parity P05 and P07) ------------------------

/** The word the oracle searches for: it is in these four files and in no fixture file. */
const REPLACE_DOCUMENTS: Record<string, string> = {
  'docs/alpha.txt':
    'Zorp one and zorp two share a line.\nNothing on this one.\nzorp three\n',
  'docs/beta.txt': 'beta has a zorp\n',
  'docs/dirty.txt': 'a dirty zorp\n',
  'docs/gamma.txt': 'gamma: zorp\nlast zorp\n',
}

/**
 * `workbench-replace`: Search over four documents the documents owner holds, one of them opened with unsaved
 * changes. The documents owner answers open, edit, save and close with revisions; the controls slow its saves
 * (so a run is still working when the person presses Esc). Everything else is the person's keys.
 */
export function WorkbenchReplaceStory() {
  return (
    <FeatureStory
      id="workbench-replace"
      options={{
        granted: EVERY_TOOL,
        transcript: true,
        idle: true,
        documents: REPLACE_DOCUMENTS,
        dirty: ['docs/dirty.txt'],
      }}
      script={open('Search')}
      wait={['Search']}
      controls={{
        'slow-saves': (host) => host.slowSaves(2500),
        'fast-saves': (host) => host.slowSaves(0),
      }}
    />
  )
}
