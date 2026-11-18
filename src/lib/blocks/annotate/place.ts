// SOURCING: none: choosing among the positions Floating UI computes for a
// note. Floating UI places one floating element against one reference; which
// side keeps several notes, a subject and the controls clear of each other is
// this scoring, in the manner of label placement in cartography: try a few
// candidates, cost each by overlap and leader length, keep the last choice
// unless another is clearly better.
import type { Box } from './anchors'

export type Placement =
  | 'top' | 'top-start' | 'top-end'
  | 'right' | 'right-start' | 'right-end'
  | 'bottom' | 'bottom-start' | 'bottom-end'
  | 'left' | 'left-start' | 'left-end'

export interface Candidate {
  placement: Placement
  box: Box
}

export interface PlaceOptions {
  /** What the note is about; covering it is costly. */
  subject: Box
  /** Other notes, subjects and controls to keep clear of. */
  obstacles: ReadonlyArray<Box>
  /** The layer; a note out of it is costly. */
  bounds: Box
  /** The placement chosen last frame, kept unless another is clearly better. */
  previous?: Placement
}

/** The head start the previous placement has. */
const STAY = 0.25

const area = (box: Box) => Math.max(0, box.width) * Math.max(0, box.height)

/** The area two boxes share. */
export function overlap(a: Box, b: Box): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

/** The point of `box` nearest to (x, y). */
export function nearest(box: Box, x: number, y: number): [number, number] {
  return [
    Math.min(Math.max(x, box.x), box.x + box.width),
    Math.min(Math.max(y, box.y), box.y + box.height),
  ]
}

/**
 * What a candidate costs: lower is better. An overlap costs by the share of
 * the smaller box it hides, so a note over a small part or label costs as much
 * as over a large one; hiding its own subject outweighs hiding anything else.
 * Leaving the layer is measured against the note, and a longer leader costs a
 * little.
 */
export function cost(candidate: Candidate, options: PlaceOptions): number {
  const { box } = candidate
  const own = Math.max(1, area(box))
  // Each obstacle by the share of the smaller box hidden: a note over a whole small part costs as much as over a large one.
  const covered = options.obstacles.reduce(
    (sum, obstacle) => sum + overlap(box, obstacle) / Math.max(1, Math.min(own, area(obstacle))),
    0,
  )
  const outside = own - overlap(box, options.bounds)
  const cx = options.subject.x + options.subject.width / 2
  const cy = options.subject.y + options.subject.height / 2
  const [nx, ny] = nearest(box, cx, cy)
  const diagonal = Math.max(1, Math.hypot(options.bounds.width, options.bounds.height))
  return (
    4 * covered +
    // Hiding what the note is about outweighs hiding anything else.
    (30 * overlap(box, options.subject)) / Math.max(1, area(options.subject)) +
    (8 * outside) / own +
    Math.hypot(nx - cx, ny - cy) / diagonal
  )
}

/**
 * The candidate to use: the cheapest, the previous one given a small head start
 * so a note does not flicker between two near-equal sides. The head start is
 * added, not multiplied, so it never holds a note somewhere clearly worse.
 */
export function choose(candidates: ReadonlyArray<Candidate>, options: PlaceOptions): Candidate {
  let best: Candidate | undefined
  let bestCost = Infinity
  for (const candidate of candidates) {
    const each = cost(candidate, options) - (candidate.placement === options.previous ? STAY : 0)
    if (each < bestCost - 1e-9) {
      best = candidate
      bestCost = each
    }
  }
  if (!best) throw new Error('choose needs at least one candidate')
  return best
}
