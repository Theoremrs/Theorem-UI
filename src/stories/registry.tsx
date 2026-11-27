// SOURCING: the real components, wrapped only in the providers the app itself gives them. Loaded lazily by the story route so none of this reaches production. Artifact stories hand a committed OpenUI program to the thread's own part renderers inside an assistant-ui external-store message; the activity and composer stories hand committed messages to the thread itself the same way, converted by the SDK's toAssistantMessages.
import { AppearanceControls } from './appearance-controls'
import { ReactFlow, ReactFlowProvider, applyNodeChanges } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { lazy, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
} from '@tanstack/react-router'
import type { ComponentType } from 'react'
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import type { ReadonlyJSONObject } from 'assistant-stream/utils'
import { toAssistantMessages } from '@theoremharness/sdk/assistant-ui'
import { Thread } from '@/components/assistant-ui/elements/thread.aui'
import {
  ARTIFACT_PART,
  readArtifact,
} from '@/components/artifacts/artifact-model'
import {
  codingMessages,
  evidenceMessages,
  writingMessages,
} from './fixtures/responses'
import { ArtifactPanel } from '@/components/artifacts/artifact-panel'
import { useArtifactView } from '@/components/artifacts/artifact-view'
import {
  LIBRARY_ID,
  LIBRARY_VERSION,
} from '@/components/artifacts/openui/library'
import { Canvas } from '@/components/canvas/canvas'
import { FaceBench, FaceBook } from '@/components/face/face-bench'
import { FaceStage } from '@/components/face/face-stage'
import { TheoFaceInverse } from '@/components/face/terminal-face-story'
import { CommandTerminalLiveStory } from '@/components/terminal/command-terminal-story'
import { CellsTerminalStory } from '@/components/terminal/cells-terminal-story'
import { speechAdapter } from '@/lib/speech/adapter'
import { theFace } from '@/lib/face/store'
import { useMicLevel } from '@/lib/speech/dictation'
import { NoteNodeView } from '@/components/program/program-annotations'
import { NoteEditor } from '@/components/notes/note-editor'
import { NoteExcerpt } from '@/components/notes/note-excerpt'
import { TheoremPartRenderers } from '@/components/chat/theorem-parts'
import type { Theorem } from '@/lib/theorem/client'
import { ComparePane } from '@/components/review/compare-pane'
import { ReviewCard } from '@/components/review/review-card'
import { LibrarianFooter } from '@/components/organize/librarian-footer'
import { ContextPanel } from '@/components/shell/sidebar'
import { CommandPalette } from '@/components/shell/command-palette'
import { ChatShell } from '@/components/shell/chat-shell'
import { LifeBackdrop } from '@/components/life/life-backdrop'
import { GlassCompareStory } from './glass-compare'
import {
  WorkbenchBranchesStory,
  WorkbenchChangesStory,
  WorkbenchSearchStory,
  WorkbenchDiagnosticsStory,
  WorkbenchRunStory,
  WorkbenchRunListStory,
  WorkbenchCabinetStory,
  WorkbenchCabinetPickerStory,
  WorkbenchFaceStory,
  WorkbenchFaceCustomStory,
  WorkbenchAccountSwitchStory,
  WorkbenchDeviceCopyStory,
  WorkbenchArrangementsStory,
  WorkbenchDefaultStory,
  WorkbenchEditorConflictStory,
  WorkbenchEditorStory,
  WorkbenchMarkdownPreviewStory,
  WorkbenchMarkdownSourceStory,
  WorkbenchMarkdownSplitStory,
  WorkbenchMarkdownVisualStory,
  WorkbenchPickerStory,
  WorkbenchTerminalStory,
} from '@/components/workbench/workbench-story'
import { WorkbenchTerminalProgramReportStory } from '@/components/workbench/workbench-program-report-story'
import { WorkbenchAppearanceStory } from '@/components/workbench/workbench-appearance-story'
import { WorkbenchSemanticOverlayStory } from '@/components/workbench/workbench-semantic-overlay-story'
import {
  WorkbenchChangesBinaryConflictStory,
  WorkbenchLayoutsPageStory,
  WorkbenchRunListExitsStory,
  WorkbenchRecoveryReloadStory,
  WorkbenchTerminalAdoptionPendingStory,
  WorkbenchTerminalAdoptionSettledStory,
  WorkbenchTerminalAdoptionUnavailableStory,
} from '@/components/workbench/workbench-state-stories'
import { WorkbenchAgentOperationsStory } from '@/components/workbench/workbench-agent-story'
import {
  WorkbenchAddSelectionStory,
  WorkbenchFollowStory,
  WorkbenchDocumentHistoryStory,
  WorkbenchPresentationStory,
  WorkbenchDelegationStory,
  WorkbenchDelegationFromChatStory,
  WorkbenchReplaceStory,
  WorkbenchThreadsStory,
  WorkbenchFilesStory,
  WorkbenchThreadsWithheldStory,
  WorkbenchDefaultArrangementStory,
} from '@/components/workbench/workbench-feature-stories'
import { WorkbenchResizeStory } from '@/components/workbench/workbench-resize-story'
import { WorkbenchKeyboardJourneyStory } from '@/components/workbench/workbench-keyboard-journey-story'
import { PALETTE_MATRIX_REGISTRY } from '@/components/workbench/workbench-palette-stories'
import { FaceFeel } from '@/components/face/face-feel'
import { useNote } from '@/lib/theorem/notes'
import { useOrganization } from '@/lib/theorem/organization'
import type { NoteFlowNode } from '@/lib/program/flow'
import { TheoremRuntimeProvider } from '@/lib/theorem/runtime'
import { useReview } from '@/lib/theorem/reviews'
import { useSidebarPrefs } from '@/lib/theorem/sidebar-prefs'
import { POPULATED_PINS } from './fixtures/populated'
import {
  ACTIVITY_STATES,
  activityMessages,
  appCheckMessages,
  toolPillMessages,
  codeBlockMessages,
} from './fixtures/activity'
import type { ActivityState } from './fixtures/activity'
import { ARTIFACT_STORIES } from './fixtures/artifacts'
import { SCENE_STORY_RENDERS } from './scene-stories'
import type { ArtifactStory } from './fixtures/artifacts'
import {
  ResponseDetailsStory,
  ResponseStylesSettingsStory,
} from './response-styles-stories'
import { documentFixtures } from './fixtures/notes'
import { PROGRAM_PART } from './fixtures/program'
import { pointingMessages } from './fixtures/pointing'
import { PLAN_ARGS, PLAN_RESULT, PLAN_UNDER_WAY } from './fixtures/plan'
import { PlanGraph } from '@/components/chat/plan-graph'

import { ArtifactView } from '@/components/artifacts/artifact-renderers'
import { NOTEBOOK_DOCUMENTS, notebookPart } from './fixtures/notebook-parts'
import { LATIN_PROSE_V1_PARAGRAPHS } from '@/lib/appearance-corpus.mjs'
import {
  WorkbenchDeltaParityBeforeStory,
  WorkbenchDeltaParityStory,
} from '@/components/workbench/workbench-delta-parity-story'
import { WorkbenchChangesReviewStory } from '@/components/workbench/workbench-review-story'
import { WorkbenchTheoBlocksStory } from '@/components/workbench/workbench-theo-blocks-story'
import { WorkbenchTheoComposerStory } from '@/components/workbench/workbench-theo-composer-story'
import GRAY_SCOTT from './fixtures/gray-scott.html?raw'
import { GRAY_SCOTT_KIT } from './fixtures/gray-scott-kit'
import { KIT_CONTROLS, kitControlApp } from './fixtures/kit-controls'
import { FRAME_COUNTER } from './fixtures/frame-counter'
import { grayScottDirection } from './fixtures/gray-scott-study'
import type { GrayScottDirection } from './fixtures/gray-scott-study'

