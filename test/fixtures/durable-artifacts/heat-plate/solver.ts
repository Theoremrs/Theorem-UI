// Steady heat conduction with no internal source, by finite differences: a
// rod (one dimension, solved directly) and a rectangular plate (two
// dimensions, solved by successive over-relaxation). Units are SI and
// recorded on every result: lengths in m, temperatures in °C, conductivity k
// in W/(m·K), the convective coefficient h in W/(m²·K).
//
// Boundaries: `fixed` holds a temperature; `insulated` passes no heat;
// `convective` loses heat to an ambient temperature at h (Newton cooling,
// -k ∂T/∂n = h (T - ambient)), discretized with a ghost node so the condition
// is second-order and exact for a linear profile. That ghost holds a piece of
// its own node's temperature, so a convective face contributes its cooling
// slope (2 Bi per face) to the diagonal of the node it bounds, not only to the
// terms summed beside it; the relaxed sweep then contracts for any h.

export const SOLVER = { name: 'steady-conduction', version: '2' } as const

export const UNITS = {
  length: 'm',
  temperature: '°C',
  conductivity: 'W/(m·K)',
  convection: 'W/(m²·K)',
} as const

export type Boundary =
  | { kind: 'fixed'; temperature: number }
  | { kind: 'insulated' }
  | { kind: 'convective'; h: number; ambient: number }

export interface RodInput {
  length: number
  nodes: number
  conductivity: number
  left: Boundary
  right: Boundary
}

export interface Sample {
  x: number
  t: number
}

/** The Biot number of one cell: how strongly a convective face pulls its node toward ambient. */
export const cellBiot = (h: number, spacing: number, conductivity: number) =>
  (h * spacing) / conductivity

/** Solves a tridiagonal system (sub a, diagonal b, super c, right side d) by the Thomas algorithm. */
export function tridiagonal(
  a: Array<number>,
  b: Array<number>,
  c: Array<number>,
  d: Array<number>,
): Array<number> {
  const n = b.length
  const cp = new Array<number>(n).fill(0)
  const dp = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    const denom = b[i]! - (i > 0 ? a[i]! * cp[i - 1]! : 0)
    if (denom === 0)
      throw new Error(
        'The system is singular: no boundary fixes a temperature.',
      )
    cp[i] = c[i]! / denom
    dp[i] = (d[i]! - (i > 0 ? a[i]! * dp[i - 1]! : 0)) / denom
  }
  const x = new Array<number>(n).fill(0)
  for (let i = n - 1; i >= 0; i--)
    x[i] = dp[i]! - cp[i]! * (i < n - 1 ? x[i + 1]! : 0)
  return x
}

/** One row of the end equation: for a node at an end whose inner neighbour is at `inner`. */
function endRow(boundary: Boundary, spacing: number, conductivity: number) {
  if (boundary.kind === 'fixed')
    return { diagonal: 1, inner: 0, rhs: boundary.temperature }
  // Ghost node mirrored through the face: insulated is the case h = 0.
  const bi =
    boundary.kind === 'convective'
      ? cellBiot(boundary.h, spacing, conductivity)
      : 0
  const ambient = boundary.kind === 'convective' ? boundary.ambient : 0
  // T_inner - (1 + Bi) T_end + Bi T_ambient = 0
  return { diagonal: 1 + bi, inner: -1, rhs: bi * ambient }
}

export function solveRod(input: RodInput): Array<Sample> {
  const { length, nodes, conductivity, left, right } = input
  if (nodes < 3) throw new Error('A rod needs at least 3 nodes.')
  if (!(length > 0 && conductivity > 0))
    throw new Error('Length and conductivity are positive.')
  const dx = length / (nodes - 1)
  const a = new Array<number>(nodes).fill(-1)
  const b = new Array<number>(nodes).fill(2)
  const c = new Array<number>(nodes).fill(-1)
  const d = new Array<number>(nodes).fill(0)
  const l = endRow(left, dx, conductivity)
  b[0] = l.diagonal
  c[0] = l.inner
  d[0] = l.rhs
  a[0] = 0
  const r = endRow(right, dx, conductivity)
  b[nodes - 1] = r.diagonal
  a[nodes - 1] = r.inner
  d[nodes - 1] = r.rhs
  c[nodes - 1] = 0
  return tridiagonal(a, b, c, d).map((t, i) => ({ x: i * dx, t }))
}

