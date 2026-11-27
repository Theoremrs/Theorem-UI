// SOURCING: React createPortal (a runtime's subtree rendered by the host into
// an element the host made once), the native <dialog> top layer for the
// expanded view (the same close()/showModal() switch inline-artifact.tsx uses,
// which keeps its children in place), ResizeObserver and requestAnimationFrame
// for placement, ui/button for the passive view's choices.
//
// AR-08 to AR-12. The host is mounted once in the signed-in shell. Each live
// runtime's subtree renders, by portal, into one element that the host makes
// and appends to its stage exactly once. That element is never moved again: a
// view does not contain the runtime, it marks a slot, and the host lays the
// runtime's element over the slot of the view that holds it, clipped to what
// of the slot can be seen. An iframe reloads when it is moved in the document,
// so moving the slot from the answer to the dock or the expanded view moves
// only geometry; the runtime's frame, its React state and its identity stay.
//
// What the guarantee rests on, and what a browser still has to show: the
// element's parent never changes (tested), and a frame whose ancestor switches
// between a non-modal and a modal dialog keeps its document, as the inline
// answer already relies on. Dockview's panels are never a runtime's parent, so
// how Dockview retains or hides them only changes whether a slot is visible.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { FC, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { TheoremArtifact } from './artifact-model'
import { useArtifactView } from './artifact-view'
import {
  expandedViewId,
  isInteractive,
  runtimesOfArtifact,
  surfaceOf,
  useArtifactRuntimes,
} from './artifact-runtime'
import type { RuntimeRecord, RuntimeSurface } from './artifact-runtime'
import {
  isDraftLifecycle,
  persistenceReceipts,
  revisionStatus,
} from './artifact-runtime-revisions'
import type { SourceDraft } from './artifact-runtime-revisions'

/** What a renderer that runs in the host supplies. */
export type HostedRenderer = {
  /** The runtime itself, rendered once by the host for as long as it runs. */
  Runtime: FC<{ runtime: RuntimeRecord }>
  /**
   * Present only for a renderer that implements several interactive views
   * over one runtime (AR-09): each view draws this in its own slot instead of
   * holding the runtime's element.
   */
  shared?: { View: FC<{ runtime: RuntimeRecord; viewId: string }> }
  /** Whether the renderer can checkpoint its running state (AR-11). */
  checkpoints?: boolean
}

const renderers = new Map<string, HostedRenderer>()

/** Registers the renderers whose live sessions the host runs. */
export function mountRuntimes(table: Record<string, HostedRenderer>) {
  for (const [id, entry] of Object.entries(table)) renderers.set(id, entry)
}

export const isHostedRenderer = (renderer: string | undefined) =>
  renderer !== undefined && renderers.has(renderer)

/** Whether a runtime host is mounted, so live views attach instead of running in place. */
export function useRuntimeHostPresent(): boolean {
  return useArtifactRuntimes((s) => s.hosts > 0)
}

/** The surface a hosted view is drawn on; the answer and the dock set it. */
export const RuntimeSurfaceContext = createContext<RuntimeSurface>('docked')

/**
 * The revisions of the artifact on screen, from the answer or the panel that
 * draws a view, so a view names a running revision as the person sees it.
 */
export const RuntimeVersionsContext = createContext<
  ReadonlyArray<TheoremArtifact> | undefined
>(undefined)

/** The inline view's id for an answer's part: stable, so its Expand can name it. */
export const inlineViewId = (partId: string) => `inline:${partId}`

// ---------------------------------------------------------------------------
// Slots and elements

type Slot = { element: HTMLElement; fill: boolean }
const slots = new Map<string, Slot>()
const elements = new Map<string, HTMLDivElement>()
const heights = new Map<string, number>()
const heightListeners = new Map<string, Set<() => void>>()

