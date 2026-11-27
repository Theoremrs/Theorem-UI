// SOURCING: dockview-react via DockShell (desktop layout), the Life field under the desktop sheet (LifeSheet) seen through the side panel's frosted glass (styles.css glass-panel; under liquid glass, glass/liquid-glass curved on all four edges, a card lifted off the sheet after the AG-UI Dojo's floating sidebar the owner's review named), Base UI Drawer (the panel's card over a sheet too narrow to dock it, with the rail on a phone), Base UI useMediaQuery, the shell's ModeView (assistant-ui Thread in chat mode), AgentComposer (Base UI Popover), NotePanel (Milkdown Crepe), WorkspaceFilePanel, WorkspaceCommands (the folder dialogs and their shortcuts), the workbench docked full screen, beside or under the sheet (WorkbenchDock) and the SideTerminal's gallery, the Vault (React.lazy, so cosmos.gl loads only when it opens)
import { useThreadDisplayTitle } from '@/lib/theorem/thread-title'
import type { SplitviewApi, SplitviewReadyEvent } from 'dockview-react'
import { useParams } from '@tanstack/react-router'
import { AgentComposer } from '@/components/canvas/agent-composer'
import { ContextPanel } from './sidebar'
import { DockShell } from './dock'
import { Drawer } from '@base-ui/react/drawer'
import { Icon } from '@/components/icons'
import { ThemeToggle } from '@/components/settings/theme-toggle'
import { LifeSheet } from '@/components/life/life-backdrop'
import { FloatingCard, FLOATING_CARD_VARS } from './floating-card'
import './chat-shell.css'
import { LayoutPriority, Orientation, SplitviewReact } from 'dockview-react'
import { modeLabel, navigatorMode, useShellMode } from './modes'
import { useProjectHomeTitle } from '@/components/projects/project-home'
import { PANEL_WIDTH, useShell } from './shell-state'
import { Rail } from './rail'
import {
  SideTerminal,
  useCabinetExpanded,
} from '@/components/terminal/side-terminal'
import {
  useWorkbenchPlacement,
  useWorkbenchShortcut,
} from '@/components/workbench/use-workbench-placement'
import { WorkbenchDock } from '@/components/workbench/workbench-dock'
import { ThreadListPrimitive } from '@assistant-ui/react'
import { TooltipIconButton } from '@/components/assistant-ui/elements/tooltip-icon-button'
import { WorkspaceCommands } from '@/components/workspace/workspace-commands'
import { cn } from '@/lib/utils'
import {
  Suspense,
  createContext,
  lazy,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ComponentType, CSSProperties } from 'react'

import { ContributionBoundary } from './contribution-boundary'
import { moduleComponentOf } from './module-mount'
import {
  useHostContributions,
  useNavEntries,
  useSelectedShell,
} from '@/lib/shell/host-registry'
import type { ShellPresentationProps } from '@/lib/shell/host-registry'
import { ModePage } from '@/components/pages/mode-page'
import { IdePageShown, OnIdePage } from '@/components/ide/ide-page'
import { IdeStatusBar } from '@/components/ide/ide-status-bar'

const Workbench = lazy(() =>
  import('@/components/workbench/workbench').then((module) => ({
    default: module.Workbench,
  })),
)

const VaultWorkspace = lazy(() =>
  import('@/components/vault/vault-workspace').then((module) => ({
    default: module.VaultWorkspace,
  })),
)

const iconButton = 'size-9 p-2'

