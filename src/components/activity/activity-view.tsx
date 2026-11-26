// SOURCING: hand-roll over the shell's own pieces: @tanstack/react-router (useNavigate, the thread route the command palette opens), components/shell/shell-state (setProjectId, the workbench placement a reveal shows), lib/workbench/activity (inventory, arrangement and the workspace's lent owners) and the platform's ResizeObserver to keep the view above the composer. No library models a non-modal activity drawer that must leave the composer uncovered (DR-01), so this is a plain region rather than a Base UI Drawer, which would trap focus and dim the page.
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react'
import { Icon } from '@/components/icons'
import { useShell } from '@/components/shell/shell-state'
import { cn } from '@/lib/utils'
import {
  effectivePlacement,
  effectiveSize,
  RIGHT_MIN_WIDTH,
  SIZE,
  useActivityView,
} from '@/lib/workbench/activity/arrangement'
import type {
  ArrangedItem,
  DrawerPlacement,
} from '@/lib/workbench/activity/arrangement'
import { DETACHED_SIDE_CHAT } from '@/lib/workbench/activity/inventory'
import type {
  ActivityEntry,
  WaitingFor,
} from '@/lib/workbench/activity/projection'
import type { ActivitySource } from '@/lib/workbench/activity/sources'
import { useActivity } from '@/lib/workbench/activity/use-activity'

/** The space kept between the view and the composer it stays above. */
const GAP = 8

/** The words a row's state reads as. Every state is named in text, never by color alone (UI-01). */
export function statusText(item: ArrangedItem): string {
  const { entry, listed } = item
  if (!listed) return 'Not listed as working now'
  const catching =
    entry.observation === 'stale' || entry.observation === 'recovering'
      ? ' (catching up)'
      : ''
  const words = (() => {
    switch (entry.execution) {
      case 'waiting':
        return waitingWords[entry.waiting?.for ?? 'other']
      case 'running':
        return entry.reported ? 'Running, by its own report' : 'Working'
      case 'queued':
      case 'starting':
        return 'Starting'
      case 'paused':
        return 'Paused'
      case 'succeeded':
        return 'Finished'
      case 'failed':
        return 'Failed'
      case 'cancelled':
        return 'Stopped'
      case 'interrupted':
        return 'Interrupted'
      default:
        return entry.detail ?? 'State not reported'
    }
  })()
  return words + catching
}

// Rex's status protocol says what a blocked program waits on (approval, an
// answer, a sign-in); the text says which, so no symbol has to.
const waitingWords: Record<WaitingFor, string> = {
  approval: 'Waiting for your approval',
  input: 'Waiting for your answer',
  dependency: 'Waiting on other work',
  capacity: 'Waiting for capacity',
  other: 'Waiting',
}

/** Which quiet mark a row carries. The status text always says the same. */
export function toneOf(
  item: ArrangedItem,
): 'working' | 'waiting' | 'ended' | 'idle' {
  if (!item.listed) return 'ended'
  switch (item.entry.execution) {
    case 'waiting':
      return 'waiting'
    case 'running':
    case 'queued':
    case 'starting':
      return 'working'
    case 'succeeded':
    case 'failed':
    case 'cancelled':
    case 'interrupted':
      return 'ended'
    default:
      return 'idle'
  }
}

/** A small mark beside the row, like Rex's tab-header indicators: decoration only. */
function ToneMark({
  tone,
  className,
}: {
  tone: ReturnType<typeof toneOf>
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      data-activity-tone={tone}
      className={cn(
        'size-2 shrink-0 rounded-full',
        tone === 'working' && 'bg-accent motion-safe:animate-pulse',
        tone === 'waiting' && 'bg-attention',
        tone === 'ended' && 'border border-separator',
        tone === 'idle' && 'bg-separator',
        className,
      )}
    />
  )
}

const sourceWord: Record<ActivityEntry['source'], string> = {
  thread: 'Thread',
  terminal: 'Terminal',
  sideChat: 'Side chat',
  delegation: 'Delegated run',
}

const COMPOSERS =
  '[data-appearance-part="sheet-frame"] [data-appearance-part="composer"]'

/**
 * Measures where the visible composer starts, so the view ends above it however tall it grows.
 * Panels kept mounted while hidden have composers too, and a Compare pane can show its own: every
 * visible one counts, and the highest decides.
 */