/** The element a runtime renders into, made once. */
function elementFor(runtimeId: string): HTMLDivElement {
  let element = elements.get(runtimeId)
  if (!element) {
    element = document.createElement('div')
    element.id = `artifact-runtime-${runtimeId}`
    element.dataset.slot = 'artifact-runtime'
    element.dataset.runtimeId = runtimeId
    element.className =
      'pointer-events-auto fixed top-0 left-0 invisible text-ink'
    elements.set(runtimeId, element)
  }
  return element
}

/** The element a runtime renders into, for tests and for revealing it. */
export const runtimeElement = (runtimeId: string) => elements.get(runtimeId)

function setHeight(runtimeId: string, height: number) {
  if (heights.get(runtimeId) === height) return
  heights.set(runtimeId, height)
  for (const listener of heightListeners.get(runtimeId) ?? []) listener()
}

function useRuntimeHeight(runtimeId: string | undefined): number | undefined {
  return useSyncExternalStore(
    useCallback(
      (listener) => {
        if (!runtimeId) return () => {}
        const set = heightListeners.get(runtimeId) ?? new Set()
        set.add(listener)
        heightListeners.set(runtimeId, set)
        return () => set.delete(listener)
      },
      [runtimeId],
    ),
    () => (runtimeId ? heights.get(runtimeId) : undefined),
  )
}

// ---------------------------------------------------------------------------
// Placement

type Box = { left: number; top: number; right: number; bottom: number }

const intersect = (a: Box, b: Box): Box => ({
  left: Math.max(a.left, b.left),
  top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right),
  bottom: Math.min(a.bottom, b.bottom),
})

const empty = (box: Box) => box.right <= box.left || box.bottom <= box.top

/** The slot's ancestors that clip what overflows them. */
function clippingAncestors(slot: HTMLElement): Array<HTMLElement> {
  const found: Array<HTMLElement> = []
  for (let node = slot.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (
      [style.overflowX, style.overflowY].some(
        (value) => value && value !== 'visible',
      )
    )
      found.push(node)
  }
  return found
}

function shown(slot: HTMLElement): boolean {
  if (!slot.isConnected) return false
  const check = (slot as { checkVisibility?: (options: object) => boolean })
    .checkVisibility
  return check
    ? check.call(slot, { checkOpacity: true, checkVisibilityCSS: true })
    : true
}

/**
 * What of a box at `area` the person can see in its slot: inside every
 * clipping ancestor and the window, and above what is marked as covering the
 * scrolling content (the conversation's composer, which sits over it).
 */
export function visibleArea(
  slot: HTMLElement,
  area: Box,
  ancestors: ReadonlyArray<HTMLElement>,
): Box {
  let visible = intersect(area, {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  })
  for (const ancestor of ancestors) {
    const rect = ancestor.getBoundingClientRect()
    visible = intersect(visible, rect)
  }
  for (const cover of document.querySelectorAll<HTMLElement>(
    '[data-runtime-occluder]',
  )) {
    if (cover.contains(slot)) continue
    // Only what covers the same scrolling content counts.
    if (!ancestors.some((ancestor) => ancestor.contains(cover))) continue
    const rect = cover.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    if (rect.right <= visible.left || rect.left >= visible.right) continue
    if (rect.top < visible.bottom && rect.bottom >= visible.bottom)
      visible = { ...visible, bottom: Math.max(visible.top, rect.top) }
    else if (rect.bottom > visible.top && rect.top <= visible.top)
      visible = { ...visible, top: Math.min(visible.bottom, rect.bottom) }
  }
  return visible
}

type Placed = {
  slot?: HTMLElement
  ancestors: Array<HTMLElement>
  age: number
  style: string
}

