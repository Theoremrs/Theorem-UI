// The shell keeps one mounted workspace. The right-hand placement uses the
// conversation edge for its overlay and can also dock beside the sheet.
// The bottom placement spans the frame, with the composer lifted above it.
import { createDraggable } from 'animejs'
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefObject,
} from 'react'
import { useShell } from '@/components/shell/shell-state'
import { useTerminalTheme } from '@/components/terminal/live-terminal-theme'
import { useCloseOnOutsideDoubleClick } from '@/components/terminal/close-on-outside-double-click'
import { cn } from '@/lib/utils'
import type { Placement } from './placement'
import { dockPresentation } from './placement'
import { dockMaxWidth, dockMinWidth } from './dock-geometry'
import { WORKBENCH_LABEL } from './label'

/** The shortest and tallest it gets under the sheet, as shares of the window. */
const MIN_SHARE = 0.2
const MAX_SHARE = 0.8
const closeWorkbench = () => useShell.getState().setWorkbench('closed')
const viewportWidth = () =>
  typeof window === 'undefined' ? 1440 : window.innerWidth

const maxWidth = dockMaxWidth

const subscribeViewport = (listener: () => void) => {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('resize', listener)
  return () => window.removeEventListener('resize', listener)
}

function useViewportWidth() {
  return useSyncExternalStore(subscribeViewport, viewportWidth, () => 1440)
}

/**
 * The workbench's inner edge, dragged (or stepped with the arrows) to set its
 * size, written live to `target` as --dock-width or --dock-height. Beside the
 * sheet the edge is its left side and dragging left widens it; at the bottom
 * it is the top and dragging up makes it taller. A docked side's edge is the
 * gap between the two sheets; a card over the conversation carries its edge
 * as a grip along its own inner side.
 */
