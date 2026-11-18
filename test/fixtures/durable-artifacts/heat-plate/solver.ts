// Steady heat conduction with no internal source, by finite differences: a
// rod (one dimension, solved directly) and a rectangular plate (two
// dimensions, solved by successive over-relaxation). Units are SI and
// recorded on every result: lengths in m, temperatures in °C, conductivity k
// in W/(m·K), the convective coefficient h in W/(m²·K).
//
// Boundaries: `fixed` holds a temperature; `insulated` passes no heat;
// `convective` loses heat to an ambient temperature at h (Newton cooling,
// -k ∂T/∂n = h (T - ambient)), discretized with a ghost node so the condition
// is second-order and exact for a linear profile.

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

/**
 * The plate's steady field. A fixed edge holds its temperature (where two
 * edges meet, a fixed one wins); an insulated or convective edge uses a
 * ghost node through its face.
 */
export function solvePlate(input: PlateInput): PlateField {
  const { width, height, nx, ny, conductivity } = input
  if (nx < 3 || ny < 3)
    throw new Error('A plate needs at least 3 nodes each way.')
  const dx = width / (nx - 1)
  const dy = height / (ny - 1)
  const tolerance = input.tolerance ?? 1e-10
  const maxSweeps = input.maxSweeps ?? 200_000
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
  const t = Array.from({ length: ny }, (_, j) =>
    Array.from({ length: nx }, (_unused, i) => fixedAt(i, j) ?? 0),
  )
  // One neighbour across an edge: its ghost value, from the boundary condition.
  const ghost = (
    side: Boundary,
    inner: number,
    here: number,
    spacing: number,
  ): number => {
    if (side.kind === 'convective')
      return (
        inner -
        2 * cellBiot(side.h, spacing, conductivity) * (here - side.ambient)
      )
    return inner
  }
  const wx = 1 / (dx * dx)
  const wy = 1 / (dy * dy)
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
        const west = i > 0 ? row[i - 1]! : ghost(input.left, row[1]!, here, dx)
        const east =
          i < nx - 1 ? row[i + 1]! : ghost(input.right, row[nx - 2]!, here, dx)
        const south =
          j > 0 ? t[j - 1]![i]! : ghost(input.bottom, t[1]![i]!, here, dy)
        const north =
          j < ny - 1
            ? t[j + 1]![i]!
            : ghost(input.top, t[ny - 2]![i]!, here, dy)
        const gauss =
          (wx * (west + east) + wy * (south + north)) / (2 * wx + 2 * wy)
        // A convective ghost depends on `here`; a few relaxed sweeps settle it.
        const next = here + omega * (gauss - here)
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