export interface PlateInput {
  width: number
  height: number
  /** Nodes along x and along y, edges included. */
  nx: number
  ny: number
  conductivity: number
  left: Boundary
  right: Boundary
  bottom: Boundary
  top: Boundary
  /** The largest change in a sweep at which the solve has converged, in °C. */
  tolerance?: number
  maxSweeps?: number
}

export interface PlateField {
  /** Temperatures by row from the bottom (y = 0), each row from the left (x = 0). */
  t: Array<Array<number>>
  dx: number
  dy: number
  sweeps: number
  converged: boolean
  /** The largest change in the last sweep, in °C. */
  change: number
  units: typeof UNITS
}

/** The most nodes along one side: past this a sweep is too slow to run in a page. */
export const MAX_NODES = 401

/** What is wrong with a plate before it is solved, by the field that is wrong. */
export interface PlateProblem {
  field: string
  message: string
}

/**
 * Every value a person can set, checked against the range the model holds
 * for: dimensions and conductivity positive, node counts whole and bounded,
 * h not negative, temperatures above absolute zero. A plate with problems is
 * not solved, so a mistyped control is shown as itself instead of as a field.
 */
export function plateProblems(input: PlateInput): Array<PlateProblem> {
  const problems: Array<PlateProblem> = []
  const positive = (field: string, value: number, unit: string) => {
    if (!(Number.isFinite(value) && value > 0))
      problems.push({
        field,
        message: `${field} is a positive number of ${unit}.`,
      })
  }
  positive('width', input.width, UNITS.length)
  positive('height', input.height, UNITS.length)
  positive('conductivity', input.conductivity, UNITS.conductivity)
  for (const field of ['nx', 'ny'] as const) {
    const value = input[field]
    if (!(Number.isInteger(value) && value >= 3 && value <= MAX_NODES))
      problems.push({
        field,
        message: `${field} is a whole number of nodes from 3 to ${MAX_NODES}.`,
      })
  }
  const temperature = (field: string, value: number) => {
    if (!(Number.isFinite(value) && value >= -273.15))
      problems.push({
        field,
        message: `${field} is a temperature at or above -273.15 ${UNITS.temperature}.`,
      })
  }
  for (const side of ['left', 'right', 'bottom', 'top'] as const) {
    const boundary = input[side]
    if (boundary.kind === 'fixed')
      temperature(`${side}.temperature`, boundary.temperature)
    if (boundary.kind === 'convective') {
      if (!(Number.isFinite(boundary.h) && boundary.h >= 0))
        problems.push({
          field: `${side}.h`,
          message: `${side}.h is zero or a positive number of ${UNITS.convection}.`,
        })
      temperature(`${side}.ambient`, boundary.ambient)
    }
  }
  if (
    input.tolerance !== undefined &&
    !(Number.isFinite(input.tolerance) && input.tolerance > 0)
  )
    problems.push({
      field: 'tolerance',
      message: `tolerance is a positive number of ${UNITS.temperature}.`,
    })
  if (
    input.maxSweeps !== undefined &&
    !(Number.isInteger(input.maxSweeps) && input.maxSweeps >= 1)
  )
    problems.push({
      field: 'maxSweeps',
      message: 'maxSweeps is a whole number of at least 1.',
    })
  return problems
}

/** A plate refused before it was solved, with every problem it has. */
export class PlateRefused extends Error {
  constructor(readonly problems: Array<PlateProblem>) {
    super(problems.map((problem) => problem.message).join(' '))
    this.name = 'PlateRefused'
  }
}

/**
 * The discrete equations of a plate: which nodes are held, and the relaxed
 * target of every other node from its neighbours (`gauss`), the value that
 * would satisfy its own equation exactly. Solving and checking share it, so a
 * check measures the equations the sweep solved, not a second copy of them.
 */
