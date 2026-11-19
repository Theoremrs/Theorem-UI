// SOURCING: none: d3-annotation's vocabulary (a subject, a connector, a note)
// as SVG path data. d3-annotation draws with D3 v4 selections into an SVG it
// owns; here a path is a string the layer writes, so a subject or a
// connector can be any function an App writes.
import type { Box } from './anchors'
import { nearest } from './place'

export type Point = [number, number]

/** What is marked: a built-in shape, or a function from the subject's box to path data. */
export type Subject = 'none' | 'point' | 'circle' | 'rect' | 'bracket' | ((box: Box) => string)

/** How the note is joined to its subject: a built-in leader, or a function from its ends to path data. */
export type Connector = 'none' | 'line' | 'elbow' | 'curve' | 'leader' | ((from: Point, to: Point) => string)

/**
 * Where a leader enters its note: that many pixels below the note's top (its
 * first line), or `'bottom'`, along the rule under a label.
 */
export type Attach = number | 'bottom'

/** The shortest horizontal run a leader keeps before it reaches its note. */
export const LEADER_RUN = 12

const grow = (box: Box, by: number): Box => ({
  x: box.x - by,
  y: box.y - by,
  width: box.width + by * 2,
  height: box.height + by * 2,
})

const centre = (box: Box): Point => [box.x + box.width / 2, box.y + box.height / 2]
const n = (value: number) => Math.round(value * 10) / 10

/** The subject's outline as path data, `padding` outside its box. */
export function subjectPath(subject: Subject, box: Box, padding = 4): string {
  if (typeof subject === 'function') return subject(box)
  const b = grow(box, padding)
  const [cx, cy] = centre(b)
  switch (subject) {
    case 'none':
      return ''
    case 'point':
      return `M${n(cx - 3)},${n(cy)}a3,3 0 1,0 6,0a3,3 0 1,0 -6,0`
    case 'circle': {
      const r = Math.max(b.width, b.height) / 2
      return `M${n(cx - r)},${n(cy)}a${n(r)},${n(r)} 0 1,0 ${n(r * 2)},0a${n(r)},${n(r)} 0 1,0 ${n(-r * 2)},0`
    }
    case 'rect': {
      const r = Math.min(8, b.width / 4, b.height / 4)
      return `M${n(b.x + r)},${n(b.y)}h${n(b.width - 2 * r)}a${n(r)},${n(r)} 0 0,1 ${n(r)},${n(r)}v${n(b.height - 2 * r)}a${n(r)},${n(r)} 0 0,1 ${n(-r)},${n(r)}h${n(-(b.width - 2 * r))}a${n(r)},${n(r)} 0 0,1 ${n(-r)},${n(-r)}v${n(-(b.height - 2 * r))}a${n(r)},${n(r)} 0 0,1 ${n(r)},${n(-r)}z`
    }
    case 'bracket': {
      // Open corners in proportion to what they frame, never closing into a box.
      const arm = Math.max(4, Math.min(16, Math.min(b.width, b.height) * 0.2, b.width / 3, b.height / 3))
      const corners: Array<[number, number, number, number]> = [
        [b.x, b.y, 1, 1],
        [b.x + b.width, b.y, -1, 1],
        [b.x + b.width, b.y + b.height, -1, -1],
        [b.x, b.y + b.height, 1, -1],
      ]
      return corners
        .map(([x, y, dx, dy]) => `M${n(x + dx * arm)},${n(y)}H${n(x)}V${n(y + dy * arm)}`)
        .join('')
    }
  }
}

/**
 * Where a leader starts on the subject (its padded outline, on the side
 * facing the note) and where it meets the note (the note's nearest point).
 */
