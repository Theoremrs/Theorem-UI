// SOURCING: Base UI Drawer (swipeDirection right) is the right-hand drawer; anime.js createDraggable drags its edge (1:1 tracking, resistance past the width range, spring back on release) and Base UI useMediaQuery keeps that to desktop; the tabbed terminal and each tab's agent are terminal-screen's (Ratzilla with ratatui Tabs over assistant-ui runtimes); zustand shell state keeps the tabs per project
import { Drawer } from '@base-ui/react/drawer'
import type { TheoremContextReference } from '@theoremharness/sdk'
import { useMediaQuery } from '@base-ui/react/unstable-use-media-query'
import { createDraggable } from 'animejs'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
} from 'react'
import { CabinetView } from '@/components/cabinet/cabinet-view'
import { useActiveProject } from '@/components/shell/projects'
import { useShell } from '@/components/shell/shell-state'
import {
  TerminalAgent,
  TerminalScreen,
  addReference,
  restartSession,
  stopSession,
  useCloseOnOutsideDoubleClick,
  useSessionAction,
} from './terminal-screen'
import type { TerminalAction } from './terminal-screen'

const HOST_ID = 'theorem-side-terminal'
/** A cabinet narrower than this would be one column of cramped cards. */
const CABINET_MIN = 340
/** §4.1: the project track's target minimum beside a docked cabinet. */
const MIN_PROJECT_TRACK = 480
/** The sheet's inset from the window edges, as chat-shell draws it. */
const INSET = 3

/** The drawer's narrowest width; the widest leaves the rail and some sheet showing. */
const MIN_WIDTH = 380
const maxWidth = () =>
  Math.max(MIN_WIDTH, Math.min(1200, window.innerWidth - 120))

/**
 * The drawer's left edge, dragged to set its width. The draggable's x is the
 * width negated (dragging left widens), kept between the bounds and written to
 * the popup while the pointer moves; the width it settles at is kept.
 */
function WidthHandle({
  popup,
  cabinet,
}: {
  popup: RefObject<HTMLDivElement | null>
  /** Sets the docked cabinet's width, which the shell reserves, not the drawer's. */
  cabinet: boolean
}) {
  const handle = useRef<HTMLDivElement>(null)
  const drag = useRef<ReturnType<typeof createDraggable> | undefined>(undefined)
  const min = cabinet ? CABINET_MIN : MIN_WIDTH
  const current = useShell((s) => (cabinet ? s.cabinetWidth : s.sideWidth))

  useEffect(() => {
    const element = handle.current
    if (!element) return
    const shell = useShell.getState()
    const draggable = createDraggable(element, {
      // The handle itself stays put; only the popup's width follows x.
      x: { mapTo: '--drag-x' },
      y: false,
      container: () => [0, -min, 0, -maxWidth()],
      // No throw on release: the edge stops where it is let go, springing
      // back only from past the range.
      velocityMultiplier: 0,
      cursor: { onHover: 'ew-resize', onGrab: 'ew-resize' },
      onUpdate: (self) => {
        popup.current?.style.setProperty('--side-width', `${-self.x}px`)
        // A docked cabinet's reserved width follows the edge as it moves.
        if (cabinet && document.documentElement.dataset.cabinet === 'docked')
          reserve(-self.x)
      },
      onSettle: (self) => {
        const width = Math.round(-self.x)
        if (cabinet) useShell.getState().setCabinetWidth(width)
        else useShell.getState().setSideWidth(width)
      },
    })
    draggable.setX(-(cabinet ? shell.cabinetWidth : shell.sideWidth), true)
    drag.current = draggable
    return () => {
      drag.current = undefined
      draggable.revert()
    }
  }, [popup, cabinet, min])

  // The keyboard equivalent of dragging (CAB-020): arrows step the edge,
  // Shift steps further, Home and End go to the limits.
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const step = event.shiftKey ? 64 : 16
    const next =
      event.key === 'ArrowLeft'
        ? current + step
        : event.key === 'ArrowRight'
          ? current - step
          : event.key === 'Home'
            ? maxWidth()
            : event.key === 'End'
              ? min
              : undefined
    if (next === undefined) return
    event.preventDefault()
    const clamped = Math.round(Math.min(maxWidth(), Math.max(min, next)))
    drag.current?.setX(-clamped, true)
    popup.current?.style.setProperty('--side-width', `${clamped}px`)
    if (cabinet && document.documentElement.dataset.cabinet === 'docked')
      reserve(clamped)
    if (cabinet) useShell.getState().setCabinetWidth(clamped)
    else useShell.getState().setSideWidth(clamped)
  }

  return (
    <div
      ref={handle}
      role="separator"
      aria-orientation="vertical"
      aria-label={cabinet ? 'Gallery width' : 'Terminal width'}
      aria-valuemin={min}
      aria-valuemax={typeof window === 'undefined' ? undefined : maxWidth()}
      aria-valuenow={current}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-base-ui-swipe-ignore=""
      className="group relative flex w-3 shrink-0 touch-none items-center justify-center outline-none z-10 before:absolute before:inset-y-0 before:left-0 before:-right-3 before:content-[''] focus-visible:outline-1 focus-visible:outline-term-sage"
    >
      <span className="h-9 w-1 rounded-full bg-term-line transition-[height,background-color] duration-(--duration-snap) ease-snap group-hover:h-14 group-hover:bg-term-muted group-focus-visible:h-14 group-focus-visible:bg-term-muted" />
    </div>
  )
}

