// SOURCING: dockview-react (docking layout: tabs, splits, floating and edge groups, maximize, serialization, always-rendered panels), the shell's ModeView (assistant-ui Thread in chat mode), FilePanel, NotePanel (Milkdown Crepe), WorkspaceFilePanel, the inspector's panels (the graph via React.lazy, so cosmos.gl loads only when it opens), the arrangements, the IDE frame (browser-only Theia), Base UI Menu on the theme's glass (the one layout menu: where the terminal opens), zustand stores for artifact view, note view, workspace file view, the inspected file, saved layouts and the drawers
import { useThreadDisplayTitle } from '@/lib/theorem/thread-title'
import { useAuiState } from '@assistant-ui/react'
import { Menu } from '@base-ui/react/menu'
import { DockviewDefaultTab, DockviewReact } from 'dockview-react'
import type {
  DockviewApi,
  DockviewReadyEvent,
  DockviewTheme,
  IDockviewHeaderActionsProps,
  IDockviewPanelHeaderProps,
  IDockviewPanelProps,
} from 'dockview-react'
import {
  Suspense,
  lazy,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { FunctionComponent } from 'react'
import { ArtifactPanel } from '@/components/artifacts/artifact-panel'
import { useThreadArtifacts } from '@/components/artifacts/artifact-model'
import { useArtifactView } from '@/components/artifacts/artifact-view'
import { Icon } from '@/components/icons'
import {
  LinksPanel,
  OutlinePanel,
} from '@/components/inspector/inspector-panels'
import { NotePanel } from '@/components/notes/note-panel'
import { ThreadHeader } from '@/components/organize/thread-header'
import { useProjectHomeTitle } from '@/components/projects/project-home'
import { useNoteView } from '@/components/notes/note-view'
import { Button } from '@/components/ui/button'
import {
  WORKSPACE_FILE_COMPONENT,
  WorkspaceFileDockPanel,
  openWorkspaceFilePanel,
} from '@/components/workspace/workspace-file-panel'
import { useNote } from '@/lib/theorem/notes'
import { useFileDock } from '@/lib/theorem/project-files'
import { useWorkspaceFileView } from '@/lib/workspace/open'
import { THREAD, followFront, holdsPanelsMenu } from './arrangements'
import { FilePanel } from './file-panel'
import { hasOwnView, ModeView, modeLabel, useShellMode } from './modes'
import { openBeside } from './open-beside'
import { useShell } from './shell-state'
import { ChromeMenuPopup, menuItem } from './chrome-menu'
import { adaptDock } from './responsive-dock'
import { ContributionBoundary } from './contribution-boundary'
import { moduleComponentOf } from './module-mount'
import './builtin-chrome'
import { registerContributions } from '@/lib/contributions/registry'
import { useHostContributions } from '@/lib/shell/host-registry'
import {
  loadLayout,
  saveLayout as saveEnvelope,
} from '@/lib/shell/layout-store'
import type { LayoutDevice } from '@/lib/shell/layout-envelope'
import {
  liveOf,
  missingAfterRestore,
  stackPanels,
  useNarrowViewport,
} from '@/lib/shell/narrow-layout'
import {
  movePanel,
  registerPanelCommands,
  usePanelOffer,
} from '@/lib/shell/panel-commands'

import { IdeFrame } from '@/components/ide/ide-frame'
import { flyGhost, popIn } from '@/lib/motion'
import { sheetShown } from '@/components/workbench/placement'
import { useWorkbenchPlacement } from '@/components/workbench/use-workbench-placement'

import { DelegationPanel } from '@/components/chat/delegation-panel'
import { ComparePane } from '@/components/review/compare-pane'
import {
  useDelegationDock,
  useThreadDelegation,
} from '@/lib/theorem/delegations'
import { useReview, useReviewDock } from '@/lib/theorem/reviews'
import { WORKBENCH_LABEL } from '@/components/workbench/label'

const ARTIFACT = 'artifact:'
const NOTE = 'note-panel:'
const artifactPanelId = (artifactId: string) => `${ARTIFACT}${artifactId}`
const artifactIdOf = (panelId: string) =>
  panelId.startsWith(ARTIFACT) ? panelId.slice(ARTIFACT.length) : undefined
const FILE = 'file:'
const filePanelId = (path: string) => `${FILE}${path}`
const isFilePanel = (panelId: string) => panelId.startsWith(FILE)
const DELEGATION = 'delegation:'

const delegationPanelId = (delegationId: string) =>
  `${DELEGATION}${delegationId}`
const isDelegationPanel = (panelId: string) => panelId.startsWith(DELEGATION)
const REVIEW = 'review:'
const reviewPanelId = (reviewId: string) => `${REVIEW}${reviewId}`
const isReviewPanel = (panelId: string) => panelId.startsWith(REVIEW)

/** Panels that open beside the conversation and share its side group. */
const isSidePanel = (panelId: string) =>
  Boolean(artifactIdOf(panelId)) ||
  isFilePanel(panelId) ||
  isDelegationPanel(panelId)
/** Colours come from the palette tokens, which already switch per palette and mode. */
const theme: DockviewTheme = {
  name: 'theorem',
  className: 'dockview-theme-theorem',
}

/** Subscribes React to a dockview event; dockview events return a disposable. */
function subscribe(event: (listener: () => void) => { dispose: () => void }) {
  return (onChange: () => void) => {
    const disposable = event(onChange)
    return () => disposable.dispose()
  }
}

/** The main panel: the conversation, or the mode's view in the Index, Pages, Spaces and the canvas. Theia covers the dock in IDE mode. */
function ThreadPanel({ api, containerApi }: IDockviewPanelProps) {
  const threadTitle = useThreadDisplayTitle()
  const title = useProjectHomeTitle() ?? threadTitle
  const mode = useShellMode()
  useEffect(
    () =>
      api.setTitle(hasOwnView(mode) ? modeLabel(mode) : title || 'New chat'),
    [api, mode, title],
  )
  // Chat's breadcrumb stands in for the tab while the conversation is
  // alone in its group, and Notes' panes draw their own pills; a tab dropped
  // beside it brings the tab bar back.
  const inChat = mode === 'chat'
  const ownTop = inChat || mode === 'notes'
  const alone = useSyncExternalStore(
    subscribe(api.group.api.onDidActivePanelChange),
    () => api.group.panels.length === 1,
  )
  useEffect(() => {
    // eslint-disable-next-line react-hooks/immutability -- dockview's header takes this as a setter, and has no method for it.
    api.group.header.hidden = ownTop && alone
  }, [api, ownTop, alone])
  const actions = alone ? (
    <GroupActions group={api.group} containerApi={containerApi} />
  ) : undefined
  return (
    <div
      data-appearance-part="main"
      data-appearance-width-role="main"
      className="flex h-full min-w-0 flex-col"
    >
      {inChat && <ThreadHeader actions={actions} />}
      <div className="relative min-h-0 flex-1">
        <ModeView docked actions={mode === 'notes' ? actions : undefined} />
      </div>
    </div>
  )
}
function ArtifactDockPanel({
  api,
  containerApi,
  params,
}: IDockviewPanelProps<{ artifactId: string }>) {
  const { artifactId } = params
  const versions = useThreadArtifacts().get(artifactId)
  const title = versions?.at(-1)?.title
  useEffect(() => {
    if (title) api.setTitle(title)
  }, [api, title])
  const expanded = useSyncExternalStore(
    subscribe(containerApi.onDidMaximizedGroupChange),
    () => api.isMaximized(),
  )
  const loading = useAuiState((s) => s.thread.isLoading)

  if (!versions?.length)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-artifact px-6 text-center text-sm text-ink-muted">
        {loading ? (
          <p>Loading artifact…</p>
        ) : (
          <>
            <p>This artifact is not part of this conversation.</p>
            <Button variant="ghost" size="sm" onClick={() => api.close()}>
              Close
            </Button>
          </>
        )}
      </div>
    )

  return (
    <ArtifactPanel
      artifactId={artifactId}
      onClose={() => api.close()}
      expanded={expanded}
      onExpandedChange={(next) => (next ? api.maximize() : api.exitMaximized())}
    />
  )
}