function ChatHeader({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const threadTitle = useThreadDisplayTitle()
  const title = useProjectHomeTitle() ?? threadTitle
  const mode = useShellMode()
  return (
    <header className="flex h-14 shrink-0 items-center gap-1 px-2">
      <TooltipIconButton
        tooltip="Open sidebar"
        aria-label="Open sidebar"
        className={iconButton}
        onClick={onOpenSidebar}
      >
        <Icon.Layout className="size-[18px]" />
      </TooltipIconButton>
      <ThreadListPrimitive.New
        render={<TooltipIconButton tooltip="New chat" className={iconButton} />}
      >
        <Icon.NewChat className="size-[18px]" />
      </ThreadListPrimitive.New>
      <h1 className="min-w-0 truncate px-2 text-sm text-ink-muted">
        {mode === 'chat' ? title || 'New chat' : modeLabel(mode)}
      </h1>
      <div className="ms-auto">
        <ThemeToggle />
      </div>
    </header>
  )
}

/**
 * Navigation over the conversation, without replacing the mounted
 * conversation, where the sheet is too narrow to dock it. It is the same
 * floating card as the docked panel, beside the docked rail; on a phone,
 * where the docked rail is hidden, the drawer brings its own rail. Escape,
 * a press outside and a swipe close it.
 */
function NavigationDrawer({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const panelWidth = useShell((s) => s.panelWidth)
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} swipeDirection="left">
      <Drawer.Portal>
        <Drawer.Backdrop className="appearance-navigation-backdrop fixed inset-0 z-40 bg-black/30" />
        <Drawer.Viewport className="fixed inset-0 z-50 flex items-stretch justify-start">
          <Drawer.Popup
            data-appearance-part="drawer"
            style={{ '--drawer-panel': `${panelWidth}px` } as CSSProperties}
            className={`appearance-navigation-drawer flex h-full max-w-full outline-none ${FLOATING_CARD_VARS} [--sheet-inset:3px]`}
          >
            <Drawer.Title className="sr-only">Navigation</Drawer.Title>
            <div className="appearance-drawer-rail h-full bg-rail">
              <Rail />
            </div>
            <div className="min-w-0 flex-1 py-(--sheet-inset)">
              <GlassPanel />
            </div>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

/** What the dock beside the context panel shows. */
type DockRoute = { projectId: string; threadId: string | undefined }
const DockRouteContext = createContext<DockRoute | null>(null)

/**
 * A layer kept mounted while another shows. Dockview's views set visibility:
 * visible on themselves, which shows through a hidden parent, so the layer is
 * transparent as well as hidden.
 */
const HIDDEN_LAYER = 'invisible opacity-0'

/**
 * The column beside the panel: the dock, and in IDE mode the IDE's page over
 * it (by default the conversation with Theia beside it). The page loads on
 * its first visit and then stays, hidden, so Theia's editors and layout
 * survive a switch; the dock stays mounted under it for the same reason, and
 * hides while the page shows so the sheet's gradient shows through the page.
 */
function DockView() {
  const route = useContext(DockRouteContext)
  if (!route) throw new Error('DockView renders inside the desktop sheet')
  const ide = useShellMode() === 'ide'
  const [ideLoaded, setIdeLoaded] = useState(ide)
  if (ide && !ideLoaded) setIdeLoaded(true)
  return (
    // The bottom workspace overlays the full frame. Keep the conversation's
    // composer above it while the sidebar retains its full height.
    <div
      data-workbench-anchor=""
      className="relative h-full pb-(--workbench-reserve,0px)"
    >
      {/* Dockview layers its panels with z-index; isolate keeps them under the page. */}
      <div inert={ide} className={cn('isolate h-full', ide && HIDDEN_LAYER)}>
        <DockShell projectId={route.projectId} threadId={route.threadId} />
      </div>
      {ideLoaded && (
        <div
          inert={!ide}
          className={cn(
            'absolute inset-x-0 top-0 bottom-(--workbench-reserve,0px)',
            !ide && HIDDEN_LAYER,
          )}
        >
          <OnIdePage value>
            <IdePageShown value={ide}>
              <ModePage mode="ide" />
            </IdePageShown>
          </OnIdePage>
        </div>
      )}
    </div>
  )
}
const PANEL = 'panel'

/**
 * The side panel as a card lifted off the sheet: inset from the sheet's edges,
 * rounded on every corner and casting a shadow, with the rail's tab for its
 * mode bridging the gap to it. As frosted glass the Life field runs under the
 * whole sheet, so it shows through the card, blurred; under liquid glass the
 * card is a liquid pane curved on all four edges.
 */
function GlassPanel() {
  return (
    <FloatingCard>
      <ContextPanel />
    </FloatingCard>
  )
}

const splitComponents = {
  [PANEL]: GlassPanel,
  dock: DockView,
}

/**
 * The sheet's two columns: the active mode's panel and the dock. The panel
 * keeps its width as the window resizes, can be dragged within its range and
 * closes per mode from the rail.
 */
function SheetSplit({
  onOpenSidebar,
  ...route
}: DockRoute & { onOpenSidebar: () => void }) {
  // The Vault covers the split, and the rail's button drives its own side
  // panel, so the split underneath keeps Chat's panel.
  const panelMode = navigatorMode(useShellMode())
  const panelOpen = useShell((s) => !s.panelCollapsed[panelMode])
  const [split, setSplit] = useState<SplitviewApi>()
  const host = useRef<HTMLDivElement>(null)
  const lastFocus = useRef<{ element: HTMLElement; inShell: boolean } | null>(
    null,
  )
  const preferredWidth = useShell((s) => s.panelWidth)
  const [overlay, setOverlay] = useState(false)
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      if (
        !(event.target instanceof HTMLElement) ||
        event.target === document.body
      )
        return
      lastFocus.current = {
        element: event.target,
        inShell: Boolean(
          host.current?.closest('.appearance-shell')?.contains(event.target),
        ),
      }
    }
    document.addEventListener('focusin', remember)
    return () => document.removeEventListener('focusin', remember)
  }, [])
  useEffect(() => {
    const element = host.current
    if (!element) return
    let frame = 0
    const measure = () => {
      frame = 0
      const root = parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      )
      setOverlay(element.clientWidth - preferredWidth < 35 * root)
    }
    const observer = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(measure)
    })
    observer.observe(element)
    observer.observe(document.documentElement)
    measure()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [preferredWidth])

  const onReady = ({ api }: SplitviewReadyEvent) => {
    const panelWidth = useShell.getState().panelWidth
    api.addPanel({
      id: PANEL,
      component: PANEL,
      size: panelWidth,
      minimumSize: PANEL_WIDTH.min,
      maximumSize: PANEL_WIDTH.max,
      priority: LayoutPriority.Low,
    })
    // Without a size the dock is added by evenly redistributing every view,
    // which would widen the panel to its maximum.
    api.addPanel({
      id: 'dock',
      component: 'dock',
      size: api.width - panelWidth,
      minimumSize: 0,
      priority: LayoutPriority.High,
    })
    setSplit(api)
  }

  useEffect(() => {
    split?.getPanel(PANEL)?.api.setVisible(panelOpen && !overlay)
    const element = host.current?.querySelector<HTMLElement>('.sheet-split')
    const frame = requestAnimationFrame(() => {
      if (element) split?.layout(element.clientWidth, element.clientHeight)
      const previous = lastFocus.current
      if (!previous?.inShell) return
      const navigationHidden =
        overlay &&
        previous.element.closest('[data-appearance-part="navigation"]')
      if (
        !navigationHidden &&
        previous.element.checkVisibility({ visibilityProperty: true })
      )
        return
      if (
        document.activeElement !== document.body &&
        document.activeElement !== previous.element
      )
        return
      const shell = host.current?.closest('.appearance-shell')
      const controls = [
        ...(shell?.querySelectorAll<HTMLElement>('button,a,[role="button"]') ??
          []),
      ].filter((control) =>
        control.checkVisibility({ visibilityProperty: true }),
      )
      // A hidden navigation command hands focus to its visible counterpart,
      // otherwise to the drawer trigger (or the first docked rail command).
      const label = previous.element.getAttribute('aria-label')
      const counterpart = controls.find(
        (control) => label && control.getAttribute('aria-label') === label,
      )
      const trigger = controls.find(
        (control) => control.getAttribute('aria-label') === 'Open sidebar',
      )
      ;(counterpart ?? trigger ?? controls[0])?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [split, panelOpen, overlay])

  // The width a drag leaves the panel at is the width it reopens with.
  useEffect(() => {
    const panel = split?.getPanel(PANEL)
    if (!panel) return
    const listener = panel.api.onDidDimensionsChange(({ width }) => {
      if (panel.api.isVisible && width > 0)
        useShell.getState().setPanelWidth(width)
    })
    return () => listener.dispose()
  }, [split])

  return (
    <DockRouteContext.Provider value={route}>
      <div
        ref={host}
        className="flex h-full min-w-0 flex-col"
        data-appearance-part="shell-allocation"
      >
        {(overlay || !panelOpen) && (
          <div className="appearance-compact-header">
            {/* With room to dock it, the panel comes back docked; only a
                sheet too narrow for it takes the drawer. */}
            <ChatHeader
              onOpenSidebar={
                overlay
                  ? onOpenSidebar
                  : () => useShell.getState().setPanelOpen(panelMode, true)
              }
            />
          </div>
        )}
        <div className="min-h-0 flex-1">
          <SplitviewReact
            className="sheet-split dockview-theme-theorem h-full w-full"
            orientation={Orientation.HORIZONTAL}
            proportionalLayout={false}
            components={splitComponents}
            onReady={onReady}
          />
        </div>
      </div>
    </DockRouteContext.Provider>
  )
}

/**
 * Desktop shell: the rail is the base, and one rounded sheet sits on it,
 * inset by --sheet-inset from the window, holding the panel and the dock.
 * The sheet lifts off the rail by a shadow in light and a glow in dark.
 * In IDE mode the IDE's page takes the dock's place beside the IDE's panel,
 * and Theia's status bar runs along the bottom of the whole sheet.
 * In Vault mode the Vault fills the sheet; it loads on its first visit and
 * then stays, hidden, so its editors and layout survive a switch, and the
 * panel and dock stay mounted under it for the same reason.
 */
function DesktopShell(route: DockRoute) {
  const mode = useShellMode()
  const {
    placement,
    requestedPlacement,
    toggle: toggleWorkbench,
  } = useWorkbenchPlacement()
  useWorkbenchShortcut(toggleWorkbench)
  const full = requestedPlacement === 'full'
  // Only the docked right placement takes space in the frame's row.
  const dockedSide = useShell(
    (s) => placement === 'side' && s.workbenchAttachment === 'docked',
  )
  // The row the workbench writes its sizes to (workbench-dock.tsx), kept as
  // the element so the workbench has it in its first layout effects.
  const [frame, setFrame] = useState<HTMLDivElement | null>(null)
  const savedFocus = useRef<HTMLElement | null>(null)
  const previousPlacement = useRef(placement)
  useLayoutEffect(() => {
    if (!frame) return
    const sheet = frame.querySelector('[data-appearance-part="sheet-frame"]')
    const remember = (event: Event) => {
      const target = event.target
      if (target instanceof HTMLElement && sheet?.contains(target))
        savedFocus.current = target
    }
    frame.addEventListener('focusin', remember)
    return () => frame.removeEventListener('focusin', remember)
  }, [frame])
  useLayoutEffect(() => {
    const closedWithFocusLost =
      previousPlacement.current !== undefined &&
      placement === undefined &&
      document.activeElement === document.body
    if (
      (previousPlacement.current === 'full' && !full) ||
      closedWithFocusLost
    ) {
      const previous = savedFocus.current
      const fallback = frame?.querySelector<HTMLElement>(
        '[data-appearance-part="sheet-frame"] [aria-label="Message input"]',
      )
      const target = previous?.getClientRects().length ? previous : fallback
      target?.focus({ preventScroll: true })
    }
    previousPlacement.current = placement
  }, [frame, full, placement])
  // Mounted on its first showing, then kept, hidden while closed, so its runs
  // and terminals carry on (components/workbench/workbench-dock.tsx).
  const [workbenchMounted, setWorkbenchMounted] = useState(
    requestedPlacement !== undefined,
  )
  if (requestedPlacement !== undefined && !workbenchMounted)
    setWorkbenchMounted(true)
  const { documentId } = useParams({ strict: false })
  const view = `${mode}:${route.threadId}:${documentId}`
  const [drawerView, setDrawerView] = useState<string | null>(null)
  const drawerOpen = drawerView === view
  const setDrawerOpen = (open: boolean) => setDrawerView(open ? view : null)
  if (drawerView !== null && drawerView !== view) setDrawerView(null)
  const vault = mode === 'vault'
  const ide = mode === 'ide'
  // An expanded artifact cabinet covers the workspace: what it dims is inert.
  const covered = useCabinetExpanded()
  const [vaultLoaded, setVaultLoaded] = useState(vault)
  if (vault && !vaultLoaded) setVaultLoaded(true)
  return (
    <div
      data-appearance-part="shell"
      data-appearance-width-role="usable"
      className={`appearance-shell flex h-full w-full ${FLOATING_CARD_VARS} [--sheet-h:calc(100dvh-2*var(--sheet-inset))] [--sheet-inset:3px]`}
    >
      <div className="appearance-docked-rail" data-appearance-width-role="rail">
        <Rail collapsible workspaceFull={full} />
      </div>
      {/* A docked cabinet reserves its width here (side-terminal sets
          --cabinet-dock); an overlay reserves none. The workbench sits in the
          same row whatever its placement, so moving it keeps the mounted
          workspace. A right drawer covers the conversation column and a
          bottom drawer spans this frame, including the sidebar. */}
      <div
        ref={setFrame}
        className="relative flex min-h-0 min-w-0 flex-1 flex-row me-(--cabinet-dock,0px) transition-[margin] duration-(--duration-glide) ease-glide"
      >
        <div
          className={cn(
            'relative my-(--sheet-inset) me-(--sheet-inset) min-h-0 min-w-0 flex-1 data-[covered]:opacity-40',
            dockedSide && 'me-0',
          )}
          data-appearance-part="sheet-frame"
          data-covered={covered || undefined}
          hidden={full}
          inert={covered}
        >
          <div aria-hidden="true" className="lift-glow" />
          <div
            data-active-surface={full ? undefined : ''}
            className="sheet relative h-full overflow-hidden rounded-xl bg-sheet shadow-sheet"
          >
            {/* Dockview layers its panels with z-index; isolate keeps them under the Vault. */}
            <div inert={vault} className="isolate flex h-full flex-col">
              <div className="min-h-0 flex-1">
                {/* The field runs under the panel as well as the conversation,
                  while the conversation is the sheet's view. */}
                <LifeSheet active={mode === 'chat' && !full}>
                  <SheetSplit
                    {...route}
                    onOpenSidebar={() => setDrawerOpen(true)}
                  />
                </LifeSheet>
              </div>
              {ide && <IdeStatusBar />}
            </div>
            {vaultLoaded && (
              <div
                inert={!vault}
                className={cn(
                  'absolute inset-0 isolate flex flex-col bg-sheet',
                  !vault && HIDDEN_LAYER,
                )}
              >
                <div className="appearance-vault-header shrink-0">
                  <ChatHeader onOpenSidebar={() => setDrawerOpen(true)} />
                </div>
                <div className="min-h-0 flex-1">
                  <Suspense>
                    <VaultWorkspace active={vault} />
                  </Suspense>
                </div>
              </div>
            )}
          </div>
        </div>
        {workbenchMounted && (
          <WorkbenchDock placement={requestedPlacement} frame={frame}>
            {({ shown, companion }) => (
              <Suspense
                fallback={
                  <p role="status" className="p-3 text-sm">
                    Opening workspace…
                  </p>
                }
              >
                <Workbench
                  key={route.projectId}
                  projectId={route.projectId}
                  shown={shown}
                  companion={companion}
                />
              </Suspense>
            )}
          </WorkbenchDock>
        )}
      </div>
      <NavigationDrawer open={drawerOpen} onOpenChange={setDrawerOpen} />
    </div>
  )
}
/**
 * Rail, panel, conversation and artifacts. Mounted inside TheoremRuntimeProvider.
 * The shipped presentation is the `theorem.shell.default` contribution. A
 * `shell` contribution the person selected replaces it, receiving the same
 * navigation and panel contributions; if it throws, the failure is recorded
 * and the shipped presentation takes its place. Recovery and sign-in are
 * mounted by the root, outside this component, so no shell can remove them.
 */
export function ChatShell({
  projectId,
  threadId,
}: {
  projectId: string
  threadId: string | undefined
}) {
  const custom = useSelectedShell()
  const navigation = useNavEntries()
  const panels = useHostContributions('panel')
  const shipped = <DesktopShell projectId={projectId} threadId={threadId} />
  // A shell a module declares has no component code: the module runtime
  // mounts it. Memoized so the mounted module is not remounted each render.
  const Custom = useMemo(
    () =>
      (custom?.Component ??
        (custom ? moduleComponentOf(custom) : undefined)) as
        ComponentType<ShellPresentationProps> | undefined,
    [custom],
  )
  return (
    <div className="flex h-dvh w-full overflow-hidden bg-rail text-ink">
      {custom && Custom ? (
        <ContributionBoundary
          area="shell"
          contributionId={custom.id}
          fallback={shipped}
        >
          <Custom
            projectId={projectId}
            threadId={threadId}
            navigation={navigation}
            panels={panels}
            shipped={shipped}
          />
        </ContributionBoundary>
      ) : (
        shipped
      )}
      <AgentComposer projectId={projectId} />
      <WorkspaceCommands />
      <SideTerminal />
    </div>
  )
}