// The table's settings route is not needed to boot every conversation fixture.
const SettingsAiStory = lazy(() =>
  import('./settings-ai').then((module) => ({
    default: module.SettingsAiStory,
  })),
)

function WithRuntime({
  children,
  initialThreadId = 'thread-app-gallery',
}: {
  /** A function child is given the thread the runtime has open. */
  children:
    React.ReactNode | ((threadId: string | undefined) => React.ReactNode)
  initialThreadId?: string
}) {
  const [threadId, setThreadId] = useState<string | undefined>(
    initialThreadId || undefined,
  )
  return (
    <TheoremRuntimeProvider
      projectId="project-theorem"
      threadId={threadId}
      onThreadIdChange={setThreadId}
    >
      {typeof children === 'function' ? children(threadId) : children}
    </TheoremRuntimeProvider>
  )
}

function OrganizedSidebarStory() {
  return (
    <WithRuntime>
      <div className="h-dvh w-[354px] bg-sidebar">
        <ContextPanel />
      </div>
    </WithRuntime>
  )
}

function LibrarianFooterStory() {
  const { data } = useOrganization()
  if (!data) return null
  return (
    <div className="w-[354px] bg-sidebar">
      <LibrarianFooter librarian={data.librarian} />
    </div>
  )
}

function ComparePaneStory({ standalone = false }: { standalone?: boolean }) {
  return (
    <WithRuntime>
      <div className="h-dvh w-[380px]">
        <ComparePane
          standalone={standalone}
          reviewId="review-app-gallery"
          onClose={() => undefined}
          onDetach={() => undefined}
          onExpandedChange={() => undefined}
        />
      </div>
    </WithRuntime>
  )
}

function ReviewCardStory() {
  const { data } = useReview('review-app-gallery')
  if (!data) return null
  return (
    <div className="w-[575px] p-4">
      <ReviewCard review={data} />
    </div>
  )
}

/**
 * The whole shell as a person with work in it sees it: three pins on the
 * shelf, projects and recent chats, and a long reply with a table, inline
 * code and a code block above the composer. The design overhaul's fixture.
 */
function PopulatedShellStory() {
  // The shelf is persisted, so the person's own pins come back when the story
  // closes; set before paint, the first frame already shows the fixture's.
  useLayoutEffect(() => {
    const { pins } = useSidebarPrefs.getState()
    useSidebarPrefs.setState({ pins: POPULATED_PINS })
    return () => {
      useSidebarPrefs.setState({ pins })
    }
  }, [])
  return (
    <WithRuntime>
      <ChatShell projectId="project-theorem" threadId="thread-app-gallery" />
    </WithRuntime>
  )
}

function NewChatStory() {
  return (
    <WithRuntime initialThreadId="">
      {(threadId) => (
        <>
          <ChatShell projectId="project-theorem" threadId={threadId} />
          <CommandPalette />
        </>
      )}
    </WithRuntime>
  )
}

function ShellCompareStory() {
  return (
    <WithRuntime>
      <ChatShell projectId="project-theorem" threadId="thread-app-gallery" />
      <div className="fixed right-2 top-2 z-40" data-story-appearance-controls>
        <AppearanceControls />
      </div>
    </WithRuntime>
  )
}

/** Real mode routes over the story transport, without leaving the fixture. */
function ShellNavigationStory() {
  const [router] = useState(() => {
    const root = createRootRoute({ component: Outlet })
    const shell = createRoute({
      getParentRoute: () => root,
      id: '_chat',
      component: ShellNavigationFrame,
    })
    return createRouter({
      routeTree: root.addChildren([
        shell.addChildren(
          ['/', 'vault', 'notes', 'notes/$documentId'].map((path) =>
            createRoute({ getParentRoute: () => shell, path }),
          ),
        ),
      ]),
      history: createMemoryHistory({ initialEntries: ['/vault'] }),
    })
  })
  return <RouterProvider router={router} />
}

/** Notes mode at desktop width over the story transport, with a note open and no review beside it. */
function NotesWorkspaceStory() {
  const [router] = useState(() => {
    const root = createRootRoute({ component: Outlet })
    const shell = createRoute({
      getParentRoute: () => root,
      id: '_chat',
      component: NotesWorkspaceFrame,
    })
    return createRouter({
      routeTree: root.addChildren([
        shell.addChildren(
          ['/', 'notes', 'notes/$documentId'].map((path) =>
            createRoute({ getParentRoute: () => shell, path }),
          ),
        ),
      ]),
      history: createMemoryHistory({ initialEntries: ['/notes/doc-proposal'] }),
    })
  })
  return <RouterProvider router={router} />
}

/** A project's page in the real shell: the projects route over the story transport. */
function ProjectHomeStory() {
  const [router] = useState(() => {
    const root = createRootRoute({ component: Outlet })
    const shell = createRoute({
      getParentRoute: () => root,
      id: '_chat',
      component: ShellCompareStory,
    })
    return createRouter({
      routeTree: root.addChildren([
        shell.addChildren([
          createRoute({
            getParentRoute: () => shell,
            path: 'projects/$projectId',
          }),
          createRoute({ getParentRoute: () => shell, path: 'c/$threadId' }),
        ]),
      ]),
      history: createMemoryHistory({
        initialEntries: ['/projects/project-theorem'],
      }),
    })
  })
  return <RouterProvider router={router} />
}

/** A project's session graph on the canvas, in the real shell: Theorem's graph read, Make main chat and saved views over the story transport. */
function SessionGraphStory() {
  const [router] = useState(() => {
    const root = createRootRoute({ component: Outlet })
    const shell = createRoute({
      getParentRoute: () => root,
      id: '_chat',
      component: ShellCompareStory,
    })
    return createRouter({
      routeTree: root.addChildren([
        shell.addChildren(
          ['canvas', 'c/$threadId', 'projects/$projectId'].map((path) =>
            createRoute({ getParentRoute: () => shell, path }),
          ),
        ),
      ]),
      history: createMemoryHistory({
        initialEntries: [
          `/canvas?sessions=${encodeURIComponent('project:project-theorem')}`,
        ],
      }),
    })
  })
  return <RouterProvider router={router} />
}

function NotesWorkspaceFrame() {
  return (
    <WithRuntime>
      <ChatShell projectId="project-theorem" threadId={undefined} />
    </WithRuntime>
  )
}

function ShellNavigationFrame() {
  const pathname = useLocation({ select: (location) => location.pathname })
  return (
    <div data-shell-route={pathname}>
      <ShellCompareStory />
    </div>
  )
}

/** The thread alone on the sheet: the reading column and the composer at desktop width. */
/** The conversation as the chat mode shows it (ModeView): over the Life field, on the sheet's gradient. */
function ConversationWideStory() {
  return (
    <WithRuntime>
      <div className="bg-sheet h-dvh w-full">
        <LifeBackdrop>
          <Thread />
        </LifeBackdrop>
      </div>
    </WithRuntime>
  )
}