function plateEquations(input: PlateInput) {
  const { width, height, nx, ny, conductivity } = input
  const dx = width / (nx - 1)
  const dy = height / (ny - 1)
  const fixedAt = (i: number, j: number): number | undefined => {
    const sides: Array<[boolean, Boundary]> = [
      [i === 0, input.left],
      [i === nx - 1, input.right],
      [j === 0, input.bottom],
      [j === ny - 1, input.top],
    ]
    const fixed = sides.filter(([on, side]) => on && side.kind === 'fixed')
    if (fixed.length === 0) return undefined
    // Where two fixed edges meet, the corner takes their mean.
    return (
      fixed.reduce(
        (sum, [, side]) => sum + (side as { temperature: number }).temperature,
        0,
      ) / fixed.length
    )
  }
  // One neighbour across an edge, as `constant + slope * here`: what it owes
  // the node's own equation, split from what it owes to the node it faces.
  // Insulated is the case h = 0, where the ghost mirrors the inner neighbour.
  const ghost = (
    side: Boundary,
    inner: number,
    spacing: number,
  ): { constant: number; slope: number } => {
    if (side.kind === 'convective') {
      // T_ghost = T_inner - 2 Bi (T_here - T_ambient). The `-2 Bi T_here` half
      // is Newton cooling seen from this node, not another neighbour, so it
      // returns as a slope and lands on the diagonal below.
      const bi = cellBiot(side.h, spacing, conductivity)
      return { constant: inner + 2 * bi * side.ambient, slope: -2 * bi }
    }
    return { constant: inner, slope: 0 }
  }
  const wx = 1 / (dx * dx)
  const wy = 1 / (dy * dy)
  /** The value that satisfies node (i, j)'s own equation, given its neighbours now. */
  const gauss = (t: Array<Array<number>>, i: number, j: number): number => {
    const row = t[j]!
    const west =
      i > 0
        ? { constant: row[i - 1]!, slope: 0 }
        : ghost(input.left, row[1]!, dx)
    const east =
      i < nx - 1
        ? { constant: row[i + 1]!, slope: 0 }
        : ghost(input.right, row[nx - 2]!, dx)
    const south =
      j > 0
        ? { constant: t[j - 1]![i]!, slope: 0 }
        : ghost(input.bottom, t[1]![i]!, dy)
    const north =
      j < ny - 1
        ? { constant: t[j + 1]![i]!, slope: 0 }
        : ghost(input.top, t[ny - 2]![i]!, dy)
    // Summing wx (west + east - 2 here) + wy (south + north - 2 here) = 0
    // for here, with the convective slopes gathered onto the diagonal:
    // the same fixed point as before, and a contraction for any Bi.
    const slope =
      wx * (west.slope + east.slope) + wy * (south.slope + north.slope)
    return (
      (wx * (west.constant + east.constant) +
        wy * (south.constant + north.constant)) /
      (2 * wx + 2 * wy - slope)
    )
  }
  return { dx, dy, fixedAt, gauss }
}

/**
 * The plate's steady field. A fixed edge holds its temperature (where two
 * edges meet, a fixed one wins); an insulated or convective edge uses a
 * ghost node through its face. A plate with any problem (plateProblems) is
 * refused with all of them, never solved with a value clamped or guessed.
 */
export function solvePlate(input: PlateInput): PlateField {
  const problems = plateProblems(input)
  if (problems.length > 0) throw new PlateRefused(problems)
  const { nx, ny } = input
  const { dx, dy, fixedAt, gauss } = plateEquations(input)
  const tolerance = input.tolerance ?? 1e-10
  const maxSweeps = input.maxSweeps ?? 200_000
  const t = Array.from({ length: ny }, (_, j) =>
    Array.from({ length: nx }, (_unused, i) => fixedAt(i, j) ?? 0),
  )
  const omega = 2 / (1 + Math.sin(Math.PI / Math.max(nx, ny)))
  let change = Infinity
  let sweeps = 0
  while (change > tolerance && sweeps < maxSweeps) {
    change = 0
    sweeps++
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (fixedAt(i, j) !== undefined) continue
        const row = t[j]!
        const here = row[i]!
        const next = here + omega * (gauss(t, i, j) - here)
        change = Math.max(change, Math.abs(next - here))
        row[i] = next
      }
    }
  }
  return {
    t,
    dx,
    dy,
    sweeps,
    converged: change <= tolerance,
    change,
    units: UNITS,
  }
}