/** Lays each runtime's element over its holder's slot, every frame while any runs. */
function usePlacement(stage: React.RefObject<HTMLDialogElement | null>) {
  const count = useArtifactRuntimes((s) => Object.keys(s.runtimes).length)
  useEffect(() => {
    if (!count) return
    const placed = new Map<string, Placed>()
    let frame = 0
    const place = () => {
      const { runtimes, expanded } = useArtifactRuntimes.getState()
      for (const record of Object.values(runtimes)) {
        const element = elements.get(record.id)
        if (!element) continue
        const holder = record.shared ? undefined : record.holder
        const slot = holder ? slots.get(holder) : undefined
        const before = placed.get(record.id)
        const state: Placed =
          before && before.slot === slot?.element && before.age < 60
            ? { ...before, age: before.age + 1 }
            : {
                slot: slot?.element,
                ancestors: slot ? clippingAncestors(slot.element) : [],
                age: 0,
                style: before?.style ?? '',
              }
        let style = 'hidden'
        // While one runtime is expanded the stage is modal: only it shows.
        const covered = expanded !== undefined && expanded !== record.id
        if (slot && !covered && shown(slot.element)) {
          const rect = slot.element.getBoundingClientRect()
          const height = slot.fill ? rect.height : element.offsetHeight
          const area = {
            left: rect.left,
            top: rect.top,
            right: rect.left + rect.width,
            bottom: rect.top + height,
          }
          const visible = visibleArea(slot.element, area, state.ancestors)
          if (rect.width > 0 && !empty(visible))
            style = [
              rect.left,
              rect.top,
              rect.width,
              slot.fill ? rect.height : -1,
              visible.top - area.top,
              area.right - visible.right,
              area.bottom - visible.bottom,
              visible.left - area.left,
              slot.element.closest('[inert]') ? 1 : 0,
            ].join(',')
        }
        if (style !== state.style) {
          state.style = style
          apply(element, style)
        }
        placed.set(record.id, state)
      }
      for (const id of placed.keys()) if (!runtimes[id]) placed.delete(id)
      frame = requestAnimationFrame(place)
    }
    place()
    return () => cancelAnimationFrame(frame)
  }, [count, stage])
}

function apply(element: HTMLDivElement, style: string) {
  if (style === 'hidden') {
    // Hidden, not removed: the runtime keeps working while the browser may
    // throttle its rendering (AR-12).
    element.classList.add('invisible')
    element.dataset.visible = 'false'
    element.inert = true
    element.setAttribute('aria-hidden', 'true')
    return
  }
  const [
    left,
    top,
    width,
    height,
    clipTop,
    clipRight,
    clipBottom,
    clipLeft,
    inert,
  ] = style.split(',').map(Number)
  element.classList.remove('invisible')
  element.dataset.visible = 'true'
  element.removeAttribute('aria-hidden')
  element.inert = inert === 1
  element.style.transform = `translate(${left}px, ${top}px)`
  element.style.width = `${width}px`
  element.style.height = height === -1 ? '' : `${height}px`
  element.style.overflow = height === -1 ? '' : 'auto'
  element.style.clipPath =
    clipTop || clipRight || clipBottom || clipLeft
      ? `inset(${clipTop}px ${clipRight}px ${clipBottom}px ${clipLeft}px)`
      : ''
}

// ---------------------------------------------------------------------------
// Keyboard order: the runtime's element sits at the end of the document, so
// Tab reaches it from its slot and leaves it back to what follows the slot.

const TABBABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),iframe,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]'

function tabbables(scope: ParentNode): Array<HTMLElement> {
  return [...scope.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) =>
      !element.closest('[inert]') &&
      !element.closest('[hidden]') &&
      !element.closest('[data-slot="artifact-runtime"]') &&
      element.dataset.runtimeGuard === undefined,
  )
}

function inside(element: HTMLElement): Array<HTMLElement> {
  return [...element.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (one) => one.dataset.runtimeGuard === undefined && !one.closest('[inert]'),
  )
}

function neighbour(
  slot: HTMLElement,
  forward: boolean,
): HTMLElement | undefined {
  const scope = slot.closest('dialog[data-runtime-stage]') ?? document
  const all = tabbables(scope).filter(
    (one) => one !== slot && !slot.contains(one),
  )
  const after = all.filter(
    (one) =>
      slot.compareDocumentPosition(one) & Node.DOCUMENT_POSITION_FOLLOWING,
  )
  const before = all.filter(
    (one) =>
      slot.compareDocumentPosition(one) & Node.DOCUMENT_POSITION_PRECEDING,
  )
  // In the expanded view the order wraps within it, as a modal's does.
  if (scope !== document)
    return forward ? (after[0] ?? before[0]) : (before.at(-1) ?? after.at(-1))
  return forward ? after[0] : before.at(-1)
}