/** Reserves `width` (plus the gap) at the shell's right edge for the dock. */
function reserve(width: number | undefined) {
  const root = document.documentElement
  if (width === undefined) root.style.removeProperty('--cabinet-dock')
  else
    root.style.setProperty(
      '--cabinet-dock',
      `${Math.min(width, window.innerWidth - 120) + INSET}px`,
    )
}

/**
 * §4.1: whether a cabinet docked at `width` leaves the project track its
 * minimum, W_project = V − R − N − C − G, measured from the shell's own
 * rail and navigation boxes. When it does not, the cabinet is an overlay.
 */
function useDockFits(width: number, active: boolean) {
  const [fits, setFits] = useState(false)
  useLayoutEffect(() => {
    if (!active) return
    const nav = () =>
      document.querySelector('[data-appearance-width-role="navigation"]')
    const measure = () => {
      const rail =
        document
          .querySelector('[data-appearance-width-role="rail"]')
          ?.getBoundingClientRect().right ?? 0
      const navigation = nav()?.getBoundingClientRect().width ?? 0
      const track = window.innerWidth - rail - navigation - (width + 3 * INSET)
      setFits(track >= MIN_PROJECT_TRACK)
    }
    measure()
    const observer = new ResizeObserver(measure)
    const element = nav()
    if (element) observer.observe(element)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [width, active])
  return active && fits
}

/**
 * The active project's terminal tabs, each its own agent thread, and what
 * their actions do. The right drawer and the IDE's docked terminal show the
 * same tabs. A project shown with none starts with one.
 */
export function useTerminalTabs(shown: boolean, close: () => void) {
  const { project } = useActiveProject()
  const projectId = project?.projectId
  const entry = useShell((s) =>
    projectId ? s.terminalTabs[projectId] : undefined,
  )
  const runAction = useSessionAction()

  useEffect(() => {
    if (shown && projectId && !entry?.tabs.length)
      useShell.getState().openTerminalTab(projectId)
  }, [shown, projectId, entry])

  const onAction = (action: TerminalAction) => {
    if (runAction(action) || !projectId) return
    const shell = useShell.getState()
    switch (action.type) {
      case 'close':
        close()
        return
      case 'new':
        restartSession(action.tab, projectId, action.tab)
        return
      case 'newTab':
        shell.openTerminalTab(projectId)
        return
      case 'closeTab':
        stopSession(action.tab)
        shell.closeTerminalTab(projectId, action.tab)
        return
      case 'selectTab':
        shell.selectTerminalTab(projectId, action.tab)
        return
    }
  }
  return {
    project,
    tabs: entry?.tabs ?? [],
    active: entry?.active ?? '',
    onAction,
  }
}

/**
 * Opens the right-hand terminal with `reference` on its active tab's next
 * turn, starting a tab when the project has none.
 */
export function attachToSideTerminal(
  projectId: string,
  reference: TheoremContextReference,
) {
  const shell = useShell.getState()
  if (!shell.terminalTabs[projectId]?.tabs.length)
    shell.openTerminalTab(projectId)
  const tab = useShell.getState().terminalTabs[projectId]?.active
  if (tab) addReference(tab, reference)
  shell.setSideDrawer('terminal')
}

/**
 * Whether the cabinet is expanded as drawn: asked for, showing, and on a
 * desktop width. The workspace it covers reads the same answer, so a window
 * narrowed under an expanded cabinet is never left dimmed and inert.
 */
export function useCabinetExpanded() {
  const desktop = useMediaQuery('(min-width: 768px)', { noSsr: true })
  const asked = useShell((s) => s.cabinetExpanded && s.sideDrawer === 'outputs')
  return desktop && asked
}

const HOST_VIEWS = [
  { id: 'outputs', label: 'Gallery' },
  { id: 'terminal', label: 'Terminal' },
] as const

/** The host's two views, a pair of tabs above whichever is shown. */
function HostViews({
  view,
  expandable,
  expanded,
}: {
  view: 'outputs' | 'terminal'
  expandable: boolean
  expanded: boolean
}) {
  return (
    // The first label starts on the gallery's content inset (set by the
    // gallery from its cell size) less the tab's own padding, and the strip
    // uses the grid's text size, so tabs and grid read as one recipe.
    <div className="flex shrink-0 items-center gap-1 ps-[max(0px,calc(var(--gallery-inset,20px)-0.5rem))] pe-3 pb-1 font-mono text-[0.78125rem]">
      <div role="tablist" aria-label="Right-hand views" className="flex gap-1">
        {HOST_VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={view === v.id}
            onClick={() => useShell.getState().setSideDrawer(v.id)}
            className="min-h-6 rounded px-2 py-0.5 text-term-muted outline-none pointer-coarse:min-h-11 hover:text-term-ink focus-visible:outline-1 focus-visible:outline-term-sage aria-selected:bg-term-raised aria-selected:text-term-bright"
          >
            {v.label}
          </button>
        ))}
      </div>
      {expandable && (
        <button
          type="button"
          aria-pressed={expanded}
          onClick={() => useShell.getState().setCabinetExpanded(!expanded)}
          className="ms-auto min-h-6 rounded px-2 py-0.5 text-term-muted pointer-coarse:min-h-11 outline-none hover:text-term-ink focus-visible:outline-1 focus-visible:outline-term-sage"
        >
          {expanded ? 'Restore' : 'Expand'}
        </button>
      )}
    </div>
  )
}