/** The field's value nearest (x, y). */
export function sampleAt(field: PlateField, x: number, y: number): number {
  const i = Math.round(x / field.dx)
  const j = Math.round(y / field.dy)
  return field.t[j]![i]!
}

/** How well a solved field satisfies the plate it was solved for. */
export interface PlateCheck {
  /**
   * The largest local equation correction at a free node, in °C: the gap
   * between a node and the value its own equation gives from the current
   * field, unrelaxed. Not a bound on how far the next (over-relaxed) sweep
   * moves a node, nor on the field's error against the converged one.
   */
  residual: number
  /** Heat into the plate through each edge, per metre of depth, in W/m (negative leaves). */
  edges: Record<'left' | 'right' | 'bottom' | 'top', number>
  /** The sum of the edges' heat, in W/m: zero for a steady plate with no source. */
  imbalance: number
  /** |imbalance| over the heat that crosses the boundary in either direction. */
  relativeImbalance: number
}

/**
 * Checks a field against the physics it claims, independently of how the
 * sweep stopped: the discrete equations' residual at every free node, and the
 * steady heat balance (what enters through the edges must leave through
 * them). Edge heat is integrated by the trapezoid rule from Newton cooling on
 * a convective edge and a second-order one-sided gradient on a fixed edge; an
 * insulated edge passes none. The balance is a discretization check, so it
 * tightens as the grid is refined; where two held edges meet at different
 * temperatures the true flux is singular and no grid closes the balance.
 */
export function checkPlate(input: PlateInput, field: PlateField): PlateCheck {
  const { nx, ny, conductivity: k } = input
  const { fixedAt, gauss } = plateEquations(input)
  const { t, dx, dy } = field
  let residual = 0
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++)
      if (fixedAt(i, j) === undefined)
        residual = Math.max(residual, Math.abs(gauss(t, i, j) - t[j]![i]!))
  // Values along an edge from its boundary node inward: depth 0 is the edge.
  const along = {
    left: (n: number, depth: number) => t[n]![depth]!,
    right: (n: number, depth: number) => t[n]![nx - 1 - depth]!,
    bottom: (n: number, depth: number) => t[depth]![n]!,
    top: (n: number, depth: number) => t[ny - 1 - depth]![n]!,
  }
  const edgeHeat = (side: keyof typeof along): number => {
    const boundary = input[side]
    if (boundary.kind === 'insulated') return 0
    const vertical = side === 'left' || side === 'right'
    const count = vertical ? ny : nx
    const spacing = vertical ? dy : dx
    const inward = vertical ? dx : dy
    let total = 0
    for (let n = 0; n < count; n++) {
      const edge = along[side](n, 0)
      const q =
        boundary.kind === 'convective'
          ? boundary.h * (boundary.ambient - edge)
          : // -k dT/dn into the plate, dT/dn one-sided to second order.
            (-k * (-3 * edge + 4 * along[side](n, 1) - along[side](n, 2))) /
            (2 * inward)
      total += (n === 0 || n === count - 1 ? 0.5 : 1) * q * spacing
    }
    return total
  }
  const edges = {
    left: edgeHeat('left'),
    right: edgeHeat('right'),
    bottom: edgeHeat('bottom'),
    top: edgeHeat('top'),
  }
  const flows = Object.values(edges)
  const imbalance = flows.reduce((sum, q) => sum + q, 0)
  const crossing = flows.reduce((sum, q) => sum + Math.abs(q), 0)
  return {
    residual,
    edges,
    imbalance,
    relativeImbalance: crossing === 0 ? 0 : Math.abs(imbalance) / crossing,
  }
}