function FileDockPanel({
  api,
  params,
}: IDockviewPanelProps<{ projectId: string; path: string }>) {
  useEffect(() => {
    api.setTitle(params.path.split('/').at(-1) || params.path)
  }, [api, params.path])
  return <FilePanel projectId={params.projectId} path={params.path} />
}
/** A focused note. Notes belong to the project, so they stay across conversations. */
function NoteDockPanel({
  api,
  params,
}: IDockviewPanelProps<{ documentId: string }>) {
  const title = useNote(params.documentId).data?.title
  useEffect(() => {
    if (title) api.setTitle(title)
  }, [api, title])
  return <NotePanel documentId={params.documentId} />
}

function DelegationDockPanel({
  api,
  params,
}: IDockviewPanelProps<{ delegationId: string }>) {
  const roleLabel = useThreadDelegation(params.delegationId)?.roleLabel
  useEffect(() => {
    if (roleLabel) api.setTitle(roleLabel)
  }, [api, roleLabel])
  return <DelegationPanel delegationId={params.delegationId} />
}

/**
 * Compare draws its own header: a way to fill the workspace with every option
 * side by side, and a way out of the window and back. Wherever the
 * conversation is not beside it, it carries the conversation's composer.
 */
function ReviewDockPanel({
  api,
  containerApi,
  params,
}: IDockviewPanelProps<{ reviewId: string }>) {
  const { reviewId } = params
  const count = useReview(reviewId).data?.options.length
  useEffect(() => {
    if (count) api.setTitle(`Compare ${count}`)
  }, [api, count])
  const location = useSyncExternalStore(
    subscribe(api.onDidLocationChange),
    () => api.location.type,
  )
  const expanded = useSyncExternalStore(
    subscribe(containerApi.onDidMaximizedGroupChange),
    () => api.isMaximized(),
  )
  // A dock too narrow for both opens Compare as a tab over the conversation.
  const overThread = useSyncExternalStore(
    subscribe(containerApi.onDidLayoutChange),
    () => api.group.panels.some((panel) => panel.id === THREAD),
  )
  // A tab opened quietly behind the conversation answers nothing until shown.
  const visible = useSyncExternalStore(
    subscribe(api.onDidVisibilityChange),
    () => api.isVisible,
  )
  const close = () => {
    const panel = containerApi.getPanel(api.id)
    if (panel) containerApi.removePanel(panel)
  }
  const detach = async () => {
    const panel = containerApi.getPanel(api.id)
    if (!panel) return
    if (location !== 'grid') {
      const thread = containerApi.getPanel(THREAD)
      if (thread) panel.api.moveTo({ group: thread.group, position: 'right' })
      return
    }
    // A blocked popup still lets the pane float clear of the conversation.
    const opened = await containerApi.addPopoutGroup(panel.group)
    if (!opened)
      containerApi.addFloatingGroup(panel, { width: 520, height: 720 })
  }
  return (
    <ComparePane
      reviewId={reviewId}
      onClose={close}
      onDetach={() => void detach()}
      detached={location !== 'grid'}
      expanded={expanded}
      onExpandedChange={(next) => (next ? api.maximize() : api.exitMaximized())}
      standalone={visible && (expanded || overThread || location !== 'grid')}
    />
  )
}

