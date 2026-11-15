// SOURCING: bun:test over the session graph's layout shape and re-rooting in ./session-graph-layout, placed by lib/graph-layout's arrange, with the real projection from ./session-graph for the shape a refetch gives
import { describe, expect, test } from 'bun:test'
import { arrange } from '@/lib/graph-layout'
import type { Point } from '@/lib/graph-layout'
import { SHOW_ALL, projectSessionGraph } from './session-graph'
import { layoutShape, rerooted } from './session-graph-layout'
import type { LayoutShape } from './session-graph-layout'
import type { SessionGraphRead, SessionTreeNode } from './sessions'

const W = 100
const H = 40

const shape = (
  ids: readonly string[],
  edges: readonly [string, string][] = [],
  mains: Record<string, string> = {},
): LayoutShape => ({
  nodes: ids.map((id) => ({ id, width: W, height: H })),
  edges: edges.map(([source, target]) => ({
    id: `${source}->${target}`,
    source,
    target,
  })),
  mains,
})

const at = (x: number, y: number): Point => ({ x, y })

describe('rerooted', () => {
  test('a re-rooted tree re-forms where it was, and other trees stay', () => {
    const before = shape(['r1', 'a1', 'r2'], [['r1', 'a1']], {
      t1: 'r1',
      t2: 'r2',
    })
    const after = shape(['a1', 'r1', 'r2'], [['a1', 'r1']], {
      t1: 'a1',
      t2: 'r2',
    })
    const moving = rerooted(before, after)
    expect([...moving].sort()).toEqual(['a1', 'r1'])
    const placed = arrange({
      graph: after,
      fresh: { a1: at(0, 0), r1: at(156, 0), r2: at(0, 100) },
      previous: { r1: at(300, 300), a1: at(456, 300), r2: at(300, 500) },
      pinned: {},
      relayout: moving,
      across: true,
    })
    expect(placed).toEqual({
      a1: at(300, 300),
      r1: at(456, 300),
      r2: at(300, 500),
    })
  })

  test('only a new main for a tree already drawn re-forms anything', () => {
    const before = shape(['r1'], [], { t1: 'r1' })
    expect(rerooted(before, shape(['r1'], [], { t1: 'r1' })).size).toBe(0)
    expect(
      rerooted(before, shape(['r1', 'r2'], [], { t1: 'r1', t2: 'r2' })).size,
    ).toBe(0)
  })
})

describe('layoutShape', () => {
  const chat = (
    threadId: string,
    over: Partial<SessionTreeNode> = {},
  ): SessionTreeNode => ({
    threadId,
    title: threadId,
    projectId: 'p',
    status: 'regular',
    createdAtMs: 1,
    depth: 0,
    isMain: false,
    isOrigin: false,
    inScope: true,
    ...over,
  })
  const read = (
    over: Partial<SessionTreeNode> = {},
    main = 'root',
  ): SessionGraphRead => ({
    schema: 'theorem-session-graph/1',
    scope: { kind: 'tree', treeId: 'root' },
    trees: [
      {
        schema: 'theorem-session-tree/1',
        treeId: 'root',
        originThreadId: 'root',
        mainThreadId: main,
        mainResolution: 'origin',
        revision: 0,
        nodes: [
          chat('root', {
            isMain: main === 'root',
            isOrigin: true,
            ...(main === 'root' ? {} : { authorityParentThreadId: 'a' }),
          }),
          chat('a', {
            forkedFromThreadId: 'root',
            isMain: main === 'a',
            ...(main === 'root' ? { authorityParentThreadId: 'root' } : {}),
            ...over,
          }),
        ],
      },
    ],
    connections: [
      {
        kind: 'message',
        fromThreadId: 'root',
        toThreadId: 'a',
        voice: 'user',
        count: 1,
        lastAtMs: 1,
      },
    ],
    artifacts: {},
    documents: {},
    tools: {},
    notServed: [],
  })
  const size = () => ({ width: W, height: H })
  const key = (r: SessionGraphRead) =>
    JSON.stringify(layoutShape(projectSessionGraph(r, SHOW_ALL), size))

  test('a refetch that changes only a status or a time gives the same shape', () => {
    expect(key(read({ activeRunId: 'run', lastMessageAtMs: 99 }))).toBe(
      key(read()),
    )
  })

  test('messages are drawn over the layout, not laid out', () => {
    const s = layoutShape(projectSessionGraph(read(), SHOW_ALL), size)
    expect(s.edges.map((e) => e.id)).toEqual(['fork:root->a'])
    expect(s.mains).toEqual({ root: 'session:root' })
  })

  test('a new main changes the shape and re-forms its tree', () => {
    const before = layoutShape(projectSessionGraph(read(), SHOW_ALL), size)
    const after = layoutShape(
      projectSessionGraph(read({}, 'a'), SHOW_ALL),
      size,
    )
    expect([...rerooted(before, after)].sort()).toEqual([
      'session:a',
      'session:root',
    ])
  })
})
