// SOURCING: @xyflow/react node and edge types, lib/graph-layout (the shared
// elkjs layout: layered, the layout React Flow's own docs pair with handles,
// groups as compound nodes; and `arrange`, so a node with no saved place goes
// beside what it is wired to instead of onto what is already there). The
// mapping from Theorem's ProgramDefinition onto them is ours: nothing upstream
// knows this format, and the definition stays the only format.
import type { Edge, Node } from '@xyflow/react'
import { arrange, layout as layOut } from '@/lib/graph-layout'
import type { Box, LayoutLeaf, LayoutPolicy, Point } from '@/lib/graph-layout'
import type {
  ProcessLiveness,
  ProgramDefinition,
  ProgramEdge,
  ProgramNode,
} from './contracts'
import type {
  CanvasGroup,
  CanvasNote,
  PendingProposal,
  ProgramLayout,
  Waypoint,
} from './api'

export type ProgramNodeData = {
  node: ProgramNode
  liveness: ProcessLiveness
  /** Severity of the graph lint diagnostics on this node. */
  lint?: 'error' | 'warning' | 'info'
  pinned?: boolean
  stale?: boolean
  /** `in:port` and `out:port` for each port an edge lands on. */
  connected?: Array<string>
  /** Downstream of a muted node: nothing can be said about it until it is unmuted. */
  undetermined?: boolean
  /** Whole-program validation named this node. */
  refused?: boolean
  /** Its block is not in the catalog: drawn from what the program itself says. */
  unknown?: boolean
  /** Showing only its header; connected handles stay so its wires hold. */
  collapsed?: boolean
  /** A proposal adds this node; it is not part of the program yet. */
  ghost?: boolean
  /** What the proposal under review would do to this node. */
  proposed?: 'removed' | 'changed'
}
export type ProgramFlowNode = Node<ProgramNodeData, 'program' | 'schema'>
export type NoteFlowNode = Node<{ note: CanvasNote }, 'note'>
export type GroupFlowNode = Node<{ group: CanvasGroup }, 'programGroup'>
export type CanvasFlowNode = ProgramFlowNode | NoteFlowNode | GroupFlowNode

export type ProgramEdgeData = {
  /** The shape class of what runs along it, which tints the wire. */
  shape?: PortClass
  undetermined?: boolean
  ghost?: boolean
  removed?: boolean
}

/** Handle ids carry the direction: a port id can name both an input and an output. */
export const inputHandle = (port: string) => `in:${port}`
export const outputHandle = (port: string) => `out:${port}`
export const portOfHandle = (handle: string | null | undefined) =>
  handle?.replace(/^(in|out):/, '') ?? ''

export const NODE_WIDTH = 248
const HEADER = 44
const ROW = 28
const PADDING = 12

export const nodeHeight = (node: ProgramNode) =>
  HEADER + PADDING + Math.max(1, node.inputs.length + node.outputs.length) * ROW

export type PortClass = 'table' | 'graph' | 'value' | 'record' | 'other'

/**
 * The spec's five port shape classes. A shape's class comes from its name and
 * its contract; the color and glyph for each class live with the node view.
 */
export function portClass(shapeId: string, tabular = false): PortClass {
  if (tabular || /tabular|variables|columns|table/i.test(shapeId))
    return 'table'
  if (/graph|node_scores|node-set|neighborhood/i.test(shapeId)) return 'graph'
  if (/scalar|value|number|bool|score/i.test(shapeId)) return 'value'
  if (/record|snapshot|event|document|item|message/i.test(shapeId))
    return 'record'
  return 'other'
}

/** Five low-chroma classes; the glyph on a port or wire carries the same distinction. */
export const PORT_COLOR: Record<PortClass, string> = {
  table: 'oklch(0.68 0.06 250)',
  graph: 'oklch(0.68 0.06 165)',
  value: 'oklch(0.72 0.06 85)',
  record: 'oklch(0.68 0.06 25)',
  other: 'oklch(0.68 0.01 260)',
}