function EdgeHandle({
  axis,
  target,
  grip,
  onClose,
}: {
  axis: 'x' | 'y'
  target: HTMLElement | null
  /** On the card's own edge, with the grip showing; otherwise the gap beside it. */
  grip: boolean
  onClose?: () => void
}) {
  const handle = useRef<HTMLDivElement>(null)
  // Anime clears its own dragged flag before onRelease; remember the gesture.
  const dragged = useRef(false)
  const closeOnRelease = useRef(false)
  const press = useRef<{
    id: number
    x: number
    y: number
    threshold: number
  } | null>(null)
  const drag = useRef<ReturnType<typeof createDraggable> | undefined>(undefined)
  const width = useShell((s) => s.sideWidth)
  const share = useShell((s) => s.terminalHeight)
  const viewport = useViewportWidth()
  const maximum = maxWidth(viewport)
  const minimum = dockMinWidth(viewport)

  useEffect(() => {
    const element = handle.current
    if (!element) return
    // Track both axes even outside the grip. Anime only counts movement on
    // its resize axis, but moving away on either axis cancels a click.
    const track = (event: PointerEvent) => {
      const start = press.current
      if (!start || event.pointerId !== start.id) return
      if (
        Math.abs(event.clientX - start.x) > start.threshold ||
        Math.abs(event.clientY - start.y) > start.threshold
      )
        dragged.current = true
      if (event.type === 'pointercancel') {
        dragged.current = true
        closeOnRelease.current = false
      }
      if (event.type !== 'pointermove') press.current = null
    }
    for (const type of ['pointermove', 'pointerup', 'pointercancel'])
      document.addEventListener(type, track as EventListener, true)
    const shell = useShell.getState()
    const pxOf = (fraction: number) => fraction * window.innerHeight
    const draggable = createDraggable(element, {
      x: axis === 'x' ? { mapTo: '--drag-x' } : false,
      y: axis === 'y' ? { mapTo: '--drag-y' } : false,
      container: () =>
        axis === 'x'
          ? [0, -minimum, 0, -maximum]
          : [-pxOf(MAX_SHARE), 0, -pxOf(MIN_SHARE), 0],
      velocityMultiplier: 0,
      onGrab: () => {
        dragged.current = false
      },
      onDrag: () => {
        dragged.current = true
      },
      onRelease: () => {
        if (closeOnRelease.current && !dragged.current) onClose?.()
        closeOnRelease.current = false
      },
      cursor:
        axis === 'x'
          ? { onHover: 'ew-resize', onGrab: 'ew-resize' }
          : { onHover: 'ns-resize', onGrab: 'ns-resize' },
      onUpdate: (self) => {
        if (axis === 'x')
          target?.style.setProperty('--dock-width', `${-self.x}px`)
        else target?.style.setProperty('--dock-height', `${-self.y}px`)
      },
      onSettle: (self) => {
        if (axis === 'x') useShell.getState().setSideWidth(Math.round(-self.x))
        else
          useShell
            .getState()
            .setTerminalHeight(
              Math.round((-self.y / window.innerHeight) * 1000) / 1000,
            )
      },
    })
    if (axis === 'x') draggable.setX(-Math.min(shell.sideWidth, maximum), true)
    else draggable.setY(-pxOf(shell.terminalHeight), true)
    drag.current = draggable
    return () => {
      drag.current = undefined
      draggable.revert()
      for (const type of ['pointermove', 'pointerup', 'pointercancel'])
        document.removeEventListener(type, track as EventListener, true)
    }
  }, [axis, target, maximum, minimum, onClose])

  // The keyboard equivalent of dragging: arrows step the edge, Shift steps
  // further, Home and End go to the limits.
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (onClose && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    const step = event.shiftKey ? 64 : 16
    const grow = axis === 'x' ? 'ArrowLeft' : 'ArrowUp'
    const shrink = axis === 'x' ? 'ArrowRight' : 'ArrowDown'
    const current = axis === 'x' ? width : share * window.innerHeight
    const min = axis === 'x' ? minimum : MIN_SHARE * window.innerHeight
    const max = axis === 'x' ? maximum : MAX_SHARE * window.innerHeight
    const next =
      event.key === grow
        ? current + step
        : event.key === shrink
          ? current - step
          : event.key === 'Home'
            ? max
            : event.key === 'End'
              ? min
              : undefined
    if (next === undefined) return
    event.preventDefault()
    const clamped = Math.round(Math.min(max, Math.max(min, next)))
    if (axis === 'x') {
      drag.current?.setX(-clamped, true)
      target?.style.setProperty('--dock-width', `${clamped}px`)
      useShell.getState().setSideWidth(clamped)
    } else {
      drag.current?.setY(-clamped, true)
      target?.style.setProperty('--dock-height', `${clamped}px`)
      useShell
        .getState()
        .setTerminalHeight(
          Math.round((clamped / window.innerHeight) * 1000) / 1000,
        )
    }
  }

  return (
    <div
      ref={handle}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={
        axis === 'x' ? `${WORKBENCH_LABEL} width` : `${WORKBENCH_LABEL} height`
      }
      aria-valuemin={axis === 'x' ? minimum : Math.round(MIN_SHARE * 100)}
      aria-valuemax={axis === 'x' ? maximum : Math.round(MAX_SHARE * 100)}
      aria-valuenow={
        axis === 'x' ? Math.min(width, maximum) : Math.round(share * 100)
      }
      tabIndex={0}
      aria-description={
        onClose
          ? 'Drag or use arrow keys to resize. Click or press Enter or Space to close.'
          : undefined
      }
      onKeyDown={onKeyDown}
      onPointerDownCapture={(event) => {
        dragged.current = false
        closeOnRelease.current = event.isPrimary && event.button === 0
        press.current = closeOnRelease.current
          ? {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              threshold: event.pointerType === 'touch' ? 7 : 3,
            }
          : null
      }}
      onClick={(event) => {
        if (event.button === 0 && (event.detail === 0 || !dragged.current))
          onClose?.()
      }}
      onPointerCancelCapture={() => {
        dragged.current = true
        closeOnRelease.current = false
      }}
      onTouchCancelCapture={() => {
        dragged.current = true
        closeOnRelease.current = false
      }}
      className={cn(
        'group z-10 flex shrink-0 touch-none items-center justify-center outline-none focus-visible:outline-1 focus-visible:outline-term-sage',
        grip
          ? axis === 'x'
            ? 'absolute inset-y-0 left-0 w-3'
            : 'absolute inset-x-0 top-0 h-3'
          : axis === 'x'
            ? "relative w-[var(--sheet-inset)] before:absolute before:inset-y-0 before:-left-1.5 before:-right-1.5 before:content-['']"
            : "relative h-[var(--sheet-inset)] before:absolute before:inset-x-0 before:-top-1.5 before:-bottom-1.5 before:content-['']",
      )}
    >
      <span
        className={cn(
          'rounded-full bg-term-line transition-[opacity,background-color] duration-(--duration-snap) ease-snap',
          // A card's grip shows, as the drawer's always did; the gap between
          // two sheets shows its grip only when reached.
          grip
            ? 'group-hover:bg-term-muted group-focus-visible:bg-term-muted'
            : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
          axis === 'x' ? 'h-9 w-1' : 'h-1 w-9',
        )}
      />
    </div>
  )
}

