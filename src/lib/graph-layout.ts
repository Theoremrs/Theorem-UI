// SOURCING: elkjs (elk.bundled: layered with its orthogonal edge router, mrtree, stress; compound nodes laid out with hierarchyHandling INCLUDE_CHILDREN; json.edgeCoords ROOT so every route is in the graph's own coordinates), the one layout engine for the node graphs drawn on React Flow: programs (lib/program/flow), plans (lib/theorem/plans) and the session graph (lib/theorem/session-graph-layout) each keep a policy here. ELK only proposes places; `arrange` decides which nodes may move, so what is on screen stays put (docs/plans/projects-sidebar-and-session-graph.md §9, Layout stability). The rounded corners of a route are React Flow's smooth step bend (@xyflow/system getSmoothStepPath: a quadratic curve through each corner), over a route with any number of bends.
import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkNode } from 'elkjs/lib/elk-api'

export type Point = { x: number; y: number }
export type Size = { width: number; height: number }
export type Box = Point & Size
/** Which way a graph runs: left to right, or top to bottom. */
export type Direction = 'RIGHT' | 'DOWN'

/** A node at the size it is drawn. */
export type LayoutLeaf = Size & { id: string }
/** A group, sized by ELK around its members, which are placed relative to it. */
export type LayoutGroup = { id: string; members: readonly LayoutLeaf[] }
export type LayoutNode = LayoutLeaf | LayoutGroup
export type LayoutEdge = { id: string; source: string; target: string }

export type Insets = {
  top: number
  left: number
  bottom: number
  right: number
}

/** How one kind of graph is laid out. Each graph keeps its own beside its data. */
export type LayoutPolicy = {
  algorithm: 'layered' | 'mrtree' | 'stress'
  direction?: Direction
  spacing: {
    /** Between nodes side by side. */
    node: number
    /** Between layers (layered). */
    layers?: number
    /** Between parallel edge segments. */
    edges?: number
    /** Between an edge and a node it passes. */
    edgeNode?: number
    /** Between parallel edge segments where edges cross from one layer to the next. */
    edgesBetweenLayers?: number
    /** Between an edge and a node where the edge crosses between layers. */
    edgeNodeBetweenLayers?: number
  }
  /** Room around the whole graph; ELK's own (12) when left out. */
  padding?: number
  /** Room inside each group, around its members. */
  groupPadding?: Insets
  /** Nodes side by side keep the order given, so a refresh does not reshuffle them. */
  keepOrder?: boolean
  /** Stress: the length an edge would like to be. */
  edgeLength?: number
}

export type Layout = {
  direction: Direction | undefined
  /** Each node's top left; a group member's is relative to its group, as React Flow places a child. */
  positions: Record<string, Point>
  /** Each group's box. */
  groups: Record<string, Box>
  /** Each edge as the router drew it, from source to target, in the graph's coordinates. */
  routes: Record<string, Point[]>
  width: number
  height: number
}

/** Which way the policy runs the graph; stress has no direction. */
const directionOf = ({ algorithm, direction }: LayoutPolicy) =>
  algorithm === 'stress'
    ? undefined
    : (direction ?? (algorithm === 'mrtree' ? 'DOWN' : 'RIGHT'))

const insets = ({ top, left, bottom, right }: Insets) =>
  `[top=${top},left=${left},bottom=${bottom},right=${right}]`