/**
 * Rows on the node instead of a plain port list: a port with a tabular contract lists
 * its columns, a source lists the table it reads, and a compound lists what it stacks.
 */
export const showsSchema = (node: ProgramNode) =>
  node.kind === 'compound' ||
  (node.kind === 'source' && node.selector.plane === 'tenant_graph') ||
  [...node.inputs, ...node.outputs].some((port) => port.column_contract)

/** Programs run left to right, with room between columns for their wires. */
export const PROGRAM_LAYOUT: LayoutPolicy = {
  algorithm: 'layered',
  direction: 'RIGHT',
  spacing: { node: 48, layers: 96 },
}

const box = (node: ProgramNode): LayoutLeaf => ({
  id: node.id,
  width: NODE_WIDTH,
  height: nodeHeight(node),
})

const wires = (program: ProgramDefinition) =>
  program.edges.map((edge) => ({
    id: edge.id,
    source: edge.from_node,
    target: edge.to_node,
  }))

/** Everything already on the canvas that a new node must not land on: groups and notes. */
const boxesOf = (
  layout: ProgramLayout | null | undefined,
): Array<Box & { id: string }> => [
  ...(layout?.groups ?? []),
  ...(layout?.notes ?? []),
]

/**
 * Place nodes that have no saved position; saved ones stay where people left
 * them. A new node goes beside a saved node it is wired to, where ELK would
 * put it relative to that node, moved down until it is clear of every node,
 * group and note on the canvas; one wired to nothing saved goes below them.
 */
export async function layoutProgram(
  program: ProgramDefinition,
  layout: ProgramLayout | null,
): Promise<Record<string, Point>> {
  const saved = layout?.nodes ?? {}
  if (program.nodes.every((node) => saved[node.id])) return saved
  const fresh = await layOut(
    { nodes: program.nodes.map(box), edges: wires(program) },
    PROGRAM_LAYOUT,
  )
  // A group member is saved relative to its group; `arrange` places everything
  // in the canvas's own coordinates.
  const groupOf = new Map(
    (layout?.groups ?? []).flatMap((group) =>
      group.members.map((member) => [member, group] as const),
    ),
  )
  const onCanvas = (id: string, at: Point) => {
    const group = groupOf.get(id)
    return group ? { x: at.x + group.x, y: at.y + group.y } : at
  }
  const fixed = boxesOf(layout)
  const previous: Record<string, Point> = {}
  for (const node of program.nodes) {
    const at = saved[node.id]
    if (at) previous[node.id] = onCanvas(node.id, at)
  }
  for (const item of fixed) previous[item.id] = { x: item.x, y: item.y }
  const placed = arrange({
    graph: {
      nodes: [
        ...program.nodes.map(box),
        ...fixed.map(({ id, width, height }) => ({ id, width, height })),
      ],
      edges: wires(program),
    },
    fresh: fresh.positions,
    previous,
    pinned: {},
    relayout: new Set(),
    across: true,
  })
  return Object.fromEntries(
    program.nodes.map((node) => {
      const at = saved[node.id]
      if (at) return [node.id, at]
      const group = groupOf.get(node.id)
      const place = placed[node.id]!
      return [
        node.id,
        group ? { x: place.x - group.x, y: place.y - group.y } : place,
      ]
    }),
  )
}

/** Everything a muted node feeds, through any path. Bypassed nodes pass values, so they do not count. */
export function mutedDownstream(program: ProgramDefinition) {
  const nodes = new Set<string>()
  const edges = new Set<string>()
  const pending = program.nodes
    .filter((node) => node.muted)
    .map((node) => node.id)
  const muted = new Set(pending)
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const edge of program.edges) {
      if (edge.from_node !== next) continue
      edges.add(edge.id)
      if (nodes.has(edge.to_node) || muted.has(edge.to_node)) continue
      nodes.add(edge.to_node)
      pending.push(edge.to_node)
    }
  }
  return { nodes, edges }
}