/**
 * Writes the conversation column's edges (the element marked
 * data-workbench-anchor inside `frame`), less the side panel's gutter, to
 * `region` as lengths from `frame`'s edges, so a card over the column covers
 * the column and never the panel beside it.
 */
function useColumnEdges(
  active: boolean,
  box: HTMLElement | null,
  region: RefObject<HTMLDivElement | null>,
) {
  useLayoutEffect(() => {
    const element = region.current
    const column = box?.querySelector<HTMLElement>('[data-workbench-anchor]')
    if (!active || !box || !element || !column) return
    let frameId = 0
    const measure = () => {
      frameId = 0
      const outer = box.getBoundingClientRect()
      const inner = column.getBoundingClientRect()
      const gap =
        parseFloat(getComputedStyle(box).getPropertyValue('--panel-float')) || 8
      // The side panel's card keeps its gutter on the column's side already;
      // with the panel closed the column starts at the sheet's own edge.
      const panel = box
        .querySelector('[data-appearance-part="navigation"]')
        ?.getBoundingClientRect()
      const panelBeside =
        panel !== undefined && panel.width > 0 && panel.right <= inner.left + 1
      const edges = {
        '--wb-left': inner.left - outer.left + (panelBeside ? 0 : gap),
        '--wb-right': outer.right - inner.right + gap,
        '--wb-top': inner.top - outer.top + gap,
        '--wb-bottom': outer.bottom - inner.bottom + gap,
        '--wb-room-x': inner.width - (panelBeside ? 1 : 2) * gap,
        '--wb-room-y': inner.height - 2 * gap,
      }
      for (const [name, value] of Object.entries(edges))
        element.style.setProperty(name, `${Math.max(0, value)}px`)
    }
    measure()
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            if (!frameId) frameId = requestAnimationFrame(measure)
          })
    observer?.observe(column)
    observer?.observe(box)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      cancelAnimationFrame(frameId)
      window.removeEventListener('resize', measure)
    }
  }, [active, box, region])
}

/** Keep the bottom overlay above the safe area and the chat composer above it. */
function useBottomClearance(
  bottom: boolean,
  frame: HTMLElement | null,
  region: RefObject<HTMLDivElement | null>,
) {
  useLayoutEffect(() => {
    const drawer = region.current
    if (!bottom || !frame || !drawer) return
    const selector = '[data-appearance-role="composer-form"]'
    let composers = frame.querySelectorAll<HTMLElement>(selector)
    let pending = 0
    const measure = () => {
      pending = 0
      const box = frame.getBoundingClientRect()
      const viewport = window.visualViewport
      const occluded = viewport
        ? Math.max(0, box.bottom - viewport.offsetTop - viewport.height)
        : 0
      frame.style.setProperty('--workbench-occluded', `${occluded}px`)
      const height = Math.max(
        0,
        ...Array.from(composers, (item) => item.offsetHeight),
      )
      frame.style.setProperty(
        '--workbench-composer-clearance',
        `${Math.max(96, height + 64)}px`,
      )
      const edge = drawer.getBoundingClientRect().top
      frame.style.setProperty(
        '--workbench-reserve',
        `${Math.max(0, box.bottom - edge + 8)}px`,
      )
    }
    const queue = () => {
      if (!pending) pending = requestAnimationFrame(measure)
    }
    const sizes = new ResizeObserver(queue)
    const observeComposers = () => {
      composers.forEach((element) => sizes.unobserve(element))
      composers = frame.querySelectorAll(selector)
      composers.forEach((element) => sizes.observe(element))
    }
    const nodes = new MutationObserver((changes) => {
      if (
        changes.some((change) =>
          [...change.addedNodes, ...change.removedNodes].some(
            (node) =>
              node instanceof Element &&
              (node.matches(selector) || node.querySelector(selector)),
          ),
        )
      ) {
        observeComposers()
        queue()
      }
    })
    sizes.observe(frame)
    sizes.observe(drawer)
    observeComposers()
    nodes.observe(frame, { subtree: true, childList: true })
    window.visualViewport?.addEventListener('resize', queue)
    window.visualViewport?.addEventListener('scroll', queue)
    measure()
    return () => {
      cancelAnimationFrame(pending)
      sizes.disconnect()
      nodes.disconnect()
      window.visualViewport?.removeEventListener('resize', queue)
      window.visualViewport?.removeEventListener('scroll', queue)
      for (const name of [
        '--workbench-reserve',
        '--workbench-composer-clearance',
        '--workbench-occluded',
      ])
        frame.style.removeProperty(name)
    }
  }, [bottom, frame, region])
}