function options(policy: LayoutPolicy, grouped: boolean) {
  const { algorithm, spacing, padding, keepOrder } = policy
  const out: Record<string, string> = {
    'elk.algorithm': algorithm,
    'elk.spacing.nodeNode': String(spacing.node),
    'elk.json.edgeCoords': 'ROOT',
  }
  if (padding !== undefined)
    out['elk.padding'] = insets({
      top: padding,
      left: padding,
      bottom: padding,
      right: padding,
    })
  if (algorithm === 'stress') {
    if (policy.edgeLength !== undefined)
      out['elk.stress.desiredEdgeLength'] = String(policy.edgeLength)
    return out
  }
  out['elk.direction'] = directionOf(policy)!
  if (algorithm === 'mrtree') return out
  out['elk.edgeRouting'] = 'ORTHOGONAL'
  if (grouped) out['elk.hierarchyHandling'] = 'INCLUDE_CHILDREN'
  const layered: Array<[string, number | undefined]> = [
    ['elk.layered.spacing.nodeNodeBetweenLayers', spacing.layers],
    [
      'elk.layered.spacing.edgeNodeBetweenLayers',
      spacing.edgeNodeBetweenLayers,
    ],
    ['elk.layered.spacing.edgeEdgeBetweenLayers', spacing.edgesBetweenLayers],
    ['elk.spacing.edgeEdge', spacing.edges],
    ['elk.spacing.edgeNode', spacing.edgeNode],
  ]
  for (const [key, value] of layered)
    if (value !== undefined) out[key] = String(value)
  if (keepOrder)
    out['elk.layered.considerModelOrder.strategy'] = 'NODES_AND_EDGES'
  return out
}

const isGroup = (node: LayoutNode): node is LayoutGroup => 'members' in node

const elk = new ELK()

/**
 * ELK's layout of the whole graph, in the order given. Edges whose ends are
 * not in the graph are left out.
 */
export async function layout(
  graph: {
    nodes: readonly LayoutNode[]
    edges: readonly LayoutEdge[]
  },
  policy: LayoutPolicy,
): Promise<Layout> {
  const ids = new Set(
    graph.nodes.flatMap((node) =>
      isGroup(node) ? node.members.map((member) => member.id) : [node.id],
    ),
  )
  const grouped = graph.nodes.some(isGroup)
  const leaf = ({ id, width, height }: LayoutLeaf): ElkNode => ({
    id,
    width,
    height,
  })
  const input: ElkNode = {
    id: 'graph',
    layoutOptions: options(policy, grouped),
    children: graph.nodes.map((node) =>
      isGroup(node)
        ? {
            id: node.id,
            ...(policy.groupPadding
              ? {
                  layoutOptions: { 'elk.padding': insets(policy.groupPadding) },
                }
              : {}),
            children: node.members.map(leaf),
          }
        : leaf(node),
    ),
    edges: graph.edges
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      .map((edge) => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
      })),
  }
  const laid = await elk.layout(input)
  const grouping = new Set(graph.nodes.filter(isGroup).map((node) => node.id))
  const positions: Record<string, Point> = {}
  const groups: Record<string, Box> = {}
  for (const child of laid.children ?? []) {
    const at = { x: child.x ?? 0, y: child.y ?? 0 }
    if (grouping.has(child.id)) {
      groups[child.id] = {
        ...at,
        width: child.width ?? 0,
        height: child.height ?? 0,
      }
      for (const member of child.children ?? [])
        positions[member.id] = { x: member.x ?? 0, y: member.y ?? 0 }
    } else positions[child.id] = at
  }
  const routes: Record<string, Point[]> = {}
  for (const edge of laid.edges ?? []) {
    const section = edge.sections?.[0]
    if (section)
      routes[edge.id] = [
        section.startPoint,
        ...(section.bendPoints ?? []),
        section.endPoint,
      ]
  }
  return {
    direction: directionOf(policy),
    positions,
    groups,
    routes,
    width: laid.width ?? 0,
    height: laid.height ?? 0,
  }
}

/** Clear space kept between nodes that are moved out of each other's way. */
const GAP = 20

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
 * Where every node goes, given ELK's layout of the whole graph:
 *
 * - A node the person dragged stays where they left it.
 * - A node already on screen stays where it is, unless it is in `relayout`.
 * - The nodes in `relayout` take ELK's places as one block, anchored where
 *   they were, so a re-formed part stays where it was on the canvas.
 * - A new node goes beside the node it hangs from (its parent, else its
 *   child), where ELK puts it relative to that node; a new group with nothing
 *   on screen to hang from goes after everything already there.
 *
 * A node that would land on another is moved along the layers (down when the
 * graph runs across, right when it runs down) until it is clear. Every place
 * is in one coordinate space: the caller turns a grouped node's place into
 * the canvas's before, and back after. Pure: the same inputs give the same
 * places.
 */