function useComposerClearance(frame: HTMLElement | null) {
  const [clearance, setClearance] = useState(GAP)
  useLayoutEffect(() => {
    if (!frame) return
    let frameId = 0
    const measure = () => {
      frameId = 0
      const box = frame.getBoundingClientRect()
      let top = box.bottom
      for (const composer of frame.querySelectorAll<HTMLElement>(COMPOSERS))
        if (composer.checkVisibility({ visibilityProperty: true }))
          top = Math.min(top, composer.getBoundingClientRect().top)
      setClearance(Math.max(GAP, Math.round(box.bottom - top + GAP)))
    }
    const schedule = () => {
      if (!frameId) frameId = requestAnimationFrame(measure)
    }
    const observer = new ResizeObserver(schedule)
    const follow = () => {
      for (const composer of frame.querySelectorAll(COMPOSERS))
        observer.observe(composer)
    }
    observer.observe(frame)
    follow()
    // Composers mount and remount as the route changes, and panels show and hide by attribute:
    // follow both.
    const mutations = new MutationObserver(() => {
      follow()
      schedule()
    })
    mutations.observe(frame, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'inert', 'style', 'class', 'aria-hidden'],
    })
    window.visualViewport?.addEventListener('resize', schedule)
    measure()
    return () => {
      observer.disconnect()
      mutations.disconnect()
      window.visualViewport?.removeEventListener('resize', schedule)
      cancelAnimationFrame(frameId)
    }
  }, [frame])
  return clearance
}

