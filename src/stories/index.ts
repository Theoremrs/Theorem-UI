// SOURCING: none: the list /stories.json serves and the story route looks up, kept free of components so the server route can read it. Each story's lane and reference are the license ledger's, docs/plans/evidence/ledger.md.
import { ACTIVITY_STATES } from './fixtures/activity'
import { ARTIFACT_STORIES } from './fixtures/artifacts'
import { SCENE_STORIES } from './fixtures/scenes'
import type { StoryRouteOptions } from './routes'
import { PALETTE_STORIES } from './palette-matrix'

export type StoryMeta = {
  id: string
  title: string
  lane: 'translation' | 'original'
  /** Under docs/plans/evidence/refs/; an original drawn to no reference has none, and the oracle skips it. */
  reference?: string
  /** Width and height the reference's region is read at. */
  viewport: { width: number; height: number }
  /** The region of the reference this story answers: left, top, width, height. */
  region?: readonly [number, number, number, number]
  /** The part of the render that answers the reference, when the story shows more than the component: left, top, width, height. The collage shows it at twice its size. */
  renderRegion?: readonly [number, number, number, number]
  /** How closely the render is meant to match the reference, said plainly: the oracle prints it on the collage. */
  tolerance?: { threshold: number; note: string }
  /** A folder under docs/plans/evidence/ that holds this story's collage, when it has one of its own. */
  evidenceDir?: string
  /** Selected in the sidebar, the way a route would. */
  threadId?: string
  /** How the fake Theorem answers this story. */
  routes?: StoryRouteOptions
}

const SIDEBAR_REF = 'sidebar-compare@2026-11-05.webp'
const CANVAS_REF = 'canvas-note-types@2026-11-05.png'
/** The coding-workspace mockup the person attached: the terminal against the code pane, and the fox. */
const CODING_REF = 'coding-workspace-mockup@2026-11-08.png'

