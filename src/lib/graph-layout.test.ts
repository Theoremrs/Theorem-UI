// SOURCING: bun:test over lib/graph-layout: ELK's layout through each policy's options (elkjs, as the app loads it), `arrange`'s placement rules, which routes still hold once nodes are placed, and the path drawn along a route
import { describe, expect, test } from 'bun:test'
import {
  arrange,
  heldRoutes,
  layout,
  routeHolds,
  routePath,
} from './graph-layout'
import type { LayoutEdge, LayoutLeaf, Point } from './graph-layout'

const W = 100
const H = 40

type Graph = { nodes: LayoutLeaf[]; edges: LayoutEdge[] }

const graph = (
  ids: readonly string[],
  edges: readonly [string, string][] = [],
): Graph => ({
  nodes: ids.map((id) => ({ id, width: W, height: H })),
  edges: edges.map(([source, target]) => ({
    id: `${source}->${target}`,
    source,
    target,
  })),
})

const none = new Set<string>()
const all = (s: Graph) => new Set(s.nodes.map((n) => n.id))
const at = (x: number, y: number): Point => ({ x, y })

describe('arrange', () => {
  test('the first layout is ELK’s', () => {
    const s = graph(['root', 'a'], [['root', 'a']])
    const fresh = { root: at(0, 0), a: at(156, 0) }
    expect(
      arrange({
        graph: s,
        fresh,
        previous: {},
        pinned: {},
        relayout: all(s),
        across: true,
      }),
    ).toEqual(fresh)
  })

  test('a new fork leaves what is on screen where it is and goes beside its parent', () => {
    const s = graph(
      ['root', 'a', 'b'],
      [
        ['root', 'a'],
        ['root', 'b'],
      ],
    )
    // With b added, ELK would also move root and a; neither moves.
    const placed = arrange({
      graph: s,
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
    const s = graph(
      ['root', 'a', 'b'],
      [
        ['root', 'a'],
        ['root', 'b'],
      ],
    )
    const placed = arrange({
      graph: s,
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
    const s = graph(['a', 'b'], [['a', 'b']])
    const placed = arrange({
      graph: s,
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
    const without = graph(['root', 'a'], [['root', 'a']])
    expect(
      arrange({
        graph: without,
        fresh: { root: at(0, 0), a: at(156, 0) },
        previous,
        pinned: {},
        relayout: none,
        across: true,
      }),
    ).toEqual({ root: at(10, 10), a: at(200, 10) })
    const back = graph(
      ['root', 'a', 'tools'],
      [
        ['root', 'a'],
        ['a', 'tools'],
      ],
    )
    expect(
      arrange({
        graph: back,
        fresh: { root: at(0, 0), a: at(156, 0), tools: at(312, 0) },
        previous,
        pinned: {},
        relayout: none,
        across: true,
      }),
    ).toEqual(previous)
  })

  test('a new group with nothing on screen to hang from goes after everything', () => {
    const s = graph(['r1', 'x', 'y'], [['x', 'y']])
    const placed = arrange({
      graph: s,
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
    const s = graph(['root', 'a', 'b'], [['root', 'a']])
    const input = {
      graph: s,
      fresh: { root: at(0, 0), a: at(156, 0), b: at(0, 60) },
      previous: { root: at(5, 5) },
      pinned: {},
      relayout: none,
      across: true,
    }
    expect(arrange(input)).toEqual(arrange(input))
  })
})

const inside = (
  p: Point,
  box: { x: number; y: number; width: number; height: number },
) =>
  p.x >= box.x - 0.5 &&
  p.x <= box.x + box.width + 0.5 &&
  p.y >= box.y - 0.5 &&
  p.y <= box.y + box.height + 0.5
const onBorder = (
  p: Point,
  box: { x: number; y: number; width: number; height: number },
) =>
  inside(p, box) &&
  (Math.abs(p.x - box.x) < 0.5 ||
    Math.abs(p.x - box.x - box.width) < 0.5 ||
    Math.abs(p.y - box.y) < 0.5 ||
    Math.abs(p.y - box.y - box.height) < 0.5)

describe('layout', () => {
  const policy = {
    algorithm: 'layered',
    spacing: { node: 20, layers: 56 },
  } as const

  test('layered runs the way the policy says, and reports it', async () => {
    const g = graph(['a', 'b'], [['a', 'b']])
    const across = await layout(g, { ...policy, direction: 'RIGHT' })
    expect(across.direction).toBe('RIGHT')
    expect(across.positions.b!.x).toBeGreaterThan(across.positions.a!.x + W)
    const down = await layout(g, { ...policy, direction: 'DOWN' })
    expect(down.direction).toBe('DOWN')
    expect(down.positions.b!.y).toBeGreaterThan(down.positions.a!.y + H)
  })

  test('each edge is routed from the border of its source to the border of its target', async () => {
    const g = graph(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['a', 'c'],
      ],
    )
    const laid = await layout(g, { ...policy, direction: 'RIGHT', padding: 16 })
    expect(laid.positions.a).toEqual(at(16, laid.positions.a!.y))
    for (const edge of g.edges) {
      const route = laid.routes[edge.id]!
      const box = (id: string) => ({
        ...laid.positions[id]!,
        width: W,
        height: H,
      })
      expect(onBorder(route[0]!, box(edge.source))).toBe(true)
      expect(onBorder(route.at(-1)!, box(edge.target))).toBe(true)
    }
  })

  test('an edge whose end is not in the graph is left out', async () => {
    const laid = await layout(
      {
        nodes: graph(['a']).nodes,
        edges: [{ id: 'gone', source: 'a', target: 'elsewhere' }],
      },
      { ...policy, direction: 'RIGHT' },
    )
    expect(Object.keys(laid.routes)).toEqual([])
    expect(Object.keys(laid.positions)).toEqual(['a'])
  })

  test('group members are placed inside their group, relative to it, and routes stay in the graph’s coordinates', async () => {
    const laid = await layout(
      {
        nodes: [
          {
            id: 'g1',
            members: [
              { id: 'a', width: W, height: H },
              { id: 'a2', width: W, height: H },
            ],
          },
          { id: 'g2', members: [{ id: 'b', width: W, height: H }] },
          { id: 'c', width: W, height: H },
        ],
        edges: [
          { id: 'a->a2', source: 'a', target: 'a2' },
          { id: 'a2->b', source: 'a2', target: 'b' },
          { id: 'b->c', source: 'b', target: 'c' },
        ],
      },
      {
        ...policy,
        direction: 'RIGHT',
        groupPadding: { top: 48, left: 24, bottom: 24, right: 24 },
      },
    )
    const g1 = laid.groups.g1!
    const g2 = laid.groups.g2!
    expect(laid.positions.a).toEqual(at(24, 48))
    expect(g1.height).toBe(48 + H + 24)
    expect(g1.width).toBe(laid.positions.a2!.x + W + 24)
    const absolute = (id: string, group?: { x: number; y: number }) => ({
      x: laid.positions[id]!.x + (group?.x ?? 0),
      y: laid.positions[id]!.y + (group?.y ?? 0),
      width: W,
      height: H,
    })
    // One edge inside a group, one between groups: both in the same coordinates.
    const within = laid.routes['a->a2']!
    expect(onBorder(within[0]!, absolute('a', g1))).toBe(true)
    expect(onBorder(within.at(-1)!, absolute('a2', g1))).toBe(true)
    const across = laid.routes['a2->b']!
    expect(onBorder(across[0]!, absolute('a2', g1))).toBe(true)
    expect(onBorder(across.at(-1)!, absolute('b', g2))).toBe(true)
  })

  test('mrtree and stress lay a tree out too', async () => {
    const g = graph(
      ['r', 'a', 'b'],
      [
        ['r', 'a'],
        ['r', 'b'],
      ],
    )
    const tree = await layout(g, { algorithm: 'mrtree', spacing: { node: 20 } })
    expect(tree.direction).toBe('DOWN')
    expect(tree.positions.a!.y).toBeGreaterThan(tree.positions.r!.y)
    const stress = await layout(g, {
      algorithm: 'stress',
      spacing: { node: 20 },
      edgeLength: 160,
    })
    expect(stress.direction).toBeUndefined()
    expect(Object.keys(stress.positions).sort()).toEqual(['a', 'b', 'r'])
  })
})

describe('heldRoutes', () => {
  const edges = [{ id: 'a->b', source: 'a', target: 'b' }]
  const routes = {
    'a->b': [at(100, 20), at(130, 20), at(130, 80), at(160, 80)],
  }
  const fresh = { a: at(0, 0), b: at(160, 60) }

  test('an edge whose ends moved together keeps its route, moved with them', () => {
    const held = heldRoutes({
      edges,
      routes,
      fresh,
      placed: { a: at(300, 100), b: at(460, 160) },
    })
    expect(held['a->b']).toEqual({
      points: [at(400, 120), at(430, 120), at(430, 180), at(460, 180)],
      from: at(300, 100),
      to: at(460, 160),
    })
  })

  test('an edge whose ends moved apart has no route', () => {
    const held = heldRoutes({
      edges,
      routes,
      fresh,
      placed: { a: at(0, 0), b: at(160, 200) },
    })
    expect(held).toEqual({})
  })

  test('a route holds only while both ends are drawn where it was routed for', () => {
    const route = { points: routes['a->b'], from: at(0, 0), to: at(160, 60) }
    expect(routeHolds(route, at(0.2, 0), at(160, 60.3))).toBe(true)
    expect(routeHolds(route, at(0, 0), at(160, 61))).toBe(false)
    expect(routeHolds(route, undefined, at(160, 60))).toBe(false)
    expect(routeHolds(undefined, at(0, 0), at(160, 60))).toBe(false)
  })
})

describe('routePath', () => {
  const route = [at(0, 0), at(40, 0), at(40, 60), at(80, 60)]

  test('without a radius it is the route’s straight legs', () => {
    expect(routePath(route)).toBe('M0,0L40,0L40,60L80,60')
  })

  test('each corner is rounded through the corner itself', () => {
    expect(routePath(route, 8)).toBe(
      'M0,0L32,0Q40,0 40,8L40,52Q40,60 48,60L80,60',
    )
  })

  test('a corner on a short leg is rounded to at most half of it', () => {
    expect(routePath([at(0, 0), at(6, 0), at(6, 40)], 8)).toBe(
      'M0,0L3,0Q6,0 6,3L6,40',
    )
  })

  test('a straight route is one line', () => {
    expect(routePath([at(0, 10), at(90, 10)], 8)).toBe('M0,10L90,10')
  })
})