function NoteKindsStory() {
  const { data: note } = useNote('doc-everything')
  if (!note) return null
  return (
    <div className="grid h-dvh grid-cols-2 divide-x divide-separator">
      <div className="overflow-y-auto">
        <NoteEditor note={note} />
      </div>
      <div className="overflow-y-auto">
        <NoteExcerpt live markdown={note.markdown} className="p-6" />
      </div>
    </div>
  )
}

function CanvasNoteTypesStory() {
  return (
    <WithRuntime>
      <div className="h-dvh w-full">
        <Canvas />
      </div>
    </WithRuntime>
  )
}

const PROGRAM_NOTE_TYPES = { note: NoteNodeView }

function ProgramNoteStory() {
  const [nodes, setNodes] = useState<NoteFlowNode[]>(() =>
    [
      { id: 'filled', x: 40, text: documentFixtures['doc-track'] ?? '' },
      { id: 'empty', x: 500, text: '' },
    ].map(({ id, x, text }) => ({
      id,
      type: 'note' as const,
      position: { x, y: 40 },
      width: 400,
      height: 320,
      data: { note: { id, text, x, y: 40, width: 400, height: 320 } },
    })),
  )
  return (
    <div className="h-dvh w-full">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          nodeTypes={PROGRAM_NOTE_TYPES}
          onNodesChange={(changes) =>
            setNodes((current) => applyNodeChanges(changes, current))
          }
        />
      </ReactFlowProvider>
    </div>
  )
}

/**
 * A notebook artifact as a thread shows it, read from the part Theorem stores
 * for it; the fake Theorem answers its outputs and host routes.
 */
function NotebookStory({ id }: { id: string }) {
  const { notebook, sourceRevision } = NOTEBOOK_DOCUMENTS[id]!
  const artifact = readArtifact(notebookPart(id, notebook, { sourceRevision }))
  if (!artifact) return null
  return (
    <div className="mx-auto w-full max-w-[880px] p-6">
      <ArtifactView artifact={artifact} distance="thing" latest />
    </div>
  )
}

function ArtifactPartMessage() {
  return <MessagePrimitive.Parts />
}

/**
 * Theo on a page that has an artifact: the `visit` performance looks at the
 * card, travels to its side and looks it over. The live reply's gutter slot
 * above it is where Theo rests, so the trip has somewhere to start.
 */
function FaceVisitStory() {
  const Artifact = FACE_VISIT_ARTIFACT
  return (
    <div className="bg-background min-h-dvh pt-6" data-slot="face-visit">
      <div className="mx-auto flex w-full max-w-(--spacing-reading) items-center gap-3 px-4">
        <span data-face-perch="live" className="flex size-8" aria-hidden />
        <p className="text-ink-muted text-sm">Here is the comparison.</p>
      </div>
      <Artifact />
      <FaceStage />
    </div>
  )
}

/**
 * An OpenUI artifact as the conversation shows it: one assistant message
 * carrying the artifact part, drawn by the thread's own part renderers at the
 * thread's reading width.
 */
function artifactStory({ id, title, program, version }: ArtifactStory) {
  const messages: ThreadMessageLike[] = [
    {
      id: `message-${id}`,
      role: 'assistant',
      status: { type: 'complete', reason: 'stop' },
      content: [
        {
          type: 'data',
          name: ARTIFACT_PART,
          data: {
            artifactId: `art_${id}`,
            artifactRevision: 'rev_1',
            artifactKind: 'openui',
            rendererId: 'theorem-openui',
            contractVersion: 'theorem-artifact-v1',
            lifecycle: 'ready',
            patchSequence: 1,
            fallbackText: title,
            // The stored publication's fields (#978 payload plus the openui form's own).
            payload: {
              documentId: `doc_${id}`,
              revision: { position: 1 },
              title,
              content: program,
              language: 'openui',
              form: 'openui',
              formVersion: 1,
              library: { id: LIBRARY_ID, version: version ?? LIBRARY_VERSION },
              program,
            },
          },
        },
      ],
    },
  ]
  return partsStory(messages)
}

/**
 * Finished messages drawn by the thread's own part renderers, at the thread's
 * reading width.
 */
function partsStory(messages: ThreadMessageLike[]) {
  return function PartsStory() {
    const runtime = useExternalStoreRuntime({
      messages,
      isRunning: false,
      onNew: async () => {},
      convertMessage: (message: ThreadMessageLike) => message,
    })
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <TheoremPartRenderers />
        <div className="mx-auto w-full max-w-(--spacing-reading) px-4 py-4">
          <ThreadPrimitive.Messages
            components={{ Message: ArtifactPartMessage }}
          />
        </div>
      </AssistantRuntimeProvider>
    )
  }
}

/** A finished reply holding an App document, after `text` when there is any. */
const appReply = (documentId: string, title: string, content: string, text?: string) =>
  partsStory([
    {
      id: `message-${documentId}`,
      role: 'assistant',
      status: { type: 'complete', reason: 'stop' },
      content: [
        ...(text ? [{ type: 'text' as const, text }] : []),
        {
          type: 'data',
          name: ARTIFACT_PART,
          data: {
            artifactId: `art_${documentId}`,
            artifactRevision: '6',
            artifactKind: 'app',
            rendererId: 'theorem-app',
            contractVersion: 'theorem-artifact-v1',
            lifecycle: 'ready',
            patchSequence: 6,
            fallbackText: title,
            payload: {
              documentId,
              revision: { position: 1 },
              title,
              content,
              language: 'html',
            },
          },
        },
      ],
    },
  ])

/** A finished reply holding a Gray–Scott App document. */
const grayScottReply = (documentId: string, content: string) =>
  appReply(
    documentId,
    'Gray-Scott Reaction-Diffusion',
    content,
    'Here is a Gray–Scott reaction–diffusion simulation running on the GPU. Drag on it to seed new growth.',
  )

/** An App counting its frames: expanding, collapsing or a theme change must leave the count climbing. */
const frameCounterStory = appReply('doc_kit_frame_counter', 'Frame counter', FRAME_COUNTER)

/** Each @theorem/ui control alone, drawing its Astryx reference's example, built as an App the agent writes is. */
const kitControlStories = Object.fromEntries(
  KIT_CONTROLS.map((control) => [`kit-${control}`, appReply(`doc_kit_${control}`, control, kitControlApp(control))]),
)

/**
 * The Gray–Scott App Qwen4 Max wrote on 2026-11-24, exactly as it ran, in a
 * finished reply: the baseline for chromeless artifacts.
 */
const grayScottStory = grayScottReply('doc_gray_scott', GRAY_SCOTT)

/** The same App on @theorem/ui in study C, built from its source as an App the agent writes is. */
const grayScottKitStory = grayScottReply('doc_gray_scott_kit', GRAY_SCOTT_KIT)

/**
 * Where a healthy App's host actions go, for the study: over the frame's
 * corner, or in a bar beneath it as a message's own actions are. Either way
 * they show on hover and on focus within, and always on a touch screen. Drawn
 * over the existing rows with CSS for the owner to compare; nothing here is
 * the implementation.
 */
