// SOURCING: the flow-graph element (vendored from assistant-ui), zod (reads
// the graph the agent wrote) and the layout function assistant-ui's
// flow-graph docs give for the element: a node sits one column past the
// furthest node it depends on, rows fill in order. Here the columns come from
// depth rather than list order, so a node may be listed before what it
// depends on, and each column is centred on the tallest.
//
// A DAG the agent wrote, as a graph artifact or through `ui.present`, drawn
// as it is: no card, title or ground around it.
import { useMemo } from 'react'
import type { ComponentProps } from 'react'
import { z } from 'zod'
import { cn } from '@/lib/utils'
import { FlowGraph } from './flow-graph'
import type { FlowEdge, FlowNode } from './flow-graph'

/** One node: its id, its label (the id when it has none) and the ids it follows. */
export const GraphNodeSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  state: z.enum(['done', 'active', 'pending']).optional(),
})
const GraphSchema = z.object({ nodes: z.array(GraphNodeSchema).min(1) })
export type GraphSource = z.infer<typeof GraphSchema>

/** The graph `value` holds, or undefined when it is not one. */
export function graphOf(value: unknown): GraphSource | undefined {
  const parsed = GraphSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** The graph a JSON source holds, or undefined when it is not one. */
export function readGraph(content: string): GraphSource | undefined {
  try {
    return graphOf(JSON.parse(content))
  } catch {
    return undefined
  }
}

/** Columns, rows and edges for the flow-graph element. */
export function layout(graph: GraphSource): {
  nodes: FlowNode[]
  edges: FlowEdge[]
} {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const columns = new Map<string, number>()
  // An id no node has, or one already on the path (a cycle), adds no column.
  const columnOf = (id: string, path: ReadonlySet<string>): number => {
    const known = columns.get(id)
    if (known !== undefined) return known
    const node = byId.get(id)
    if (!node || path.has(id)) return -1
    const next = new Set(path).add(id)
    const column =
      Math.max(-1, ...(node.dependsOn ?? []).map((d) => columnOf(d, next))) + 1
    columns.set(id, column)
    return column
  }
  const rowsIn = new Map<number, number>()
  const placed = graph.nodes.map((node) => {
    const column = columnOf(node.id, new Set())
    const row = rowsIn.get(column) ?? 0
    rowsIn.set(column, row + 1)
    return {
      id: node.id,
      label: node.label ?? node.id,
      column,
      row,
      state: node.state ?? ('done' as const),
    }
  })
  const tallest = Math.max(...rowsIn.values())
  return {
    nodes: placed.map((node) => ({
      ...node,
      row: node.row + (tallest - (rowsIn.get(node.column) ?? 0)) / 2,
    })),
    edges: graph.nodes.flatMap((node) =>
      (node.dependsOn ?? []).map((from) => ({ from, to: node.id })),
    ),
  }
}

/** The flow graph of `graph`, with the element's paper taken off. */
export function DependencyGraph({
  graph,
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'children'> & { graph: GraphSource }) {
  const { nodes, edges } = useMemo(() => layout(graph), [graph])
  return (
    <FlowGraph
      nodes={nodes}
      edges={edges}
      visibleCount={nodes.length}
      className={cn(
        'max-w-none rounded-none border-0 bg-transparent p-0 dark:bg-transparent',
        className,
      )}
      {...props}
    />
  )
}