export const STORIES: readonly StoryMeta[] = [
  {
    id: 'design-oracle-empty',
    title: 'Design oracle F01: empty conversation',
    lane: 'original',
    viewport: { width: 1440, height: 900 },
  },
  {
    id: 'assistant-math',
    title: 'assistant-ui: LaTeX math in a reply',
    lane: 'translation',
    viewport: { width: 1024, height: 768 },
  },
  {
    id: 'assistant-present',
    title: 'assistant-ui: a painted interface in a reply',
    lane: 'translation',
    viewport: { width: 1024, height: 768 },
  },
  {
    id: 'response-evidence',
    title: 'Interactive responses: a research answer with inspectable sources and a chart with its data',
    lane: 'original',
    viewport: { width: 1024, height: 900 },
  },
  {
    id: 'response-coding',
    title: 'Interactive responses: a coding answer keeping the failed step beside the fix',
    lane: 'original',
    viewport: { width: 1024, height: 768 },
  },
  {
    id: 'response-writing',
    title: 'Interactive responses: a draft whose claims carry evidence status',
    lane: 'original',
    viewport: { width: 1024, height: 768 },
  },
  {
    id: 'settings-appearance',
    title: 'Settings: Appearance with the per-role palette color editors',
    lane: 'original',
    viewport: { width: 1024, height: 900 },
  },
  {
    id: 'assistant-context-usage',
    title: 'assistant-ui: context usage ring beside the composer',
    lane: 'translation',
    viewport: { width: 1024, height: 768 },
  },
  {
    id: 'design-oracle-long',
    title: 'Design oracle F02: fixed Latin calibration prose',
    lane: 'original',
    viewport: { width: 1440, height: 900 },
  },
  { id: 'design-oracle-preview', title: 'Design oracle F03: collapsed message preview', lane: 'original', viewport: { width: 1024, height: 768 } },
  { id: 'design-oracle-content', title: 'Design oracle F04: code, table and long URL', lane: 'original', viewport: { width: 1024, height: 768 } },
  { id: 'design-oracle-draft', title: 'Design oracle F05: composer draft and controls', lane: 'original', viewport: { width: 1440, height: 900 } },
  { id: 'design-oracle-stream', title: 'Design oracle F06: active stream actions', lane: 'original', viewport: { width: 1440, height: 900 } },
  { id: 'design-oracle-failure', title: 'Design oracle F07: failure and recovery', lane: 'original', viewport: { width: 1024, height: 768 } },
  { id: 'design-oracle-navigation', title: 'Design oracle F08: selected navigation states', lane: 'original', viewport: { width: 1440, height: 900 }, threadId: 'thread-app-gallery' },
  { id: 'design-oracle-reflow', title: 'Design oracle F09: scale and narrow reflow', lane: 'original', viewport: { width: 390, height: 844 } },
  { id: 'design-oracle-rtl', title: 'Design oracle F10: RTL and CJK fallback', lane: 'original', viewport: { width: 390, height: 844 } },
  { id: 'design-oracle-continuity', title: 'Design oracle F11: draft continuity', lane: 'original', viewport: { width: 1440, height: 900 } },
  {
    id: 'workbench-default',
    title: 'Workbench: Files, main and tools with the picker',
    lane: 'original',
    viewport: { width: 1280, height: 640 },
  },
  { id: 'workbench-files', title: 'Workbench: Files with a symlink, ignored, hidden and partial listing', lane: 'original', viewport: { width: 1280, height: 640 } },
  {
    id: 'workbench-threads',
    title: 'Workbench: the Threads panel over three projects, a pinned thread, children and delegations, running, needs-you, unread and archived threads, a hostile title and four Herdr sessions',
    lane: 'translation',
    reference: 'workbench-threads@delta-sidebar.png',
    viewport: { width: 1280, height: 640 },
    // The Threads pane of the default layout; the reference is the whole of the Delta sidebar.
    renderRegion: [0, 0, 228, 640],
    tolerance: {
      threshold: 0.2,
      note: 'Organization reference, not a pixel target: sections, nesting, state marks and times follow the reference; colors, fonts, metrics and the Herdr section differ by design (a cell grid in a mono face against a proportional UI). The differing share is reported, never a verdict.',
    },
    evidenceDir: 'workbench-threads',
  },
  {
    id: 'workbench-default-arrangement',
    title: 'Workbench: a fresh workbench with every capability granted: Threads on the left, Theo in the middle, Changes then Files on the right',
    lane: 'translation',
    reference: 'workbench-default-arrangement@delta-2026-11-15.png',
    viewport: { width: 1280, height: 640 },
    tolerance: {
      threshold: 0.2,
      note: 'Arrangement reference, not a pixel target: the blurred frame shows which groups stand where and roughly how wide; contents, colors and metrics differ by design. The differing share is reported, never a verdict.',
    },
    evidenceDir: 'workbench-default-arrangement',
  },
  {
    id: 'workbench-delta-parity',
    title: 'Workbench: Threads, Theo and Changes over an invented fixture at the reference size, in the colour ladder',
    lane: 'translation',
    reference: 'workbench-delta-parity@delta-2026-11-15.png',
    viewport: { width: 1568, height: 914 },
    tolerance: {
      threshold: 0.2,
      note: 'Colour-ladder reference, not a pixel target: the blurred frame shows the surface steps and where the registers sit; contents and metrics differ by design. The differing share is reported, never a verdict.',
    },
    evidenceDir: 'workbench-delta-parity',
  },
  {
    id: 'workbench-changes-review',
    title: 'Workbench: the Changes panel as a Review, twelve invented files in five folders at the reference size',
    lane: 'translation',
    reference: 'workbench-changes-review@delta-2026-11-15.png',
    viewport: { width: 1568, height: 914 },
    tolerance: {
      threshold: 0.2,
      note: 'Layout reference, not a pixel target: the blurred frame shows where the diff, the tree and the sticky headers stand; contents and metrics differ by design. The differing share is reported, never a verdict.',
    },
    evidenceDir: 'workbench-changes-review',
  },
  {
    id: 'workbench-theo-blocks',
    title: 'Workbench: the Theo transcript as blocks (thinking, a folded turn, a running command, diffs streaming, a fenced block, the person\'s message) over an invented fixture at the reference size',
    lane: 'translation',
    reference: 'workbench-theo-blocks@delta-2026-11-15.png',
    viewport: { width: 1568, height: 914 },
    tolerance: {
      threshold: 0.2,
      note: 'Layout reference, not a pixel target: the blurred frame shows how the summary line, the thinking headers and the outlined running command stand in the transcript; contents, colours and metrics differ by design. The differing share is reported, never a verdict.',
    },
    evidenceDir: 'workbench-theo-blocks',
  },
  {
    id: 'workbench-theo-composer',
    title: 'Workbench: the Theo composer during a working run (messages sent mid-turn over the box, a waiting approval pinned over it, an answered approval\'s receipt, the footer under it) over an invented fixture at the reference size',
    lane: 'translation',
    reference: 'workbench-theo-composer@delta-2026-11-15.png',
    viewport: { width: 1568, height: 914 },
    tolerance: {
      threshold: 0.2,
      note: 'Layout reference, not a pixel target: the blurred frame shows how the queued messages, the approval and the footer stand around the composer; contents, colours and metrics differ by design. The differing share is reported, never a verdict.',
    },
    evidenceDir: 'workbench-theo-composer',
  },
  { id: 'workbench-delta-parity-before', title: 'Workbench: the same fixture as workbench-delta-parity in the colours from before the ladder', lane: 'translation', viewport: { width: 1568, height: 914 } },
  { id: 'workbench-threads-withheld', title: 'Workbench: the Threads panel where the host grants no delete, tags, pin or admission', lane: 'translation', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-terminal', title: 'Workbench: a recorded terminal session with an alternate screen and a resize', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-terminal-adoption-pending', title: 'Workbench: the Shell chooser while the host is still looking for terminals', lane: 'original', viewport: { width: 1600, height: 640 } },
  { id: 'workbench-terminal-adoption-unavailable', title: 'Workbench: the Shell chooser when the host cannot list its terminals, with a reason', lane: 'original', viewport: { width: 1600, height: 640 } },
  { id: 'workbench-terminal-adoption-settled', title: 'Workbench: the Shell chooser when the host has settled and has no terminals', lane: 'original', viewport: { width: 1600, height: 640 } },
  { id: 'workbench-editor', title: 'Workbench: the editor with tabs, CJK, ZWJ emoji, a wrapped line and a selection', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-editor-conflict', title: 'Workbench: the editor with a disk conflict', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-markdown-visual', title: 'Workbench: the Markdown panel in visual mode', lane: 'original', viewport: { width: 1280, height: 700 } },
  { id: 'workbench-markdown-source', title: 'Workbench: the Markdown panel in source mode', lane: 'original', viewport: { width: 1280, height: 700 } },
  { id: 'workbench-markdown-split', title: 'Workbench: the Markdown panel in split mode', lane: 'original', viewport: { width: 1280, height: 700 } },
  { id: 'workbench-markdown-preview', title: 'Workbench: the Markdown panel in preview mode', lane: 'original', viewport: { width: 1280, height: 700 } },
  { id: 'workbench-branches', title: 'Workbench: a reply with two branches, switched through the owner', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-search', title: 'Workbench: Search with matches in two files, one after CJK text', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-diagnostics', title: 'Workbench: Diagnostics for two open documents, every severity', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-run', title: 'Workbench: a finished run attached from the host list, with coloured output', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-run-list', title: 'Workbench: the list of runs on the host', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-terminal-program-report', title: 'Workbench: a program\'s own status report in the terminal pane, apart from the pane\'s state', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-run-list-exits', title: 'Workbench: the host run list with exit codes 0, 2 and none, and each run kind', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-recovery-reload', title: 'Workbench: edits kept on this device are offered back after a reload', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-cabinet', title: 'Workbench: the Artifacts panel with cards and previews over the grid', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-cabinet-picker', title: 'Workbench: Artifacts opened from the picker by key', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-face', title: 'Workbench: Theo face on the status row of the Theo panel, dark', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-face-custom', title: 'Workbench: Theo face on a custom warm palette', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-account-switch', title: 'Workbench: a draft, then another account is signed in', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-device-copy', title: 'Workbench: the layout read from this device, labelled, saving refused', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-arrangements', title: 'Workbench: presets applied by key and a saved arrangement kept across a reload', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-changes-binary-conflict', title: 'Workbench: Changes with a conflicted binary file, sides not shown as text', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-appearance', title: 'Workbench: a saved layout carries its theme; applying it restores the theme, a preset does not', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-layouts-page',title: 'Workbench: the Layouts page of the picker: save, apply, rename and delete a layout by key', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-agent-operations', title: 'Workbench: the agent reads the workbench and acts on it through two client operations', lane: 'original', viewport: { width: 1600, height: 640 } },
  { id: 'workbench-add-selection', title: 'Workbench: Add Selection to chat from the editor and the Markdown panel, a reference in the composer and on the send', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-follow', title: 'Workbench: Follow the agent, a followed run\'s edit shown in a panel without taking the keyboard, paused by the person\'s own navigation and resumed', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-document-history', title: 'Workbench: a document\'s history drawer, the points listed and previewed, a restore asked first and refused while an edit is unaccepted or when the agent asks', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-presentation', title: 'Workbench: a document shown another way, the Show as chooser and the next presentation swapped in place, refused with unsaved changes', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-delegation', title: 'Workbench: a delegation changes panel brought back by a saved layout, the changed files with their letters, the before and after of one, a missing side said in words, hostile paths escaped', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-delegation-from-chat', title: 'Workbench: the delegations a conversation made, listed under the transcript; Alt+D chooses one and Enter opens its changes panel', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-replace', title: 'Workbench: Replace across the workspace from Search, asked with a preview, confirmed, run file by file, with a dirty file skipped, stopped between files and summarised', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-resize', title: 'Workbench: the window resized through three sizes, then the text enlarged, without clipping', lane: 'original', viewport: { width: 1440, height: 900 } },
  { id: 'workbench-keyboard-journey', title: 'Workbench: the keyboard-only journey (tools, a document, changes, a pane, an approval, a terminal) and paste and copy on each surface', lane: 'original', viewport: { width: 1440, height: 900 } },
  { id: 'workbench-changes', title: 'Workbench: Changes with a diff open and a commit draft', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-semantic-overlay', title: 'Workbench: the accessible overlay over the grid, read through the browser accessibility tree', lane: 'original', viewport: { width: 1280, height: 640 } },
  {
    id: 'workbench-picker',
    title: 'Workbench: the tool picker in two columns',
    lane: 'translation',
    reference: 'workbench-picker@spec-1.0.png',
    // The reference is 2048x454; the render is its aspect at a width that gives the tools pane 86+ cells.
    viewport: { width: 2304, height: 512 },
    tolerance: {
      threshold: 0.2,
      note: 'Hierarchy and interaction reference, not a pixel target: colors, fonts and metrics differ by design (cell grid in a mono face against a proportional UI). The differing share is reported, never a verdict.',
    },
    evidenceDir: 'workbench-picker',
  },
  {
    id: 'organized-sidebar',
    title: 'Organized sidebar',
    lane: 'translation',
    reference: SIDEBAR_REF,
    viewport: { width: 354, height: 1064 },
    region: [59, 0, 354, 1064],
    threadId: 'thread-app-gallery',
  },
  {
    id: 'populated-shell',
    title: 'Populated shell: pins, a long reply with a table and code, the composer and its + menu',
    lane: 'original',
    viewport: { width: 1440, height: 900 },
    threadId: 'thread-app-gallery',
    routes: { populated: true, reviewless: true },
  },
  { id: 'project-home', title: 'Project home: composer, sessions and context on one page', lane: 'original', viewport: { width: 1440, height: 900 } },
  { id: 'session-graph', title: 'Session graph on the canvas: forks from the main, connections, outputs, Make main chat and saved views', lane: 'original', viewport: { width: 1440, height: 900 } },
  {
    id: 'librarian-footer',
    title: 'Librarian footer',
    lane: 'original',
    reference: SIDEBAR_REF,
    viewport: { width: 354, height: 110 },
    region: [59, 855, 354, 110],
  },
  {
    id: 'compare-pane',
    title: 'Compare pane',
    // Drawn to the owner's sketch of 2026-11-11 (option rows, one preview,
    // Write feedback), which was attached in chat and is not in the repo. The
    // 2026-11-05 reference shows the earlier cards, so the oracle skips this.
    lane: 'original',
    viewport: { width: 380, height: 760 },
  },
  {
    id: 'compare-pane-standalone',
    title: 'Compare pane with shared sidecar composer',
    lane: 'original',
    viewport: { width: 380, height: 900 },
  },
  {
    id: 'review-card',
    title: 'Review card',
    lane: 'translation',
    reference: SIDEBAR_REF,
    viewport: { width: 575, height: 80 },
    region: [471, 370, 575, 80],
  },
  {
    id: 'note-kinds',
    title: 'Note kinds',
    lane: 'original',
    reference: CANVAS_REF,
    viewport: { width: 1280, height: 1000 },
  },
  {
    id: 'program-note',
    title: 'Note on the program canvas',
    lane: 'original',
    reference: CANVAS_REF,
    viewport: { width: 900, height: 600 },
  },
  {
    id: 'response-details',
    title: 'Response details for a reply',
    lane: 'original',
    viewport: { width: 760, height: 620 },
  },
  {
    id: 'response-styles-settings',
    title: 'Settings, response styles',
    lane: 'original',
    viewport: { width: 760, height: 900 },
  },
  {
    id: 'canvas-note-types',
    title: 'Canvas with typed notes',
    lane: 'original',
    reference: CANVAS_REF,
    viewport: { width: 1440, height: 900 },
  },
  {
    id: 'conversation-wide',
    title: 'Conversation on a wide sheet',
    lane: 'original',
    reference: CODING_REF,
    viewport: { width: 1600, height: 1000 },
    threadId: 'thread-app-gallery',
  },
  {
    id: 'glass-compare',
    title: 'Glass materials over the Life field',
    lane: 'original',
    viewport: { width: 1440, height: 900 },
    threadId: 'thread-app-gallery',
  },
  {
    id: 'face-feel',
    title: 'Tuning how Theo moves',
    lane: 'original',
    viewport: { width: 900, height: 1000 },
  },
  {
    id: 'shell-compare',
    title: 'Shell with Compare open',
    lane: 'translation',
    reference: SIDEBAR_REF,
    viewport: { width: 1479, height: 1064 },
    threadId: 'thread-app-gallery',
  },
  {
    id: 'shell-navigation',
    title: 'Phone navigation across Vault and Notes',
    lane: 'original',
    viewport: { width: 390, height: 844 },
  },
  {
    id: 'notes-workspace',
    title: 'Notes with several notes open side by side',
    lane: 'original',
    viewport: { width: 1440, height: 900 },
  },
  {
    id: 'settings-ai',
    title: 'AI settings and model table',
    lane: 'original',
    viewport: { width: 1920, height: 1080 },
  },
  {
    id: 'settings-responses',
    title: 'Response defaults: style, detail, effort and budgets',
    lane: 'original',
    viewport: { width: 1440, height: 900 },
  },
  {
    id: 'chromeless-gray-scott',
    title: 'Chromeless artifacts: the Gray–Scott App in a reply, as the model wrote it',
    lane: 'original',
    viewport: { width: 1280, height: 1100 },
  },
  {
    id: 'chromeless-study-strip',
    title: 'Chromeless artifacts study A: the picture, a caption, one strip of controls; host actions over the corner',
    lane: 'original',
    viewport: { width: 1280, height: 1100 },
  },
  {
    id: 'chromeless-study-inspector',
    title: 'Chromeless artifacts study B: an inspector beside the picture; host actions beneath',
    lane: 'original',
    viewport: { width: 1280, height: 1100 },
  },
  {
    id: 'chromeless-study-overlay',
    title: 'Chromeless artifacts study C: the picture alone, controls over it on demand; host actions over the corner',
    lane: 'original',
    viewport: { width: 1280, height: 1100 },
  },
  {
    id: 'cpu-gpu-tradeoff',
    title: 'CPU or GPU: the tradeoff notebook',
    lane: 'original',
    viewport: { width: 960, height: 1500 },
  },
  {
    id: 'cpu-gpu-measured',
    title: 'CPU or GPU: measured timings, CPU-only run',
    lane: 'original',
    viewport: { width: 960, height: 1400 },
  },
  {
    id: 'cpu-gpu-awaiting-gpu',
    title: 'CPU or GPU: timings awaiting a GPU host',
    lane: 'original',
    viewport: { width: 960, height: 400 },
  },
  {
    id: 'cpu-gpu-model',
    title: 'CPU or GPU: the cost model in Python, runnable in the browser',
    lane: 'original',
    viewport: { width: 960, height: 900 },
  },
  {
    id: 'composer-paper',
    title: 'Composer on paper, new conversation',
    lane: 'original',
    viewport: { width: 760, height: 560 },
  },
  {
    id: 'composer-markdown',
    title: 'Composer holding formatted Markdown',
    lane: 'original',
    viewport: { width: 760, height: 760 },
  },
  {
    id: 'chat-program',
    title: 'A program the agent wrote',
    lane: 'original',
    viewport: { width: 760, height: 560 },
  },
  ...ACTIVITY_STATES.map((state): StoryMeta => ({
    id: `activity-${state}`,
    title: `Activity line: ${state}`,
    lane: 'original',
    viewport: { width: 760, height: 560 },
  })),
  {
    id: 'activity-approval-high',
    title: 'Activity line: an approval Theorem marks high risk',
    lane: 'original',
    viewport: { width: 760, height: 560 },
  },
  {
    id: 'face-bench',
    title: 'Theo: the bench, every way to move the face',
    lane: 'original',
    viewport: { width: 1000, height: 620 },
  },
  {
    id: 'face-book',
    title: 'Theo: every performance in the book, stopped at its fullest',
    lane: 'original',
    viewport: { width: 780, height: 860 },
  },
  {
    id: 'face-in-shell',
    title: 'Theo in the shell, beside Kit',
    lane: 'original',
    viewport: { width: 1280, height: 800 },
    threadId: 'thread-app-gallery',
  },
  {
    id: 'face-visit',
    title: 'Theo on a page with an artifact, to visit',
    lane: 'original',
    viewport: { width: 1280, height: 800 },
  },
  {
    id: 'face-point',
    title: 'Theo on a page with things to point at',
    lane: 'original',
    viewport: { width: 1280, height: 800 },
  },
  {
    id: 'face-sound',
    title: 'Theo on a page with a reply to read aloud',
    lane: 'original',
    viewport: { width: 1280, height: 800 },
  },
  {
    id: 'face-listen',
    title: 'Theo as a microphone, listening to the person',
    lane: 'original',
    viewport: { width: 1280, height: 800 },
  },
  {
    id: 'theo-face-inverse',
    title: 'Theo on the terminal surface: inverse face in dark, light and a custom palette',
    lane: 'translation',
    reference: 'theo-face@7fa8fcb3.png',
    viewport: { width: 1000, height: 600 },
    tolerance: {
      threshold: 0.2,
      note: 'The reference is the chat face (bare light eyes on dark, dark visor on light); the render is its terminal inverse. They are meant to differ: the collage shows the expression and shape are the same, not that the colours match.',
    },
    evidenceDir: 'theo-face-inverse',
  },
  {
    id: 'tool-pills',
    title: 'Tool calls: done, failed and running',
    lane: 'original',
    viewport: { width: 760, height: 560 },
  },
  {
    id: 'plan-card',
    title: "Plan card: the harness plan as drafted, in the thread",
    lane: 'original',
    viewport: { width: 1280, height: 900 },
  },
  {
    id: 'plan-card-under-way',
    title: 'Plan card: the harness plan under way, one task deviating',
    lane: 'original',
    viewport: { width: 1280, height: 720 },
  },
  {
    id: 'tool-calls-check',
    title: 'Tool calls: an App check with its problems',
    lane: 'original',
    viewport: { width: 760, height: 560 },
  },
  ...ARTIFACT_STORIES.map(({ id, title }): StoryMeta => ({
    id,
    title: `Artifact: ${title}`,
    lane: 'original',
    viewport: { width: 760, height: 900 },
  })),
  ...SCENE_STORIES.map(({ id, title }): StoryMeta => ({
    id,
    title: `Scene: ${title}`,
    lane: 'original',
    viewport: { width: 1280, height: 900 },
  })),
  ...PALETTE_STORIES,
]

export const findStory = (id: string) =>
  STORIES.find((story) => story.id === id)