function useWidth(element: HTMLElement | null) {
  const [width, setWidth] = useState(1440)
  useLayoutEffect(() => {
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    // The observer reports the first size as soon as it observes.
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return width
}

/** Shows the workspace beside the conversation if it is closed. Starts nothing. */
function revealWorkspace() {
  const shell = useShell.getState()
  if (!shell.workbench || shell.workbench === 'closed')
    shell.setWorkbench(shell.lastCompanion)
}

/**
 * Opening work: the existing resource is revealed, never a new execution (CP-03). A thread opens
 * its conversation; a terminal or side chat shows the workspace, whose own side-chat list reopens
 * a closed side chat.
 */
function useOpenWork(projectId: string, source: ActivitySource | undefined) {
  const navigate = useNavigate()
  const [notice, setNotice] = useState<string>()
  const open = async (entry: ActivityEntry, listed: boolean) => {
    setNotice(undefined)
    if (entry.source === 'thread') {
      // A thread filed in the project shown now opens there; only one from elsewhere moves the
      // shell. The chat route opens a thread in the project asked for, so say which.
      const shell = useShell.getState()
      const target =
        entry.projectId && !entry.projects?.includes(projectId)
          ? entry.projectId
          : projectId
      shell.askProject({ threadId: entry.resource, projectId: target })
      if (target !== projectId) shell.setProjectId(target)
      await navigate({
        to: '/c/$threadId',
        params: { threadId: entry.resource },
      })
      return
    }
    if (!source) {
      setNotice(
        'The workspace is not open here, so this work cannot be shown yet.',
      )
      return
    }
    revealWorkspace()
    // A closed side chat reopens from the workspace's own side-chat list, where the workspace's
    // conversation owner keeps it, so the drawer never opens a second copy of it.
    if (
      entry.source === 'sideChat' &&
      listed &&
      entry.detail === DETACHED_SIDE_CHAT
    )
      setNotice('Reopen it from the side chat list in the workspace.')
  }
  return { open, notice }
}

function IconButton({
  label,
  onClick,
  children,
  pressed,
  disabled,
}: {
  label: string
  onClick: () => void
  children: ReactNode
  pressed?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      data-activity-chrome=""
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className="grid size-8 disabled:opacity-40 place-items-center rounded-md text-ink-muted outline-focus hover:bg-hover hover:text-ink focus-visible:outline-2 aria-pressed:bg-selected aria-pressed:text-ink"
    >
      {children}
    </button>
  )
}

/** One stable row: a header that selects (double-click opens), and an Open work action for every input. */
function Row({
  item,
  selected,
  projectLabel,
  onSelect,
  onOpen,
  onHeaderOpen,
}: {
  item: ArrangedItem
  selected: boolean
  projectLabel?: string
  onSelect: () => void
  /** The Open work action: reveals the work itself. */
  onOpen: () => void
  /** Double-click on the header: opens the preferred surface, by default the drawer. */
  onHeaderOpen?: (origin: HTMLElement) => void
}) {
  const { entry } = item
  return (
    <li data-activity-item={entry.key} className="flex items-center gap-1">
      <button
        type="button"
        data-activity-chrome=""
        data-activity-row={entry.key}
        aria-pressed={selected}
        onClick={onSelect}
        onDoubleClick={(event) =>
          onHeaderOpen ? onHeaderOpen(event.currentTarget) : onOpen()
        }
        className={cn(
          'flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 text-start outline-focus focus-visible:outline-2',
          selected ? 'bg-selected' : 'hover:bg-hover',
        )}
      >
        <ToneMark tone={toneOf(item)} className="mt-1.5" />
        {/* Rex's row anatomy: the name, a quieter line saying what it is
            doing, and where it lives at the far end. */}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex w-full items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-sm text-ink">
              {entry.label}
            </span>
            <span className="shrink-0 text-xs text-ink-faint">
              {sourceWord[entry.source]}
              {projectLabel ? ` in ${projectLabel}` : ''}
            </span>
          </span>
          <span className="w-full truncate text-xs text-ink-muted">
            {statusText(item)}
          </span>
        </span>
      </button>
      <button
        type="button"
        data-activity-chrome=""
        onClick={onOpen}
        aria-label={`Open work: ${entry.label}`}
        className="shrink-0 rounded-md px-2 py-1 text-xs text-ink-muted outline-focus hover:bg-hover hover:text-ink focus-visible:outline-2"
      >
        Open work
      </button>
    </li>
  )
}

/** The selected run's main surface: what it is, where it lives and what can be done with it. */
function Surface({
  item,
  projectLabel,
  onOpen,
  onRemove,
  onMove,
  canMove,
}: {
  item: ArrangedItem | undefined
  projectLabel?: string
  onOpen: () => void
  onRemove: () => void
  onMove: (by: number) => void
  canMove: { up: boolean; down: boolean }
}) {
  if (!item)
    return (
      <p className="p-4 text-sm text-ink-muted">
        Choose work from the list to see it here.
      </p>
    )
  const { entry } = item
  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-auto p-4">
      <div>
        <h3 className="text-sm font-medium text-ink">{entry.label}</h3>
        <p className="text-xs text-ink-muted">
          {sourceWord[entry.source]}
          {projectLabel ? ` in ${projectLabel}` : ''}
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-ink-muted">State</dt>
        <dd className="text-ink">{statusText(item)}</dd>
        {entry.detail && item.listed && entry.execution !== 'unknown' && (
          <>
            <dt className="text-ink-muted">Detail</dt>
            <dd className="text-ink">{entry.detail}</dd>
          </>
        )}
        {entry.runId && (
          <>
            <dt className="text-ink-muted">Run</dt>
            <dd className="select-text font-mono text-ink">{entry.runId}</dd>
          </>
        )}
        {entry.reported && (
          <>
            <dt className="text-ink-muted">Source</dt>
            <dd className="text-ink">
              The program’s own report, not its agent’s outcome
            </dd>
          </>
        )}
      </dl>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-activity-chrome=""
          onClick={onOpen}
          className="rounded-md bg-action px-3 py-1.5 text-sm text-ink outline-focus focus-visible:outline-2"
        >
          Open work
        </button>
        <button
          type="button"
          data-activity-chrome=""
          disabled={!canMove.up}
          onClick={() => onMove(-1)}
          className="rounded-md px-3 py-1.5 text-sm text-ink-muted outline-focus hover:bg-hover disabled:opacity-40 focus-visible:outline-2"
        >
          Move up
        </button>
        <button
          type="button"
          data-activity-chrome=""
          disabled={!canMove.down}
          onClick={() => onMove(1)}
          className="rounded-md px-3 py-1.5 text-sm text-ink-muted outline-focus hover:bg-hover disabled:opacity-40 focus-visible:outline-2"
        >
          Move down
        </button>
        <button
          type="button"
          data-activity-chrome=""
          onClick={onRemove}
          className="rounded-md px-3 py-1.5 text-sm text-ink-muted outline-focus hover:bg-hover focus-visible:outline-2"
        >
          Remove from view
        </button>
      </div>
    </div>
  )
}

/** The drawer's resize edge: a separator that drags, and steps with the arrow keys. */
function ResizeEdge({
  placement,
  size,
  room,
  onSize,
}: {
  placement: DrawerPlacement
  size: number
  room: number
  onSize: (size: number) => void
}) {
  const start = useRef<{ at: number; size: number; sign: number } | null>(null)
  const bottom = placement === 'bottom'
  // A side drawer sits at the inline end, so its edge faces the start: leftwards in a
  // left-to-right layout, rightwards in a right-to-left one.
  const rtl = (element: HTMLElement) =>
    getComputedStyle(element).direction === 'rtl'
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    start.current = {
      at: bottom ? event.clientY : event.clientX,
      size,
      sign: !bottom && rtl(event.currentTarget) ? -1 : 1,
    }
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return
    const delta =
      (start.current.at - (bottom ? event.clientY : event.clientX)) *
      start.current.sign
    onSize(Math.min(room, start.current.size + delta))
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const reversed = !bottom && rtl(event.currentTarget)
    const grow = bottom ? 'ArrowUp' : reversed ? 'ArrowRight' : 'ArrowLeft'
    const shrink = bottom ? 'ArrowDown' : reversed ? 'ArrowLeft' : 'ArrowRight'
    if (event.key !== grow && event.key !== shrink) return
    event.preventDefault()
    onSize(Math.min(room, size + (event.key === grow ? 24 : -24)))
  }
  return (
    <div
      role="separator"
      tabIndex={0}
      data-activity-chrome=""
      aria-label="Resize agent activity"
      aria-orientation={bottom ? 'horizontal' : 'vertical'}
      aria-valuemin={SIZE[placement].min}
      aria-valuemax={Math.round(room)}
      aria-valuenow={Math.round(size)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
      onKeyDown={onKeyDown}
      className={cn(
        'absolute z-10 outline-focus focus-visible:outline-2',
        bottom
          ? 'inset-x-0 top-0 h-2 -translate-y-1 cursor-row-resize'
          : 'inset-y-0 start-0 w-2 -translate-x-1 rtl:translate-x-1 cursor-col-resize',
      )}
    />
  )
}

/** Work worth a glance while the drawer is closed: what is working or waiting now. */
const active = (item: ArrangedItem) =>
  item.listed &&
  ['running', 'waiting', 'starting', 'queued'].includes(item.entry.execution)

/**
 * The compact preview: a quiet count above the composer, with a disclosure that lists the work
 * inline. A row's header selects it, double-click opens it in the drawer, and Open work reveals it.
 * Nothing here takes focus when work starts or ends (CP-04).
 */
function ActivityCompact({
  items,
  clearance,
  labelFor,
  onOpenWork,
  notice,
}: {
  items: ArrangedItem[]
  notice?: string
  clearance: number
  labelFor: (entry: ActivityEntry) => string | undefined
  onOpenWork: (item: ArrangedItem) => void
}) {
  const view = useActivityView()
  const [expanded, setExpanded] = useState(false)
  // While focus is inside the preview, the row holding it and the preview itself stay, so work
  // that finishes never takes focus away (CP-04). The counts still follow the owners.
  const [focus, setFocus] = useState<{ within: boolean; row?: string }>({
    within: false,
  })
  const live = items.filter(active)
  const shown = items.filter(
    (item) => active(item) || item.entry.key === focus.row,
  )
  if (!shown.length && !focus.within) return null
  const waiting = live.filter((i) => i.entry.execution === 'waiting').length
  const working = live.length - waiting
  const summary =
    [
      working ? `${working} working` : '',
      waiting ? `${waiting} waiting for you` : '',
    ]
      .filter(Boolean)
      .join(', ') || 'Nothing working now'
  return (
    <section
      aria-label="Agent activity preview"
      data-appearance-part="activity-compact"
      style={{ bottom: clearance }}
      onFocus={(event) => {
        const row = event.target
          .closest('[data-activity-item]')
          ?.getAttribute('data-activity-item')
        setFocus({ within: true, ...(row ? { row } : {}) })
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocus({ within: false })
      }}
      className="absolute end-(--sheet-inset) z-30 w-72 max-w-[calc(100%-2*var(--sheet-inset))] rounded-xl border border-separator bg-raised text-ink shadow-lg"
    >
      <div className="flex items-center gap-1 p-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-start text-xs text-ink-muted outline-focus hover:bg-hover focus-visible:outline-2"
        >
          {expanded ? (
            <Icon.ChevronDown className="size-3.5 shrink-0" />
          ) : (
            <Icon.ChevronUp className="size-3.5 shrink-0" />
          )}
          {/* Like Rex's session picker: one quiet mark for the strongest
              state, waiting over working, with the words beside it. */}
          <ToneMark tone={waiting ? 'waiting' : working ? 'working' : 'idle'} />
          <span className="truncate">{summary}</span>
        </button>
        <button
          data-activity-return=""
          type="button"
          onClick={(event) => view.openView({ origin: event.currentTarget })}
          className="shrink-0 rounded-md px-2 py-1 text-xs text-ink-muted outline-focus hover:bg-hover hover:text-ink focus-visible:outline-2"
        >
          Show all
        </button>
      </div>
      {notice && (
        <p role="status" className="px-3 pb-1.5 text-xs text-ink">
          {notice}
        </p>
      )}
      {expanded && (
        <ul className="flex max-h-60 flex-col gap-0.5 overflow-auto border-t border-separator p-1">
          {shown.map((item) => (
            <Row
              key={item.entry.key}
              item={item}
              selected={item.entry.key === view.selected}
              projectLabel={labelFor(item.entry)}
              onSelect={() => view.select(item.entry.key)}
              onOpen={() => onOpenWork(item)}
              onHeaderOpen={(origin) =>
                view.openView({ origin, select: item.entry.key })
              }
            />
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Agent activity: the drawer and, expanded, the full agent workspace. The same arrangement,
 * selection and run keys show in both; expanding and restoring keep the saved placement and size.
 * It overlays the sheet without reflowing it, and always ends above the composer (DR-01).
 */
export function ActivityView({
  projectId,
  frame,
}: {
  projectId: string
  frame: HTMLElement | null
}) {
  const view = useActivityView()
  const { arranged, completeness, projects, source } = useActivity(projectId)
  const clearance = useComposerClearance(frame)
  const width = useWidth(frame)
  const region = useRef<HTMLElement>(null)
  const { open: openWork, notice } = useOpenWork(projectId, source)
  // Commands that open the view are offered only while a view like this one is mounted.
  const host = useActivityView((s) => s.host)
  useEffect(() => host(), [host])
  const [frameHeight, setFrameHeight] = useState(800)
  useLayoutEffect(() => {
    if (!frame) return
    const observer = new ResizeObserver(() =>
      setFrameHeight(frame.clientHeight),
    )
    observer.observe(frame)
    return () => observer.disconnect()
  }, [frame])

  // Opening moves focus into the view's chrome once, never into a terminal or the composer.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (view.open && !wasOpen.current) {
      const target =
        region.current?.querySelector<HTMLElement>(
          '[aria-pressed="true"][data-activity-row]',
        ) ??
        region.current?.querySelector<HTMLElement>('[data-activity-chrome]')
      target?.focus({ preventScroll: true })
    }
    wasOpen.current = view.open
  }, [view.open])

  const titles = new Map(projects.map((p) => [p.projectId, p.title]))
  const labelFor = (entry: ActivityEntry) =>
    view.scope === 'all' && entry.projectId && entry.projectId !== projectId
      ? (titles.get(entry.projectId) ?? 'another project')
      : undefined
  const items = (arranged?.order ?? []).flatMap((key) => {
    const item = arranged?.items[key]
    return item ? [item] : []
  })
  if (!view.open)
    return (
      <ActivityCompact
        items={items}
        clearance={clearance}
        labelFor={labelFor}
        notice={notice}
        onOpenWork={(item) => void openWork(item.entry, item.listed)}
      />
    )

  const selectedIndex = items.findIndex((i) => i.entry.key === view.selected)
  const selected = selectedIndex >= 0 ? items[selectedIndex] : undefined

  const placement = view.expanded
    ? 'full'
    : effectivePlacement(view.placement, width)
  // The list beside the details needs the width a right drawer needs; narrower, they stack.
  const stacked = placement === 'right' || width < RIGHT_MIN_WIDTH
  const room =
    placement === 'bottom'
      ? frameHeight - clearance - GAP
      : placement === 'right'
        ? width - 320
        : 0
  const size =
    placement === 'full'
      ? 0
      : effectiveSize(placement, view.size[placement], room)

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    // Escape belongs to the view only when its own chrome holds focus (DR-04).
    const target = event.target as HTMLElement
    if (!target.closest('[data-activity-chrome]')) return
    event.preventDefault()
    if (view.expanded) view.setExpanded(false)
    else view.close()
  }

  return (
    <section
      ref={region}
      role="region"
      aria-label="Agent activity"
      data-appearance-part="activity"
      data-activity-placement={placement}
      onKeyDown={onKeyDown}
      style={{
        bottom: clearance,
        ...(placement === 'bottom' ? { height: size } : {}),
        ...(placement === 'right' ? { width: size } : {}),
      }}
      className={cn(
        'absolute z-30 flex flex-col overflow-hidden rounded-xl border border-separator bg-raised text-ink shadow-lg',
        placement === 'bottom' && 'inset-x-(--sheet-inset)',
        placement === 'right' && 'top-(--sheet-inset) end-(--sheet-inset)',
        placement === 'full' && 'top-(--sheet-inset) inset-x-(--sheet-inset)',
      )}
    >
      {placement !== 'full' && (
        <ResizeEdge
          placement={placement}
          size={size}
          room={room}
          onSize={(next) => view.setSize(placement, next)}
        />
      )}
      <header className="flex shrink-0 items-center gap-1 border-b border-separator px-2 py-1">
        <h2 className="px-1 text-sm font-medium">Agent activity</h2>
        <div
          role="group"
          aria-label="Scope"
          className="ms-2 flex rounded-md bg-hover p-0.5 text-xs"
        >
          {(['project', 'all'] as const).map((scope) => (
            <button
              key={scope}
              type="button"
              data-activity-chrome=""
              aria-pressed={view.scope === scope}
              onClick={() => view.setScope(scope)}
              className="rounded px-2 py-0.5 text-ink-muted outline-focus aria-pressed:bg-raised aria-pressed:text-ink focus-visible:outline-2"
            >
              {scope === 'project' ? 'This project' : 'All work'}
            </button>
          ))}
        </div>
        <div className="ms-auto flex items-center">
          {!view.expanded && (
            <IconButton
              label={
                placement === 'right'
                  ? 'Show at the bottom'
                  : width < RIGHT_MIN_WIDTH
                    ? 'Too narrow to show on the right'
                    : 'Show on the right'
              }
              disabled={placement === 'bottom' && width < RIGHT_MIN_WIDTH}
              onClick={() =>
                view.setPlacement(placement === 'right' ? 'bottom' : 'right')
              }
            >
              <Icon.Columns className="size-4" />
            </IconButton>
          )}
          <IconButton
            label={
              view.expanded ? 'Restore drawer' : 'Expand to full workspace'
            }
            onClick={() => view.setExpanded(!view.expanded)}
          >
            {view.expanded ? (
              <Icon.Panels className="size-4" />
            ) : (
              <Icon.Expand className="size-4" />
            )}
          </IconButton>
          <IconButton label="Close agent activity" onClick={view.close}>
            <Icon.Close className="size-4" />
          </IconButton>
        </div>
      </header>
      <div
        className={cn(
          'grid min-h-0 flex-1',
          stacked
            ? 'grid-rows-[minmax(0,1fr)_minmax(0,1fr)]'
            : 'grid-cols-[minmax(12rem,20rem)_minmax(0,1fr)]',
        )}
      >
        <nav
          aria-label="Work"
          className={cn(
            'min-h-0 overflow-auto p-1',
            stacked ? 'border-b border-separator' : 'border-e border-separator',
          )}
        >
          {items.length ? (
            <ul className="flex flex-col gap-0.5">
              {items.map((item) => (
                <Row
                  key={item.entry.key}
                  item={item}
                  selected={item.entry.key === view.selected}
                  projectLabel={labelFor(item.entry)}
                  onSelect={() => view.select(item.entry.key)}
                  onOpen={() => {
                    view.select(item.entry.key)
                    void openWork(item.entry, item.listed)
                  }}
                />
              ))}
            </ul>
          ) : (
            <p className="p-3 text-sm text-ink-muted">
              {arranged ? 'Nothing is working here now.' : 'Reading work…'}
            </p>
          )}
        </nav>
        <Surface
          item={selected}
          projectLabel={selected ? labelFor(selected.entry) : undefined}
          onOpen={() =>
            selected && void openWork(selected.entry, selected.listed)
          }
          onRemove={() => selected && view.remove(selected.entry.key)}
          onMove={(by) => selected && view.move(selected.entry.key, by)}
          canMove={{
            up: selectedIndex > 0,
            down: selectedIndex >= 0 && selectedIndex < items.length - 1,
          }}
        />
      </div>
      <footer className="shrink-0 border-t border-separator px-3 py-1.5 text-xs text-ink-muted">
        {notice && (
          <p role="status" className="text-ink">
            {notice}
          </p>
        )}
        <details>
          <summary
            data-activity-chrome=""
            className="cursor-pointer outline-focus focus-visible:outline-2"
          >
            What this view cannot see
          </summary>
          <ul className="mt-1 list-disc ps-4">
            {completeness.gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </details>
      </footer>
    </section>
  )
}