const HOST_STUDY_CSS = `
[data-host-study] [data-slot="inline-artifact"] > div:first-child,
[data-host-study] section > [data-revision] {
  transition: opacity 120ms ease-out;
}
@media (hover: hover) {
  [data-host-study] [data-slot="inline-artifact"]:not(:hover):not(:focus-within) > div:first-child,
  [data-host-study] [data-slot="inline-artifact"]:not(:hover):not(:focus-within) section > [data-revision] {
    opacity: 0;
  }
}
[data-host-study="corner"] [data-slot="inline-artifact"] > div:first-child,
[data-host-study="corner"] section > [data-revision] {
  position: absolute; top: 8px; z-index: 2; height: 40px; padding: 0 4px;
  display: flex; align-items: center; border-radius: var(--radius-md); background: var(--surface-raised);
}
[data-host-study="corner"] [data-slot="inline-artifact"] > div:first-child { right: 8px; }
[data-host-study="corner"] section > [data-revision] { right: 120px; flex-wrap: nowrap; white-space: nowrap; }
[data-host-study="beneath"] [data-slot="inline-artifact"] > div:first-child {
  order: 2; padding: 4px 0 0;
}
[data-host-study="beneath"] section > [data-revision] {
  order: 2; position: absolute; left: 0; bottom: 0; z-index: 1;
}
/* Last, so the narrow placements win over the wide ones above. */
@media (max-width: 640px) {
  [data-host-study="corner"] section > [data-revision] { right: 8px; top: 56px; }
  [data-host-study="beneath"] section > [data-revision] { position: static; }
}
`

const grayScottStudy = (direction: GrayScottDirection, host: 'corner' | 'beneath') => {
  const Reply = grayScottReply(`doc_gray_scott_${direction}`, grayScottDirection(direction))
  return function GrayScottStudy() {
    return (
      <div data-host-study={host}>
        <style>{HOST_STUDY_CSS}</style>
        <Reply />
      </div>
    )
  }
}

/** A program the agent wrote, as the row the conversation draws for it. */
const FACE_VISIT_ARTIFACT = artifactStory(ARTIFACT_STORIES[0] as ArtifactStory)

const programStory = partsStory([
  {
    id: 'message-program',
    role: 'assistant',
    status: { type: 'complete', reason: 'stop' },
    content: [{ type: 'data', name: 'theorem-program', data: PROGRAM_PART }],
  },
])

const ACTIVITY_STATUS: Record<ActivityState, ThreadMessageLike['status']> = {
  working: { type: 'running' },
  approval: { type: 'running' },
  finished: { type: 'complete', reason: 'stop' },
  stopped: { type: 'incomplete', reason: 'cancelled' },
  unfinished: {
    type: 'incomplete',
    reason: 'error',
    error: 'The response could not be saved.',
  },
}

/** Every kind of formatting the composer takes, as the Markdown a draft holds. */
const COMPOSER_DRAFT = `## Release notes

Ship the **composer** with *Markdown* and \`inline code\`, as the [Milkdown docs](https://milkdown.dev) describe.

- Lists stay lists
- with a second item

> A quote reads as a quote.

\`\`\`ts
const sent = composer.text
\`\`\``

/** Writes a draft into the thread's composer the way any other writer does. */
function ComposerDraft({ text }: { text: string }) {
  const aui = useAui()
  useEffect(() => aui.composer.setText(text), [aui, text])
  return null
}

/**
 * The thread itself, composer and all, over committed messages: none for a new
 * conversation, or one question and its reply in a state of the activity line.
 * A `draft` is already in the composer.
 */
function threadStory(
  state?: ActivityState,
  stored = state ? activityMessages(state) : [],
  draft?: string,
  fixtureId?: string,
) {
  const messages: ThreadMessageLike[] = state
    ? toAssistantMessages(stored).map((message) =>
        message.role === 'assistant'
          ? { ...message, status: ACTIVITY_STATUS[state] }
          : message,
      )
    : fixtureId === 'F05'
      ? [
          {
            id: 'design-oracle-draft-context',
            role: 'assistant',
            status: { type: 'complete', reason: 'stop' },
            content: [
              {
                type: 'text',
                text: 'A short conversation response gives the draft editor a real prose track for typography and alignment measurements.',
              },
            ],
          },
        ]
      : []
  const isRunning = state === 'working' || state === 'approval'
  return function ThreadStory() {
    const runtime = useExternalStoreRuntime({
      messages,
      isRunning,
      onNew: async () => {},
      ...(fixtureId === 'F06' && { onCancel: async () => {} }),
      convertMessage: (message: ThreadMessageLike) => message,
    })
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <TheoremPartRenderers />
        {draft && <ComposerDraft text={draft} />}
        <div data-appearance-fixture={fixtureId} className="h-dvh">
          <Thread autoFocus={false} />
        </div>
      </AssistantRuntimeProvider>
    )
  }
}

const POINTING_MESSAGES: ThreadMessageLike[] =
  toAssistantMessages(pointingMessages())

/**
 * Theo on a conversation with things to be sent to: a tool call that failed,
 * folded away among ones that did not; a worker's changed file and its diff;
 * a document whose card shows an excerpt, with the larger view beside the
 * conversation once it is opened, as the shell has it.
 */
function FacePointStory() {
  const runtime = useExternalStoreRuntime({
    messages: POINTING_MESSAGES,
    isRunning: false,
    onNew: async () => {},
    convertMessage: (message: ThreadMessageLike) => message,
  })
  const openId = useArtifactView((s) => s.openId)
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TheoremPartRenderers />
      <div className="flex h-dvh">
        <div className="min-w-0 flex-1">
          <Thread autoFocus={false} />
        </div>
        {openId && (
          <ArtifactPanel
            artifactId={openId}
            onClose={() => useArtifactView.getState().closed(openId)}
            className="border-separator w-[46%] shrink-0 border-s"
          />
        )}
      </div>
      <FaceStage />
    </AssistantRuntimeProvider>
  )
}

const SOUND_MESSAGES: ThreadMessageLike[] = [
  {
    id: 'sound-ask',
    role: 'user',
    content: [{ type: 'text', text: 'What did the build turn up?' }],
  },
  {
    id: 'sound-reply',
    role: 'assistant',
    status: { type: 'complete', reason: 'stop' },
    content: [
      {
        type: 'text',
        text: [
          'The build passed, with **two things** worth a look.',
          '',
          '1. The map loader now reads tiles in parallel, which took the cold start from nine seconds to four.',
          '2. One test is slow: `tiles.test.ts` spends most of its time waiting on a timer.',
          '',
          'Nothing failed. I would fix the timer next, then cut the release.',
        ].join('\n'),
      },
    ],
  },
]

/**
 * Theo on a conversation with a reply to read aloud. Pressing "Read aloud"
 * speaks it with the page's voice through the page's sound graph, and Theo
 * hears what plays: it is the thread as the shell has it, with nothing told
 * to the face but the sound.
 */
function FaceSoundStory() {
  const speech = useMemo(() => speechAdapter(), [])
  const runtime = useExternalStoreRuntime({
    messages: SOUND_MESSAGES,
    isRunning: false,
    onNew: async () => {},
    convertMessage: (message: ThreadMessageLike) => message,
    adapters: { speech },
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TheoremPartRenderers />
      <div className="h-dvh">
        <Thread autoFocus={false} />
      </div>
      <FaceStage />
    </AssistantRuntimeProvider>
  )
}

/**
 * Theo as a microphone: the form it takes while the person holds it to speak.
 * The face is told to listen and the mic level is held steady, so the grille
 * throbs at a fixed loudness and the arcs stand where they are: a deterministic
 * render of the listening form, with no microphone opened.
 */
function FaceListenStory() {
  const runtime = useExternalStoreRuntime({
    messages: SOUND_MESSAGES,
    isRunning: false,
    onNew: async () => {},
    convertMessage: (message: ThreadMessageLike) => message,
  })
  useEffect(() => {
    const face = theFace()
    face.notice('person.listen')
    useMicLevel.setState({ level: 0.5 })
    return () => {
      face.notice('person.listen.end')
      useMicLevel.setState({ level: 0 })
    }
  }, [])
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TheoremPartRenderers />
      <div className="h-dvh">
        <Thread autoFocus={false} />
      </div>
      <FaceStage />
    </AssistantRuntimeProvider>
  )
}

