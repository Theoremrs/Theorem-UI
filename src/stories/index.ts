// SOURCING: none: the list /stories.json serves and the story route looks up, kept free of components so the server route can read it. Each story's lane and reference are the license ledger's, docs/plans/evidence/ledger.md.
import { ACTIVITY_STATES } from './fixtures/activity'
import { ARTIFACT_STORIES } from './fixtures/artifacts'

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
  /** How closely the render is meant to match the reference, said plainly: the oracle prints it on the collage. */
  tolerance?: { threshold: number; note: string }
  /** A folder under docs/plans/evidence/ that holds this story's collage, when it has one of its own. */
  evidenceDir?: string
  /** Selected in the sidebar, the way a route would. */
  threadId?: string
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
  { id: 'workbench-terminal', title: 'Workbench: a recorded terminal session with an alternate screen and a resize', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-editor', title: 'Workbench: the editor with tabs, CJK, ZWJ emoji, a wrapped line and a selection', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-editor-conflict', title: 'Workbench: the editor with a disk conflict', lane: 'original', viewport: { width: 1280, height: 640 } },
  { id: 'workbench-changes', title: 'Workbench: Changes with a diff open and a commit draft', lane: 'original', viewport: { width: 1280, height: 640 } },
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
]

export const findStory = (id: string) =>
  STORIES.find((story) => story.id === id)
