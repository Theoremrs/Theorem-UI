// SOURCING: none: an annotation is a note in a slot the layer moves, and its
// subject and leader drawn into the layer's SVG; the layer (layer.tsx) owns
// where it goes. React's createPortal puts both in the layer wherever the
// annotation is written.
import { useLayoutEffect, useRef } from 'react'
import type { HTMLAttributes, PointerEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { LEADER_PLACEMENTS, PLACEMENTS, useLayer } from './layer'
import type { Entry } from './layer'
import type { Attach, Connector, Point, Subject } from './paths'
import type { Placement } from './place'

export interface AnnotationProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** The id the renderer writes this subject's anchor under. */
  anchor: string
  /** How the subject is marked; a function draws it from its box. */
  subject?: Subject
  /**
   * How the note is joined to it; a function draws it from its two ends.
   * `'leader'` is a technical drawing's: out from the subject's corner at 45
   * degrees, one elbow, then level into the note.
   */
  connector?: Connector
  /** Where a leader enters the note: pixels below its top, or `'bottom'` along a label's rule. */
  attach?: Attach
  /** The sides the note may take, tried in this order. */
  placements?: ReadonlyArray<Placement>
  /** Space between the subject and the note, in pixels. */
  gap?: number
  /** Space between the subject and its mark, in pixels. */
  padding?: number
  /** Higher places first and keeps its side when notes compete. */
  priority?: number
  /**
   * Stays shown when its subject leaves the view, at the nearest edge. A
   * pinned note can be dragged by any element in it marked `data-drag-handle`,
   * and then stays where it was put.
   */
  pinned?: boolean
  /** Where a pinned note was put, as `onPlace` gave it: its top left from its subject's centre. */
  offset?: Point
  /** Told where the person left a pinned note they dragged. */
  onPlace?: (offset: Point) => void
  /** Hides rather than cover a reserved control or a note of higher priority: for labels. */
  yields?: boolean
  children?: ReactNode
}

/** A note attached to a subject the renderer projects. Holds any children. */
export function Annotation({
  anchor,
  subject = 'none',
  connector = 'line',
  attach = 'bottom',
  placements = connector === 'leader' ? LEADER_PLACEMENTS : PLACEMENTS,
  gap = 10,
  padding = 4,
  priority = 0,
  pinned = false,
  offset,
  onPlace,
  yields = false,
  children,
  className,
  style,
  ...slot
}: AnnotationProps) {
  const layer = useLayer()
  const slotRef = useRef<HTMLDivElement>(null)
  const subjectRef = useRef<SVGPathElement>(null)
  const connectorRef = useRef<SVGPathElement>(null)
  const entry = useRef<Entry | null>(null)
  entry.current ??= {
    anchor, subject, connector, attach, placements, gap, padding, priority, pinned, yields,
    slot: null, subjectPath: null, connectorPath: null, size: { width: 0, height: 0 }, manual: offset,
  }
  Object.assign(entry.current, { anchor, subject, connector, attach, placements, gap, padding, priority, pinned, yields, onPlace })
  if (pinned && offset && !entry.current.manual) entry.current.manual = offset

  // A pinned note is dragged by its handle; the layer keeps it where it is left.
  const drag = useRef<{ x: number; y: number } | null>(null)
  const dragHandlers = {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      slot.onPointerDown?.(event)
      const target = event.target as Element
      if (!pinned || event.button !== 0 || !target.closest('[data-drag-handle]') || target.closest('button, input, select, textarea, a')) return
      drag.current = { x: event.clientX, y: event.clientY }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      slot.onPointerMove?.(event)
      if (!drag.current || !entry.current) return
      layer.drag(entry.current, event.clientX - drag.current.x, event.clientY - drag.current.y, false)
      drag.current = { x: event.clientX, y: event.clientY }
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
      slot.onPointerUp?.(event)
      if (!drag.current || !entry.current) return
      drag.current = null
      layer.drag(entry.current, 0, 0, true)
    },
  }

  const ready = Boolean(layer.notes && layer.svg)
  useLayoutEffect(() => {
    const current = entry.current
    if (!ready || !current) return
    current.slot = slotRef.current
    current.subjectPath = subjectRef.current
    current.connectorPath = connectorRef.current
    return layer.register(current)
  }, [ready, layer.register])

  // A change of what is drawn or where it may go is placed now, not next frame.
  useLayoutEffect(() => {
    if (ready) layer.schedule()
  })

  if (!layer.notes || !layer.svg) return null
  return (
    <>
      {createPortal(
        <g className="tn-annotation" data-anchor={anchor} data-hidden="">
          <path ref={connectorRef} className="tn-connector" />
          <path ref={subjectRef} className="tn-subject" />
        </g>,
        layer.svg,
      )}
      {createPortal(
        <div
          ref={slotRef}
          {...slot}
          {...dragHandlers}
          className={['tn-slot', className].filter(Boolean).join(' ')}
          // A note placed first is drawn above the ones placed after it.
          style={{ zIndex: Math.max(0, Math.round(priority) + 1), ...style }}
          data-anchor={anchor}
          data-pinned={pinned ? '' : undefined}
          data-hidden=""
        >
          {children}
        </div>,
        layer.notes,
      )}
    </>
  )
}
