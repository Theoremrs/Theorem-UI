// SOURCING: Floating UI (`@floating-ui/core`) computes each candidate position
// of a note against its subject: placement, gap (offset) and keeping it in
// the layer (shift), plus whether the subject has left the layer (hide). Its
// core runs on rectangles, so the layer hands it the numbers it already has
// and nothing reads the page each frame. Which candidate a note takes, given
// the other notes and the reserved controls, is place.ts. This file is the one
// owner of where every note in a layer goes.
import { computePosition, hide, offset, shift } from '@floating-ui/core'
import type { Platform, Rect } from '@floating-ui/core'
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import type { Anchors, Box } from './anchors'
import { attachOffset, connectorEnds, connectorPath, LEADER_RUN, leaderEnds, subjectPath } from './paths'
import type { Attach, Connector, Point, Subject } from './paths'
import { choose, cleared, overlap } from './place'
import type { Candidate, Placement } from './place'
import { Theme } from '@theorem/ui'

/** One annotation as the layer places it. */
export interface Entry {
  anchor: string
  subject: Subject
  connector: Connector
  /** Where a leader enters the note. */
  attach: Attach
  placements: ReadonlyArray<Placement>
  gap: number
  padding: number
  priority: number
  pinned: boolean
  /** Hidden, not placed, where it would cover a reserved control or a note placed before it. */
  yields: boolean
  slot: HTMLDivElement | null
  subjectPath: SVGPathElement | null
  connectorPath: SVGPathElement | null
  size: { width: number; height: number }
  previous?: Placement
  /** Where the note was put last, in the layer. */
  placed?: Box
  /**
   * Where the person put a pinned note: its top left from its subject's
   * centre. The layer keeps it there and no longer chooses for it.
   */
  manual?: Point
  /** Told where the person left a pinned note they dragged. */
  onPlace?: (offset: Point) => void
}

interface LayerContext {
  register: (entry: Entry) => () => void
  /** Moves a pinned note by (dx, dy) pixels; `done` at the end of the drag. */
  drag: (entry: Entry, dx: number, dy: number, done: boolean) => void
  keepClear: (element: Element) => () => void
  schedule: () => void
  notes: HTMLDivElement | null
  svg: SVGSVGElement | null
}

const Context = createContext<LayerContext | null>(null)

export function useLayer(): LayerContext {
  const layer = useContext(Context)
  if (!layer) throw new Error('An annotation must be inside an <AnnotationLayer>')
  return layer
}

// Floating UI's core, given rectangles instead of elements.
const platform: Platform = {
  getElementRects: ({ reference, floating }) => ({
    reference: reference as Rect,
    floating: { x: 0, y: 0, ...(floating as { width: number; height: number }) },
  }),
  getDimensions: (element) => element as { width: number; height: number },
  getClippingRect: ({ boundary }) => boundary as Rect,
}

export const PLACEMENTS: ReadonlyArray<Placement> = [
  'right', 'left', 'top', 'bottom', 'right-start', 'left-start', 'bottom-start', 'top-start',
]

/**
 * A leader's sides: off a corner first, so it leaves at 45 degrees; level
 * beside the subject next; above and below last.
 */
export const LEADER_PLACEMENTS: ReadonlyArray<Placement> = [
  'right-start', 'left-start', 'right-end', 'left-end', 'right', 'left', 'top', 'bottom',
]

const inset = (box: Box, by: number): Box => ({
  x: box.x + by,
  y: box.y + by,
  width: Math.max(0, box.width - by * 2),
  height: Math.max(0, box.height - by * 2),
})

const clampPoint = (bounds: Box, x: number, y: number): [number, number] => [
  Math.min(Math.max(x, bounds.x), bounds.x + bounds.width),
  Math.min(Math.max(y, bounds.y), bounds.y + bounds.height),
]

export interface AnnotationLayerProps extends HTMLAttributes<HTMLDivElement> {
  /** Where each subject is now; the layer places its notes on every commit. */
  anchors: Anchors
  /** Space a note keeps from the layer's edge, in pixels. */
  margin?: number
  children?: ReactNode
}

/**
 * The layer notes live in: an SVG for subjects and leaders, and a plane for
 * the notes. It covers its positioned parent and lets pointer events through
 * except on the notes themselves.
 */
