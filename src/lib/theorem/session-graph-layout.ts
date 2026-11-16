// SOURCING: lib/graph-layout (the shared ELK layout and `arrange`), with the session graph's policy: layered, the main at the left (or top) and forks running out from it, keeping the projection's node order so a refresh does not reshuffle the graph. What a layout depends on, and which nodes a re-rooted tree moves, are decided here; where everything else goes is `arrange`'s (docs/plans/projects-sidebar-and-session-graph.md §9, Layout stability).
import type { Direction, LayoutPolicy, Size } from '@/lib/graph-layout'
import type { GraphNode, ProjectedGraph, Relation } from './session-graph'

/** The session graph's layout: each fork one layer out from the chat it came from. */
export const sessionLayout = (direction: Direction): LayoutPolicy => ({
  algorithm: 'layered',
  direction,
  padding: 16,
  spacing: { node: 20, layers: 56, edgeNodeBetweenLayers: 16, edges: 12 },
  keepOrder: true,
})

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