function RuntimeGuards({
  runtime,
  children,
}: {
  runtime: RuntimeRecord
  children: ReactNode
}) {
  const content = useRef<HTMLDivElement>(null)
  const leave = (forward: boolean, from: EventTarget | null) => {
    const holder = runtime.holder ? slots.get(runtime.holder) : undefined
    const within = from instanceof Node && content.current?.contains(from)
    if (within && holder) {
      neighbour(holder.element, forward)?.focus()
      return
    }
    const targets = content.current ? inside(content.current) : []
    ;(forward ? targets[0] : targets.at(-1))?.focus()
  }
  return (
    <>
      <span
        tabIndex={0}
        data-runtime-guard=""
        aria-hidden
        className="sr-only"
        onFocus={(event) => leave(false, event.relatedTarget)}
      />
      <div ref={content}>{children}</div>
      <span
        tabIndex={0}
        data-runtime-guard=""
        aria-hidden
        className="sr-only"
        onFocus={(event) => leave(true, event.relatedTarget)}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// The host

/**
 * Mounted once in the signed-in shell, inside the conversation's runtime
 * provider. It owns every live artifact runtime and the expanded view.
 */
export function ArtifactRuntimeHost() {
  useEffect(() => {
    const unmounted = useArtifactRuntimes.getState().hostMounted()
    return () => {
      unmounted()
      // Signed out, or the shell went: its runtimes ended with it. A remount
      // in the same task (React's development double effects) keeps them.
      setTimeout(() => {
        if (useArtifactRuntimes.getState().hosts > 0) return
        for (const element of elements.values()) element.remove()
        elements.clear()
        heights.clear()
        useArtifactRuntimes.getState().reset()
      })
    }
  }, [])
  const runtimes = useArtifactRuntimes((s) => s.runtimes)
  const expanded = useArtifactRuntimes((s) => s.expanded)
  const stage = useRef<HTMLDialogElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const modal = useRef(false)
  const opener = useRef<HTMLElement | null>(null)
  const restoreButton = useRef<HTMLButtonElement>(null)
  const switching = useRef(false)

  // Each runtime's element joins the stage once, and leaves only when the
  // runtime ends. React never places it, so a re-render never moves it.
  useLayoutEffect(() => {
    const parent = layer.current
    if (!parent) return
    for (const id of Object.keys(runtimes)) {
      const element = elementFor(id)
      if (element.parentNode !== parent) parent.append(element)
    }
    for (const [id, element] of elements)
      if (!runtimes[id]) {
        element.remove()
        elements.delete(id)
        heights.delete(id)
      }
  }, [runtimes])

  // Content-sized views reserve the runtime's own height in their layout.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const element = entry.target as HTMLDivElement
        const id = element.dataset.runtimeId
        if (id) setHeight(id, element.offsetHeight)
      }
    })
    for (const id of Object.keys(runtimes)) observer.observe(elementFor(id))
    return () => observer.disconnect()
  }, [runtimes])

  usePlacement(stage)

  useLayoutEffect(() => {
    const node = stage.current
    if (!node) return
    if (!node.open && !modal.current) node.setAttribute('open', '')
    const wantModal = expanded !== undefined
    if (wantModal === modal.current) return
    switching.current = true
    try {
      if (wantModal) {
        opener.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null
        if (node.open) node.close()
        node.showModal()
        modal.current = true
        restoreButton.current?.focus()
      } else {
        if (node.open) node.close()
        node.setAttribute('open', '')
        modal.current = false
        const back = opener.current
        opener.current = null
        if (back?.isConnected) back.focus()
      }
    } finally {
      switching.current = false
    }
  }, [expanded])

  useEffect(() => {
    const node = stage.current
    if (!node) return
    const cancel = (event: Event) => {
      event.preventDefault()
      useArtifactRuntimes.getState().restore()
    }
    const close = () => {
      if (switching.current || node.open) return
      // Closed by the browser: the stage itself must stay open to keep showing runtimes.
      node.setAttribute('open', '')
      modal.current = false
      useArtifactRuntimes.getState().restore()
    }
    node.addEventListener('cancel', cancel)
    node.addEventListener('close', close)
    return () => {
      node.removeEventListener('cancel', cancel)
      node.removeEventListener('close', close)
    }
  }, [])

  const shownExpanded = expanded ? runtimes[expanded] : undefined
  return createPortal(
    <dialog
      ref={stage}
      data-runtime-stage=""
      data-appearance-part="runtime-stage"
      aria-label="Running artifacts"
      className={cn(
        'pointer-events-none fixed inset-0 z-30 m-0 block size-full max-h-none max-w-none border-0 bg-transparent p-0 text-ink',
        'backdrop:bg-black/40 supports-backdrop-filter:backdrop:backdrop-blur-xs',
      )}
    >
      {shownExpanded && (
        <ExpandedView runtime={shownExpanded} restoreRef={restoreButton} />
      )}
      <div ref={layer} data-slot="artifact-runtime-layer" />
      {Object.values(runtimes).map((record) => {
        const entry = renderers.get(record.renderer)
        if (!entry) return null
        return createPortal(
          <RuntimeGuards runtime={record}>
            <entry.Runtime runtime={record} />
          </RuntimeGuards>,
          elementFor(record.id),
          record.id,
        )
      })}
    </dialog>,
    document.body,
  )
}