export function toFlowNodes(
  program: ProgramDefinition,
  positions: Record<string, { x: number; y: number }>,
  liveness: Record<string, ProcessLiveness>,
  extras: Record<string, Partial<ProgramNodeData>> = {},
): Array<ProgramFlowNode> {
  const downstream = mutedDownstream(program)
  return program.nodes.map((node) => ({
    id: node.id,
    type: showsSchema(node) ? 'schema' : 'program',
    position: positions[node.id] ?? { x: 0, y: 0 },
    width: NODE_WIDTH,
    data: {
      node,
      liveness: liveness[node.id] ?? 'dormant',
      undetermined: downstream.nodes.has(node.id),
      connected: [
        ...program.edges
          .filter((edge) => edge.to_node === node.id)
          .map((edge) => `in:${edge.to_port}`),
        ...program.edges
          .filter((edge) => edge.from_node === node.id)
          .map((edge) => `out:${edge.from_port}`),
      ],
      ...extras[node.id],
    },
  }))
}

export function toFlowEdges(
  program: ProgramDefinition,
  liveness: Record<string, ProcessLiveness>,
): Array<Edge> {
  const downstream = mutedDownstream(program)
  const shapeOf = (edge: ProgramEdge) => {
    const port = program.nodes
      .find((node) => node.id === edge.from_node)
      ?.outputs.find((candidate) => candidate.id === edge.from_port)
    return port && portClass(port.shape_id, Boolean(port.column_contract))
  }
  return program.edges.map((edge) => ({
    id: edge.id,
    source: edge.from_node,
    sourceHandle: outputHandle(edge.from_port),
    target: edge.to_node,
    targetHandle: inputHandle(edge.to_port),
    type: 'program',
    animated: liveness[edge.from_node] === 'running',
    data: { undetermined: downstream.edges.has(edge.id), shape: shapeOf(edge) },
  }))
}

/** Groups, then notes, then the program: xyflow needs a parent before its children. */
export function toCanvasNodes(
  program: ProgramDefinition,
  layout: ProgramLayout,
  positions: Record<string, { x: number; y: number }>,
  liveness: Record<string, ProcessLiveness>,
  extras: Record<string, Partial<ProgramNodeData>> = {},
): Array<CanvasFlowNode> {
  const groups = layout.groups ?? []
  const parents = new Map(
    groups.flatMap((group) =>
      group.members.map((member) => [member, group.id] as const),
    ),
  )
  return [
    ...groups.map((group): GroupFlowNode => ({
      id: group.id,
      type: 'programGroup',
      position: { x: group.x, y: group.y },
      width: group.width,
      height: group.height,
      deletable: false,
      data: { group },
    })),
    ...(layout.notes ?? []).map((note): NoteFlowNode => ({
      id: note.id,
      type: 'note',
      position: { x: note.x, y: note.y },
      width: note.width,
      height: note.height,
      data: { note },
    })),
    ...toFlowNodes(program, positions, liveness, extras).map((node) => {
      const parentId = parents.get(node.id)
      const collapsed = layout.collapsed?.includes(node.id)
      return {
        ...node,
        ...(parentId ? { parentId } : {}),
        data: { ...node.data, collapsed },
      }
    }),
  ]
}

/** Nodes and edges a proposal would add, positioned clear of what is on the canvas. */
export function ghostFlow(
  pending: PendingProposal,
  places: Record<string, { x: number; y: number }>,
) {
  const proposed = pending.proposal.proposed_program
  const addedNodes = new Set(pending.diff?.node_ids_only_in_right)
  const addedEdges = new Set(pending.diff?.edge_ids_only_in_right)
  const nodes = toFlowNodes(proposed, places, {})
    .filter((node) => addedNodes.has(node.id))
    .map((node): ProgramFlowNode => ({
      ...node,
      draggable: false,
      selectable: false,
      connectable: false,
      deletable: false,
      data: { ...node.data, ghost: true },
    }))
  const edges = toFlowEdges(proposed, {})
    .filter((edge) => addedEdges.has(edge.id))
    .map((edge): Edge => ({
      ...edge,
      selectable: false,
      deletable: false,
      data: { ghost: true },
    }))
  return { nodes, edges }
}