/**
 * The harness plan as the thread draws its draft_plan call, at the thread's
 * own reading width. The result names no plan id, so the card shows the plan
 * as drafted and reads no live copy.
 */
function PlanCardStory() {
  const { planId: _written, ...result } = PLAN_RESULT
  const messages = useMemo<ThreadMessageLike[]>(
    () => [
      {
        id: 'plan-ask',
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Make the harness easier for agents to use. Plan it before you start.',
          },
        ],
      },
      {
        id: 'plan-answer',
        role: 'assistant',
        status: { type: 'complete', reason: 'stop' },
        content: [
          {
            type: 'text',
            text: 'Here is the plan. The audit and the scope can start together.',
          },
          {
            type: 'tool-call',
            toolCallId: 'call-plan',
            toolName: 'draft_plan',
            args: PLAN_ARGS as unknown as ReadonlyJSONObject,
            result,
          },
        ],
      },
    ],
    [result],
  )
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: false,
    onNew: async () => {},
    convertMessage: (message: ThreadMessageLike) => message,
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TheoremPartRenderers />
      <div className="h-dvh">
        <Thread autoFocus={false} />
      </div>
    </AssistantRuntimeProvider>
  )
}

/** The same plan from Theorem's copy, one root claimed and the other deviating, at the reading width. */
function PlanCardUnderWayStory() {
  return (
    <div className="mx-auto w-full max-w-(--spacing-reading) px-4 py-4">
      <PlanGraph view={PLAN_UNDER_WAY} />
    </div>
  )
}

/** Fixed Latin calibration prose rendered by the actual assistant-ui Thread. */
const ORACLE_F02_CONTENT = [
  '# Conversation reading fixture',
  '',
  'Prepared for the fixed Latin calibration corpus. **Six paragraphs** remain plain so browser line measurement is reproducible.',
  '',
  '# Reading and writing',
  '',
  'The article uses the same measure as the draft editor.',
  '',
  '## Reading settings',
  '',
  'The displayed text follows the selected content size.',
  '',
  '### Stable reading measure',
  '',
  LATIN_PROSE_V1_PARAGRAPHS.join('\n\n'),
  '',
  'Reviewed against the current appearance policy · metadata',
  '',
  '```ts',
  'const reading = { fixture: "latin-prose-v1", paragraphs: 6 }',
  '```',
].join('\n')

function DesignOracleThreadStory({
  empty = false,
  fixtureId = empty ? 'F01' : 'F02',
  content,
  draft = empty ? undefined : 'Draft a follow-up question.',
}: {
  empty?: boolean
  fixtureId?: string
  content?: string
  draft?: string
}) {
  const messages: ThreadMessageLike[] = empty
    ? []
    : [
        {
          id: 'appearance-oracle-long-answer',
          role: 'assistant',
          status: { type: 'complete', reason: 'stop' },
          content: [
            // The real Activity metadata line is part of the reading fixture. Two
            // settled progress steps make its Details label visible through the
            // production MessageMetadata slot without duplicating that component.
            {
              type: 'data',
              name: 'theorem-progress',
              data: { label: 'Reading the conversation', status: 'complete' },
            },
            {
              type: 'data',
              name: 'theorem-progress',
              data: { label: 'Checking the measure', status: 'complete' },
            },
            { type: 'text', text: content ?? ORACLE_F02_CONTENT },
          ],
        },
      ]
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: false,
    onNew: async () => {},
    convertMessage: (message: ThreadMessageLike) => message,
  })
  return (
    <div data-appearance-fixture={fixtureId}>
      <AssistantRuntimeProvider runtime={runtime}>
        <TheoremPartRenderers />
        {draft && <ComposerDraft text={draft} />}
        <div className="h-dvh">
          <Thread autoFocus={false} />
        </div>
      </AssistantRuntimeProvider>
    </div>
  )
}

const ORACLE_PREVIEW_USER = [
  'Please compare these workspace choices. '.repeat(22),
  'I need to understand which source is current, what changed since the last review, and how to keep the draft while moving between conversations. '.repeat(
    4,
  ),
].join('')

function DesignOraclePreviewStory() {
  const runtime = useExternalStoreRuntime({
    messages: [
      {
        id: 'design-oracle-preview-user',
        role: 'user',
        content: [{ type: 'text', text: ORACLE_PREVIEW_USER }],
      },
      {
        id: 'design-oracle-preview-answer',
        role: 'assistant',
        status: { type: 'complete', reason: 'stop' },
        content: [{ type: 'text', text: 'Short answer.' }],
      },
    ],
    isRunning: false,
    onNew: async () => {},
    convertMessage: (message: ThreadMessageLike) => message,
  })
  return (
    <div data-appearance-fixture="F03">
      <AssistantRuntimeProvider runtime={runtime}>
        <TheoremPartRenderers />
        <div className="h-dvh">
          <Thread autoFocus={false} />
        </div>
      </AssistantRuntimeProvider>
    </div>
  )
}

const ORACLE_MARKUP_CONTENT = [
  '## Expanded content fixture',
  '',
  'A paragraph with **strong text**, *emphasis*, `inline code`, and [a link](https://example.com/a-long-reference-path).',
  '',
  'A long URL should wrap or scroll locally: https://example.com/reference/this/is/a/very/long/unbroken/path/used/to/verify/reflow-and-horizontal-overflow',
  '',
  '| Role | State | Meaning |',
  '| --- | --- | --- |',
  '| Composer | Ready | Draft remains editable |',
  '| Navigation | Selected | Current location stays visible |',
  '',
  '```ts',
  'const appearance = { material: "flat", contentScale: 1 }',
  '```',
].join('\n')

function DesignOracleContentStory({
  fixtureId,
  content,
  direction = 'ltr',
  lang = 'en',
  includeArtifact = false,
}: {
  fixtureId: string
  content: string
  direction?: 'ltr' | 'rtl'
  lang?: string
  includeArtifact?: boolean
}) {
  const artifact = ARTIFACT_STORIES[0] as ArtifactStory
  const contentItems: ThreadMessageLike['content'] = [
    { type: 'text', text: content },
  ]
  if (includeArtifact && Array.isArray(contentItems)) {
    contentItems.push({
      type: 'data',
      name: ARTIFACT_PART,
      data: {
        artifactId: `art_${artifact.id}`,
        artifactRevision: 'rev_1',
        artifactKind: 'openui',
        rendererId: 'theorem-openui',
        contractVersion: 'theorem-artifact-v1',
        lifecycle: 'ready',
        patchSequence: 1,
        fallbackText: artifact.title,
        payload: {
          documentId: `doc_${artifact.id}`,
          revision: { position: 1 },
          title: artifact.title,
          content: artifact.program,
          language: 'openui',
          form: 'openui',
          formVersion: 1,
          library: {
            id: LIBRARY_ID,
            version: artifact.version ?? LIBRARY_VERSION,
          },
          program: artifact.program,
        },
      },
    } as ThreadMessageLike['content'][number])
  }
  const runtime = useExternalStoreRuntime({
    messages: [
      {
        id: `design-oracle-${fixtureId}`,
        role: 'assistant',
        status: { type: 'complete', reason: 'stop' },
        content: contentItems,
      },
    ],
    isRunning: false,
    onNew: async () => {},
    convertMessage: (message: ThreadMessageLike) => message,
  })
  return (
    <div data-appearance-fixture={fixtureId} dir={direction} lang={lang}>
      <AssistantRuntimeProvider runtime={runtime}>
        <TheoremPartRenderers />
        <div className="h-dvh">
          <Thread autoFocus={false} />
        </div>
      </AssistantRuntimeProvider>
    </div>
  )
}