function ExpandedView({
  runtime,
  restoreRef,
}: {
  runtime: RuntimeRecord
  restoreRef: React.RefObject<HTMLButtonElement | null>
}) {
  const viewId = expandedViewId(runtime.id)
  return (
    <section
      aria-label={runtime.title}
      data-slot="artifact-runtime-expanded"
      className="pointer-events-auto absolute inset-2 flex flex-col gap-2 rounded-artifact bg-artifact p-3 sm:inset-6"
    >
      <div className="flex shrink-0 items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate font-heading text-sm font-semibold">
          {runtime.title}
        </h2>
        <Button
          ref={restoreRef}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Restore"
          onClick={() => useArtifactRuntimes.getState().restore(runtime.id)}
          className="text-ink-muted hover:text-ink pointer-coarse:size-11"
        >
          <Icon.Close aria-hidden />
        </Button>
      </div>
      <RuntimeStatus runtime={runtime} surface="expanded" />
      <RuntimeSlot runtime={runtime} viewId={viewId} fill />
    </section>
  )
}

// ---------------------------------------------------------------------------
// Views

/** Where the runtime shows in this view: the host lays its element here. */
function RuntimeSlot({
  runtime,
  viewId,
  fill,
}: {
  runtime: RuntimeRecord
  viewId: string
  fill: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    slots.set(viewId, { element, fill })
    return () => {
      if (slots.get(viewId)?.element === element) slots.delete(viewId)
    }
  }, [viewId, fill])
  const height = useRuntimeHeight(fill ? undefined : runtime.id)
  const elementId = `artifact-runtime-${runtime.id}`
  return (
    <div
      ref={ref}
      tabIndex={0}
      data-slot="artifact-runtime-slot"
      data-runtime-id={runtime.id}
      data-view-id={viewId}
      aria-label={runtime.title}
      // The runtime's element is read here, where it is shown.
      aria-owns={elementId}
      className={cn('w-full outline-none', fill && 'min-h-0 flex-1')}
      style={fill ? undefined : { height: height ?? 0 }}
      onFocus={(event) => {
        if (event.target !== event.currentTarget) return
        const element = elements.get(runtime.id)
        if (!element) return
        const from = event.relatedTarget
        const backward =
          from instanceof Node &&
          event.currentTarget.compareDocumentPosition(from) &
            Node.DOCUMENT_POSITION_FOLLOWING
        const targets = inside(element)
        ;(backward ? targets.at(-1) : targets[0])?.focus()
      }}
    />
  )
}