const GraphPanel = lazy(() =>
  import('@/components/inspector/graph-panel').then((module) => ({
    default: module.GraphPanel,
  })),
)

/** The inspector's panels draw on the surface the files beside them do. */
const inspector = (Panel: React.ComponentType) =>
  function InspectorPanel() {
    return (
      <div className="relative h-full bg-artifact">
        <Suspense>
          <Panel />
        </Suspense>
      </div>
    )
  }

/** The id the outputs side panel had; only old saved layouts still name it. */
const RETIRED_OUTPUTS_PANEL = 'outputs'

/**
 * The panels the shell ships, registered as `panel` contributions: the dock
 * builds its component table from the registry, so an installed module's panel
 * opens through the same path (EXT-08). `singleDriver` surfaces keep one
 * active driver (HOST-01).
 */
const SHIPPED_PANELS: ReadonlyArray<{
  component: string
  label: string
  Component: React.ComponentType<any>
  singleDriver?: boolean
}> = [
  {
    component: 'thread',
    label: 'Conversation',
    Component: ThreadPanel,
    singleDriver: true,
  },
  {
    component: 'outline',
    label: 'Outline',
    Component: inspector(OutlinePanel),
  },
  { component: 'links', label: 'Links', Component: inspector(LinksPanel) },
  { component: 'graph', label: 'Graph', Component: inspector(GraphPanel) },
  { component: 'artifact', label: 'Artifact', Component: ArtifactDockPanel },
  { component: 'note', label: 'Note', Component: NoteDockPanel },
  {
    component: WORKSPACE_FILE_COMPONENT,
    label: 'File',
    Component: WorkspaceFileDockPanel,
  },
  { component: 'file', label: 'File', Component: FileDockPanel },
  {
    component: 'delegation',
    label: 'Delegation',
    Component: DelegationDockPanel,
  },
  { component: 'review', label: 'Compare', Component: ReviewDockPanel },
]

