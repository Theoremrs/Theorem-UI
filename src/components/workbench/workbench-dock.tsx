// SOURCING: anime.js createDraggable drags the docked workbench's edge (as side-terminal's WidthHandle drags the drawer's: x or y mapped to a CSS variable, bounded by the container, no throw on release); zustand shell state keeps the size; the region is a second sheet beside the first, as the docked cabinet is. The workbench inside is components/workbench/workbench.tsx, mounted once and kept mounted across placements so its panels, terminals and side chats outlast a move.
import { createDraggable } from 'animejs'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useShell } from '@/components/shell/shell-state'
import { cn } from '@/lib/utils'
import type { Placement } from './placement'
import { dockPresentation } from './placement'
import { dockMaxWidth, dockMinWidth } from './dock-geometry'
import { Workbench } from './workbench'
import { WORKBENCH_LABEL } from './label'

/** The shortest and tallest it gets under the sheet, as shares of the window. */
const MIN_SHARE = 0.2
const MAX_SHARE = 0.8
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
 * The docked workbench's inner edge, dragged (or stepped with the arrows) to
 * set its size. Beside the sheet the edge is its left side and dragging left
 * widens it; under the sheet it is the top and dragging up makes it taller.
 */
function EdgeHandle({
  axis,
  region,
}: {
  axis: 'x' | 'y'
  region: React.RefObject<HTMLDivElement | null>
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
          region.current?.style.setProperty('--dock-width', `${-self.x}px`)
        else region.current?.style.setProperty('--dock-height', `${-self.y}px`)
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
  }, [axis, region, maximum, minimum])

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
      region.current?.style.setProperty('--dock-width', `${clamped}px`)
      useShell.getState().setSideWidth(clamped)
    } else {
      drag.current?.setY(-clamped, true)
      region.current?.style.setProperty('--dock-height', `${clamped}px`)
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
        'group relative z-10 flex shrink-0 touch-none items-center justify-center outline-none focus-visible:outline-1 focus-visible:outline-term-sage',
        axis === 'x' ? 'w-[var(--sheet-inset)]' : 'h-[var(--sheet-inset)]',
        // A wider grip than the gap it sits in.
        axis === 'x'
          ? "before:absolute before:inset-y-0 before:-left-1.5 before:-right-1.5 before:content-['']"
          : "before:absolute before:inset-x-0 before:-top-1.5 before:-bottom-1.5 before:content-['']",
      )}
    >
      <span
        className={cn(
          'rounded-full bg-term-line opacity-0 transition-[opacity,background-color] duration-(--duration-snap) ease-snap group-hover:opacity-100 group-focus-visible:opacity-100',
          axis === 'x' ? 'h-9 w-1' : 'h-1 w-9',
        )}
      />
    </div>
  )
}

/**
 * The workbench in its placement: the whole sheet's place, or a second sheet
 * docked beside or under the first, with its edge to resize it. Once mounted it
 * stays mounted while closed (hidden), so its runs and terminals carry on and
 * reopening shows them as they were.
 */
export function WorkbenchDock({
  placement,
  projectId,
}: {
  placement: Placement | undefined
  projectId: string
}) {
  const region = useRef<HTMLDivElement>(null)
  const width = useShell((s) => s.sideWidth)
  const share = useShell((s) => s.terminalHeight)
  const viewport = useViewportWidth()
  const drawn = dockPresentation(placement, viewport)
  const docked = drawn === 'side' || drawn === 'bottom'
  return (
    <>
      {docked && (
        <EdgeHandle
          key={drawn}
          axis={drawn === 'side' ? 'x' : 'y'}
          region={region}
        />
      )}
      <div
        ref={region}
        data-workbench-placement={drawn ?? 'closed'}
        data-workbench-requested-placement={placement ?? 'closed'}
        hidden={placement === undefined}
        style={
          {
            '--dock-width': `${Math.min(width, maxWidth(viewport))}px`,
            '--dock-height': `${share * 100}dvh`,
          } as CSSProperties
        }
        className={cn(
          'relative min-h-0 min-w-0 overflow-hidden rounded-xl bg-sheet shadow-sheet',
          drawn === 'full' && 'my-(--sheet-inset) me-(--sheet-inset) flex-1',
          drawn === 'side' &&
            'my-(--sheet-inset) me-(--sheet-inset) w-(--dock-width) shrink-0',
          drawn === 'bottom' &&
            'me-(--sheet-inset) mb-(--sheet-inset) h-(--dock-height) shrink-0',
        )}
      >
        <Workbench
          projectId={projectId}
          shown={placement !== undefined}
          companion={docked}
        />
      </div>
    </>
  )
}