const WHERE: Record<RuntimeSurface, string> = {
  inline: 'in its answer',
  docked: 'in a panel',
  expanded: 'in the expanded view',
  cabinet: 'in the cabinet',
}

/** A view of a runtime this build names by thread versions where it can. */
function versionName(versions: ReadonlyArray<TheoremArtifact> | undefined) {
  return (position: string) => {
    const index = versions
      ? versions.findLastIndex(
          (one) =>
            one.documentPosition !== undefined &&
            String(one.documentPosition) === position,
        )
      : -1
    return index >= 0 ? `v${index + 1}` : `saved version ${position}`
  }
}

const NamesContext = createContext<(position: string) => string | undefined>(
  versionName(undefined),
)
const DraftContext = createContext<SourceDraft | undefined>(undefined)

function RuntimeStatus({
  runtime,
  surface,
}: {
  runtime: RuntimeRecord
  surface: RuntimeSurface
}) {
  const name = useContext(NamesContext)
  const draft = useContext(DraftContext)
  const [open, setOpen] = useState(false)
  const status = revisionStatus(runtime.revisions, draft, name)
  const receipts = persistenceReceipts(
    runtime.revisions,
    surface,
    name,
    renderers.get(runtime.renderer)?.checkpoints,
  )
  const lineage = runtime.lineage
  const source = lineage
    ? useArtifactRuntimes.getState().runtimes[lineage.from]
    : undefined
  const id = useId()
  return (
    <div
      data-slot="artifact-runtime-status"
      className="flex flex-col gap-1 text-xs"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span
          role="status"
          data-tone={status.tone}
          data-restart={status.restartNeeded || undefined}
          className={cn(
            'min-w-0 truncate text-ink-muted',
            status.tone === 'negative' && 'text-error-ink',
          )}
        >
          {status.text}
        </span>
        {lineage && (
          <span className="text-ink-faint">
            Separate copy, started from{' '}
            {lineage.revision ? name(lineage.revision) : 'the original'}
            {source ? '' : ' (the original has ended)'}
          </span>
        )}
        {runtime.restartedAfterRelease && (
          <span className="text-ink-faint">
            Started again: it was stopped to free memory while no view showed
            it.
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-expanded={open}
          aria-controls={id}
          className="ml-auto text-ink-muted"
          onClick={() => setOpen((value) => !value)}
        >
          What’s saved
        </Button>
      </div>
      {open && (
        <dl
          id={id}
          className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-separator bg-raised p-2"
        >
          {receipts.map((receipt) => (
            <div
              key={receipt.label}
              data-receipt={receipt.state}
              className="contents"
            >
              <dt className="font-medium text-ink">{receipt.label}</dt>
              <dd className="text-ink-muted">{receipt.text}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

/** A view that does not hold the runtime: it says where it runs and offers the three choices. */
function PassiveRuntime({
  runtime,
  viewId,
}: {
  runtime: RuntimeRecord
  viewId: string
}) {
  const all = useArtifactRuntimes((s) => s.runtimes)
  const name = useContext(NamesContext)
  const holderSurface = surfaceOf(runtime, runtime.holder) ?? 'docked'
  const others = runtimesOfArtifact(all, runtime.artifactId).filter(
    (one) => one.id !== runtime.id,
  )
  const actions = useArtifactRuntimes.getState()
  const reveal = () => {
    // A panel behind another tab comes forward first.
    if (holderSurface === 'docked')
      useArtifactView.getState().dock?.open(runtime.artifactId)
    const holder = runtime.holder ? slots.get(runtime.holder) : undefined
    holder?.element.scrollIntoView({ block: 'center' })
    holder?.element.focus({ preventScroll: true })
  }
  return (
    <section
      data-slot="artifact-runtime-passive"
      data-runtime-id={runtime.id}
      aria-label={`${runtime.title} runs ${WHERE[holderSurface]}`}
      className="flex flex-col items-start gap-3 rounded-artifact border border-separator bg-raised p-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="truncate font-heading text-sm font-semibold">
          {runtime.title}
        </h3>
        <p className="text-xs text-ink-muted">
          Running {WHERE[holderSurface]}. One view uses it at a time, so its
          state stays in one place. A separate copy starts the App again with
          state of its own.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => actions.moveHere(viewId)}
        >
          Move here
        </Button>
        {holderSurface !== 'expanded' && (
          <Button size="sm" variant="ghost" onClick={reveal}>
            Show where it runs
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => actions.startCopy(viewId)}
        >
          Start a separate copy
        </Button>
      </div>
      {others.length > 0 && (
        <ul className="flex w-full flex-col divide-y divide-separator border-t border-separator text-xs">
          {others.map((other) => (
            <li key={other.id} className="flex items-center gap-2 py-1.5">
              <span className="min-w-0 flex-1 truncate text-ink-muted">
                {other.primary
                  ? 'The original'
                  : `A separate copy, started from ${other.lineage?.revision ? name(other.lineage.revision) : 'the original'}`}
              </span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => actions.showHere(viewId, other.id)}
              >
                Show here
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * A view of a live artifact through the host: attaches on mount, detaches on
 * unmount (never stopping the runtime), and shows either the runtime itself,
 * when it holds it, or the passive view with its choices.
 */
export function HostedArtifact({
  artifact,
  documentId,
  renderer,
  conversation,
}: {
  artifact: TheoremArtifact
  documentId: string
  renderer: string
  /** The conversation the artifact came from, when it is not the one on screen. */
  conversation?: string
}) {
  const surface = useContext(RuntimeSurfaceContext)
  const versions = useContext(RuntimeVersionsContext)
  const generated = useId()
  const viewId =
    surface === 'inline'
      ? inlineViewId(artifact.partId)
      : `${surface}:${generated}`
  const entry = renderers.get(renderer)
  const { artifactId, title, documentPosition } = artifact
  useLayoutEffect(() => {
    useArtifactRuntimes.getState().attach({
      viewId,
      surface,
      artifactId,
      documentId,
      renderer,
      title,
      shared: Boolean(entry?.shared),
      conversation,
      pinnedPosition: documentPosition,
    })
  }, [
    viewId,
    surface,
    artifactId,
    documentId,
    renderer,
    title,
    entry,
    conversation,
    documentPosition,
  ])
  useLayoutEffect(
    () => () => useArtifactRuntimes.getState().detach(viewId),
    [viewId],
  )
  const runtime = useArtifactRuntimes((s) => {
    const id = s.views[viewId]
    return id ? s.runtimes[id] : undefined
  })
  const draft = isDraftLifecycle(artifact.lifecycle)
    ? {
        ...(documentPosition !== undefined && {
          position: String(documentPosition),
        }),
      }
    : undefined
  if (!runtime) return null
  const interactive = isInteractive(runtime, viewId)
  const fill = surface !== 'inline'
  return (
    <NamesContext value={versionName(versions)}>
      <DraftContext value={draft}>
        <div
          data-slot="artifact-runtime-view"
          data-view-id={viewId}
          data-runtime-id={runtime.id}
          data-interactive={interactive || undefined}
          className={cn(
            'flex w-full flex-col gap-2',
            fill && 'min-h-0 flex-1 p-3',
          )}
        >
          <RuntimeStatus runtime={runtime} surface={surface} />
          {interactive && runtime.shared && entry?.shared ? (
            <entry.shared.View runtime={runtime} viewId={viewId} />
          ) : interactive ? (
            <RuntimeSlot runtime={runtime} viewId={viewId} fill={fill} />
          ) : (
            <PassiveRuntime runtime={runtime} viewId={viewId} />
          )}
        </div>
      </DraftContext>
    </NamesContext>
  )
}
