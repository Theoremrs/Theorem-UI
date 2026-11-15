// SOURCING: bun:test over the placement rules in ./session-graph-layout, with the real projection from ./session-graph for the shape a refetch gives
import { describe, expect, test } from 'bun:test'
import { SHOW_ALL, projectSessionGraph } from './session-graph'
import { arrange, layoutShape, rerooted } from './session-graph-layout'
import type { LayoutShape, Point } from './session-graph-layout'
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

const none = new Set<string>()
const all = (s: LayoutShape) => new Set(s.nodes.map((n) => n.id))
const at = (x: number, y: number): Point => ({ x, y })

describe('arrange', () => {
  test('the first layout is ELK’s', () => {
    const s = shape(['root', 'a'], [['root', 'a']])
    const fresh = { root: at(0, 0), a: at(156, 0) }
    expect(
      arrange({
        shape: s,
        fresh,
        previous: {},
        pinned: {},
        relayout: all(s),
        across: true,
      }),
    ).toEqual(fresh)
  })

  test('a new fork leaves what is on screen where it is and goes beside its parent', () => {
    const s = shape(
      ['root', 'a', 'b'],
      [
        ['root', 'a'],
        ['root', 'b'],
      ],
    )
    // With b added, ELK would also move root and a; neither moves.
    const placed = arrange({
      shape: s,
      fresh: { root: at(0, 30), a: at(156, 0), b: at(156, 60) },
      previous: { root: at(500, 500), a: at(656, 470) },
      pinned: {},
      relayout: none,
      across: true,
    })
    expect(placed).toEqual({
      root: at(500, 500),
      a: at(656, 470),
      b: at(656, 530),
    })
  })

  test('a dragged node never moves, and a node ELK puts on it is moved clear', () => {
    const s = shape(
      ['root', 'a', 'b'],
      [
        ['root', 'a'],
        ['root', 'b'],
      ],
    )
    const placed = arrange({
      shape: s,
      fresh: { root: at(0, 0), a: at(156, 0), b: at(156, 60) },
      previous: {},
      pinned: { b: at(156, 0) },
      relayout: all(s),
      across: true,
    })
    expect(placed.b).toEqual(at(156, 0))
    expect(placed.a).toEqual(at(156, 0 + H + 20))
    expect(placed.root).toEqual(at(0, 0))
  })

  test('running down, a node is moved clear to the right', () => {
    const s = shape(['a', 'b'], [['a', 'b']])
    const placed = arrange({
      shape: s,
      fresh: { a: at(0, 0), b: at(0, 0) },
      previous: { a: at(0, 0) },
      pinned: {},
      relayout: none,
      across: false,
    })
    expect(placed.b).toEqual(at(W + 20, 0))
  })

  test('hidden nodes come back where they were', () => {
    const previous = { root: at(10, 10), a: at(200, 10), tools: at(200, 90) }
    const without = shape(['root', 'a'], [['root', 'a']])
    expect(
      arrange({
        shape: without,
        fresh: { root: at(0, 0), a: at(156, 0) },
        previous,
        pinned: {},
        relayout: none,
        across: true,
      }),
    ).toEqual({ root: at(10, 10), a: at(200, 10) })
    const back = shape(
      ['root', 'a', 'tools'],
      [
        ['root', 'a'],
        ['a', 'tools'],
      ],
    )
    expect(
      arrange({
        shape: back,
        fresh: { root: at(0, 0), a: at(156, 0), tools: at(312, 0) },
        previous,
        pinned: {},
        relayout: none,
        across: true,
      }),
    ).toEqual(previous)
  })

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
      shape: after,
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

  test('a new group with nothing on screen to hang from goes after everything', () => {
    const s = shape(['r1', 'x', 'y'], [['x', 'y']])
    const placed = arrange({
      shape: s,
      fresh: { r1: at(0, 0), x: at(0, 0), y: at(156, 0) },
      previous: { r1: at(0, 0) },
      pinned: {},
      relayout: none,
      across: true,
    })
    expect(placed.x).toEqual(at(0, H + 40))
    expect(placed.y).toEqual(at(156, H + 40))
  })

  test('the same inputs give the same places', () => {
    const s = shape(['root', 'a', 'b'], [['root', 'a']])
    const input = {
      shape: s,
      fresh: { root: at(0, 0), a: at(156, 0), b: at(0, 60) },
      previous: { root: at(5, 5) },
      pinned: {},
      relayout: none,
      across: true,
    }
    expect(arrange(input)).toEqual(arrange(input))
  })
})

describe('rerooted', () => {
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