/** `workspaceFile` becomes `workspace-file`: contribution ids are lowercase and dashed. */
export const panelContributionId = (component: string) =>
  `theorem.panel.${component.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`

registerContributions(
  SHIPPED_PANELS.map(({ component, label, Component, singleDriver }) => ({
    kind: 'panel' as const,
    id: panelContributionId(component),
    label,
    Component,
    meta: { component, ...(singleDriver && { singleDriver: true }) },
  })),
)

/**
 * Components only old saved layouts still name. They restore and are then
 * removed (restoreLayout), so they are not contributions.
 */
const RETIRED_COMPONENTS: Record<
  string,
  FunctionComponent<IDockviewPanelProps>
> = {
  // Layouts saved while the IDE was a dock panel name it; restoreLayout drops it.
  ide: () => <IdeFrame />,
  // The outputs were a side panel until 2026-11-14; a layout saved then still
  // names it, so it restores and is removed (restoreLayout).
  [RETIRED_OUTPUTS_PANEL]: () => null,
}

/**
 * An installed panel's component, wrapped so a render failure is recorded and
 * leaves a placeholder: the resource and its parameters stay in the layout.
 */
function guardedPanel(
  id: string,
  Component: React.ComponentType<any>,
): FunctionComponent<IDockviewPanelProps> {
  return function GuardedPanel(props) {
    return (
      <ContributionBoundary
        area="panel"
        contributionId={id}
        fallback={
          <div role="status" className="p-4 text-sm text-ink-muted">
            This panel could not be shown. Its settings and the resource it
            opened are kept; recovery lists what failed.
          </div>
        }
      >
        <Component {...props} />
      </ContributionBoundary>
    )
  }
}

/** The dock's component table, from the panel contributions in force. */
function useDockComponents() {
  const panels = useHostContributions('panel')
  return useMemo(() => {
    const table: Record<string, FunctionComponent<IDockviewPanelProps>> = {
      ...RETIRED_COMPONENTS,
    }
    for (const one of panels) {
      const name = one.meta?.component
      // A module's panel has no component code: the module runtime mounts it.
      const Component = one.Component ?? moduleComponentOf(one)
      if (typeof name !== 'string' || !Component) continue
      table[name] =
        one.source.kind === 'builtin'
          ? (Component as FunctionComponent<IDockviewPanelProps>)
          : guardedPanel(one.id, Component)
    }
    return table
  }, [panels])
}

const tabComponents = {
  /** The thread is always present, so its tab has no close button. */
  fixed: (props: IDockviewPanelHeaderProps) => (
    <DockviewDefaultTab {...props} hideClose />
  ),
}

/** The dock's one layout menu: where the terminal opens. New chat lives in the sidebar. */
function GroupActions({
  group,
  containerApi,
}: Pick<IDockviewHeaderActionsProps, 'group' | 'containerApi'>) {
  const holds = useSyncExternalStore(
    subscribe(containerApi.onDidMaximizedGroupChange),
    () => holdsPanelsMenu(group),
  )
  return holds ? <PanelsMenu /> : null
}

