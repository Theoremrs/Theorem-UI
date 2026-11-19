// SOURCING: elkjs (Eclipse Layout Kernel, the `layered` algorithm) arranges a
// network the way a circuit or dataflow diagram is read: parts in layers along
// the flow, input ports on the west side and outputs on the east, crossings
// kept few, wires routed orthogonally. `elk.bundled.js` runs without a worker,
// so it also runs inside an App.
//
// This is a starting arrangement and nothing more. A part's own `at` always
// wins, the arrangement is made once for a network's structure (never because
// a value changed), and what the person moves afterwards is theirs. `stages`
// is the older arrangement by settle stage, kept as an option.

import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api.js'
import type { Network, Part, Vec3 } from './engine'

export interface Box {
  x: number
  y: number
}

export interface Arranged {
  /** Every part's centre in its network's frame, by path. A part's own `at` is kept. */
  positions: Map<string, Vec3>
  /** Orthogonal routes of the wires ELK arranged, by wire id, as points in the same frame (z = 0). */
  routes: Map<string, Array<Vec3>>
}

/** ELK units per model unit: ELK's spacing defaults assume pixels. */
const SCALE = 100
const LAYER_GAP = 1.6
const ROW_GAP = 0.9
const WIRE_GAP = 0.25

const free = (part: Part) => !part.spec.at

/** A port's place on its part, in the part's frame (origin at the centre, y up), as the view draws it. */
function portPlace(part: Part, size: Box, dir: 'in' | 'out', index: number) {
  const port = part.ports.filter((candidate) => candidate.dir === dir)[index]!
  const count = part.ports.filter((candidate) => candidate.dir === dir).length
  if (port.at) return { x: port.at[0], y: port.at[1] }
  return {
    x: (dir === 'in' ? -size.x : size.x) / 2,
    y: count === 1 ? 0 : size.y * 0.8 * (0.5 - index / (count - 1)),
  }
}

type Side = 'WEST' | 'EAST' | 'NORTH' | 'SOUTH'

/** The side of a part's box a port sits on, and its position along that border, in ELK's frame (top left origin, y down). */
function portOnBorder(place: { x: number; y: number }, size: Box, dir: 'in' | 'out') {
  const half = { x: size.x / 2, y: size.y / 2 }
  const nx = place.x / half.x
  const ny = place.y / half.y
  const side: Side =
    Math.abs(nx) >= Math.abs(ny) ? (nx < 0 ? 'WEST' : nx > 0 ? 'EAST' : dir === 'in' ? 'WEST' : 'EAST') : ny > 0 ? 'NORTH' : 'SOUTH'
  const along = side === 'WEST' || side === 'EAST' ? half.y - place.y : half.x + place.x
  const x = side === 'WEST' ? 0 : side === 'EAST' ? size.x : Math.min(size.x, Math.max(0, along))
  const y = side === 'NORTH' ? 0 : side === 'SOUTH' ? size.y : Math.min(size.y, Math.max(0, along))
  return { side, x, y }
}

/**
 * Arranges one network level with ELK's layered algorithm. Parts that give an
 * `at` are placed there; the rest are arranged among all the parts and the wires
 * between them (the wires to the network's own ports are left out), then
 * centred on the origin as the stage arrangement is.
 */