export function AnnotationLayer({ anchors, margin = 8, children, className, style, ...rest }: AnnotationLayerProps) {
  const root = useRef<HTMLDivElement>(null)
  const [notes, setNotes] = useState<HTMLDivElement | null>(null)
  const [svg, setSvg] = useState<SVGSVGElement | null>(null)
  const entries = useRef(new Set<Entry>())
  const clear = useRef(new Map<Element, Box>())
  const bounds = useRef<Box>({ x: 0, y: 0, width: 0, height: 0 })
  const running = useRef(false)
  const again = useRef(false)
  const observer = useRef<ResizeObserver | null>(null)

  const measureClear = useCallback(() => {
    const layer = root.current?.getBoundingClientRect()
    if (!layer) return
    bounds.current = { x: 0, y: 0, width: layer.width, height: layer.height }
    for (const element of clear.current.keys()) {
      const box = element.getBoundingClientRect()
      clear.current.set(element, { x: box.left - layer.left, y: box.top - layer.top, width: box.width, height: box.height })
    }
  }, [])

  const layout = useCallback(async () => {
    if (running.current) {
      again.current = true
      return
    }
    running.current = true
    try {
      do {
        again.current = false
        await place()
      } while (again.current)
    } finally {
      running.current = false
    }
  }, [])

  async function place() {
    const area = bounds.current
    const boundary = inset(area, margin)
    const reserved = [...clear.current.values()]
    const ordered = [...entries.current].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.priority - a.priority)
    const subjects: Box[] = []
    for (const entry of ordered) {
      const anchor = anchors.get(entry.anchor)
      // A subject the scene already hides behind something nearer is not one to keep clear.
      if (anchor?.visible && !anchor.occluded) subjects.push(anchor.box)
    }
    const taken: Array<{ box: Box; priority: number }> = []
    for (const entry of ordered) {
      const { slot } = entry
      if (!slot) continue
      const anchor = anchors.get(entry.anchor)
      const inView =
        anchor !== undefined &&
        anchor.visible &&
        anchor.box.x + anchor.box.width >= area.x &&
        anchor.box.x <= area.x + area.width &&
        anchor.box.y + anchor.box.height >= area.y &&
        anchor.box.y <= area.y + area.height
      // A subject out of view hides its note, unless the note is pinned: then
      // it waits at the edge nearest its subject, pointing toward it.
      if (!anchor || (!inView && !entry.pinned)) {
        hideEntry(entry)
        continue
      }
      let subject = anchor.box
      if (!inView) {
        const [x, y] = clampPoint(boundary, anchor.box.x + anchor.box.width / 2, anchor.box.y + anchor.box.height / 2)
        subject = { x, y, width: 0, height: 0 }
      }
      const floating = entry.size
      const candidates: Candidate[] = []
      let referenceHidden = false
      if (!entry.pinned) entry.manual = undefined
      const kept = inView ? entry.manual : undefined
      if (kept) {
        const [mx, my] = kept
        const x = Math.min(Math.max(subject.x + subject.width / 2 + mx, boundary.x), boundary.x + boundary.width - floating.width)
        const y = Math.min(Math.max(subject.y + subject.height / 2 + my, boundary.y), boundary.y + boundary.height - floating.height)
        candidates.push({ placement: entry.previous ?? 'right', box: { x, y, width: floating.width, height: floating.height } })
      }
      // A leader's note sits off the corner, so the leader leaves at 45
      // degrees and turns level into it: the note is raised (start) or
      // lowered (end) until the line it is entered on clears the subject.
      // The gap is measured from the subject, the leader from its padded
      // bracket: what is left after the level run is the 45 degree rise.
      const rise = Math.max(0, entry.gap - entry.padding - LEADER_RUN)
      const across = (placement: Placement, height: number) => {
        if (entry.connector !== 'leader' || placement.startsWith('top') || placement.startsWith('bottom')) return 0
        const into = attachOffset(entry.attach, height)
        if (placement.endsWith('-start')) return -entry.padding - rise - into
        if (placement.endsWith('-end')) return height + entry.padding + rise - into
        return 0
      }
      for (const placement of candidates.length ? [] : entry.placements) {
        const result = await computePosition(subject, floating, {
          placement,
          platform,
          middleware: [
            offset(({ rects }) => ({ mainAxis: entry.gap, crossAxis: across(placement, rects.floating.height) })),
            // Both axes: a note never leaves the layer; covering its subject instead costs it in `choose`.
            shift({ boundary, padding: 0, crossAxis: true }),
            hide({ boundary, strategy: 'referenceHidden' }),
          ],
        })
        referenceHidden ||= Boolean(result.middlewareData.hide?.referenceHidden)
        candidates.push({ placement, box: { x: result.x, y: result.y, width: floating.width, height: floating.height } })
      }
      const others = subjects.filter((box) => box !== anchor.box)
      const obstacles = [...taken.map((each) => each.box), ...reserved]
      // A note the person put somewhere stays there; a chosen one may slide clear of what is in the way.
      if (!kept) candidates.push(...candidates.flatMap((each) => cleared(each, obstacles, margin)))
      const chosen = choose(candidates, {
        subject,
        bounds: boundary,
        obstacles,
        others,
        previous: entry.previous,
      })
      if (
        entry.yields &&
        [...reserved, ...taken.filter((each) => each.priority > entry.priority).map((each) => each.box)].some(
          (box) => overlap(box, chosen.box) > 0,
        )
      ) {
        hideEntry(entry)
        continue
      }
      entry.previous = chosen.placement
      entry.placed = chosen.box
      taken.push({ box: chosen.box, priority: entry.priority })
      slot.style.transform = `translate3d(${Math.round(chosen.box.x)}px, ${Math.round(chosen.box.y)}px, 0)`
      slot.dataset.placement = chosen.placement
      slot.toggleAttribute('data-hidden', false)
      slot.toggleAttribute('data-offscreen', !inView || referenceHidden)
      slot.toggleAttribute('data-occluded', Boolean(anchor.occluded))
      const group = entry.subjectPath?.parentElement
      group?.toggleAttribute('data-occluded', Boolean(anchor.occluded))
      group?.toggleAttribute('data-hidden', false)
      entry.subjectPath?.setAttribute('d', inView ? subjectPath(entry.subject, subject, entry.padding) : '')
      const padding = inView ? entry.padding : 0
      const { from, to } =
        entry.connector === 'leader' ? leaderEnds(subject, chosen.box, padding, entry.attach) : connectorEnds(subject, chosen.box, padding)
      entry.connectorPath?.setAttribute('d', connectorPath(entry.connector, from, to))
    }
  }

  function hideEntry(entry: Entry) {
    entry.slot?.toggleAttribute('data-hidden', true)
    entry.subjectPath?.parentElement?.toggleAttribute('data-hidden', true)
    entry.placed = undefined
  }

  useLayoutEffect(() => {
    observer.current = new ResizeObserver((records) => {
      for (const record of records) {
        const entry = [...entries.current].find((each) => each.slot === record.target)
        const box = record.borderBoxSize?.[0]
        if (entry) entry.size = box ? { width: box.inlineSize, height: box.blockSize } : { width: record.contentRect.width, height: record.contentRect.height }
      }
      measureClear()
      void layout()
    })
    if (root.current) observer.current.observe(root.current)
    measureClear()
    const unsubscribe = anchors.subscribe(() => void layout())
    window.addEventListener('scroll', measureClear, true)
    return () => {
      unsubscribe()
      window.removeEventListener('scroll', measureClear, true)
      observer.current?.disconnect()
    }
  }, [anchors, layout, measureClear])

  const context: LayerContext = {
    notes,
    svg,
    schedule: () => void layout(),
    drag: (entry, dx, dy, done) => {
      const anchor = anchors.get(entry.anchor)
      if (!anchor || !entry.placed) return
      const cx = anchor.box.x + anchor.box.width / 2
      const cy = anchor.box.y + anchor.box.height / 2
      const [mx, my] = entry.manual ?? [entry.placed.x - cx, entry.placed.y - cy]
      entry.manual = [mx + dx, my + dy]
      if (done) entry.onPlace?.(entry.manual)
      void layout()
    },
    register: (entry) => {
      entries.current.add(entry)
      if (entry.slot) {
        entry.size = { width: entry.slot.offsetWidth, height: entry.slot.offsetHeight }
        observer.current?.observe(entry.slot)
      }
      void layout()
      return () => {
        entries.current.delete(entry)
        if (entry.slot) observer.current?.unobserve(entry.slot)
      }
    },
    keepClear: (element) => {
      clear.current.set(element, { x: 0, y: 0, width: 0, height: 0 })
      observer.current?.observe(element)
      measureClear()
      void layout()
      return () => {
        clear.current.delete(element)
        observer.current?.unobserve(element)
      }
    },
  }

  return (
    <Context.Provider value={context}>
      <Theme ref={root} className={['tn-layer', className].filter(Boolean).join(' ')} style={style} data-liquid-ignore="" {...rest}>
        <svg ref={setSvg} className="tn-marks" aria-hidden="true" />
        <div ref={setNotes} className="tn-notes" />
        {children}
      </Theme>
    </Context.Provider>
  )
}

/** Keeps every note off its children: wrap controls that sit over the scene. */
export function KeepClear({ children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const { keepClear } = useLayer()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => (ref.current ? keepClear(ref.current) : undefined), [keepClear])
  return (
    <div ref={ref} {...rest} className={['tn-keep-clear', rest.className].filter(Boolean).join(' ')}>
      {children}
    </div>
  )
}