function PanelsMenu() {
  return (
    <div className="flex h-full items-center pe-1">
      <Menu.Root>
        <Menu.Trigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label="Layout"
              className="min-h-(--appearance-control-min) min-w-(--appearance-control-min) p-1.5"
            />
          }
        >
          <Icon.Panels className="size-4" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner align="end" sideOffset={6} className="z-50">
            <ChromeMenuPopup className="min-w-52">
              <Menu.Item
                className={menuItem}
                onClick={() => useShell.getState().setWorkbench('side')}
              >
                <Icon.Terminal className="size-4 text-ink-muted" />
                {`${WORKBENCH_LABEL} on the right`}
              </Menu.Item>
              <Menu.Item
                className={menuItem}
                onClick={() => useShell.getState().setWorkbench('bottom')}
              >
                <Icon.Terminal className="size-4 text-ink-muted" />
                {`${WORKBENCH_LABEL} at the bottom`}
                <span className="ms-auto ps-4 font-mono text-xs text-ink-faint">
                  ctrl+`
                </span>
              </Menu.Item>
              <Menu.Item
                className={menuItem}
                onClick={() => useShell.getState().setWorkbench('full')}
              >
                <Icon.Terminal className="size-4 text-ink-muted" />
                {`${WORKBENCH_LABEL} full screen`}
              </Menu.Item>
            </ChromeMenuPopup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  )
}

/** Below this the conversation's column is not laid out. */
const THREAD_MIN_WIDTH = 0

function buildDefaultLayout(api: DockviewApi) {
  api.addPanel({
    id: THREAD,
    component: 'thread',
    tabComponent: 'fixed',
    title: 'New chat',
    minimumWidth: THREAD_MIN_WIDTH,
  })
}

/** Restores a saved layout, or reports that it is unusable. */
function restoreLayout(
  api: DockviewApi,
  dock: Parameters<DockviewApi['fromJSON']>[0],
) {
  try {
    api.fromJSON(dock)
  } catch {
    api.clear()
    return false
  }
  // Theia now covers the sheet in IDE mode, so an IDE panel would load it twice.
  const ide = api.getPanel('ide')
  if (ide) api.removePanel(ide)
  const outputs = api.getPanel(RETIRED_OUTPUTS_PANEL)
  if (outputs) api.removePanel(outputs)
  if (api.getPanel(THREAD)) return true
  api.clear()
  return false
}

/**
 * New artifacts and files join the existing side tabs, else open beside the
 * conversation.
 */
function openSide(
  api: DockviewApi,
  options: {
    id: string
    component: string
    params: Record<string, string>
    title: string
  },
) {
  const existing = api.getPanel(options.id)
  if (existing) {
    existing.api.setActive()
    return
  }
  const sized = { ...options, minimumWidth: 400 }
  const sibling = api.panels.find((panel) => isSidePanel(panel.id))
  if (sibling) {
    api.addPanel({ ...sized, position: { referenceGroup: sibling.group } })
    return
  }
  openBeside(api, sized, THREAD, 0.55)
}
function openArtifact(api: DockviewApi, artifactId: string) {
  openSide(api, {
    id: artifactPanelId(artifactId),
    component: 'artifact',
    params: { artifactId },
    title: 'Artifact',
  })
}

function openDelegation(api: DockviewApi, delegationId: string, title: string) {
  openSide(api, {
    id: delegationPanelId(delegationId),
    component: 'delegation',
    params: { delegationId },
    title,
  })
}
/** Compare's column opens this wide, or at 40% of a dock too narrow for that. */
const COMPARE_WIDTH = 380
/** The conversation keeps this much beside Compare, which otherwise opens over it. */
const CONVERSATION_WIDTH = 480

/**
 * Compare opens in a column of its own, with its own header in place of the
 * tab, and a quiet open leaves the keyboard in the conversation. The column
 * has a set width, so a wide window gives the room to the conversation; a
 * dock with no room for both opens Compare over the conversation as a tab.
 */
function openReviewPanel(
  api: DockviewApi,
  reviewId: string,
  quiet: boolean | undefined,
) {
  const id = reviewPanelId(reviewId)
  const existing = api.getPanel(id)
  if (existing) {
    existing.api.setActive()
    return
  }
  openBeside(
    api,
    {
      id,
      component: 'review',
      params: { reviewId },
      title: 'Compare',
      minimumWidth: 340,
    },
    THREAD,
    Math.min(0.4, COMPARE_WIDTH / api.width),
    CONVERSATION_WIDTH - THREAD_MIN_WIDTH,
  )
  const panel = api.getPanel(id)
  if (panel && panel.group.panels.length === 1) panel.group.header.hidden = true
  if (quiet) api.getPanel(THREAD)?.api.setActive()
  // Dockview can keep an always-rendered panel at its old width when a column
  // opens mid-frame, until the next layout. Lay out once the frame has settled.
  requestAnimationFrame(() => api.layout(api.width, api.height, true))
}

/** Files belong to the project, so they stay open across conversations. */
function openFile(api: DockviewApi, projectId: string, path: string) {
  openSide(api, {
    id: filePanelId(path),
    component: 'file',
    params: { projectId, path },
    title: path.split('/').at(-1) || path,
  })
}

/**
 * Maximize and restore move groups on springs: a group that changes size
 * grows or shrinks there as a ghost of its surface, and groups that come back
 * into view pop in. dockview brackets the change, so the rects before it are
 * still on screen when the first event fires.
 */
function springMaximize(dock: DockviewApi) {
  let before = new Map<string, DOMRect>()
  return [
    dock.onWillMutateLayout(({ kind }) => {
      if (kind !== 'maximize') return
      before = new Map(
        dock.groups.map((group) => [
          group.id,
          group.element.getBoundingClientRect(),
        ]),
      )
    }),
    dock.onDidMutateLayout(({ kind }) => {
      if (kind !== 'maximize') return
      const was = before
      requestAnimationFrame(() => {
        for (const group of dock.groups) {
          const from = was.get(group.id)
          const to = group.element.getBoundingClientRect()
          if (!from || to.width === 0 || to.height === 0) continue
          if (from.width === 0 || from.height === 0) {
            popIn(group.element, { from: 0.97, ease: 'settle' })
            continue
          }
          if (from.width === to.width && from.height === to.height) continue
          // Every panel beside the conversation draws on the artifact surface.
          const side = group.panels.some((panel) => panel.id !== THREAD)
          flyGhost(from, group.element, {
            className: side ? 'bg-artifact' : 'bg-background',
            ease: 'settle',
          })
        }
      })
    }),
  ]
}
/** Notes join the open note tabs, else open beside the conversation. */
function openNote(api: DockviewApi, documentId: string) {
  const id = `${NOTE}${documentId}`
  const existing = api.getPanel(id)
  if (existing) {
    existing.api.setActive()
    return
  }
  const options = {
    id,
    component: 'note',
    params: { documentId },
    title: 'Note',
    minimumWidth: 360,
  }
  const sibling = api.panels.find((panel) => panel.id.startsWith(NOTE))
  if (sibling) {
    api.addPanel({ ...options, position: { referenceGroup: sibling.group } })
    return
  }
  openBeside(api, options, THREAD, 0.4)
}
/**
 * Shown when an open request lands on a single-driver surface that is already
 * placed: it offers to focus the one that exists or move it here, rather than
 * starting a second runtime (HOST-01). Focus already happened; nothing starts.
 */
function PanelOfferBar({ dock }: { dock: DockviewApi | undefined }) {
  const offer = usePanelOffer((state) => state.offer)
  const dismiss = usePanelOffer((state) => state.dismiss)
  if (!offer || !dock) return null
  const from =
    offer.from && offer.from !== offer.panelId ? offer.from : undefined
  return (
    <div
      role="group"
      aria-label={`${offer.label} is already open`}
      className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-separator bg-sheet px-3 py-2 text-sm shadow-sheet"
    >
      <span>{offer.label} is already open, so it was brought forward.</span>
      {from && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            movePanel(dock, {
              id: offer.panelId,
              to: 'tab',
              reference: from,
            })
            dismiss()
          }}
        >
          Move it here
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={dismiss}>
        Dismiss
      </Button>
    </div>
  )
}

/**
 * Desktop dock: the conversation and each open artifact, note and file as dock panels. Panels render always, so moving or hiding one
 * keeps its React state, scroll position and focus target. The layout is saved
 * per project; artifact panels belong to the conversation they came from.
 */
export function DockShell({
  projectId,
  threadId,
}: {
  projectId: string
  /** Routed conversation; undefined for a new chat that has not been saved yet. */
  threadId: string | undefined
}) {
  const [dock, setDock] = useState<DockviewApi>()
  const components = useDockComponents()
  // A narrow viewport stacks the panels and saves to its own slot, so the
  // desktop arrangement is never overwritten from a phone (HOST-03).
  const narrow = useNarrowViewport()
  const device = useRef<LayoutDevice>(narrow ? 'narrow' : 'desktop')
  const host = useRef<HTMLDivElement>(null)
  const adaptation = useRef<ReturnType<typeof adaptDock> | null>(null)
  useEffect(() => {
    if (!dock || !host.current) return
    const adapter = adaptDock(dock, host.current)
    adaptation.current = adapter
    return () => {
      adapter.dispose()
      adaptation.current = null
    }
  }, [dock])
  /** Conversation the layout's artifact panels belong to. */
  const layoutThread = useRef<string | undefined>(undefined)
  /** Saves the live layout in the versioned envelope, for this device only. */
  const persistLayout = useEffectEvent(() => {
    if (!dock) return
    const layout = adaptation.current
      ? adaptation.current.layoutForSave()
      : dock.toJSON()
    if (layout)
      saveEnvelope(projectId, device.current, {
        vendor: layout as never,
        threadId: layoutThread.current,
      })
  })
  // A full-screen workbench covers this dock: a review asked for there (its
  // Artifacts panel, its conversation's review card) brings the sheet back
  // beside it so the review can be seen and used.
  const { requestedPlacement } = useWorkbenchPlacement()
  const showSheet = useEffectEvent(() => {
    const shell = useShell.getState()
    const moved = sheetShown(requestedPlacement, shell.lastCompanion)
    if (moved) shell.setWorkbench(moved)
  })

  const onReady = ({ api }: DockviewReadyEvent) => {
    const loaded = loadLayout(
      projectId,
      device.current,
      useShell.getState().layouts[projectId],
    )
    if (
      loaded.status === 'ok' &&
      restoreLayout(
        api,
        loaded.vendor as unknown as Parameters<typeof api.fromJSON>[0],
      )
    )
      layoutThread.current = loaded.threadId
    else buildDefaultLayout(api)
    setDock(api)
  }

  // Connects the artifact store to this dock and saves every layout change.
  useEffect(() => {
    if (!dock) return
    const save = () => persistLayout()
    const active = dock.activePanel && artifactIdOf(dock.activePanel.id)
    if (active) useArtifactView.getState().focused(active)
    useArtifactView.setState({
      dock: {
        open: (artifactId) => openArtifact(dock, artifactId),
        expand: (artifactId) => {
          openArtifact(dock, artifactId)
          dock.getPanel(artifactPanelId(artifactId))?.api.maximize()
        },
        close: (artifactId) => {
          const panel = dock.getPanel(artifactPanelId(artifactId))
          if (panel) dock.removePanel(panel)
          else useArtifactView.getState().closed(artifactId)
        },
      },
    })
    useNoteView.setState({
      dock: { open: (documentId) => openNote(dock, documentId) },
    })
    useWorkspaceFileView.setState({
      dock: {
        open: (file, replacing) =>
          openWorkspaceFilePanel(dock, file, THREAD, replacing),
      },
    })
    useFileDock.setState({ open: (path) => openFile(dock, projectId, path) })
    useDelegationDock.setState({
      open: (delegationId, title) => openDelegation(dock, delegationId, title),
    })
    useReviewDock.setState({
      open: (reviewId, options) => {
        // A quiet open is the dock noticing a new review, not someone asking.
        if (!options?.quiet) showSheet()
        openReviewPanel(dock, reviewId, options?.quiet)
      },
      close: (reviewId) => {
        const panel = dock.getPanel(reviewPanelId(reviewId))
        if (panel) dock.removePanel(panel)
      },
    })
    const listeners = [
      dock.onDidActivePanelChange(({ panel }) => {
        const artifactId = panel && artifactIdOf(panel.id)
        if (artifactId) useArtifactView.getState().focused(artifactId)
      }),
      dock.onDidRemovePanel((panel) => {
        const artifactId = artifactIdOf(panel.id)
        if (artifactId) useArtifactView.getState().closed(artifactId)
      }),
      dock.onDidLayoutChange(save),
      { dispose: followFront(dock) },
      ...springMaximize(dock),
    ]
    return () => {
      for (const listener of listeners) listener.dispose()
      useArtifactView.setState({ dock: undefined })
      useNoteView.setState({ dock: undefined })
      useWorkspaceFileView.setState({ dock: undefined })
      useFileDock.setState({ open: undefined })
      useDelegationDock.setState({ open: undefined })
      useReviewDock.setState({ open: undefined, close: undefined })
    }
  }, [dock, projectId])

  // A different conversation starts without the previous one's artifacts and delegations. A
  // new chat gaining its first id is the same conversation, so it keeps them.
  useEffect(() => {
    if (!dock || layoutThread.current === threadId) return
    const previous = layoutThread.current
    layoutThread.current = threadId
    if (previous !== undefined) {
      for (const panel of dock.panels)
        if (
          artifactIdOf(panel.id) ||
          isDelegationPanel(panel.id) ||
          isReviewPanel(panel.id)
        )
          dock.removePanel(panel)
      useArtifactView.getState().reset()
    }
    persistLayout()
  }, [dock, threadId, projectId])

  // Panel commands: every panel action has a path that is not a drag.
  useEffect(() => {
    if (!dock) return
    return registerPanelCommands(() => dock)
  }, [dock])

  // Crossing the narrow breakpoint switches slots. Going narrow stacks the
  // panels as tabs; coming back restores the desktop arrangement and keeps
  // any panel opened meanwhile.
  const wasNarrow = useRef(narrow)
  useEffect(() => {
    if (!dock || wasNarrow.current === narrow) return
    wasNarrow.current = narrow
    if (narrow) {
      device.current = 'narrow'
      stackPanels(dock, THREAD)
      persistLayout()
      return
    }
    const live = dock.panels.map(liveOf)
    device.current = 'desktop'
    const loaded = loadLayout(
      projectId,
      'desktop',
      useShell.getState().layouts[projectId],
    )
    if (
      loaded.status !== 'ok' ||
      !restoreLayout(
        dock,
        loaded.vendor as unknown as Parameters<typeof dock.fromJSON>[0],
      )
    )
      return
    const kept = new Set(dock.panels.map((panel) => panel.id))
    for (const panel of missingAfterRestore(live, kept))
      dock.addPanel({
        id: panel.id,
        component: panel.component,
        title: panel.title,
        params: panel.params,
        position: { referencePanel: THREAD },
      })
  }, [dock, narrow, projectId])
  // Opening in a narrow dock lands as a tab in the one pane.
  useEffect(() => {
    if (!dock || !narrow) return
    const added = dock.onDidAddPanel(() => stackPanels(dock, THREAD))
    return () => added.dispose()
  }, [dock, narrow])

  return (
    <div
      ref={host}
      data-appearance-part="dock"
      className="relative h-full min-w-0"
    >
      <DockviewReact
        className="h-full w-full"
        theme={theme}
        components={components}
        tabComponents={tabComponents}
        rightHeaderActionsComponent={GroupActions}
        defaultRenderer="always"
        floatingGroupBounds="boundedWithinViewport"
        getTabContextMenuItems={({ panel, api }) => {
          // The built-in float opens at 300px, narrower than these panels' minimums.
          const float = {
            label: 'Float',
            action: () =>
              api.addFloatingGroup(panel, { width: 480, height: 560 }),
          }
          // The same action the Move panel command runs, for a pointer user too.
          const next = {
            label: 'Move to next group',
            action: () => movePanel(api, { id: panel.id }),
          }
          return panel.id === THREAD
            ? ['maximize', float, next]
            : ['maximize', float, next, 'separator', 'close']
        }}
        onReady={onReady}
      />
      <PanelOfferBar dock={dock} />
    </div>
  )
}