// F12: the Markdown inventory the chat typography brief measures (2026-11-24).
// A human turn that mixes every block, a short answer, and a long one with
// sections, nested lists, both tables, both code lengths, a long identifier,
// prices beside math, and a diagram.
const ORACLE_HUMAN_MARKDOWN = [
  'Can you check the **release notes** before Friday? The [plan](https://example.com/plan) is in `docs/plan.md` and it costs $20 a seat.',
  '',
  '- tight item one',
  '- tight item with `inline code`',
  '',
  '1. A loose item, written as its own paragraph.',
  '',
  '2. A second loose item that wraps onto another line so the paragraph inside the list shows its leading.',
  '',
  '> A quoted line from the earlier thread.',
  '',
  '### A heading the person wrote',
  '',
  'The energy is $E = mc^2$ and the bound is \\(a^2 + b^2 = c^2\\).',
].join('\n')

const ORACLE_SHORT_ANSWER =
  'Yes. The notes are ready, and `docs/plan.md` already lists the seat price.'

const ORACLE_LONG_ANSWER = [
  'Here is what changed, section by section, with the numbers checked against the [pricing page](https://example.com/pricing) and the earlier review.[^1]',
  '',
  '## What changed',
  '',
  'The release moves the reading surface onto one document rhythm. Paragraphs keep three quarters of a line between them, and a heading sits closer to the text it introduces than to the section before it.',
  '',
  'A second paragraph follows so the gap between two paragraphs can be measured on its own, without a heading or a list beside it.',
  '',
  '### Lists',
  '',
  '- A tight item',
  '- Another tight item with *emphasis and `code inside it`*',
  '  - A nested item',
  '  - A second nested item',
  '- A last tight item',
  '',
  '1. A loose item, written as its own paragraph so the list is loose.',
  '',
  '   It carries a second paragraph inside the same item.',
  '',
  '2. The second loose item.',
  '',
  '> A quotation with **strong text** inside it.',
  '>',
  '> > A nested quotation that keeps its own flow.',
  '',
  '## Tables',
  '',
  '| Plan | [Seats](https://example.com/seats) | Price |',
  '| :--- | :---: | ---: |',
  '| Starter | 3 | $20.00 |',
  '| Team, with the longer description that should wrap inside its cell rather than push the table wider | 25 | $180.00 |',
  '',
  '| Region | Requests | p50 | p95 | p99 | Errors | Saturation | Owner | Notes |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |',
  '| us-east-1 | 1,204,331 | 41ms | 120ms | 410ms | 0.02% | 61% | platform-reliability | steady after the cache change |',
  '| eu-west-2 | 801,992 | 38ms | 131ms | 455ms | 0.04% | 57% | platform-reliability | one noisy neighbour on Tuesday |',
  '',
  '## Code',
  '',
  '```ts',
  'const seat = 20',
  '```',
  '',
  '```ts',
  'export function priceFor(plan: Plan, seats: number): number {',
  '  const base = plan.kind === "team" ? 180 : 20',
  '  const extra = Math.max(0, seats - plan.included)',
  '  return base + extra * plan.perSeat',
  '}',
  '',
  'export const plans = [',
  '  { kind: "starter", included: 3, perSeat: 7 },',
  '  { kind: "team", included: 25, perSeat: 6 },',
  ']',
  '```',
  '',
  'The failing call was `src/components/assistant-ui/elements/markdown-text.tsx:defaultComponents.code.isCodeBlock.fallback` in the build log, a long identifier that stays inline.',
  '',
  '## Prices and math',
  '',
  'The starter plan is $20 and the team plan is $180, so ten extra seats cost $60. The marginal price is $p(s) = 6s$ and the total is',
  '',
  '$$',
  'T(s) = 180 + 6\\,\\max(0, s - 25)',
  '$$',
  '',
  '## Diagram',
  '',
  '```mermaid',
  'flowchart LR',
  '  Draft --> Review --> Release',
  '```',
  '',
  '[^1]: The review from November 22.',
].join('\n')

function DesignOracleMarkdownStory() {
  const messages: ThreadMessageLike[] = [
    {
      id: 'design-oracle-F12-human',
      role: 'user',
      content: [{ type: 'text', text: ORACLE_HUMAN_MARKDOWN }],
    },
    {
      id: 'design-oracle-F12-short',
      role: 'assistant',
      status: { type: 'complete', reason: 'stop' },
      content: [{ type: 'text', text: ORACLE_SHORT_ANSWER }],
    },
    {
      id: 'design-oracle-F12-ask',
      role: 'user',
      content: [{ type: 'text', text: 'And the long version, please.' }],
    },
    {
      id: 'design-oracle-F12-long',
      role: 'assistant',
      status: { type: 'complete', reason: 'stop' },
      content: [{ type: 'text', text: ORACLE_LONG_ANSWER }],
    },
  ]
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: false,
    onNew: async () => {},
    convertMessage: (message: ThreadMessageLike) => message,
  })
  return (
    <div data-appearance-fixture="F12">
      <AssistantRuntimeProvider runtime={runtime}>
        <TheoremPartRenderers />
        <div className="h-dvh">
          <Thread autoFocus={false} />
        </div>
      </AssistantRuntimeProvider>
    </div>
  )
}

const ORACLE_RTL_CONTENT = [
  'مرحبا، هذا نص تجريبي للتحقق من اتجاه القراءة والمحاذاة في الواجهة.',
  '日本語の文章も表示し、ラテン文字と日本語のフォールバックが混在する状態を確認します。',
  ...LATIN_PROSE_V1_PARAGRAPHS.slice(0, 2),
].join('\n\n')

/** Math the model emits: dollar and bracket delimiters, display and inline,
 *  beside a price that must stay prose. */
const MATH_CONTENT = [
  'The quadratic formula solves $ax^2 + bx + c = 0$:',
  '',
  '$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$',
  '',
  'Models often write brackets instead: \\(e^{i\\pi} + 1 = 0\\) inline, and',
  '',
  '\\[\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}\\]',
  '',
  'A price is not math: the plan costs $5 and the add-on $10, billed monthly.',
].join('\n')

/** A reply that paints an interface: a fact card, a comparison table and steps,
 *  composed from the generative vocabulary through a ui.present operation. */
const PRESENT_TREE = {
  _type: 'Col',
  gap: 'md',
  children: [
    { _type: 'Header', text: 'Release readiness', size: 'lg' },
    {
      _type: 'Row',
      gap: 'md',
      children: [
        { _type: 'Fact', label: 'Checks passed', value: '128', delta: '+6', trend: 'up', upIsGood: true },
        { _type: 'Fact', label: 'Open issues', value: '3', delta: '-2', trend: 'down', upIsGood: false },
      ],
    },
    {
      _type: 'Table',
      columns: [
        { label: 'Surface', priority: 'primary' },
        {
          label: 'State',
          format: { kind: 'badge', tones: { Ready: 'success', Review: 'warning' } },
        },
        { label: 'Checks', format: { kind: 'number' } },
        { label: 'Week', format: { kind: 'delta', unit: '%', decimals: 1 } },
        { label: 'Owner' },
      ],
      rows: [
        ['Composer', 'Ready', 48, 4.2, 'UI'],
        ['Runtime', 'Streaming', 61, 0, 'Core'],
        ['Connections', 'Review', 19, -2.5, 'Platform'],
      ],
    },
    {
      _type: 'Steps',
      steps: [
        { title: 'Build', detail: 'Compile the workspace' },
        { title: 'Verify', detail: 'Run the oracles' },
        { title: 'Ship', detail: 'Promote the release' },
      ],
    },
  ],
}