/** Keep the same workbench mounted as its placement and visibility change. */
export function WorkbenchDock({
  placement,
  frame,
  children,
}: {
  placement: Placement | undefined
  frame: HTMLElement | null
  /** The workbench, told whether it shows and whether it stands beside the conversation. */
  children: (view: { shown: boolean; companion: boolean }) => ReactNode
}) {
  const region = useRef<HTMLDivElement>(null)
  const width = useShell((s) => s.sideWidth)
  const share = useShell((s) => s.terminalHeight)
  const attachment = useShell((s) => s.workbenchAttachment)
  const ground = useTerminalTheme((s) => s.roles.chrome.bg)
  const viewport = useViewportWidth()
  const drawn = dockPresentation(placement, viewport)
  const bottom = drawn === 'bottom'
  const sideDrawer = drawn === 'side' && attachment === 'drawer'
  const drawer = bottom || sideDrawer
  const dockedSide = drawn === 'side' && !sideDrawer

  useCloseOnOutsideDoubleClick(drawer, closeWorkbench)
  useColumnEdges(sideDrawer, frame, region)
  useBottomClearance(bottom, frame, region)

  useLayoutEffect(() => {
    const box = frame
    if (!box) return
    box.style.setProperty(
      '--dock-width',
      `${Math.min(width, maxWidth(viewport))}px`,
    )
    box.style.setProperty('--dock-height', `${share * 100}dvh`)
  }, [frame, width, share, viewport])
  useLayoutEffect(() => {
    const box = frame
    return () => {
      for (const name of ['--dock-width', '--dock-height'])
        box?.style.removeProperty(name)
    }
  }, [frame])

  return (
    <>
      {dockedSide && (
        <EdgeHandle key="side" axis="x" target={frame} grip={false} />
      )}
      <div
        ref={region}
        data-workbench-placement={drawn ?? 'closed'}
        data-workbench-requested-placement={placement ?? 'closed'}
        data-workbench-attachment={
          bottom ? 'drawer' : drawn === 'side' ? attachment : undefined
        }
        data-active-surface={drawn === 'full' ? '' : undefined}
        // The drawers' shared hook leaves a double-click inside any drawer alone.
        data-terminal-drawer={drawer ? '' : undefined}
        hidden={placement === undefined}
        style={drawer ? { background: ground } : undefined}
        className={cn(
          'min-h-0 min-w-0 flex-col overflow-hidden rounded-xl',
          drawn && 'flex',
          !drawer && 'relative bg-sheet shadow-sheet',
          drawn === 'full' && 'my-(--sheet-inset) me-(--sheet-inset) flex-1',
          dockedSide &&
            'my-(--sheet-inset) me-(--sheet-inset) w-(--dock-width) shrink-0',
          drawer && 'absolute',
          bottom &&
            'inset-x-(--sheet-inset) bottom-[calc(var(--workbench-occluded,0px)+max(var(--sheet-inset),env(safe-area-inset-bottom)))] h-(--dock-height) max-h-[calc(100%-var(--workbench-occluded,0px)-var(--workbench-composer-clearance,10rem)-env(safe-area-inset-bottom))] pt-3',
          // On the right: the column's height, its grip on the left.
          sideDrawer &&
            'top-(--wb-top) right-(--wb-right) bottom-(--wb-bottom) w-[min(var(--dock-width),var(--wb-room-x))] ps-3',
          // A drawer slides in over everything on the sheet.
          drawer &&
            'z-30 transition-[translate] duration-(--duration-glide) ease-glide motion-reduce:transition-none',
          bottom &&
            'shadow-[0_-8px_32px_rgb(0_0_0/0.28)] starting:translate-y-full',
          sideDrawer &&
            'shadow-[-8px_0_32px_rgb(0_0_0/0.28)] starting:translate-x-[calc(100%+var(--wb-right))]',
        )}
      >
        {drawer && (
          <EdgeHandle
            key={drawn}
            axis={drawn === 'side' ? 'x' : 'y'}
            target={frame}
            grip
            onClose={closeWorkbench}
          />
        )}
        <div className="min-h-0 flex-1">
          {children({
            shown: drawn !== undefined,
            // The page's conversation remains available beside either drawer.
            companion: drawn === 'side' || drawn === 'bottom',
          })}
        </div>
      </div>
    </>
  )
}
