// SOURCING: elkjs (elk.bundled, as lib/theorem/plans and lib/program/flow load it): layered for the session graph (the main at the left, forks running right), with mrtree and stress kept for tree and related layouts, each keeping the projection's node order so a refresh does not reshuffle the graph. ELK is the one layout engine here; the node renderer does not depend on it. Which nodes ELK may move is decided here, not by ELK: a person keeps their mental map of the graph only if what is on screen stays put (docs/plans/projects-sidebar-and-session-graph.md §9, Layout stability).
import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkNode } from 'elkjs/lib/elk-api'
import type { GraphNode, ProjectedGraph, Relation } from './session-graph'

/** How a graph is laid out: by ELK algorithm and direction. */
export type LensLayout = {
  algorithm: 'layered' | 'mrtree' | 'stress'
  direction?: 'RIGHT' | 'DOWN'
}

export type Point = { x: number; y: number }
type Size = { width: number; height: number }

export type GraphLayout = {
  positions: Record<string, Point>
  /** Each edge as the router drew it, source to target. */
  routes: Record<string, Point[]>
  width: number
  height: number
}

const elk = new ELK()

function options({ algorithm, direction }: LensLayout): Record<string, string> {
  const common = {
    'elk.algorithm': algorithm,
    'elk.padding': '[top=16,left=16,bottom=16,right=16]',
    'elk.spacing.nodeNode': '20',
  }
  if (algorithm === 'stress')
    return { ...common, 'elk.stress.desiredEdgeLength': '160' }
  if (algorithm === 'mrtree')
    return { ...common, 'elk.direction': direction ?? 'DOWN' }
  return {
    ...common,
    'elk.direction': direction ?? 'RIGHT',
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.layered.spacing.nodeNodeBetweenLayers': '56',
    'elk.layered.spacing.edgeNodeBetweenLayers': '16',
    'elk.spacing.edgeEdge': '12',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  }
}

/** Places the nodes at the sizes they measured and routes the edges between them. */
export async function layoutGraph(
  nodes: readonly { id: string }[],
  edges: readonly { id: string; source: string; target: string }[],
  sizes: Readonly<Record<string, Size>>,
  layout: LensLayout,
): Promise<GraphLayout> {
  const ids = new Set(nodes.map((node) => node.id))
  const input: ElkNode = {
    id: 'sessions',
    layoutOptions: options(layout),
    children: nodes.map((node) => ({
      id: node.id,
      ...(sizes[node.id] ?? { width: 220, height: 44 }),
    })),
    edges: edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  }
  const graph = await elk.layout(input)
  const positions: Record<string, Point> = {}
  for (const child of graph.children ?? [])
    positions[child.id] = { x: child.x ?? 0, y: child.y ?? 0 }
  const routes: Record<string, Point[]> = {}
  for (const edge of graph.edges ?? []) {
    const section = edge.sections?.[0]
    if (section)
      routes[edge.id] = [
        section.startPoint,
        ...(section.bendPoints ?? []),
        section.endPoint,
      ]
  }
  return {
    positions,
    routes,
    width: graph.width ?? 0,
    height: graph.height ?? 0,
  }
}

/**
 * What a layout depends on, and nothing else: the nodes at their sizes, in
 * the projection's order, the edges ELK lays out, and each tree's main.
 * Status, titles and times are left out, so a refetch that changes only those
 * gives the same shape and the graph is not laid out again.
 */
export type LayoutShape = {
  nodes: readonly { id: string; width: number; height: number }[]
  edges: readonly { id: string; source: string; target: string }[]
  /** Each drawn tree's main, by node id. */
  mains: Readonly<Record<string, string>>
}

/**
 * The relations that shape the layout: each runs one column out from the chat
 * it starts at. Messages pass between any two chats of a tree, so they are
 * drawn over the layout, not allowed to pull a fork out of its column.
 */
export const LAID_OUT: ReadonlySet<Relation> = new Set([
  'fork',
  'continued',
  'made',
  'used',
])

/** The shape a projected graph is laid out by, with each node at its drawn size. */
export function layoutShape(
  graph: ProjectedGraph,
  sizeOf: (node: GraphNode) => Size,
): LayoutShape {
  const mains: Record<string, string> = {}
  for (const node of graph.nodes)
    if (node.kind === 'session' && node.isMain && node.treeId)
      mains[node.treeId] = node.id
  return {
    nodes: graph.nodes.map((node) => ({ id: node.id, ...sizeOf(node) })),
    edges: graph.edges
      .filter((edge) => LAID_OUT.has(edge.relation))
      .map(({ id, source, target }) => ({ id, source, target })),
    mains,
  }
}

/**
 * The nodes a re-rooted tree re-forms: when a tree drawn before has a new
 * main, everything joined to it moves to where ELK now puts it. Nothing else
 * that was on screen moves on its own.
 */
export function rerooted(before: LayoutShape, after: LayoutShape): Set<string> {
  const moving = new Set<string>()
  const neighbours = new Map<string, string[]>()
  for (const edge of after.edges) {
    neighbours.set(edge.source, [
      ...(neighbours.get(edge.source) ?? []),
      edge.target,
    ])
    neighbours.set(edge.target, [
      ...(neighbours.get(edge.target) ?? []),
      edge.source,
    ])
  }
  for (const [tree, main] of Object.entries(after.mains)) {
    const was = before.mains[tree]
    if (was === undefined || was === main) continue
    const queue = [main]
    moving.add(main)
    while (queue.length) {
      const at = queue.shift()!
      for (const next of neighbours.get(at) ?? [])
        if (!moving.has(next)) {
          moving.add(next)
          queue.push(next)
        }
    }
  }
  return moving
}

