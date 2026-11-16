// SOURCING: anime.js createDraggable drags the docked workbench's edge (as side-terminal's WidthHandle drags the drawer's: x or y mapped to a CSS variable, bounded by the container, no throw on release); zustand shell state keeps the size; the region is a second sheet beside the first, as the docked cabinet is. The workbench inside is components/workbench/workbench.tsx, mounted once and kept mounted across placements so its panels, terminals and side chats outlast a move.
import { createDraggable } from 'animejs'
import { useEffect, useRef } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useShell } from '@/components/shell/shell-state'
import { cn } from '@/lib/utils'
import type { Placement } from './placement'
import { Workbench } from './workbench'

/** The narrowest the docked workbench gets beside the sheet; its panels collapse below their minimums. */
const MIN_WIDTH = 360
/** The shortest and tallest it gets under the sheet, as shares of the window. */
const MIN_SHARE = 0.2
const MAX_SHARE = 0.8
/** What the conversation keeps beside it at the least. */
const MIN_CONVERSATION = 420

const maxWidth = () =>
  Math.max(MIN_WIDTH, Math.min(1400, window.innerWidth - MIN_CONVERSATION))

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
          ? [0, -MIN_WIDTH, 0, -maxWidth()]
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
    if (axis === 'x') draggable.setX(-shell.sideWidth, true)
    else draggable.setY(-pxOf(shell.terminalHeight), true)
    drag.current = draggable
    return () => {
      drag.current = undefined
      draggable.revert()
    }
  }, [axis, region])

  // The keyboard equivalent of dragging: arrows step the edge, Shift steps
  // further, Home and End go to the limits.
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const step = event.shiftKey ? 64 : 16
    const grow = axis === 'x' ? 'ArrowLeft' : 'ArrowUp'
    const shrink = axis === 'x' ? 'ArrowRight' : 'ArrowDown'
    const current = axis === 'x' ? width : share * window.innerHeight
    const min = axis === 'x' ? MIN_WIDTH : MIN_SHARE * window.innerHeight
    const max = axis === 'x' ? maxWidth() : MAX_SHARE * window.innerHeight
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
      aria-label={axis === 'x' ? 'Workbench width' : 'Workbench height'}
      aria-valuemin={axis === 'x' ? MIN_WIDTH : Math.round(MIN_SHARE * 100)}
      aria-valuemax={axis === 'x' ? undefined : Math.round(MAX_SHARE * 100)}
      aria-valuenow={axis === 'x' ? width : Math.round(share * 100)}
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
  const docked = placement === 'side' || placement === 'bottom'
  return (
    <>
      {docked && (
        <EdgeHandle
          key={placement}
          axis={placement === 'side' ? 'x' : 'y'}
          region={region}
        />
      )}
      <div
        ref={region}
        data-workbench-placement={placement ?? 'closed'}
        hidden={placement === undefined}
        style={
          {
            '--dock-width': `${Math.min(width, typeof window === 'undefined' ? width : maxWidth())}px`,
            '--dock-height': `${share * 100}dvh`,
          } as CSSProperties
        }
        className={cn(
          'relative min-h-0 min-w-0 overflow-hidden rounded-xl bg-sheet shadow-sheet',
          placement === 'full' &&
            'my-(--sheet-inset) me-(--sheet-inset) flex-1',
          placement === 'side' &&
            'my-(--sheet-inset) me-(--sheet-inset) w-(--dock-width) shrink-0',
          placement === 'bottom' &&
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