export async function arrangeElk(network: Network, sizes: (part: Part) => Box): Promise<Arranged> {
  const positions = new Map<string, Vec3>()
  const routes = new Map<string, Array<Vec3>>()
  for (const part of network.parts) if (!free(part)) positions.set(part.path, [...part.spec.at!] as Vec3)
  if (!network.parts.some(free)) return { positions, routes }

  const byPath = new Map(network.parts.map((part) => [part.path, part]))
  const children: Array<ElkNode> = network.parts.map((part) => {
    const size = sizes(part)
    const ports: Array<ElkPort> = (['in', 'out'] as const).flatMap((dir) =>
      part.ports
        .filter((port) => port.dir === dir)
        .map((port, index) => {
          const onBorder = portOnBorder(portPlace(part, size, dir, index), size, dir)
          return {
            id: `${part.path}#${port.name}`,
            x: onBorder.x * SCALE,
            y: onBorder.y * SCALE,
            width: 0,
            height: 0,
            layoutOptions: { 'elk.port.side': onBorder.side },
          }
        }),
    )
    return {
      id: part.path,
      width: size.x * SCALE,
      height: size.y * SCALE,
      ports,
      // The ports are where the view puts them, so ELK may not move them.
      layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
    }
  })
  const edges: Array<ElkExtendedEdge> = network.wires
    .filter((wire) => !wire.from.boundary && !wire.to.boundary && byPath.has(wire.from.part) && byPath.has(wire.to.part))
    .map((wire) => ({
      id: wire.id,
      sources: [`${wire.from.part}#${wire.from.port}`],
      targets: [`${wire.to.part}#${wire.to.port}`],
    }))

  const laid = await new ELK().layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': String(ROW_GAP * SCALE),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(LAYER_GAP * SCALE),
      'elk.spacing.edgeNode': String(WIRE_GAP * SCALE),
      'elk.layered.spacing.edgeNodeBetweenLayers': String(WIRE_GAP * SCALE),
      'elk.spacing.edgeEdge': String(WIRE_GAP * 0.6 * SCALE),
      'elk.layered.spacing.edgeEdgeBetweenLayers': String(WIRE_GAP * 0.6 * SCALE),
      'elk.randomSeed': '1',
    },
    children,
    edges,
  })

  // ELK's y runs down and its origin is a corner; the view's y runs up, centred.
  const placed = (laid.children ?? []).filter((node) => byPath.get(node.id)!.spec.at === undefined)
  if (!placed.length) return { positions, routes }
  const left = Math.min(...placed.map((node) => node.x!))
  const right = Math.max(...placed.map((node) => node.x! + node.width!))
  const top = Math.min(...placed.map((node) => node.y!))
  const bottom = Math.max(...placed.map((node) => node.y! + node.height!))
  const cx = (left + right) / 2
  const cy = (top + bottom) / 2
  const toModel = (x: number, y: number): Vec3 => [(x - cx) / SCALE, (cy - y) / SCALE, 0]
  for (const node of placed)
    positions.set(node.id, toModel(node.x! + node.width! / 2, node.y! + node.height! / 2))
  for (const edge of laid.edges) {
    const section = edge.sections?.[0]
    if (!section) continue
    routes.set(edge.id, [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((point) => toModel(point.x, point.y)))
  }
  return { positions, routes }
}

/**
 * Arranges one network level in columns by settle stage, left to right: the
 * parts of a stage stacked in a column, each column staggered a little in depth.
 * `stageOf` is the stage a part fires at.
 */
export function arrangeStages(network: Network, sizes: (part: Part) => Box, stageOf: (part: Part) => number): Arranged {
  const positions = new Map<string, Vec3>()
  const columns = new Map<number, Array<Part>>()
  for (const part of network.parts) {
    if (part.spec.at) positions.set(part.path, [...part.spec.at] as Vec3)
    else columns.set(stageOf(part), [...(columns.get(stageOf(part)) ?? []), part])
  }
  const stages = [...columns.keys()].sort((a, b) => a - b)
  const widths = stages.map((stage) => Math.max(...columns.get(stage)!.map((part) => sizes(part).x)))
  const total = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, stages.length - 1) * LAYER_GAP
  let x = -total / 2
  stages.forEach((stage, index) => {
    const column = columns.get(stage)!
    const heights = column.map((part) => sizes(part).y)
    const height = heights.reduce((sum, h) => sum + h, 0) + (column.length - 1) * ROW_GAP
    let y = height / 2
    column.forEach((part, row) => {
      y -= heights[row]! / 2
      positions.set(part.path, [x + widths[index]! / 2, y, (row % 2) * -0.35])
      y -= heights[row]! / 2 + ROW_GAP
    })
    x += widths[index]! + LAYER_GAP
  })
  return { positions, routes: new Map() }
}