function MathStory() {
  const runtime = useExternalStoreRuntime({
    messages: [
      {
        id: 'message-math',
        role: 'assistant',
        status: { type: 'complete', reason: 'stop' },
        content: [{ type: 'text', text: MATH_CONTENT }],
      },
    ],
    isRunning: false,
    onNew: async () => {},
    convertMessage: (message: ThreadMessageLike) => message,
    adapters: {
      threadList: {
        threadId: 'story-math',
        threads: [{ status: 'regular', id: 'story-math', remoteId: 'thread_story_math' }],
      },
    },
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TheoremPartRenderers />
      <div className="h-dvh">
        <Thread autoFocus={false} />
      </div>
    </AssistantRuntimeProvider>
  )
}

function PresentStory() {
  const runtime = useExternalStoreRuntime({
    messages: [
      {
        id: 'message-present',
        role: 'assistant',
        status: { type: 'complete', reason: 'stop' },
        metadata: { custom: { theoremRunId: 'run-present-story' } },
        content: [
          { type: 'text', text: 'Here is where the release stands.' },
          {
            type: 'data',
            name: 'theorem-client_operation',
            data: {
              requestRef: 'req-present-story',
              operation: 'ui.present',
              state: 'answered',
              args: PRESENT_TREE,
              expectedRevision: 0,
              receipt: { outcome: 'applied', result: { painted: 'Col' } },
            },
          },
        ],
      },
    ],
    isRunning: false,
    onNew: async () => {},
    convertMessage: (message: ThreadMessageLike) => message,
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TheoremPartRenderers />
      <div className="h-dvh">
        <Thread autoFocus={false} />
      </div>
    </AssistantRuntimeProvider>
  )
}

/** A reply that holds an interactive view: Observable cells the person works
 *  in the answer and edits in the terminal under it. */
const VIEW_TREE = {
  _type: 'View',
  title: 'Sales by region',
  caption: 'Drag the slider to hide the smaller regions.',
  data: [
    { name: 'North', sales: 42 },
    { name: 'South', sales: 31 },
    { name: 'East', sales: 27 },
    { name: 'West', sales: 18 },
  ],
  cells: [
    'const min = view(Inputs.range([0, 50], { label: "At least", step: 1, value: 20 }))',
    'Plot.barY(data.filter((d) => d.sales >= min), { x: "name", y: "sales" }).plot()',
  ],
}

function ViewStory() {
  const runtime = useExternalStoreRuntime({
    messages: [
      {
        id: 'message-view',
        role: 'assistant',
        status: { type: 'complete', reason: 'stop' },
        metadata: { custom: { theoremRunId: 'run-view-story' } },
        content: [
          { type: 'text', text: 'Here are the sales by region.' },
          {
            type: 'data',
            name: 'theorem-client_operation',
            data: {
              requestRef: 'req-view-story',
              operation: 'ui.present',
              state: 'answered',
              args: VIEW_TREE,
              expectedRevision: 0,
              receipt: { outcome: 'applied', result: { painted: 'View' } },
            },
          },
        ],
      },
    ],
    isRunning: false,
    onNew: async () => {},
    convertMessage: (message: ThreadMessageLike) => message,
    adapters: {
      threadList: {
        threadId: 'story-view',
        threads: [{ status: 'regular', id: 'story-view', remoteId: 'thread_story_view' }],
      },
    },
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TheoremPartRenderers />
      <div className="h-dvh">
        <Thread autoFocus={false} />
      </div>
    </AssistantRuntimeProvider>
  )
}

/** One of the interactive-responses plan's representative replies, over its
 *  committed fixture: the real thread and part renderers, the real
 *  present bridge, a thread-list adapter so context references have a
 *  durable thread to name. */
function responseStory(stored: () => Theorem.Message[], id: string) {
  const messages = toAssistantMessages(stored())
  return function ResponseStory() {
    const runtime = useExternalStoreRuntime({
      messages,
      isRunning: false,
      onNew: async () => {},
      convertMessage: (message: ThreadMessageLike) => message,
      adapters: {
        threadList: {
          threadId: id,
          threads: [{ status: 'regular', id, remoteId: 'thread-responses' }],
        },
      },
    })
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <TheoremPartRenderers />
        <div className="h-dvh">
          <Thread autoFocus={false} />
        </div>
      </AssistantRuntimeProvider>
    )
  }
}

/** A conversation whose last run reported its context occupancy, so the
 *  composer's context ring has real Theorem usage to draw. */
function ContextUsageStory() {
  const runtime = useExternalStoreRuntime({
    messages: [
      {
        id: 'message-usage-user',
        role: 'user',
        content: [{ type: 'text', text: 'How full is this conversation?' }],
      },
      {
        id: 'message-usage',
        role: 'assistant',
        status: { type: 'complete', reason: 'stop' },
        content: [
          {
            type: 'text',
            text: 'The conversation has room left. The ring beside the composer shows how much of the model\'s context the last request used.',
          },
          {
            type: 'data',
            name: 'theorem-usage',
            data: { contextTokens: 84_000, contextWindow: 200_000 },
          },
        ],
      },
    ],
    isRunning: false,
    onNew: async () => {},
    convertMessage: (message: ThreadMessageLike) => message,
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TheoremPartRenderers />
      <div className="h-dvh">
        <Thread autoFocus={false} />
      </div>
    </AssistantRuntimeProvider>
  )
}

export const REGISTRY: Readonly<Record<string, ComponentType>> = {
  ...PALETTE_MATRIX_REGISTRY,
  'workbench-default': WorkbenchDefaultStory,
  'workbench-semantic-overlay': WorkbenchSemanticOverlayStory,
  'workbench-picker': WorkbenchPickerStory,
  'workbench-files': WorkbenchFilesStory,
  'workbench-threads': WorkbenchThreadsStory,
  'workbench-threads-withheld': WorkbenchThreadsWithheldStory,
  'workbench-default-arrangement': WorkbenchDefaultArrangementStory,
  'workbench-delta-parity': WorkbenchDeltaParityStory,
  'workbench-delta-parity-before': WorkbenchDeltaParityBeforeStory,
  'workbench-changes-review': WorkbenchChangesReviewStory,
  'workbench-theo-blocks': WorkbenchTheoBlocksStory,
  'workbench-theo-composer': WorkbenchTheoComposerStory,
  'workbench-terminal': WorkbenchTerminalStory,
  'workbench-terminal-adoption-pending': WorkbenchTerminalAdoptionPendingStory,
  'workbench-terminal-adoption-unavailable':
    WorkbenchTerminalAdoptionUnavailableStory,
  'workbench-terminal-adoption-settled': WorkbenchTerminalAdoptionSettledStory,
  'workbench-editor': WorkbenchEditorStory,
  'workbench-editor-conflict': WorkbenchEditorConflictStory,
  'workbench-changes': WorkbenchChangesStory,
  'workbench-changes-binary-conflict': WorkbenchChangesBinaryConflictStory,
  'workbench-branches': WorkbenchBranchesStory,
  'workbench-search': WorkbenchSearchStory,
  'workbench-diagnostics': WorkbenchDiagnosticsStory,
  'workbench-run': WorkbenchRunStory,
  'workbench-run-list': WorkbenchRunListStory,
  'workbench-run-list-exits': WorkbenchRunListExitsStory,
  'workbench-terminal-program-report': WorkbenchTerminalProgramReportStory,
  'workbench-recovery-reload': WorkbenchRecoveryReloadStory,
  'workbench-cabinet': WorkbenchCabinetStory,
  'workbench-cabinet-picker': WorkbenchCabinetPickerStory,
  'workbench-face': WorkbenchFaceStory,
  'workbench-face-custom': WorkbenchFaceCustomStory,
  'workbench-account-switch': WorkbenchAccountSwitchStory,
  'workbench-device-copy': WorkbenchDeviceCopyStory,
  'workbench-arrangements': WorkbenchArrangementsStory,
  'workbench-layouts-page': WorkbenchLayoutsPageStory,
  'workbench-agent-operations': WorkbenchAgentOperationsStory,
  'workbench-add-selection': WorkbenchAddSelectionStory,
  'workbench-follow': WorkbenchFollowStory,
  'workbench-document-history': WorkbenchDocumentHistoryStory,
  'workbench-presentation': WorkbenchPresentationStory,
  'workbench-delegation': WorkbenchDelegationStory,
  'workbench-delegation-from-chat': WorkbenchDelegationFromChatStory,
  'workbench-replace': WorkbenchReplaceStory,
  'workbench-resize': WorkbenchResizeStory,
  'workbench-keyboard-journey': WorkbenchKeyboardJourneyStory,
  'workbench-appearance': WorkbenchAppearanceStory,
  'workbench-markdown-visual': WorkbenchMarkdownVisualStory,
  'workbench-markdown-source': WorkbenchMarkdownSourceStory,
  'workbench-markdown-split': WorkbenchMarkdownSplitStory,
  'workbench-markdown-preview': WorkbenchMarkdownPreviewStory,
  'design-oracle-empty': () => <DesignOracleThreadStory empty />,
  'assistant-math': MathStory,
  'assistant-present': PresentStory,
  'response-evidence': responseStory(evidenceMessages, 'story-response-evidence'),
  'response-coding': responseStory(codingMessages, 'story-response-coding'),
  'response-writing': responseStory(writingMessages, 'story-response-writing'),
  'assistant-context-usage': ContextUsageStory,
  'design-oracle-long': DesignOracleThreadStory,
  'design-oracle-reflow': () => <DesignOracleThreadStory fixtureId="F09" />,
  'design-oracle-draft': threadStory(undefined, [], COMPOSER_DRAFT, 'F05'),
  'design-oracle-stream': threadStory(
    'working',
    activityMessages('working'),
    undefined,
    'F06',
  ),
  'design-oracle-failure': threadStory(
    'unfinished',
    activityMessages('unfinished'),
    undefined,
    'F07',
  ),
  'design-oracle-continuity': threadStory(undefined, [], COMPOSER_DRAFT, 'F11'),
  'design-oracle-preview': DesignOraclePreviewStory,
  'design-oracle-content': () => (
    <DesignOracleContentStory
      fixtureId="F04"
      content={ORACLE_MARKUP_CONTENT}
      includeArtifact
    />
  ),
  'design-oracle-error': threadStory('unfinished'),
  'design-oracle-markdown': DesignOracleMarkdownStory,
  'design-oracle-navigation': () => (
    <div data-appearance-fixture="F08">
      <ShellCompareStory />
    </div>
  ),
  'design-oracle-rtl': () => (
    <DesignOracleContentStory
      fixtureId="F10"
      content={ORACLE_RTL_CONTENT}
      direction="rtl"
      lang="ar"
    />
  ),
  'composer-paper': threadStory(),
  'composer-markdown': threadStory(undefined, [], COMPOSER_DRAFT),
  'chat-program': programStory,
  'chromeless-gray-scott': grayScottStory,
  'chromeless-gray-scott-kit': grayScottKitStory,
  ...kitControlStories,
  'presentation-frame-counter': frameCounterStory,
  'chromeless-study-strip': grayScottStudy('strip', 'corner'),
  'chromeless-study-inspector': grayScottStudy('inspector', 'beneath'),
  'chromeless-study-overlay': grayScottStudy('overlay', 'corner'),
  ...Object.fromEntries(
    ACTIVITY_STATES.map((state) => [`activity-${state}`, threadStory(state)]),
  ),
  ...Object.fromEntries(
    ARTIFACT_STORIES.map((story) => [story.id, artifactStory(story)]),
  ),
  ...SCENE_STORY_RENDERS,
  'activity-approval-high': threadStory(
    'approval',
    activityMessages('approval', 'high'),
  ),
  'tool-pills': threadStory('working', toolPillMessages()),
  'code-blocks': threadStory('finished', codeBlockMessages()),
  'tool-calls-check': threadStory('finished', appCheckMessages()),
  'plan-card': PlanCardStory,
  'plan-card-under-way': PlanCardUnderWayStory,
  'face-bench': FaceBench,
  'face-book': FaceBook,
  'face-in-shell': ShellCompareStory,
  'face-visit': FaceVisitStory,
  'face-point': FacePointStory,
  'face-sound': FaceSoundStory,
  'face-listen': FaceListenStory,
  'theo-face-inverse': TheoFaceInverse,
  'organized-sidebar': OrganizedSidebarStory,
  'librarian-footer': LibrarianFooterStory,
  'compare-pane': ComparePaneStory,
  'compare-pane-standalone': () => <ComparePaneStory standalone />,
  'review-card': ReviewCardStory,
  'shell-compare': ShellCompareStory,
  'populated-shell': PopulatedShellStory,
  'new-chat': NewChatStory,
  'command-live': CommandTerminalLiveStory,
  'view-cells': CellsTerminalStory,
  'present-view': ViewStory,
  'project-home': ProjectHomeStory,
  'session-graph': SessionGraphStory,
  'shell-navigation': ShellNavigationStory,
  'notes-workspace': NotesWorkspaceStory,
  'settings-ai': SettingsAiStory,
  'settings-responses': () => <SettingsAiStory path="/settings/responses" />,
  'settings-appearance': () => <SettingsAiStory path="/settings/appearance" />,
  'glass-compare': () => (
    <WithRuntime>
      <GlassCompareStory />
    </WithRuntime>
  ),
  // Theo's motion constants, tuned against the live face. A development bench,
  // not a setting: the product's Appearance page does not show it.
  'face-feel': () => (
    <div className="mx-auto max-w-2xl p-6">
      <FaceFeel />
    </div>
  ),
  'conversation-wide': ConversationWideStory,
  'note-kinds': NoteKindsStory,
  'canvas-note-types': CanvasNoteTypesStory,
  'program-note': ProgramNoteStory,
  'response-details': ResponseDetailsStory,
  'response-styles-settings': ResponseStylesSettingsStory,
  'cpu-gpu-tradeoff': () => <NotebookStory id="cpu-gpu-tradeoff" />,
  'cpu-gpu-measured': () => <NotebookStory id="cpu-gpu-measured" />,
  'cpu-gpu-awaiting-gpu': () => <NotebookStory id="cpu-gpu-awaiting-gpu" />,
  'cpu-gpu-model': () => <NotebookStory id="cpu-gpu-model" />,
}