/** Clear space kept between nodes that are moved out of each other's way. */
const GAP = 20

type Box = Point & Size

// Closer than half the gap counts as touching; ELK itself keeps a full gap.
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width + GAP / 2 &&
  b.x < a.x + a.width + GAP / 2 &&
  a.y < b.y + b.height + GAP / 2 &&
  b.y < a.y + a.height + GAP / 2

const corner = (points: readonly Point[]) => ({
  x: Math.min(...points.map((p) => p.x)),
  y: Math.min(...points.map((p) => p.y)),
})

/**
 * Where every node in the shape goes, given ELK's layout of the whole shape:
 *
 * - A node the person dragged stays where they left it.
 * - A node already on screen stays where it is, unless it is in `relayout`.
 * - The nodes in `relayout` take ELK's places as one block, anchored where
 *   they were, so a re-formed tree stays where it was on the canvas.
 * - A new node goes beside the node it hangs from (its parent, else its
 *   child), where ELK puts it relative to that node; a new group with nothing
 *   on screen to hang from goes after everything already there.
 *
 * A node that would land on another is moved along the layers (down when the
 * graph runs across, right when it runs down) until it is clear. Pure: the
 * same inputs give the same places.
 */
export function arrange({
  shape,
  fresh,
  previous,
  pinned,
  relayout,
  across,
}: {
  shape: LayoutShape
  /** ELK's places for every node in the shape. */
  fresh: Readonly<Record<string, Point>>
  /** Where nodes were last placed, including ones hidden since. */
  previous: Readonly<Record<string, Point>>
  /** Where the person dragged nodes to. */
  pinned: Readonly<Record<string, Point>>
  relayout: ReadonlySet<string>
  /** The graph runs across (RIGHT) rather than down. */
  across: boolean
}): Record<string, Point> {
  const size = new Map(shape.nodes.map((n) => [n.id, n]))
  const placed: Record<string, Point> = {}
  const taken: Box[] = []
  const put = (id: string, at: Point) => {
    placed[id] = at
    const { width, height } = size.get(id)!
    taken.push({ ...at, width, height })
  }
  const clear = (id: string, at: Point): Point => {
    const { width, height } = size.get(id)!
    let box = { ...at, width, height }
    // Each step moves past one node, so this ends within one pass of them.
    for (let step = 0; step <= taken.length; step++) {
      const hit = taken.find((other) => overlaps(box, other))
      if (!hit) break
      box = across
        ? { ...box, y: hit.y + hit.height + GAP }
        : { ...box, x: hit.x + hit.width + GAP }
    }
    return { x: box.x, y: box.y }
  }
  const freshAt = (id: string) => fresh[id] ?? { x: 0, y: 0 }

  const ids = shape.nodes.map((n) => n.id)
  for (const id of ids) if (pinned[id]) put(id, pinned[id])
  for (const id of ids)
    if (!(id in placed) && previous[id] && !relayout.has(id))
      put(id, previous[id])

  const block = ids.filter((id) => !(id in placed) && relayout.has(id))
  const was = block.flatMap((id) => (previous[id] ? [id] : []))
  const shift = was.length
    ? (() => {
        const from = corner(was.map((id) => previous[id]!))
        const to = corner(was.map(freshAt))
        return { x: from.x - to.x, y: from.y - to.y }
      })()
    : { x: 0, y: 0 }
  for (const id of block) {
    const at = freshAt(id)
    put(id, clear(id, { x: at.x + shift.x, y: at.y + shift.y }))
  }

  let waiting = ids.filter((id) => !(id in placed))
  const parents = new Map<string, string[]>()
  const children = new Map<string, string[]>()
  for (const edge of shape.edges) {
    parents.set(edge.target, [...(parents.get(edge.target) ?? []), edge.source])
    children.set(edge.source, [
      ...(children.get(edge.source) ?? []),
      edge.target,
    ])
  }
  for (;;) {
    const before = waiting.length
    waiting = waiting.filter((id) => {
      const anchor = [
        ...(parents.get(id) ?? []),
        ...(children.get(id) ?? []),
      ].find((other) => other in placed)
      if (anchor === undefined) return true
      const own = freshAt(id)
      const theirs = freshAt(anchor)
      put(
        id,
        clear(id, {
          x: placed[anchor]!.x + own.x - theirs.x,
          y: placed[anchor]!.y + own.y - theirs.y,
        }),
      )
      return false
    })
    if (waiting.length === before) break
  }
  if (waiting.length) {
    // Nothing on screen to hang from: after everything, keeping ELK's shape.
    const start = corner(waiting.map(freshAt))
    const end = taken.length
      ? across
        ? {
            x: Math.min(...taken.map((b) => b.x)),
            y: Math.max(...taken.map((b) => b.y + b.height)) + GAP * 2,
          }
        : {
            x: Math.max(...taken.map((b) => b.x + b.width)) + GAP * 2,
            y: Math.min(...taken.map((b) => b.y)),
          }
      : start
    for (const id of waiting) {
      const at = freshAt(id)
      put(
        id,
        clear(id, { x: at.x - start.x + end.x, y: at.y - start.y + end.y }),
      )
    }
  }
  return placed
}