export function arrange({
  graph,
  fresh,
  previous,
  pinned,
  relayout,
  across,
}: {
  graph: {
    nodes: readonly LayoutLeaf[]
    edges: readonly LayoutEdge[]
  }
  /** ELK's places for the nodes it laid out. */
  fresh: Readonly<Record<string, Point>>
  /** Where nodes were last placed, including ones hidden since. */
  previous: Readonly<Record<string, Point>>
  /** Where the person dragged nodes to. */
  pinned: Readonly<Record<string, Point>>
  relayout: ReadonlySet<string>
  /** The graph runs across (RIGHT) rather than down. */
  across: boolean
}): Record<string, Point> {
  const size = new Map(graph.nodes.map((n) => [n.id, n]))
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

  const ids = graph.nodes.map((n) => n.id)
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
  for (const edge of graph.edges) {
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
      ].find((other) => other in placed && other in fresh)
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

/** An edge as the router drew it, and where its two ends were placed when it was. */
export type Route = { points: Point[]; from: Point; to: Point }

/**
 * The routes that still hold once the nodes are placed: an edge whose two
 * ends moved the same way from ELK's places keeps ELK's route, moved with
 * them. One whose ends moved apart (a node dragged, or anchored beside
 * another) has none, and is drawn between its handles.
 */
export function heldRoutes({
  edges,
  routes,
  fresh,
  placed,
}: {
  edges: readonly LayoutEdge[]
  routes: Readonly<Record<string, Point[]>>
  fresh: Readonly<Record<string, Point>>
  placed: Readonly<Record<string, Point>>
}): Record<string, Route> {
  const held: Record<string, Route> = {}
  for (const { id, source, target } of edges) {
    const points = routes[id]
    const [a, b, from, to] = [
      fresh[source],
      fresh[target],
      placed[source],
      placed[target],
    ]
    if (!points || !a || !b || !from || !to) continue
    const dx = from.x - a.x
    const dy = from.y - a.y
    if (!near({ x: to.x - b.x, y: to.y - b.y }, { x: dx, y: dy })) continue
    held[id] = {
      points: points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      from,
      to,
    }
  }
  return held
}

/** Within half a pixel: the same place on screen. */
export const near = (a: Point | undefined, b: Point | undefined) =>
  a !== undefined &&
  b !== undefined &&
  Math.abs(a.x - b.x) < 0.5 &&
  Math.abs(a.y - b.y) < 0.5

/** A route holds while both its ends are drawn where they were placed when it was routed. */
export const routeHolds = (
  route: Route | undefined,
  from: Point | undefined,
  to: Point | undefined,
): route is Route =>
  route !== undefined && near(from, route.from) && near(to, route.to)

const round = (n: number) => Math.round(n * 100) / 100

/**
 * An SVG path along a route, each corner rounded to at most `radius` (and to
 * no more than half of either leg, so short legs stay straight).
 */
export function routePath(points: readonly Point[], radius = 0): string {
  if (points.length === 0) return ''
  const at = ({ x, y }: Point) => `${round(x)},${round(y)}`
  let path = `M${at(points[0]!)}`
  for (let i = 1; i < points.length - 1; i++) {
    const [before, bend, after] = [points[i - 1]!, points[i]!, points[i + 1]!]
    const into = Math.hypot(bend.x - before.x, bend.y - before.y)
    const out = Math.hypot(after.x - bend.x, after.y - bend.y)
    const r = Math.min(radius, into / 2, out / 2)
    if (r <= 0) {
      path += `L${at(bend)}`
      continue
    }
    const toward = (from: Point, to: Point, length: number, by: number) => ({
      x: from.x + ((to.x - from.x) / length) * by,
      y: from.y + ((to.y - from.y) / length) * by,
    })
    path += `L${at(toward(bend, before, into, r))}Q${at(bend)} ${at(toward(bend, after, out, r))}`
  }
  return `${path}L${at(points[points.length - 1]!)}`
}