export function connectorEnds(subject: Box, note: Box, padding = 4): { from: Point; to: Point } {
  const b = grow(subject, padding)
  const [cx, cy] = centre(b)
  const to = nearest(note, cx, cy)
  const dx = to[0] - cx
  const dy = to[1] - cy
  // Leave the outline where the line from its centre to the note crosses it.
  const scale = Math.min(
    dx ? b.width / 2 / Math.abs(dx) : Infinity,
    dy ? b.height / 2 / Math.abs(dy) : Infinity,
    1,
  )
  return { from: [cx + dx * scale, cy + dy * scale], to }
}

/** How far below its top a note is entered, for a note `height` tall. */
export const attachOffset = (attach: Attach, height: number) => (attach === 'bottom' ? height : Math.min(attach, height / 2))

/**
 * The ends of a technical-drawing leader: it leaves the subject's padded
 * outline at the corner nearest the note (or straight across, when the note
 * is level with the subject) and enters the note's near side where `attach`
 * says. A note above or below the subject is reached straight down or up.
 */
export function leaderEnds(subject: Box, note: Box, padding = 4, attach: Attach = 'bottom'): { from: Point; to: Point } {
  const b = grow(subject, padding)
  const right = b.x + b.width
  const bottom = b.y + b.height
  const y = note.y + attachOffset(attach, note.height)
  const side = note.x >= right - 0.5 ? 'right' : note.x + note.width <= b.x + 0.5 ? 'left' : null
  if (!side) {
    const x = Math.min(Math.max(note.x + note.width / 2, b.x), right)
    return note.y >= bottom ? { from: [x, bottom], to: [x, note.y] } : { from: [x, b.y], to: [x, note.y + note.height] }
  }
  const fromX = side === 'right' ? right : b.x
  const toX = side === 'right' ? note.x : note.x + note.width
  return { from: [fromX, Math.min(Math.max(y, b.y), bottom)], to: [toX, y] }
}

/** The leader as path data. */
export function connectorPath(connector: Connector, from: Point, to: Point): string {
  if (typeof connector === 'function') return connector(from, to)
  const [x1, y1] = from
  const [x2, y2] = to
  switch (connector) {
    case 'none':
      return ''
    case 'line':
      return `M${n(x1)},${n(y1)}L${n(x2)},${n(y2)}`
    case 'elbow': {
      // Out along the longer axis, then straight to the note: d3-annotation's elbow.
      const horizontal = Math.abs(x2 - x1) >= Math.abs(y2 - y1)
      const bend = Math.min(Math.abs(horizontal ? y2 - y1 : x2 - x1), Math.abs(horizontal ? x2 - x1 : y2 - y1))
      return horizontal
        ? `M${n(x1)},${n(y1)}L${n(x1 + Math.sign(x2 - x1) * bend)},${n(y2)}L${n(x2)},${n(y2)}`
        : `M${n(x1)},${n(y1)}L${n(x2)},${n(y1 + Math.sign(y2 - y1) * bend)}L${n(x2)},${n(y2)}`
    }
    case 'leader': {
      // One deliberate elbow: out at 45 degrees, then level into the note.
      // When the rise is too steep for that and a run, straight up or down
      // instead, so the elbow is a right angle.
      const dx = x2 - x1
      const dy = y2 - y1
      if (Math.abs(dy) < 0.5 || Math.abs(dx) < 0.5) return `M${n(x1)},${n(y1)}L${n(x2)},${n(y2)}`
      // Layout leaves LEADER_RUN of level run; a part moving under a note that
      // keeps its side may eat into it, and the 45 degree elbow holds while
      // a short run is left.
      const diagonal = Math.abs(dy) <= Math.abs(dx) - LEADER_RUN / 3
      const bendX = diagonal ? x1 + Math.sign(dx) * Math.abs(dy) : x1
      return `M${n(x1)},${n(y1)}L${n(bendX)},${n(y2)}L${n(x2)},${n(y2)}`
    }
    case 'curve': {
      const mx = (x1 + x2) / 2
      return `M${n(x1)},${n(y1)}C${n(mx)},${n(y1)} ${n(mx)},${n(y2)} ${n(x2)},${n(y2)}`
    }
  }
}
