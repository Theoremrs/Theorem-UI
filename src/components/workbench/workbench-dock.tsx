// SOURCING: anime.js createDraggable drags the workbench's inner edge (as side-terminal's WidthHandle drags the drawer's: x or y mapped to a CSS variable, bounded by the container, no throw on release); zustand shell state keeps the size and whether it is a drawer or part of the screen; the close on a double-click outside is the drawers' shared hook (terminal/close-on-outside-double-click); ResizeObserver measures the conversation column it attaches to (CSS anchor positioning would do this, but the Servo desktop host does not have it). A docked side is a second sheet beside the first, as the docked cabinet is; at the bottom, docked or a drawer, it is a card over the conversation column, so the side panel keeps its height. The workbench inside is the caller's (components/workbench/workbench.tsx), mounted once and kept mounted across placements so its panels, terminals and side chats outlast a move.
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
/** The room the conversation gives up under itself for a docked bottom card: the card and the panel's gutter above and below it. */
const BOTTOM_RESERVE = 'calc(var(--dock-height) + 2 * var(--panel-float, 8px))'
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
}: {
  axis: 'x' | 'y'
  target: HTMLElement | null
  /** On the card's own edge, with the grip showing; otherwise the gap beside it. */
  grip: boolean
}) {
  const handle = useRef<HTMLDivElement>(null)
  const drag = useRef<ReturnType<typeof createDraggable> | undefined>(undefined)
  const width = useShell((s) => s.sideWidth)
  const share = useShell((s) => s.terminalHeight)
  const viewport = useViewportWidth()
  const maximum = maxWidth(viewport)
  const minimum = dockMinWidth(viewport)

  useEffect(() => {
    const element = handle.current
    if (!element) return
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
    }
  }, [axis, target, maximum, minimum])

  // The keyboard equivalent of dragging: arrows step the edge, Shift steps
  // further, Home and End go to the limits.
  const onKeyDown = (event: ReactKeyboardEvent) => {
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
      onKeyDown={onKeyDown}
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

/**
 * The workbench in its placement: the whole sheet's place, or beside or under
 * the conversation, where the person's choice in Settings makes it a drawer
 * over the screen (closed by a double-click outside it) or part of the screen
 * (a second sheet beside, or a card under the conversation that the
 * conversation makes room for). At the bottom it covers the conversation
 * column only, so the side panel keeps its height. Once mounted it stays
 * mounted while closed (hidden), so its runs and terminals carry on and
 * reopening shows them as they were.
 *
 * `frame` is the shell's row that holds the sheet and this region: the sizes
 * are written there, so the conversation inside the sheet can read the room a
 * docked bottom card takes (--workbench-reserve). It is the element, not a ref:
 * a parent's ref is attached only after its children's layout effects run, so
 * the shell keeps it in state and the first frame painted already has it.
 */
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
  const companion = drawn === 'side' || drawn === 'bottom'
  const drawer = companion && attachment === 'drawer'
  const dockedSide = drawn === 'side' && !drawer
  const dockedBottom = drawn === 'bottom' && !drawer
  // A card over the conversation column: a drawer either way, or docked at the bottom.
  const card = drawer || dockedBottom

  useCloseOnOutsideDoubleClick(drawer, () =>
    useShell.getState().setWorkbench('closed'),
  )
  useColumnEdges(card, frame, region)

  useLayoutEffect(() => {
    const box = frame
    if (!box) return
    box.style.setProperty(
      '--dock-width',
      `${Math.min(width, maxWidth(viewport))}px`,
    )
    box.style.setProperty('--dock-height', `${share * 100}dvh`)
    box.style.setProperty(
      '--workbench-reserve',
      dockedBottom ? BOTTOM_RESERVE : '0px',
    )
  }, [frame, width, share, viewport, dockedBottom])
  useLayoutEffect(() => {
    const box = frame
    return () => {
      for (const name of [
        '--dock-width',
        '--dock-height',
        '--workbench-reserve',
      ])
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
        data-workbench-attachment={companion ? attachment : undefined}
        // The drawers' shared hook leaves a double-click inside any drawer alone.
        data-terminal-drawer={drawer ? '' : undefined}
        hidden={placement === undefined}
        style={card ? { background: ground } : undefined}
        className={cn(
          'min-h-0 min-w-0 overflow-hidden rounded-xl',
          !card && 'relative bg-sheet shadow-sheet',
          drawn === 'full' && 'my-(--sheet-inset) me-(--sheet-inset) flex-1',
          dockedSide &&
            'my-(--sheet-inset) me-(--sheet-inset) w-(--dock-width) shrink-0',
          card && 'absolute',
          // At the bottom: over the conversation column only, its grip on top.
          card &&
            drawn === 'bottom' &&
            'right-(--wb-right) bottom-(--wb-bottom) left-(--wb-left) h-[min(var(--dock-height),var(--wb-room-y))] pt-3',
          // On the right: the column's height, its grip on the left.
          drawer &&
            drawn === 'side' &&
            'top-(--wb-top) right-(--wb-right) bottom-(--wb-bottom) w-[min(var(--dock-width),var(--wb-room-x))] ps-3',
          dockedBottom && 'z-20 shadow-sheet',
          // A drawer slides in over everything on the sheet.
          drawer &&
            'z-30 transition-[translate] duration-(--duration-glide) ease-glide motion-reduce:transition-none',
          drawer &&
            drawn === 'bottom' &&
            'shadow-[0_-8px_32px_rgb(0_0_0/0.28)] starting:translate-y-[calc(100%+var(--wb-bottom))]',
          drawer &&
            drawn === 'side' &&
            'shadow-[-8px_0_32px_rgb(0_0_0/0.28)] starting:translate-x-[calc(100%+var(--wb-right))]',
        )}
      >
        {card && (
          <EdgeHandle
            key={drawn}
            axis={drawn === 'side' ? 'x' : 'y'}
            target={frame}
            grip
          />
        )}
        {children({
          shown: placement !== undefined,
          companion: dockedSide || dockedBottom,
        })}
      </div>
    </>
  )
}