/**
 * The right-hand drawer, a terminal with tabs: each tab its own agent thread,
 * all running while the drawer is closed.
 */
export function SideTerminal() {
  const view = useShell((s) => s.sideDrawer)
  // One host, two views: the artifact cabinet ('outputs') and the terminal.
  const open = view === 'terminal' || view === 'outputs'
  const cabinet = view === 'outputs'
  const setSideDrawer = useShell((s) => s.setSideDrawer)
  const sideWidth = useShell((s) => s.sideWidth)
  const cabinetWidth = useShell((s) => s.cabinetWidth)
  const desktop = useMediaQuery('(min-width: 768px)', { noSsr: true })
  const popup = useRef<HTMLDivElement>(null)
  const { project, tabs, active, onAction } = useTerminalTabs(open, () =>
    setSideDrawer(undefined),
  )
  // §4.1/§4.3: on desktop the cabinet docks, reserving its width, when the
  // project track keeps its minimum beside it; otherwise it is an overlay.
  // Expanded, it takes the whole workspace. The terminal is always an overlay.
  const expanded = useCabinetExpanded()
  const docked = useDockFits(cabinetWidth, cabinet && desktop && !expanded)
  const layout = !cabinet
    ? undefined
    : expanded
      ? 'expanded'
      : docked
        ? 'docked'
        : 'overlay'
  const width = cabinet ? cabinetWidth : sideWidth
  useCloseOnOutsideDoubleClick(open && !docked, () => setSideDrawer(undefined))

  useLayoutEffect(() => {
    const root = document.documentElement
    if (layout) root.dataset.cabinet = layout
    else delete root.dataset.cabinet
    reserve(layout === 'docked' ? width : undefined)
    // Expanded, the cabinet covers navigation and main and leaves the rail.
    const rail = document
      .querySelector('[data-appearance-width-role="rail"]')
      ?.getBoundingClientRect().right
    if (layout === 'expanded' && rail !== undefined)
      root.style.setProperty('--cabinet-left', `${rail}px`)
    return () => {
      delete root.dataset.cabinet
      reserve(undefined)
      root.style.removeProperty('--cabinet-left')
    }
  }, [layout, width])

  // Escape restores an expanded cabinet once nothing above it took the key:
  // a native listener, so a portaled dialog's Escape never reaches it.
  useEffect(() => {
    const element = popup.current
    if (!expanded || !element) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      useShell.getState().setCabinetExpanded(false)
    }
    element.addEventListener('keydown', onKey)
    return () => element.removeEventListener('keydown', onKey)
  }, [expanded])

  return (
    <>
      {project &&
        tabs.map((tab) => (
          <TerminalAgent
            key={`${project.projectId}:${tab.id}`}
            sessionKey={tab.id}
            tabId={tab.id}
            projectId={project.projectId}
            project={project.title}
          />
        ))}
      <Drawer.Root
        open={open}
        onOpenChange={(next) =>
          setSideDrawer(next ? (view ?? 'terminal') : undefined)
        }
        modal={false}
        disablePointerDismissal
        swipeDirection="right"
      >
        <Drawer.Portal keepMounted>
          <Drawer.Viewport className="pointer-events-none fixed inset-0 z-40">
            <Drawer.Popup
              ref={popup}
              data-terminal-drawer=""
              data-cabinet-layout={layout}
              style={
                {
                  '--side-width': expanded
                    ? 'calc(100vw - var(--cabinet-left, 0px) - 6px)'
                    : `${width}px`,
                } as CSSProperties
              }
              initialFocus={() => document.getElementById(HOST_ID)}
              className="pointer-events-auto absolute top-[3px] right-[3px] bottom-[3px] flex w-[calc(100vw-6px)] overflow-hidden rounded-xl bg-term shadow-[-8px_0_32px_rgb(0_0_0/0.28)] outline-none [transform:translateX(var(--drawer-swipe-movement-x))] transition-transform duration-[calc(var(--duration-glide)*var(--drawer-swipe-strength))] ease-glide data-ending-style:duration-(--duration-exit) data-ending-style:ease-exit data-ending-style:[transform:translateX(calc(100%+8px))] data-starting-style:[transform:translateX(calc(100%+8px))] data-swiping:duration-0 data-swiping:select-none md:w-[min(var(--side-width),calc(100vw-120px))] data-[cabinet-layout=docked]:shadow-none data-[cabinet-layout=expanded]:md:w-(--side-width)"
            >
              <Drawer.Title className="sr-only">
                {cabinet ? 'Gallery' : 'Agent terminal'}
              </Drawer.Title>
              {desktop && expanded ? (
                <div aria-hidden="true" className="w-3 shrink-0" />
              ) : desktop ? (
                <WidthHandle
                  key={String(cabinet)}
                  popup={popup}
                  cabinet={cabinet}
                />
              ) : (
                <div
                  aria-hidden="true"
                  className="flex w-3 shrink-0 cursor-grab items-center justify-center active:cursor-grabbing"
                >
                  <span className="h-9 w-1 rounded-full bg-term-line" />
                </div>
              )}
              <div className="flex min-w-0 flex-1 flex-col pt-1.5">
                <HostViews
                  view={cabinet ? 'outputs' : 'terminal'}
                  expandable={cabinet && desktop}
                  expanded={expanded}
                />
                <div className="relative min-h-0 flex-1">
                  {/* The terminal stays mounted under the cabinet, so its
                      sessions and scrollback outlast a look at the collection. */}
                  <div
                    className="absolute inset-0 flex flex-col data-[hidden]:invisible"
                    data-hidden={cabinet || undefined}
                    inert={cabinet}
                  >
                    <TerminalScreen
                      hostId={HOST_ID}
                      tabbed
                      tabs={tabs}
                      active={active}
                      onAction={onAction}
                    />
                  </div>
                  {cabinet && (
                    <div className="absolute inset-0 flex flex-col">
                      <CabinetView expanded={expanded} />
                    </div>
                  )}
                </div>
              </div>
            </Drawer.Popup>
          </Drawer.Viewport>
        </Drawer.Portal>
      </Drawer.Root>
    </>
  )
}