/** Places a proposal's new nodes below everything already on the canvas: its nodes, groups and notes. */
export async function ghostPlaces(
  proposed: ProgramDefinition,
  positions: Record<string, { x: number; y: number }>,
  layout?: ProgramLayout,
) {
  const placed = await layoutProgram(proposed, null)
  const fresh = proposed.nodes.filter((node) => !positions[node.id])
  if (fresh.length === 0) return {}
  // A group's members are inside it, and positioned relative to it.
  const grouped = new Set(layout?.groups?.flatMap((group) => group.members))
  const floor = Math.max(
    0,
    ...proposed.nodes.flatMap((node) => {
      const at = positions[node.id]
      return at && !grouped.has(node.id) ? [at.y + nodeHeight(node)] : []
    }),
    ...boxesOf(layout).map((item) => item.y + item.height),
  )
  const top = Math.min(...fresh.map((node) => placed[node.id]?.y ?? 0))
  return Object.fromEntries(
    fresh.map((node) => {
      const at = placed[node.id] ?? { x: 0, y: 0 }
      return [node.id, { x: at.x, y: at.y - top + floor + 96 }]
    }),
  )
}

/** The fields a proposal changes on a node, by name; the diff itself only names the node. */
export function changedFields(before: ProgramNode, after: ProgramNode) {
  const left = before as unknown as Record<string, unknown>
  const right = after as unknown as Record<string, unknown>
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(
    (key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]),
  )
}

const distance = (a: Waypoint, b: Waypoint) => Math.hypot(a.x - b.x, a.y - b.y)

/** A new waypoint goes on the leg of the route it lengthens least. */
export function insertWaypoint(
  route: Array<Waypoint>,
  from: Waypoint,
  to: Waypoint,
  at: Waypoint,
): Array<Waypoint> {
  const stops = [from, ...route, to]
  let best = 0
  let bestCost = Number.POSITIVE_INFINITY
  for (let leg = 0; leg < stops.length - 1; leg += 1) {
    const start = stops[leg]!
    const end = stops[leg + 1]!
    const cost = distance(start, at) + distance(at, end) - distance(start, end)
    if (cost < bestCost) {
      best = leg
      bestCost = cost
    }
  }
  return [...route.slice(0, best), at, ...route.slice(best)]
}

/** Room for a group's label above its members, and a margin around them. */
const GROUP_INSETS = { top: 48, left: 24, bottom: 24, right: 24 }

/**
 * The relayout command: ELK lays out everything again, groups as compound nodes
 * so members stay inside them. Waypoints belong to the old routes, so they go.
 */
export async function relayoutProgram(
  program: ProgramDefinition,
  layout: ProgramLayout,
) {
  const groups = layout.groups ?? []
  const grouped = new Set(groups.flatMap((group) => group.members))
  const laid = await layOut(
    {
      nodes: [
        ...groups.map((group) => ({
          id: group.id,
          members: program.nodes
            .filter((node) => group.members.includes(node.id))
            .map(box),
        })),
        ...program.nodes.filter((node) => !grouped.has(node.id)).map(box),
      ],
      edges: wires(program),
    },
    { ...PROGRAM_LAYOUT, groupPadding: GROUP_INSETS },
  )
  const placedGroups: Array<CanvasGroup> = groups.flatMap((group) => {
    const at = laid.groups[group.id]
    return at ? [{ ...group, ...at }] : []
  })
  return { positions: laid.positions, groups: placedGroups }
}

/** The node the palette inserts for a catalog entry, with the fields its kind requires. */
export function nodeIdFor(program: ProgramDefinition, base: string) {
  const slug = base.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  const taken = new Set(program.nodes.map((node) => node.id))
  if (!taken.has(slug)) return slug
  let suffix = 2
  while (taken.has(`${slug}-${suffix}`)) suffix += 1
  return `${slug}-${suffix}`
}
